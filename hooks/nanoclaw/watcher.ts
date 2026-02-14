#!/usr/bin/env node
/**
 * NanoClaw Watcher Daemon
 *
 * Standalone process that tails NanoClaw's Pino logs, translating container
 * lifecycle events into webhook payloads for Mission Control's Convex backend.
 *
 * No SQLite dependency — group info is read from available_groups.json and
 * Mission Control session keys are extracted from file-based mappings written
 * by the Vite IPC bridge.
 *
 * Usage:
 *   npx tsx hooks/nanoclaw/watcher.ts
 *
 * Environment:
 *   MISSION_CONTROL_URL  – Convex HTTP endpoint (required)
 *   NANOCLAW_DIR         – NanoClaw root dir (default: ~/nanoclaw)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MISSION_CONTROL_URL =
  process.env.MISSION_CONTROL_URL || "http://127.0.0.1:3211/nanoclaw/event";
const NANOCLAW_DIR = process.env.NANOCLAW_DIR || path.join(os.homedir(), "nanoclaw");
const LOG_FILE = path.join(NANOCLAW_DIR, "logs", "nanoclaw.log");
const GROUPS_FILE = path.join(NANOCLAW_DIR, "data", "ipc", "main", "available_groups.json");
const MC_MAPPINGS_DIR = path.join(NANOCLAW_DIR, "data", "ipc", "main", ".mc-mappings");
const IPC_MESSAGES_DIR = path.join(NANOCLAW_DIR, "data", "ipc", "main", "messages");
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  group: string;
  startTime: number;
  sessionKey: string;
  prompt?: string;
  source?: string;
  response?: string;
  completedEarly?: boolean;
}

interface GroupInfo {
  jid: string;
  name: string;
}

interface DeferredMcTask {
  sessionKey: string;
  group: string;
  startTime: number;
  containerName?: string;
  fileSnapshot?: Map<string, number>; // relativePath → mtimeMs
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, RunState>();
const lastContainerByGroup = new Map<string, string>();
const activeTaskRuns = new Map<string, RunState>();

// Mission Control session key queues (FIFO per group — supports concurrent tasks)
const missionSessionQueues = new Map<string, string[]>();
const deferredMcTasks = new Map<string, DeferredMcTask>();

// Captured outgoing messages from IPC messages/ directory (send_message MCP tool)
const capturedResponseByGroup = new Map<string, string>();
// File snapshots taken when MC mapping is discovered, keyed by session key
const mcFileSnapshots = new Map<string, Map<string, number>>();
// Cooldown after consuming a session — prevents duplicate "message sent" events
// from the same task (interactive handler fires after IPC handler) stealing
// the next task's session.
const groupEndCooldown = new Map<string, number>();
// Groups with active MC-triggered queries awaiting "Agent query completed" signal
const pendingQueryGroups = new Set<string>();

// Queue helpers for missionSessionQueues
function pushMcSession(group: string, sessionKey: string): void {
  const queue = missionSessionQueues.get(group);
  if (queue) { queue.push(sessionKey); } else { missionSessionQueues.set(group, [sessionKey]); }
}
function peekMcSession(group: string): string | undefined {
  return missionSessionQueues.get(group)?.[0];
}
function shiftMcSession(group: string): string | undefined {
  const queue = missionSessionQueues.get(group);
  if (!queue || queue.length === 0) return undefined;
  const session = queue.shift()!;
  if (queue.length === 0) missionSessionQueues.delete(group);
  return session;
}
function hasMcSession(group: string): boolean {
  const queue = missionSessionQueues.get(group);
  return !!queue && queue.length > 0;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

async function postEvent(payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(MISSION_CONTROL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[watcher] POST failed: ${res.status}`);
    }
  } catch (err) {
    console.error(`[watcher] POST error:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Group info (from JSON file, no SQLite)
// ---------------------------------------------------------------------------

let cachedGroups: GroupInfo[] | null = null;
let groupsCacheTime = 0;

function getGroups(): GroupInfo[] {
  const now = Date.now();
  if (cachedGroups && now - groupsCacheTime < 30_000) return cachedGroups;

  try {
    const data = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf-8"));
    cachedGroups = (data?.groups ?? []).map((g: any) => ({
      jid: g.jid,
      name: g.name,
    }));
    groupsCacheTime = now;
  } catch {
    cachedGroups = [];
  }
  return cachedGroups!;
}

function getGroupName(folder: string): string {
  // "main" folder maps to the first registered group
  if (folder === "main") {
    const groups = getGroups();
    return groups[0]?.name ?? "NanoClaw";
  }
  return folder;
}

// ---------------------------------------------------------------------------
// MC session key extraction (from NanoClaw's SQLite prompt field)
// ---------------------------------------------------------------------------

const NANOCLAW_DB = path.join(NANOCLAW_DIR, "store", "messages.db");

/**
 * Extract the MC session key from a NanoClaw task's prompt.
 * The Vite IPC bridge embeds [mc:session=mission:<id>] at the start.
 * Reads directly from SQLite via the sqlite3 CLI — no npm dependency.
 */
function findMcSession(nanoTaskId: string): string | null {
  try {
    const result = execSync(
      `sqlite3 "${NANOCLAW_DB}" "SELECT prompt FROM scheduled_tasks WHERE id='${nanoTaskId}' LIMIT 1;"`,
      { encoding: "utf-8", timeout: 2000 },
    ).trim();
    const match = result.match(/\[mc:session=(mission:[^\]]+)\]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task result reader (from SQLite task_run_logs)
// ---------------------------------------------------------------------------

/**
 * Read the agent's full response from task_run_logs (written after container exits).
 * Strips <internal>...</internal> blocks to match NanoClaw's display behavior.
 */
function readTaskResult(nanoTaskId: string): string | null {
  try {
    const result = execSync(
      `sqlite3 "${NANOCLAW_DB}" "SELECT result FROM task_run_logs WHERE task_id='${nanoTaskId}' AND status='success' ORDER BY run_at DESC LIMIT 1;"`,
      { encoding: "utf-8", timeout: 2000 },
    ).trim();
    return result
      ? result.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim()
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File snapshot / diff for group directories
// ---------------------------------------------------------------------------

const SNAPSHOT_EXCLUDE = new Set(["logs", "conversations", "node_modules", "CLAUDE.md", ".git"]);

function walkDir(dir: string, base: string, out: Map<string, number>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SNAPSHOT_EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      walkDir(full, base, out);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(full);
        out.set(rel, stat.mtimeMs);
      } catch { /* skip unreadable files */ }
    }
  }
}

function snapshotGroupDir(group: string): Map<string, number> {
  const groupDir = path.join(NANOCLAW_DIR, "groups", group);
  const snapshot = new Map<string, number>();
  if (fs.existsSync(groupDir)) {
    walkDir(groupDir, groupDir, snapshot);
  }
  return snapshot;
}

interface FileDiff {
  relativePath: string;
  fullPath: string;
}

function diffGroupDir(group: string, before: Map<string, number>): FileDiff[] {
  const groupDir = path.join(NANOCLAW_DIR, "groups", group);
  const current = new Map<string, number>();
  if (fs.existsSync(groupDir)) {
    walkDir(groupDir, groupDir, current);
  }

  const changed: FileDiff[] = [];
  for (const [rel, mtime] of current) {
    const prev = before.get(rel);
    if (prev === undefined || mtime > prev) {
      changed.push({ relativePath: rel, fullPath: path.join(groupDir, rel) });
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// File type detection for documents
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".sh",
  ".sql", ".css", ".html", ".c", ".cpp", ".h", ".java", ".rb",
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

function detectFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  return CODE_EXTENSIONS.has(ext) ? "code" : "text";
}

// ---------------------------------------------------------------------------
// Pino pretty log parser
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseLogLine(raw: string): {
  timestamp: string;
  level: string;
  message: string;
} | null {
  const clean = stripAnsi(raw);
  const match = clean.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s+(\w+)\s+\(\d+\):\s+(.+)$/);
  if (!match) return null;
  return { timestamp: match[1], level: match[2], message: match[3] };
}

function parseKeyValue(raw: string): { key: string; value: string } | null {
  const clean = stripAnsi(raw);
  const match = clean.match(/^\s{4}(\w+):\s+(.+)$/);
  if (!match) return null;
  let value = match[2];
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

function detectSource(jid: string): string | null {
  if (jid.startsWith("tg:")) return "telegram";
  if (jid.includes("@s.whatsapp.net") || jid.includes("@g.us")) return "whatsapp";
  if (jid === "web@chat") return "webui";
  return null;
}

// Pending prompts captured from "Processing messages" log, keyed by group
const pendingPromptByGroup = new Map<string, string>();

// File snapshots for non-MC runs, keyed by containerName
const runFileSnapshots = new Map<string, Map<string, number>>();

function hasActiveRun(group: string): boolean {
  for (const [, run] of activeRuns) {
    if (run.group === group && !run.completedEarly) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Debounced end-event finalizer
// ---------------------------------------------------------------------------

/**
 * Called when "Agent query completed" is detected for a group. Consumes the
 * MC session, sends the accumulated response as a comment, detects documents,
 * and posts the END event. Handles both tracked runs (EARLY_END) and
 * orphaned sessions (watcher restarted mid-run).
 */
function finalizeGroupEnd(group: string): void {
  // Try tracked active run first
  const containerName = lastContainerByGroup.get(group);
  const run = containerName ? activeRuns.get(containerName) : undefined;

  if (run && !run.completedEarly) {
    const mcSession = run.sessionKey.startsWith("mission:")
      ? run.sessionKey
      : peekMcSession(group) ?? null;

    if (mcSession) {
      run.completedEarly = true;
      if (!run.sessionKey.startsWith("mission:")) shiftMcSession(group);

      if (!capturedResponseByGroup.has(group) && run.response) {
        capturedResponseByGroup.set(group, run.response);
      }
      const capturedResponse = capturedResponseByGroup.get(group) ?? null;
      sendResponseComment(group, run.runId, mcSession);

      const snapshot = mcFileSnapshots.get(mcSession) ?? null;
      mcFileSnapshots.delete(mcSession);
      sendDocumentEvents(group, run.runId, mcSession, snapshot);
      if (snapshot) {
        const _g = group, _r = run.runId, _s = mcSession, _snap = snapshot;
        setTimeout(() => sendDocumentEvents(_g, _r, _s, _snap), 5000);
      }

      let response = capturedResponse ?? run.response ?? null;
      if (response && response.length > 1000) {
        response = response.slice(0, 1000) + "...";
      }

      void postEvent({
        runId: run.runId,
        action: "end",
        sessionKey: mcSession,
        agentId: getGroupName(run.group),
        timestamp: new Date().toISOString(),
        response,
        eventType: "lifecycle:end",
      });

      groupEndCooldown.set(group, Date.now() + 3000);
      console.log(`[watcher] EARLY_END ${containerName} session=${mcSession} (query completed)`);
      return;
    }

    // Non-MC run (telegram, whatsapp, webui) — finalize directly
    if (run.sessionKey.startsWith("nanoclaw:")) {
      run.completedEarly = true;

      if (!capturedResponseByGroup.has(group) && run.response) {
        capturedResponseByGroup.set(group, run.response);
      }
      sendResponseComment(group, run.runId, run.sessionKey);

      const snapshot = runFileSnapshots.get(containerName!) ?? null;
      runFileSnapshots.delete(containerName!);
      sendDocumentEvents(group, run.runId, run.sessionKey, snapshot);
      if (snapshot) {
        const _g = group, _r = run.runId, _s = run.sessionKey, _snap = snapshot;
        setTimeout(() => sendDocumentEvents(_g, _r, _s, _snap), 5000);
      }

      let response = capturedResponseByGroup.get(group) ?? run.response ?? null;
      capturedResponseByGroup.delete(group);
      if (response && response.length > 1000) {
        response = response.slice(0, 1000) + "...";
      }

      void postEvent({
        runId: run.runId,
        action: "end",
        sessionKey: run.sessionKey,
        agentId: getGroupName(run.group),
        timestamp: new Date().toISOString(),
        response,
        eventType: "lifecycle:end",
      });

      groupEndCooldown.set(group, Date.now() + 3000);
      console.log(`[watcher] EARLY_END ${containerName} session=${run.sessionKey} source=${run.source ?? "unknown"} (query completed)`);
      return;
    }
  }

  // Fallback: orphaned session (watcher missed the container spawn)
  const pendingSession = shiftMcSession(group);
  if (pendingSession) {
    const syntheticRunId = `orphan-${Date.now()}`;
    const capturedResponse = capturedResponseByGroup.get(group) ?? null;

    sendResponseComment(group, syntheticRunId, pendingSession);

    const snapshot = mcFileSnapshots.get(pendingSession) ?? null;
    mcFileSnapshots.delete(pendingSession);
    sendDocumentEvents(group, syntheticRunId, pendingSession, snapshot);
    if (snapshot) {
      const _g = group, _r = syntheticRunId, _s = pendingSession, _snap = snapshot;
      setTimeout(() => sendDocumentEvents(_g, _r, _s, _snap), 5000);
    }

    let response = capturedResponse;
    if (response && response.length > 1000) response = response.slice(0, 1000) + "...";

    void postEvent({
      runId: syntheticRunId,
      action: "end",
      sessionKey: pendingSession,
      agentId: getGroupName(group),
      timestamp: new Date().toISOString(),
      response,
      eventType: "lifecycle:end",
    });
    groupEndCooldown.set(group, Date.now() + 3000);
    console.log(`[watcher] ORPHAN_END session=${pendingSession} (query completed)`);
    return;
  }

  // Last resort: check SQLite for active MC tasks
  try {
    const result = execSync(
      `sqlite3 "${NANOCLAW_DB}" "SELECT id, prompt FROM scheduled_tasks WHERE status='active' ORDER BY created_at DESC LIMIT 1;"`,
      { encoding: "utf-8", timeout: 2000 },
    ).trim();
    if (result) {
      const [, prompt] = result.split("|");
      const match = prompt?.match(/\[mc:session=(mission:[^\]]+)\]/);
      if (match) {
        const syntheticRunId = `orphan-${Date.now()}`;
        const capturedResponse = capturedResponseByGroup.get(group) ?? null;

        sendResponseComment(group, syntheticRunId, match[1]);
        const snapshot = mcFileSnapshots.get(match[1]) ?? null;
        mcFileSnapshots.delete(match[1]);
        sendDocumentEvents(group, syntheticRunId, match[1], snapshot);
        if (snapshot) {
          const _snap = snapshot;
          setTimeout(() => sendDocumentEvents(group, syntheticRunId, match[1], _snap), 5000);
        }

        let response = capturedResponse;
        if (response && response.length > 1000) response = response.slice(0, 1000) + "...";

        void postEvent({
          runId: syntheticRunId,
          action: "end",
          sessionKey: match[1],
          agentId: getGroupName(group),
          timestamp: new Date().toISOString(),
          response,
          eventType: "lifecycle:end",
        });
        groupEndCooldown.set(group, Date.now() + 3000);
        console.log(`[watcher] ORPHAN_END session=${match[1]} (query completed, from SQLite)`);
      }
    }
  } catch { /* SQLite read failed, skip */ }
}

// ---------------------------------------------------------------------------
// Log line handler
// ---------------------------------------------------------------------------

function handleLogBlock(mainLine: string, kvLines: string[]): void {
  const parsed = parseLogLine(mainLine);
  if (!parsed) return;

  const kv: Record<string, string> = {};
  for (const line of kvLines) {
    const pair = parseKeyValue(line);
    if (pair) kv[pair.key] = pair.value;
  }

  const { message } = parsed;

  // --- Processing messages → capture prompt for upcoming container ---
  if (message === "Processing messages") {
    const group = kv["group"];
    const prompt = kv["prompt"];
    if (group && prompt) {
      pendingPromptByGroup.set(group, prompt);
      console.log(`[watcher] PROMPT_CAPTURE group=${group} len=${prompt.length}`);
    }
    return;
  }

  // --- Spawning container agent → start event ---
  if (message === "Spawning container agent") {
    const group = kv["group"];
    const containerName = kv["containerName"];
    if (!group || !containerName) return;

    lastContainerByGroup.set(group, containerName);

    // Link container to deferred MC task and take file snapshot
    for (const [, deferred] of deferredMcTasks) {
      if (deferred.group === group && !deferred.containerName) {
        deferred.containerName = containerName;
        deferred.fileSnapshot = snapshotGroupDir(group);
        break;
      }
    }

    const mcSession = peekMcSession(group);
    const chatJid = kv["chatJid"];
    let source: string | null = chatJid ? detectSource(chatJid) : null;
    const sessionKey = mcSession ?? `nanoclaw:${group}`;

    if (mcSession) {
      source = "mission-control";
      shiftMcSession(group);
    }

    // Capture prompt: prefer "Processing messages" capture, fall back to spawn log KV
    const prompt = pendingPromptByGroup.get(group) ?? kv["prompt"] ?? undefined;
    pendingPromptByGroup.delete(group);

    // Take file snapshot for all runs (not just MC)
    if (!mcSession) {
      runFileSnapshots.set(containerName, snapshotGroupDir(group));
    }

    const run: RunState = {
      runId: containerName,
      group,
      startTime: Date.now(),
      sessionKey,
      source: source ?? undefined,
      prompt,
    };
    activeRuns.set(containerName, run);

    void postEvent({
      runId: containerName,
      action: "start",
      sessionKey,
      agentId: getGroupName(group),
      timestamp: new Date().toISOString(),
      source,
      prompt: prompt ?? null,
      eventType: "lifecycle:start",
    });

    console.log(`[watcher] START ${containerName} group=${group} session=${sessionKey} source=${source ?? "unknown"}`);
    return;
  }

  // --- Agent output → capture response ---
  if (message.startsWith("Agent output:")) {
    const group = kv["group"];
    const responseText = message.replace("Agent output:", "").trim();

    if (group) {
      const containerName = lastContainerByGroup.get(group);
      if (containerName) {
        const run = activeRuns.get(containerName);
        if (run) {
          run.response = run.response
            ? run.response + "\n" + responseText
            : responseText;
        }
      }
    }
    return;
  }

  // --- IPC/Telegram message sent → mark group as having active query ---
  // NanoClaw emits these after agent output is delivered via send_message MCP
  // tool. We track the group so watchIpcMessages captures the response text.
  // The actual end signal is "Agent query completed" (below).
  if (message === "IPC message sent" || message === "Telegram message sent") {
    let group = kv["sourceGroup"];

    if (!group && kv["jid"]) {
      const groups = getGroups();
      const matched = groups.find(g => g.jid === kv["jid"]);
      if (matched) group = "main";
    }
    if (!group) {
      for (const [, r] of activeRuns) {
        if (!r.completedEarly) {
          group = r.group;
          break;
        }
      }
    }

    if (!group) return;

    // Cooldown: skip duplicate "message sent" from the same task's interactive handler.
    const cooldownUntil = groupEndCooldown.get(group);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      console.log(`[watcher] SKIP (cooldown) ${message} group=${group}`);
      return;
    }

    // Mark this group as having an active query (enables IPC capture)
    pendingQueryGroups.add(group);
    console.log(`[watcher] MESSAGE_SENT ${message} group=${group}`);
    return;
  }

  // --- Agent query completed → definitive end signal ---
  // NanoClaw logs this when the agent-runner finishes a query (null-result
  // OUTPUT_MARKER). This is the real "turn done" signal — finalize immediately.
  if (message === "Agent query completed") {
    const group = kv["group"];
    if (!group) return;

    if (!pendingQueryGroups.has(group) && !hasMcSession(group) && !hasActiveRun(group)) {
      // No tracked activity for this group, ignore
      console.log(`[watcher] QUERY_DONE (no tracked session) group=${group}`);
      return;
    }

    pendingQueryGroups.delete(group);
    console.log(`[watcher] QUERY_DONE group=${group}`);
    finalizeGroupEnd(group);
    return;
  }

  // --- Container completed ---
  if (
    message === "Container completed" ||
    message === "Container completed (streaming mode)" ||
    message === "Container timed out after output (idle cleanup)"
  ) {
    const group = kv["group"];
    const duration = kv["duration"];
    const containerName = kv["containerName"] ?? (group ? lastContainerByGroup.get(group) : undefined);
    if (!containerName) return;

    const run = activeRuns.get(containerName);
    if (!run) return;

    // Skip duplicate end event if already sent via early completion
    if (run.completedEarly) {
      console.log(`[watcher] END (skip, already sent early) ${containerName} duration=${duration ?? "?"}ms`);
      activeRuns.delete(containerName);
      return;
    }

    let response = run.response ?? null;
    if (response && response.length > 1000) {
      response = response.slice(0, 1000) + "...";
    }

    void postEvent({
      runId: run.runId,
      action: "end",
      sessionKey: run.sessionKey,
      agentId: getGroupName(run.group),
      timestamp: new Date().toISOString(),
      response,
      eventType: "lifecycle:end",
    });

    console.log(`[watcher] END ${containerName} duration=${duration ?? "?"}ms session=${run.sessionKey}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Container exited with error ---
  if (message === "Container exited with error") {
    const group = kv["group"];
    const code = kv["code"];
    const stderr = kv["stderr"];
    const containerName = kv["containerName"] ?? (group ? lastContainerByGroup.get(group) : undefined);
    if (!containerName) return;

    const run = activeRuns.get(containerName);
    if (!run) return;

    // Skip if already completed early — code 137 (SIGKILL) is expected
    // when NanoClaw kills the idle container after the output was delivered
    if (run.completedEarly) {
      console.log(`[watcher] ERROR (skip, already sent early) ${containerName} code=${code}`);
      activeRuns.delete(containerName);
      return;
    }

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: run.sessionKey,
      agentId: getGroupName(run.group),
      timestamp: new Date().toISOString(),
      error: `Exit code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
      eventType: "lifecycle:error",
    });

    console.log(`[watcher] ERROR ${containerName} code=${code}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Container timeout ---
  if (message === "Container timeout, stopping gracefully" || message === "Container timed out with no output") {
    const group = kv["group"];
    const containerName = kv["containerName"] ?? (group ? lastContainerByGroup.get(group) : undefined);
    if (!containerName) return;

    const run = activeRuns.get(containerName);
    if (!run) return;

    if (run.completedEarly) {
      console.log(`[watcher] TIMEOUT (skip, already sent early) ${containerName}`);
      activeRuns.delete(containerName);
      return;
    }

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: run.sessionKey,
      agentId: getGroupName(run.group),
      timestamp: new Date().toISOString(),
      error: "Container timed out",
      eventType: "lifecycle:timeout",
    });

    console.log(`[watcher] TIMEOUT ${containerName}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Container agent error ---
  if (message === "Container agent error") {
    const group = kv["group"];
    const error = kv["error"];
    const containerName = group ? lastContainerByGroup.get(group) : undefined;
    if (!containerName) return;

    const run = activeRuns.get(containerName);
    if (!run) return;

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: run.sessionKey,
      agentId: getGroupName(run.group),
      timestamp: new Date().toISOString(),
      error: error ?? "Container agent error",
      eventType: "lifecycle:error",
    });

    console.log(`[watcher] AGENT_ERROR ${containerName}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Running scheduled task → check for MC session key ---
  if (message === "Running scheduled task") {
    const taskId = kv["taskId"];
    const group = kv["group"];
    if (!taskId) return;

    const groupFolder = group ?? "unknown";

    // Check for MC session key in the task's prompt
    const mcSession = findMcSession(taskId);
    if (mcSession) {
      // watchMcMappings usually pushes this session first (via .mc-mappings/).
      // Only push here as a fallback if it's NOT already in the queue —
      // duplicate pushes leave stale sessions that steal slots from future tasks.
      const queue = missionSessionQueues.get(groupFolder);
      const alreadyQueued = queue?.includes(mcSession) ?? false;
      if (!alreadyQueued) pushMcSession(groupFolder, mcSession);
      deferredMcTasks.set(taskId, {
        sessionKey: mcSession,
        group: groupFolder,
        startTime: Date.now(),
      });

      console.log(`[watcher] TASK_START (MC) ${taskId} group=${groupFolder} session=${mcSession}`);
      return;
    }

    // Non-MC scheduled task
    const runId = `task-${taskId}-${Date.now()}`;
    const run: RunState = {
      runId,
      group: groupFolder,
      startTime: Date.now(),
      sessionKey: `nanoclaw:task:${taskId}`,
    };
    activeTaskRuns.set(taskId, run);

    void postEvent({
      runId,
      action: "start",
      sessionKey: `nanoclaw:task:${taskId}`,
      agentId: getGroupName(groupFolder),
      timestamp: new Date().toISOString(),
      source: "scheduled",
      eventType: "task:start",
    });

    console.log(`[watcher] TASK_START ${taskId} group=${groupFolder}`);
    return;
  }

  // --- Task completed ---
  if (message === "Task completed") {
    const taskId = kv["taskId"];
    const durationMs = kv["durationMs"];
    if (!taskId) return;

    const deferred = deferredMcTasks.get(taskId);
    if (deferred) {
      // MC task: two-phase delivery — card already moved at EARLY_END,
      // now send response text and detect new files.
      deferredMcTasks.delete(taskId);

      const runId = deferred.containerName ?? `task-${taskId}-${Date.now()}`;
      const agentId = getGroupName(deferred.group);

      // a) Read result from task_run_logs
      const result = readTaskResult(taskId);

      // b) Send response text as a progress comment
      if (result) {
        const truncated = result.length > 2000
          ? result.slice(0, 2000) + "..."
          : result;

        void postEvent({
          runId,
          action: "progress",
          sessionKey: deferred.sessionKey,
          agentId,
          timestamp: new Date().toISOString(),
          message: `**Agent Response:**\n\n${truncated}`,
          eventType: "task:response",
        });
        console.log(`[watcher] TASK_RESPONSE ${taskId} len=${result.length}`);
      } else {
        console.log(`[watcher] TASK_END (MC, no result in DB) ${taskId}`);
      }

      // c) Diff file snapshot → send document events for new/modified files
      if (deferred.fileSnapshot) {
        const changed = diffGroupDir(deferred.group, deferred.fileSnapshot);
        for (const file of changed) {
          try {
            const content = fs.readFileSync(file.fullPath, "utf-8");
            const title = path.basename(file.relativePath);
            void postEvent({
              runId,
              action: "document",
              sessionKey: deferred.sessionKey,
              agentId,
              timestamp: new Date().toISOString(),
              document: {
                title,
                content: content.length > 10000
                  ? content.slice(0, 10000) + "\n\n... (truncated)"
                  : content,
                type: detectFileType(file.relativePath),
                path: file.relativePath,
              },
            });
            console.log(`[watcher] DOCUMENT ${taskId} ${file.relativePath}`);
          } catch {
            console.log(`[watcher] DOCUMENT (read failed) ${file.relativePath}`);
          }
        }
      }

      return;
    }

    // Non-MC scheduled task
    const run = activeTaskRuns.get(taskId);
    if (!run) return;

    void postEvent({
      runId: run.runId,
      action: "end",
      sessionKey: run.sessionKey,
      agentId: getGroupName(run.group),
      timestamp: new Date().toISOString(),
      eventType: "task:end",
    });

    console.log(`[watcher] TASK_END ${taskId} duration=${durationMs}ms`);
    activeTaskRuns.delete(taskId);
    return;
  }

  // --- Task failed ---
  if (message === "Task failed") {
    const taskId = kv["taskId"];
    const error = kv["error"];
    if (!taskId) return;

    if (deferredMcTasks.has(taskId)) {
      deferredMcTasks.delete(taskId);
      console.log(`[watcher] TASK_ERROR (MC, handled by container) ${taskId}`);
      return;
    }

    const run = activeTaskRuns.get(taskId);
    if (!run) return;

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: run.sessionKey,
      agentId: getGroupName(run.group),
      timestamp: new Date().toISOString(),
      error: error ?? "Task failed",
      eventType: "task:error",
    });

    console.log(`[watcher] TASK_ERROR ${taskId}`);
    activeTaskRuns.delete(taskId);
    return;
  }
}

// ---------------------------------------------------------------------------
// Log tailer
// ---------------------------------------------------------------------------

function tailLog(): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`[watcher] Waiting for log file: ${LOG_FILE}`);
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const interval = setInterval(() => {
      if (fs.existsSync(LOG_FILE)) {
        clearInterval(interval);
        tailLog();
      }
    }, POLL_INTERVAL_MS);
    return;
  }

  const stat = fs.statSync(LOG_FILE);
  let position = stat.size;
  let partialLine = "";

  let pendingMainLine: string | null = null;
  let pendingKvLines: string[] = [];

  function flushPending(): void {
    if (pendingMainLine) {
      try {
        handleLogBlock(pendingMainLine, pendingKvLines);
      } catch (err) {
        console.error("[watcher] Error handling log block:", err);
      }
      pendingMainLine = null;
      pendingKvLines = [];
    }
  }

  function processLine(line: string): void {
    if (!line.trim()) return;

    const clean = stripAnsi(line);

    if (clean.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/)) {
      flushPending();
      pendingMainLine = line;
      pendingKvLines = [];
    } else if (clean.match(/^\s{4}\w+:/)) {
      pendingKvLines.push(line);
    } else {
      flushPending();
    }
  }

  function readNewData(): void {
    try {
      const newStat = fs.statSync(LOG_FILE);

      if (newStat.size < position) {
        position = 0;
        partialLine = "";
        flushPending();
      }

      if (newStat.size === position) return;

      const bytesToRead = newStat.size - position;
      const fd = fs.openSync(LOG_FILE, "r");
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, buf.length, position);
      fs.closeSync(fd);
      position = newStat.size;

      const text = partialLine + buf.toString("utf-8");
      const lines = text.split("\n");
      partialLine = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line);
      }
      // Flush after processing all lines so the last block isn't stuck
      flushPending();
    } catch (err) {
      console.error("[watcher] Error reading log:", err);
    }
  }

  const watcher = fs.watch(LOG_FILE, () => {
    readNewData();
  });

  // Polling fallback — fs.watch on macOS can silently miss events
  const pollInterval = setInterval(() => {
    readNewData();
  }, POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    watcher.close();
    clearInterval(pollInterval);
    flushPending();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    watcher.close();
    clearInterval(pollInterval);
    flushPending();
    process.exit(0);
  });

  console.log(`[watcher] Tailing ${LOG_FILE} (position=${position})`);
}

// ---------------------------------------------------------------------------
// IPC messages watcher — capture outgoing response text from send_message tool
// ---------------------------------------------------------------------------

const seenIpcMessages = new Set<string>();

/**
 * Watch the IPC messages/ directory for outgoing messages written by the
 * container's send_message MCP tool. NanoClaw's IPC watcher also reads these
 * files (every 1s) and forwards them to Telegram, then deletes them.
 *
 * We poll at 200ms to read the file content before the IPC watcher deletes it.
 * The captured text is stored in capturedResponseByGroup for use when
 * EARLY_END/ORPHAN_END fires.
 */
function watchIpcMessages(): void {
  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });

  const scan = () => {
    try {
      const files = fs.readdirSync(IPC_MESSAGES_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"));
      for (const file of files) {
        if (seenIpcMessages.has(file)) continue;
        seenIpcMessages.add(file);

        const filePath = path.join(IPC_MESSAGES_DIR, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (data.type === "message" && data.text && typeof data.text === "string") {
            const group = data.groupFolder ?? "main";
            // Capture if we have an active MC session or any active run for this group
            if (hasMcSession(group) || hasActiveRun(group)) {
              // Append to captured response (agent may call send_message multiple times)
              const existing = capturedResponseByGroup.get(group);
              capturedResponseByGroup.set(group, existing ? existing + "\n\n" + data.text : data.text);
              console.log(`[watcher] IPC_CAPTURE ${file} group=${group} len=${data.text.length}`);
            }
          }
        } catch {
          // File already deleted by IPC watcher, or malformed — skip
        }
      }
    } catch {
      // Directory read failed
    }

    // Prevent unbounded growth of seen set
    if (seenIpcMessages.size > 500) seenIpcMessages.clear();
  };

  setInterval(scan, 200);
  scan();
  console.log(`[watcher] Watching IPC messages: ${IPC_MESSAGES_DIR}`);
}

// ---------------------------------------------------------------------------
// Document + response delivery helpers
// ---------------------------------------------------------------------------

/**
 * Send document events for files created/modified during this task.
 * Only uses snapshot diff — files must be new or have a newer mtime
 * than the snapshot taken when the MC mapping was written.
 * Without a snapshot, no documents are sent (avoids cross-contamination).
 */
function sendDocumentEvents(
  group: string,
  runId: string,
  sessionKey: string,
  snapshot: Map<string, number> | null,
): void {
  if (!snapshot) {
    console.log(`[watcher] DOCUMENT (no snapshot) group=${group}`);
    return;
  }

  const changed = diffGroupDir(group, snapshot);
  if (changed.length === 0) {
    console.log(`[watcher] DOCUMENT (none changed) group=${group}`);
    return;
  }

  for (const file of changed) {
    try {
      const content = fs.readFileSync(file.fullPath, "utf-8");
      const title = path.basename(file.relativePath);
      void postEvent({
        runId,
        action: "document",
        sessionKey,
        agentId: getGroupName(group),
        timestamp: new Date().toISOString(),
        document: {
          title,
          content: content.length > 10000
            ? content.slice(0, 10000) + "\n\n... (truncated)"
            : content,
          type: detectFileType(file.relativePath),
          path: file.relativePath,
        },
      });
      console.log(`[watcher] DOCUMENT ${file.relativePath} session=${sessionKey}`);
    } catch {
      console.log(`[watcher] DOCUMENT (read failed) ${file.relativePath}`);
    }
  }
}

/**
 * Send captured response text as a progress comment on the task.
 */
function sendResponseComment(
  group: string,
  runId: string,
  sessionKey: string,
): void {
  const response = capturedResponseByGroup.get(group);
  if (!response) return;

  capturedResponseByGroup.delete(group);

  const truncated = response.length > 2000
    ? response.slice(0, 2000) + "..."
    : response;

  void postEvent({
    runId,
    action: "progress",
    sessionKey,
    agentId: getGroupName(group),
    timestamp: new Date().toISOString(),
    message: `**Agent Response:**\n\n${truncated}`,
    eventType: "task:response",
  });
  console.log(`[watcher] RESPONSE group=${group} len=${response.length}`);
}

// ---------------------------------------------------------------------------
// MC mappings watcher — detect session keys written by the Vite IPC bridge
// ---------------------------------------------------------------------------

const seenMappingFiles = new Set<string>();

/**
 * Poll the .mc-mappings/ directory for session key files written by the
 * Vite IPC bridge. This is the correlation mechanism for both delivery paths:
 * - Task path: watcher also discovers session key via findMcSession() in SQLite,
 *   but the mapping provides an earlier signal.
 * - Input/ path (container active): the ONLY way the watcher discovers the
 *   session key, since there's no scheduled task in SQLite.
 *
 * No race condition: the watcher owns these files (the container never touches
 * .mc-mappings/). Files are cleaned up after processing.
 */
function watchMcMappings(): void {
  fs.mkdirSync(MC_MAPPINGS_DIR, { recursive: true });

  // Purge stale mapping files left over from a previous watcher instance.
  // These would poison the session queue with already-consumed sessions.
  try {
    const stale = fs.readdirSync(MC_MAPPINGS_DIR).filter(f => f.endsWith(".json"));
    for (const file of stale) {
      seenMappingFiles.add(file);
      try { fs.unlinkSync(path.join(MC_MAPPINGS_DIR, file)); } catch { /* ignore */ }
    }
    if (stale.length > 0) {
      console.log(`[watcher] Purged ${stale.length} stale MC mapping(s) from previous run`);
    }
  } catch { /* ignore */ }

  const scan = () => {
    try {
      const files = fs.readdirSync(MC_MAPPINGS_DIR).filter(f => f.endsWith(".json"));
      for (const file of files) {
        if (seenMappingFiles.has(file)) continue;
        seenMappingFiles.add(file);

        const filePath = path.join(MC_MAPPINGS_DIR, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (data.sessionKey && typeof data.sessionKey === "string") {
            const sessionKey = data.sessionKey as string;
            pushMcSession("main", sessionKey);

            // Take file snapshot BEFORE agent processes the message
            mcFileSnapshots.set(sessionKey, snapshotGroupDir("main"));

            // Post start time as first comment on the task
            const startTime = Date.now();
            const timeStr = new Date(startTime).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });
            const containerName = lastContainerByGroup.get("main");
            void postEvent({
              runId: containerName ?? `mc-${Date.now()}`,
              action: "progress",
              sessionKey,
              agentId: getGroupName("main"),
              timestamp: new Date().toISOString(),
              message: `Task started at ${timeStr}`,
              eventType: "task:start",
            });

            console.log(`[watcher] MC_MAPPING ${file} session=${sessionKey}`);
          }

          // Clean up processed mapping file
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        } catch {
          // Malformed file, clean it up
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }
    } catch {
      // Directory read failed, try again next poll
    }
  };

  setInterval(scan, 500);
  scan(); // Initial scan
  console.log(`[watcher] Watching MC mappings: ${MC_MAPPINGS_DIR}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("[watcher] NanoClaw Watcher starting");
console.log(`[watcher] URL: ${MISSION_CONTROL_URL}`);
console.log(`[watcher] Dir: ${NANOCLAW_DIR}`);
console.log(`[watcher] Log: ${LOG_FILE}`);

if (!fs.existsSync(NANOCLAW_DIR)) {
  console.error(`[watcher] NanoClaw directory not found: ${NANOCLAW_DIR}`);
  process.exit(1);
}

tailLog();
watchMcMappings();
watchIpcMessages();

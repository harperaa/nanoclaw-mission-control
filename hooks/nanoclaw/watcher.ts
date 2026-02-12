#!/usr/bin/env node
/**
 * NanoClaw Watcher Daemon
 *
 * Standalone process that tails NanoClaw's Pino logs and polls its SQLite
 * database, translating events into webhook payloads that Mission Control
 * already understands.
 *
 * Usage:
 *   node --import tsx hooks/nanoclaw/watcher.ts
 *   # or: npx tsx hooks/nanoclaw/watcher.ts
 *
 * Environment:
 *   MISSION_CONTROL_URL  – Convex HTTP endpoint (required)
 *   NANOCLAW_DIR         – NanoClaw root dir (default: ~/nanoclaw)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MISSION_CONTROL_URL =
  process.env.MISSION_CONTROL_URL || "http://127.0.0.1:3211/nanoclaw/event";
const NANOCLAW_DIR = process.env.NANOCLAW_DIR || path.join(os.homedir(), "nanoclaw");
const LOG_FILE = path.join(NANOCLAW_DIR, "logs", "nanoclaw.log");
const DB_FILE = path.join(NANOCLAW_DIR, "store", "messages.db");
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  group: string;
  startTime: number;
  prompt?: string;
  source?: string;
  response?: string;
}

interface RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
}

interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Active runs keyed by containerName
const activeRuns = new Map<string, RunState>();

// Track the last container name per group for "Agent output" messages
// (which only include group, not containerName)
const lastContainerByGroup = new Map<string, string>();

// Track scheduled task runs by taskId
const activeTaskRuns = new Map<string, RunState>();

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
// SQLite helpers (read-only)
// ---------------------------------------------------------------------------

let db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (!db) {
    db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    db.pragma("journal_mode = WAL");
  }
  return db;
}

function getRecentPrompt(chatJid: string): string | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT content FROM messages
         WHERE chat_jid = ? AND is_from_me = 0
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(chatJid) as { content: string } | undefined;
    return row?.content ?? null;
  } catch {
    return null;
  }
}

function getRegisteredGroups(): RegisteredGroup[] {
  try {
    return getDb()
      .prepare("SELECT jid, name, folder FROM registered_groups")
      .all() as RegisteredGroup[];
  } catch {
    return [];
  }
}

function getScheduledTask(taskId: string): ScheduledTask | null {
  try {
    return (
      (getDb()
        .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
        .get(taskId) as ScheduledTask | undefined) ?? null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pino pretty log parser
// ---------------------------------------------------------------------------

// Strip ANSI escape codes
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parse a Pino pretty-printed log line.
 * Format: [HH:MM:SS.mmm] LEVEL (pid): message
 * Continuation lines:     key: value
 */
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

/**
 * Parse continuation key-value lines that follow a log message.
 * Format:     key: value
 */
function parseKeyValue(raw: string): { key: string; value: string } | null {
  const clean = stripAnsi(raw);
  const match = clean.match(/^\s{4}(\w+):\s+(.+)$/);
  if (!match) return null;
  let value = match[2];
  // Strip surrounding quotes
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

function detectSource(chatJid: string): string | null {
  if (chatJid.startsWith("tg:")) return "telegram";
  if (chatJid.includes("@s.whatsapp.net") || chatJid.includes("@g.us")) return "whatsapp";
  return null;
}

function findGroupByFolder(folder: string): RegisteredGroup | null {
  const groups = getRegisteredGroups();
  return groups.find((g) => g.folder === folder) ?? null;
}

// ---------------------------------------------------------------------------
// Log line handler — processes buffered lines
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

  // --- Processing messages → start event ---
  if (message === "Processing messages") {
    const group = kv["group"];
    const messageCount = kv["messageCount"];
    if (!group) return;

    console.log(`[watcher] Processing messages for group "${group}" (${messageCount} msgs)`);
    // Actual "start" is emitted on "Spawning container agent"
    return;
  }

  // --- Spawning container agent → start event ---
  if (message === "Spawning container agent") {
    const group = kv["group"];
    const containerName = kv["containerName"];
    if (!group || !containerName) return;

    lastContainerByGroup.set(group, containerName);

    // Look up the group's chat JID for prompt extraction
    const groupInfo = findGroupByFolder(group);
    let prompt: string | null = null;
    let source: string | null = null;

    if (groupInfo) {
      prompt = getRecentPrompt(groupInfo.jid);
      source = detectSource(groupInfo.jid);
    }

    const run: RunState = {
      runId: containerName,
      group,
      startTime: Date.now(),
      prompt: prompt ?? undefined,
      source: source ?? undefined,
    };
    activeRuns.set(containerName, run);

    void postEvent({
      runId: containerName,
      action: "start",
      sessionKey: `nanoclaw:${group}`,
      agentId: groupInfo?.name ?? group,
      timestamp: new Date().toISOString(),
      prompt,
      source,
      eventType: "lifecycle:start",
    });

    console.log(`[watcher] START ${containerName} group=${group} prompt="${(prompt ?? "").slice(0, 60)}"`);
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
          // Accumulate responses (streaming mode may produce multiple)
          run.response = run.response
            ? run.response + "\n" + responseText
            : responseText;
        }
      }
    }
    return;
  }

  // --- Container completed (both streaming and legacy mode) ---
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

    // Truncate long responses
    let response = run.response ?? null;
    if (response && response.length > 1000) {
      response = response.slice(0, 1000) + "...";
    }

    void postEvent({
      runId: run.runId,
      action: "end",
      sessionKey: `nanoclaw:${run.group}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
      timestamp: new Date().toISOString(),
      response,
      eventType: "lifecycle:end",
    });

    console.log(`[watcher] END ${containerName} duration=${duration ?? "?"}ms`);
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

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: `nanoclaw:${run.group}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
      timestamp: new Date().toISOString(),
      error: `Exit code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
      eventType: "lifecycle:error",
    });

    console.log(`[watcher] ERROR ${containerName} code=${code}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Container timeout (no output) ---
  if (message === "Container timeout, stopping gracefully" || message === "Container timed out with no output") {
    const group = kv["group"];
    const containerName = kv["containerName"] ?? (group ? lastContainerByGroup.get(group) : undefined);

    if (!containerName) return;

    const run = activeRuns.get(containerName);
    if (!run) return;

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: `nanoclaw:${run.group}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
      timestamp: new Date().toISOString(),
      error: "Container timed out",
      eventType: "lifecycle:timeout",
    });

    console.log(`[watcher] TIMEOUT ${containerName}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Container agent error (from index.ts) ---
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
      sessionKey: `nanoclaw:${run.group}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
      timestamp: new Date().toISOString(),
      error: error ?? "Container agent error",
      eventType: "lifecycle:error",
    });

    console.log(`[watcher] AGENT_ERROR ${containerName}`);
    activeRuns.delete(containerName);
    return;
  }

  // --- Running scheduled task → start ---
  if (message === "Running scheduled task") {
    const taskId = kv["taskId"];
    const group = kv["group"];
    if (!taskId) return;

    const task = getScheduledTask(taskId);
    const runId = `task-${taskId}-${Date.now()}`;

    const run: RunState = {
      runId,
      group: group ?? task?.group_folder ?? "unknown",
      startTime: Date.now(),
      prompt: task?.prompt,
    };
    activeTaskRuns.set(taskId, run);

    void postEvent({
      runId,
      action: "start",
      sessionKey: `nanoclaw:task:${taskId}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
      timestamp: new Date().toISOString(),
      prompt: task?.prompt,
      source: "scheduled",
      eventType: "task:start",
    });

    console.log(`[watcher] TASK_START ${taskId} group=${run.group}`);
    return;
  }

  // --- Task completed ---
  if (message === "Task completed") {
    const taskId = kv["taskId"];
    const durationMs = kv["durationMs"];
    if (!taskId) return;

    const run = activeTaskRuns.get(taskId);
    if (!run) return;

    void postEvent({
      runId: run.runId,
      action: "end",
      sessionKey: `nanoclaw:task:${taskId}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
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

    const run = activeTaskRuns.get(taskId);
    if (!run) return;

    void postEvent({
      runId: run.runId,
      action: "error",
      sessionKey: `nanoclaw:task:${taskId}`,
      agentId: findGroupByFolder(run.group)?.name ?? run.group,
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

    // Poll until the file appears
    const interval = setInterval(() => {
      if (fs.existsSync(LOG_FILE)) {
        clearInterval(interval);
        tailLog();
      }
    }, POLL_INTERVAL_MS);
    return;
  }

  // Start from end of file (only watch new entries)
  const stat = fs.statSync(LOG_FILE);
  let position = stat.size;
  let partialLine = "";

  // Buffered line processing: a log message may span multiple lines
  // (main line + key-value continuation lines). We buffer until we
  // see the next main log line, then process the previous block.
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

    // Is this a main log line (starts with [timestamp])?
    if (clean.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/)) {
      // Flush previous block
      flushPending();
      pendingMainLine = line;
      pendingKvLines = [];
    } else if (clean.match(/^\s{4}\w+:/)) {
      // Key-value continuation line
      pendingKvLines.push(line);
    } else {
      // Other line (banner text, blank lines) — flush and ignore
      flushPending();
    }
  }

  // Watch for changes
  const watcher = fs.watch(LOG_FILE, () => {
    try {
      const newStat = fs.statSync(LOG_FILE);

      // Log rotation: file was truncated
      if (newStat.size < position) {
        position = 0;
        partialLine = "";
        flushPending();
      }

      if (newStat.size === position) return;

      const fd = fs.openSync(LOG_FILE, "r");
      const buf = Buffer.alloc(newStat.size - position);
      fs.readSync(fd, buf, 0, buf.length, position);
      fs.closeSync(fd);
      position = newStat.size;

      const text = partialLine + buf.toString("utf-8");
      const lines = text.split("\n");

      // Last element may be a partial line (no trailing newline yet)
      partialLine = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line);
      }
    } catch (err) {
      console.error("[watcher] Error reading log:", err);
    }
  });

  // Flush any remaining block on shutdown
  process.on("SIGINT", () => {
    flushPending();
    watcher.close();
    db?.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    flushPending();
    watcher.close();
    db?.close();
    process.exit(0);
  });

  console.log(`[watcher] Tailing ${LOG_FILE} (position=${position})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("[watcher] NanoClaw Watcher starting");
console.log(`[watcher] URL: ${MISSION_CONTROL_URL}`);
console.log(`[watcher] Dir: ${NANOCLAW_DIR}`);
console.log(`[watcher] Log: ${LOG_FILE}`);
console.log(`[watcher] DB:  ${DB_FILE}`);

if (!fs.existsSync(NANOCLAW_DIR)) {
  console.error(`[watcher] NanoClaw directory not found: ${NANOCLAW_DIR}`);
  process.exit(1);
}

tailLog();

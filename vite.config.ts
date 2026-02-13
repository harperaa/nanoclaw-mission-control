import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";

const NANOCLAW_DIR = process.env.NANOCLAW_DIR || path.join(os.homedir(), "nanoclaw");
const IPC_INPUT_DIR = path.join(NANOCLAW_DIR, "data", "ipc", "main", "input");
const IPC_TASKS_DIR = path.join(NANOCLAW_DIR, "data", "ipc", "main", "tasks");
const MC_MAPPINGS_DIR = path.join(NANOCLAW_DIR, "data", "ipc", "main", ".mc-mappings");

/**
 * Read the first registered group JID from NanoClaw's available_groups.json.
 * Falls back to "main" if unavailable.
 */
function getTargetJid(): string {
	try {
		const groupsFile = path.join(NANOCLAW_DIR, "data", "ipc", "main", "available_groups.json");
		const data = JSON.parse(fs.readFileSync(groupsFile, "utf-8"));
		const groups = data?.groups;
		if (Array.isArray(groups) && groups.length > 0 && groups[0].jid) {
			return groups[0].jid;
		}
	} catch {
		// Fall through
	}
	return "main";
}

/**
 * Check if a NanoClaw container is currently running for the main group.
 * Uses ps to look for the container runtime process.
 */
function isContainerRunning(): boolean {
	try {
		const result = execSync("ps -eo args", { encoding: "utf-8", timeout: 1000 });
		return result.includes("nanoclaw-main-");
	} catch {
		return false;
	}
}

/**
 * Write a message directly to the container's IPC input directory.
 * This is the same delivery path NanoClaw uses for Telegram messages —
 * the container agent-runner polls input/ every 500ms and processes
 * messages immediately, even mid-query.
 *
 * Only used when a container is already running. The prompt is sent raw
 * (no [mc:session=...] tag) — correlation is handled via .mc-mappings/.
 */
function writeIpcInput(prompt: string): string {
	fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

	const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
	const tmpPath = path.join(IPC_INPUT_DIR, `${filename}.tmp`);
	const finalPath = path.join(IPC_INPUT_DIR, filename);

	// Instruct the agent to use send_message so the watcher can capture
	// the response text from the IPC messages/ directory.
	const wrappedPrompt = `${prompt}\n\n[Use the send_message tool to deliver your response.]`;
	fs.writeFileSync(tmpPath, JSON.stringify({ type: "message", text: wrappedPrompt }));
	fs.renameSync(tmpPath, finalPath);

	return filename.replace(".json", "");
}

/**
 * Write an MC mapping file so the watcher can correlate the response
 * back to the Mission Control task. Used for both input/ and task/ paths.
 */
function writeMcMapping(sessionKey: string): void {
	fs.mkdirSync(MC_MAPPINGS_DIR, { recursive: true });
	const mappingFile = path.join(MC_MAPPINGS_DIR, `${Date.now()}.json`);
	fs.writeFileSync(mappingFile, JSON.stringify({ sessionKey, writtenAt: Date.now() }));
}

/**
 * Write a NanoClaw IPC file to trigger a one-shot scheduled task.
 * Used as a fallback to spawn a container when none is running.
 * The IPC watcher polls this directory every ~1 second,
 * then the scheduler picks up due tasks every ~60 seconds.
 */
function writeIpcTask(prompt: string, sessionKey?: string): string {
	fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });

	// Embed session key in prompt so the watcher can correlate back to Mission Control
	const taggedPrompt = sessionKey
		? `[mc:session=${sessionKey}]\n\n${prompt}`
		: prompt;

	const targetJid = getTargetJid();
	const payload = {
		type: "schedule_task",
		prompt: taggedPrompt,
		targetJid,
		schedule_type: "once",
		// Set to now so the scheduler runs it on the next poll
		schedule_value: new Date().toISOString(),
		context_mode: "isolated",
	};

	const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
	const tmpPath = path.join(IPC_TASKS_DIR, `${filename}.tmp`);
	const finalPath = path.join(IPC_TASKS_DIR, filename);

	// Atomic write: tmp → rename prevents partial reads
	fs.writeFileSync(tmpPath, JSON.stringify(payload));
	fs.renameSync(tmpPath, finalPath);

	return filename.replace(".json", "");
}

/**
 * Collect the request body from an IncomingMessage.
 */
function collectBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "local-file-server",
			configureServer(server) {
				server.middlewares.use("/api/local-file", (req, res) => {
					const url = new URL(req.url || "", "http://localhost");
					const filePath = url.searchParams.get("path");
					if (!filePath || !filePath.startsWith("/")) {
						res.statusCode = 400;
						res.end("Missing or invalid path");
						return;
					}
					const ext = path.extname(filePath).toLowerCase();
					const mimeTypes: Record<string, string> = {
						".png": "image/png",
						".jpg": "image/jpeg",
						".jpeg": "image/jpeg",
						".gif": "image/gif",
						".svg": "image/svg+xml",
						".webp": "image/webp",
						".pdf": "application/pdf",
					};
					const contentType = mimeTypes[ext] || "application/octet-stream";
					try {
						const data = fs.readFileSync(filePath);
						res.setHeader("Content-Type", contentType);
						res.setHeader("Cache-Control", "public, max-age=3600");
						res.end(data);
					} catch {
						res.statusCode = 404;
						res.end("File not found");
					}
				});
			},
		},
		{
			name: "nanoclaw-ipc-bridge",
			configureServer(server) {
				// POST /hooks/agent — write NanoClaw IPC file to trigger agent run
				server.middlewares.use("/hooks/agent", async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
					if (req.method !== "POST") {
						next();
						return;
					}

					try {
						const body = JSON.parse(await collectBody(req));
						const { message, sessionKey } = body as {
							message?: string;
							sessionKey?: string;
							name?: string;
							wakeMode?: string;
						};

						if (!message) {
							res.statusCode = 400;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ error: "Missing 'message' field" }));
							return;
						}

						// Check NanoClaw is reachable
						if (!fs.existsSync(path.join(NANOCLAW_DIR, "data", "ipc"))) {
							res.statusCode = 503;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ error: "NanoClaw IPC directory not found" }));
							return;
						}

						// Write MC mapping for watcher correlation (both paths need it)
						if (sessionKey) {
							writeMcMapping(sessionKey);
						}

						// Deliver the prompt the same way Telegram messages reach the container:
						// - Container active: write to input/ for immediate delivery (500ms)
						// - No container: create a scheduled task to spawn one (task path only,
						//   NOT input/ — avoids double execution since the container would drain
						//   input/ at startup AND get the task prompt via stdin)
						const containerActive = isContainerRunning();

						if (containerActive) {
							const inputId = writeIpcInput(message);
							console.log(`[nanoclaw-ipc] Wrote input/${inputId} (container active) sessionKey=${sessionKey ?? "none"}`);
						} else {
							const taskId = writeIpcTask(message, sessionKey);
							console.log(`[nanoclaw-ipc] Wrote task/${taskId} (no container) sessionKey=${sessionKey ?? "none"}`);
						}

						res.statusCode = 200;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ ok: true }));
					} catch (err) {
						console.error("[nanoclaw-ipc] Error:", err);
						res.statusCode = 500;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Internal error" }));
					}
				});
			},
		},
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});

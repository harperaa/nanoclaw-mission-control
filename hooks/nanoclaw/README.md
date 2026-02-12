# NanoClaw Watcher

Standalone daemon that tails NanoClaw's logs and translates container lifecycle events into Mission Control webhook payloads.

## Quick Start

```bash
# Install as LaunchAgent (auto-starts on login)
bash hooks/nanoclaw/install.sh

# Or run manually for testing
npx tsx hooks/nanoclaw/watcher.ts
```

## How It Works

```
NanoClaw (Pino logs) → watcher.ts (tail + SQLite read) → HTTP POST → Convex → Real-time UI
```

The watcher:
1. Tails `~/nanoclaw/logs/nanoclaw.log` for container lifecycle events
2. Reads `~/nanoclaw/store/messages.db` (read-only) for prompt extraction and group metadata
3. POSTs webhook events to Mission Control's Convex HTTP endpoint

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MISSION_CONTROL_URL` | `http://127.0.0.1:3211/nanoclaw/event` | Convex HTTP endpoint |
| `NANOCLAW_DIR` | `~/nanoclaw` | NanoClaw root directory |

## LaunchAgent

After running `install.sh`, the watcher runs as:

```
~/Library/LaunchAgents/com.mission-control.nanoclaw-watcher.plist
```

Manage with:
```bash
launchctl unload ~/Library/LaunchAgents/com.mission-control.nanoclaw-watcher.plist  # stop
launchctl load ~/Library/LaunchAgents/com.mission-control.nanoclaw-watcher.plist    # start
```

Logs at: `~/Library/Logs/nanoclaw-watcher/`

## Events Tracked

| NanoClaw Log | Mission Control Action |
|-------------|----------------------|
| Spawning container agent | Task created (in_progress) |
| Agent output | Response captured |
| Container completed | Task done |
| Container error/timeout | Task moved to review |
| Running scheduled task | Scheduled task created |
| Task completed/failed | Scheduled task done/error |

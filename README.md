# Mission Control

A real-time, high-performance dashboard for managing autonomous agents and complex task queues. Built with **Convex**, **React**, and **Tailwind CSS**, Mission Control provides a "Command Center" experience for monitoring and orchestrating operations.

## Features

- **Real-time Synchronization**: Powered by Convex, every change (task moves, agent updates, comments, document creation) propagates instantly to all connected clients.
- **Agent Oversight**: Monitor the status and activity of your agent roster in real-time, with live counts in the header.
- **Mission Queue**: A kanban-style overview of tasks categorized by status: Inbox, Assigned, In Progress, Review, and Done, with selection-driven detail views.
- **Task Detail Panel**: Inspect and edit task status, descriptions, and assignees, plus quick actions like "Mark as Done" and task ID copy.
- **Resources & Deliverables**: Task-linked documents show up as structured resources with type and path metadata.
- **Comments & Activity**: Comment tracking and a live activity feed with filters for tasks, comments, docs, and status updates.
- **Secure Access**: Integrated Convex Auth for secure terminal login and management.
- **Responsive Design**: Premium, centered layout that works seamlessly across all devices.
- **NanoClaw Integration**: Automatic task tracking for NanoClaw agent runs with real-time lifecycle events.

## Tech Stack

- **Backend**: [Convex](https://convex.dev/) (Real-time Database, Functions, Auth)
- **Frontend**: [React](https://react.dev/) with [Vite](https://vitejs.dev/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Icons**: [Tabler Icons](https://tabler-icons.io/)

## Getting Started

### 1. Initial Setup
Run the following commands to install dependencies and start the development environment:

```bash
bun install
bun dev
```

### 2. Seeding Data
To populate your local dashboard with the initial roster of agents and tasks, run the seed script:

```bash
npx convex run seed:run
```

### 3. Terminal Access
1. Open the app in your browser (usually `http://localhost:5173`).
2. Use the **Sign Up** flow to create your commander credentials.
3. Access the dashboard to start monitoring operations.

## NanoClaw Integration

Mission Control integrates with [NanoClaw](https://github.com/anthropics/nanoclaw) to automatically track agent tasks in real-time.

### How It Works

```
NanoClaw Process → Pino Logs → Watcher Daemon → HTTP POST → Convex → Real-time UI
```

A standalone watcher daemon (`hooks/nanoclaw/watcher.ts`) tails NanoClaw's structured logs and polls its SQLite database, translating container lifecycle events into webhook payloads.

When a NanoClaw agent runs:
1. **Task Created** - A new task appears in the "In Progress" column with the user's prompt as the title
2. **Completion** - Task moves to "Done" with the agent's response captured
3. **Errors** - Task moves to "Review" column with error details
4. **Scheduled Tasks** - Cron/interval tasks are tracked with their own lifecycle

### Setup

#### 1. Install the Watcher Daemon

```bash
bash hooks/nanoclaw/install.sh
```

This creates a macOS LaunchAgent that automatically starts the watcher on login.

#### 2. Configure the Webhook URL

Set the `MISSION_CONTROL_URL` environment variable before running the installer, or edit the LaunchAgent plist after installation:

```bash
MISSION_CONTROL_URL="https://your-project.convex.site/nanoclaw/event" bash hooks/nanoclaw/install.sh
```

For local development (default):
```
http://127.0.0.1:3211/nanoclaw/event
```

#### 3. Verify

```bash
# Check the watcher is running
launchctl list com.mission-control.nanoclaw-watcher

# View watcher logs
tail -f ~/Library/Logs/nanoclaw-watcher/stdout.log
```

### Features

| Feature | Description |
|---------|-------------|
| **Prompt Capture** | User prompts become task titles and descriptions |
| **Duration Tracking** | Shows how long each agent run took |
| **Source Detection** | Messages from Telegram, WhatsApp, etc. show source prefix |
| **Scheduled Tasks** | Cron/interval task runs tracked with their own lifecycle |
| **Agent Matching** | NanoClaw groups map to Mission Control agents by name |

### Webhook Endpoint

The integration receives events at:

```
POST /nanoclaw/event
```

Payload format:
```json
{
  "runId": "nanoclaw-main-1707825000",
  "action": "start | end | error",
  "sessionKey": "nanoclaw:main",
  "agentId": "main",
  "prompt": "user prompt text",
  "source": "telegram",
  "response": "agent response",
  "error": "error message"
}
```

## Learn More

- [Convex Documentation](https://docs.convex.dev/)
- [React Documentation](https://react.dev/)
- [Tailwind CSS Docs](https://tailwindcss.com/)

---

*Mission Control // Secure Terminal Access // Ref: 2026*

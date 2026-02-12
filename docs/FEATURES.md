# Mission Control Dashboard Features

## Overview
Mission Control is the central operating dashboard for the NanoClaw multi-agent system. It provides a real-time interface for managing tasks, monitoring agent status, and tracking system activities.

## 1. Core Navigation & Layout
- **Dual Sidebar Layout**:
  - **Left Sidebar**: Agents Status & Roster.
  - **Right Sidebar**: Live Activity Feed.
  - **Main Area**: Mission Queue (Task Board).
- **Responsive Design**: Sidebars can be toggled; mobile-friendly drawer actions.
- **Keyboard Shortcuts**: `Escape` key closes open sidebars.
- **Authentication**: Secured via Convex Auth (Authenticated/Unauthenticated states).

## 2. Agents Sidebar (Team Roster)
Located on the left, this panel provides a real-time snapshot of the agent workforce.
- **Agent List**: Displays all registered agents.
- **Status Indicators**:
  - **Active**: Green dot/text (Working).
  - **Blocked**: Red dot/text (Needs help).
  - **Idle**: Grey dot/text.
- **Agent Metadata**:
  - **Avatar**: Visual identifier.
  - **Name & Role**: E.g., "Fury" (Product Analyst).
  - **Level Badge**:
    - `LEAD`: Leadership/Reviewer.
    - `INT`: Intermediate/Builder.
    - `SPC`: Specialist/Support.
- **Real-time Updates**: Status changes reflect immediately via Convex subscriptions.

## 3. Mission Queue (Task Management)
The central workspace for tracking work items.
- **Kanban Board Columns**:
  1. **INBOX**: New requests/unassigned items.
  2. **ASSIGNED**: Tasks picked up by or delegated to agents.
  3. **IN PROGRESS**: Currently active work.
  4. **REVIEW**: Completed work awaiting validation.
  5. **DONE**: Finished items.
- **Task Cards**:
  - **Title & Description**: Concise summary and details (truncated to 3 lines).
  - **Assignee**: Avatar/Name of the agent working on it.
  - **Tags**: Categorization (e.g., `research`, `dev`, `ui`).
  - **Time Tracking**: Relative time of last activity (e.g., "2h ago").
  - **Selection State**: Click to open detailed view; active card is highlighted with a blue ring.
  - **Visual Coding**: Border colors match task status/type.

## 4. Live Feed (Activity Log)
Located on the right, this panel tracks the "pulse" of the system.
- **Activity Stream**: Chronological list of system events (messages, status updates, task moves).
- **Filtering**:
  - **By Type**: All, Tasks, Comments, Decisions, Docs, Status.
  - **By Agent**: Filter feed to show only a specific agent's actions.
- **Live Indicator**: Visual confirmation that the system is connected and streaming.

## 5. Task Detail Panel
A focused view for a specific task (invoked by clicking a card in Mission Queue).
- **Status Management**: Move tasks between columns.
- **Full Context**: Read full description without truncation.
- **Conversation/History**: (Implied) View comments and updates specific to the task.

## 6. Authentication
- **Sign In/Out**: Secure access control.
- **Session Management**: Persistent sessions via Convex.

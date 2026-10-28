# Implementation Plan - MailSocketTactics Control Center

## 1. Overview
Build a high-performance, real-time developer control center for the multi-AI team (Claude, Codex, Antigravity) running locally on Windows. The system integrates directly with the existing Event Broker, authoritative `TEAM_MAILBOX.md`, `StateStore`, `LockManager`, and service runner.

## 2. Architecture & Design

### A. Backend Architecture Extensions
1. **Agent Registry (`src/broker/AgentRegistry.js`)**:
   - Manages and persists registered agents to `data/agent_registry.json`.
   - Seeded from `config/default.json` (Claude, Codex, Antigravity).
   - Tracks configuration, integration method (CLI, AgentAPI, MCP, Custom), capabilities, onboarding status (`draft`, `prompt_generated`, `awaiting_setup`, `configured`, `ready`, `disabled`), pause/resume task assignment, and runtime telemetry.
2. **Operational Activity Logger (`src/broker/ActivityLogger.js`)**:
   - In-memory circular buffer with persistent flush support.
   - Automatically sanitizes/redacts secret tokens (`authToken`, passwords, sensitive headers).
   - Records operational events: connections, disconnections, task lifecycle changes, mailbox scans, administrative actions, retries, DLQ events.
3. **Onboarding Prompt Generator (`src/broker/PromptGenerator.js`)**:
   - Generates project-accurate instructions incorporating repository rules, mailbox paths (`TEAM_MAILBOX.md`), message formatting, mutex rules (`Global\OneBossFightMailbox`), routing protocols, and error reporting.
   - Guaranteed zero secrets/tokens in generated prompts.
4. **Service Controller (`src/broker/ServiceController.js`)**:
   - Strictly allowlisted actions (`start`, `stop`, `restart`, `status`) on targets (`all`, `broker`, `adapters`, `watcher`).
   - Executes via Windows CIM / Node child process with real PID inspection and health check polling before confirming completion.
5. **EventBroker HTTP & Static Asset Server**:
   - Serves API routes under `/api/*`.
   - Serves pre-built Vite client static files from `client/dist/` on the broker's HTTP port (`8766`).
   - Broadcasts real-time events (`DASHBOARD_EVENT`) over WebSocket to connected dashboard clients.

### B. Frontend Architecture (React + TypeScript + Vite)
1. **Layout & Navigation**:
   - Persistent sidebar with 8 navigation items:
     - Overview
     - AI Agents
     - Task Queue
     - Mailbox
     - Message Logs
     - Activity Timeline
     - Add AI Agent
     - System Settings
   - Top navigation bar:
     - Live system health badge.
     - WebSocket connection indicator with auto-reconnect.
     - Last sync timestamp.
     - System action controls: Start, Stop, Restart (with modal confirmation).
2. **Views**:
   - **Overview**: Real-time summary cards, service health indicators, quick-filter activity feed.
   - **AI Agents**: Rich agent cards showing exact statuses (`Connected`, `Idle`, `Working`, `Waiting`, `Degraded`, `Offline`, `Unknown`), metrics, and live action buttons (Pause/Resume, Retry, Disconnect/Reconnect).
   - **Task Queue**: Real-time task grid with filtering/sorting, 9-stage lifecycle inspection drawer, retry/requeue/cancel actions.
   - **Mailbox**: Direct view of `TEAM_MAILBOX.md`, thread context, search, message composer modal with mutex-protected atomic submission.
   - **Message Logs**: Chronological log grid with redactions, filters by agent/type/result, CSV/JSON export.
   - **Activity Timeline**: High-density operational timeline.
   - **Add AI Agent Wizard**:
     - Step 1: Agent Details (name, ID, type, integration, paths, capabilities, role).
     - Step 2: Capability check (CLI execution check or API detection).
     - Step 3: Onboarding prompt generation with copy, save, regenerate, and mark-delivered actions.
     - Step 4: Registration into persistent registry.
     - Step 5: Real-time onboarding status tracking.
   - **System Settings**: Broker ports, paths, token masking, theme toggle (dark/light), diagnostic export.

### C. Testing Strategy (20 Scenarios)
1. Initial dashboard snapshot reflects backend state.
2. WebSocket events update dashboard in real-time without polling.
3. Reconnection restores snapshot and resumes event stream.
4. New mailbox message updates mailbox view and activity feed.
5. Task transitions through lifecycle states (Pending -> Claimed -> Running -> Completed).
6. Disconnected/offline agents reflect correct non-Boolean status.
7. Service start/stop/restart uses allowlisted controller.
8. Failed service operations display error feedback.
9. Unauthorized control requests return 401/403.
10. Agent onboarding enforces required fields and rejects duplicate IDs.
11. Generated onboarding prompt contains project-accurate instructions.
12. Generated onboarding prompt redacts all secrets and tokens.
13. Unsupported integrations display "Configuration required" / not falsely marked ready.
14. Newly registered agents appear immediately in registry and dashboard.
15. Filtering, searching, and CSV/JSON export work accurately.
16. Dashboard recovers from missed events via sequence numbers.
17. Service restart preserves task history and registry.
18. Dashboard functions gracefully when zero agents are connected.
19. Dashboard functions gracefully when all agents are idle.
20. Dashboard remains resilient during task failures and broker outages.

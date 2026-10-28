# MailBox Socket Tactics — Architecture & System Design

## 1. Overview
MailBox Socket Tactics is an asynchronous, event-driven coordination, notification, and monitoring framework enabling AI coding agents (**Claude**, **OpenAI Codex**, and **Google Antigravity**) to collaborate in real-time on complex software projects without wasteful polling loops.

```
+---------------------------------------------------------------------------------------------------+
|                                        Authoritative Store                                        |
|                                   Documentation/TEAM_MAILBOX.md                                   |
+---------------------------------------------------------------------------------------------------+
        ^                                                                          |
        | Atomic Write (Mutex)                                                     | fs.watch +
        | & /publish POST                                                          | Atomic Read
        |                                                                          v
+------------------+             WebSocket & HTTP (Pub/Sub)        +--------------------------------+
|  PowerShell      | <-------------------------------------------> |          Event Broker          |
|  MailboxPost     |           - Bearer Auth & Security            |     (ws://127.0.0.1:8765)      |
|  MailboxNext     |           - Recipient-Only Routing            |     (http://127.0.0.1:8766)    |
+------------------+           - Leases, Retries, DLQ              +--------------------------------+
                               - ActivityLogger & AgentRegistry                    ^
                                                                                   | Real-Time WS Events
                                                                                   v & REST API
                                                                   +--------------------------------+
                                                                   |  Control Center Web Dashboard  |
                                                                   |   React + TypeScript + Vite    |
                                                                   |     (http://127.0.0.1:8766)    |
                                                                   +--------------------------------+
                                       |
        +------------------------------+------------------------------+
        |                              |                              |
        v                              v                              v
+-------------------+          +-------------------+          +-------------------+
|   ClaudeAdapter   |          |   CodexAdapter    |          | AntigravityAdapter|
+-------------------+          +-------------------+          +-------------------+
        |                              |                              |
 claude -c -p <prompt>          codex exec <prompt>           agentapi send-message
 (shell: false)                 (shell: false)                (shell: false)
```

---

## 2. Key Components

### A. The Authoritative Message Store (`TEAM_MAILBOX.md`)
- The single source of truth for all instructions, reviews, handovers, and evidence receipts.
- All writes are append-only and serialized under the named Windows Mutex `Global\OneBossFightMailbox`.
- Sockets are used exclusively for notifications, leases, and wake-up events; they never replace the durable on-disk markdown ledger.
- If the authoritative mailbox file is missing at startup, the broker and watcher fail fast immediately rather than creating phantom or split mailboxes.

### B. The Event Broker (`src/broker/EventBroker.js`)
- **WebSocket Server (`ws://127.0.0.1:8765`):**
  - Bound strictly to localhost (`127.0.0.1`) for security.
  - Requires token authentication (`AUTH_REQUEST` / `AUTH_RESPONSE`) upon connection.
  - Enforces strict recipient authorization: clients can only subscribe to their own identity.
  - Dispatches notifications only to matching recipients; non-recipients receive zero notifications.
  - Broadcasts structured `DASHBOARD_EVENT` notifications to connected Control Center instances.
  - Maintains heartbeats (`PING` / `PONG`) every 15 seconds; drops dead connections after 35 seconds.
  - Enforces processing leases (`leaseTimeoutMs`, default 120s) to prevent duplicate execution across workers.
  - Implements exponential backoff retries and an unrecoverable Dead Letter Queue (`DLQ`).
- **HTTP API & Static Server (`http://127.0.0.1:8766`):**
  - Serves REST endpoints (`/health`, `/status`, `/api/snapshot`, `/api/agents`, `/api/tasks`, `/api/mailbox`, `/api/logs`, `/api/service/control`, `/api/prompt/generate`).
  - Serves pre-built Vite client static files from `client/dist/` for single-port browser access.

### C. Persistent Agent Registry (`src/broker/AgentRegistry.js`)
- Persisted to disk at `data/agent_registry.json`.
- Seeds from `config/default.json` with Claude, Codex, and Antigravity.
- Tracks configuration, integration method (`cli`, `agentapi`, `mcp`, `custom`), capabilities, onboarding status, and pause/resume task assignments without killing active work.

### D. Operational Activity Logger (`src/broker/ActivityLogger.js`)
- Circular in-memory buffer + append-only persistence to `data/activity_log.jsonl`.
- Automatically sanitizes and redacts access tokens, passwords, and sensitive headers.
- Supports structured querying and instant export to JSON and CSV.

### E. Service Controller (`src/broker/ServiceController.js`)
- Allowlisted operations (`start`, `stop`, `restart`, `status`) on targets (`all`, `broker`, `adapters`).
- Integrates with `ServiceControl.ps1` and `ServiceRunner.js` with real PID validation and health check polling before confirming completion.
- Zero arbitrary command execution: strictly rejects non-allowlisted actions.

### F. Team Onboarding Prompt Generator (`src/broker/PromptGenerator.js`)
- Generates project-accurate instructions incorporating repository rules, mailbox path, message format, mutex rules, and routing protocols.
- Strictly guaranteed zero secrets or credentials.

### G. Durable State Store (`src/broker/StateStore.js`)
- Persisted to disk at `data/mailbox_state.json`.
- State mutations are written atomically using temporary file writes followed by atomic replacement (`fs.renameSync`).
- Tracks for each message: status, attempt counts, lease ownership, and completion evidence hashes.

### H. Atomic Lock Manager (`src/adapters/LockManager.js`)
- Local filesystem locks placed in `.locks/<agentId>/<messageId>.lock`.
- Prevents race conditions among multiple concurrent worker instances with PID liveness verification (`process.kill(pid, 0)`).

### I. Agent Adapters (`src/adapters/`)
- All adapters execute binaries with `shell: false`:
  - **ClaudeAdapter:** Uses `claude.exe -c -p "<prompt>"`.
  - **CodexAdapter:** Uses `codex.exe exec resume --last "<prompt>"`.
  - **AntigravityAdapter:** Uses `language_server.exe agentapi send-message <id> "<prompt>"`.

---

## 3. Real-Time Telemetry & Token Efficiency
1. **Zero LLM Polling on Idle:** When no messages arrive, the adapters and broker sit entirely dormant. Only lightweight TCP keep-alives occur. Zero AI models or CLI processes are invoked.
2. **Targeted Dispatch:** A message addressed to Claude wakes *only* Claude. Codex and Antigravity remain completely asleep.
3. **Reactive Dashboard:** The web UI receives instant WebSocket events and maintains synchronization with the authoritative state store without aggressive client polling.

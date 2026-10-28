# MailBox Socket Tactics — Architecture & System Design

## 1. Overview
MailBox Socket Tactics is an asynchronous, event-driven coordination and notification framework enabling AI coding agents (**Claude**, **OpenAI Codex**, and **Google Antigravity**) to collaborate in real-time on complex software projects without wasteful polling loops.

```
+--------------------------------------------------------------------------------+
|                             Authoritative Store                                |
|                        Documentation/TEAM_MAILBOX.md                           |
+--------------------------------------------------------------------------------+
        ^                                                                |
        | Atomic Write (Mutex)                                           | fs.watch +
        | & /publish POST                                                | Atomic Read
        |                                                                v
+------------------+       WebSocket (Pub/Sub)        +--------------------------+
|  PowerShell      | <------------------------------> |      Event Broker        |
|  MailboxPost     |     - Bearer Auth & Security     |   (ws://127.0.0.1:8765)  |
|  MailboxNext     |     - Recipient-Only Routing     |   (http://127.0.0.1:8766)|
+------------------+     - Leases, Retries, DLQ       +--------------------------+
                                                                 |
                               +---------------------------------+---------------------------------+
                               |                                 |                                 |
                               v                                 v                                 v
                     +-------------------+             +-------------------+             +-------------------+
                     |   ClaudeAdapter   |             |   CodexAdapter    |             | AntigravityAdapter|
                     +-------------------+             +-------------------+             +-------------------+
                               |                                 |                                 |
                      claude -c -p <prompt>             codex exec <prompt>              agentapi send-message
                      (shell: false)                    (shell: false)                   (shell: false)
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
  - Maintains heartbeats (`PING` / `PONG`) every 15 seconds; drops dead connections after 35 seconds.
  - Enforces processing leases (`leaseTimeoutMs`, default 120s) to prevent duplicate execution across workers.
  - Implements exponential backoff retries and an unrecoverable Dead Letter Queue (`DLQ`).
- **HTTP API Server (`http://127.0.0.1:8766`):**
  - `GET /health` and `GET /status`: Returns JSON diagnostics, active leases, completed counts, metrics, and connected agent list.
  - `POST /publish`: Immediate event trigger invoked by `MailboxPostSocket.ps1` upon appending to the mailbox.
  - `POST /requeue`: Administrative endpoint to resurrect tasks from the Dead Letter Queue.
- **Mailbox Watcher (`src/broker/MailboxWatcher.js`):**
  - Monitors the directory with Node `fs.watch` and debounced reads.
  - Retries transient file locks when another process holds write handles.
  - Parses message headings and deduplicates seen message IDs.

### C. Durable State Store (`src/broker/StateStore.js`)
- Persisted to disk at `data/mailbox_state.json`.
- State mutations are written atomically using temporary file writes followed by atomic replacement (`fs.renameSync`).
- Tracks for each message:
  - Status: `PENDING`, `CLAIMED`, `RUNNING`, `COMPLETED`, `RETRYABLE_FAILED`, `DEAD_LETTER`.
  - Attempt counts and maximum retry limits.
  - Lease ownership (`workerId`), lease acquisition timestamp, and lease expiry.
  - Completion evidence (hash, timestamp, worker).
- On startup, `reconcileAbandonedTasks()` checks in-flight tasks whose lease expired while offline, resetting them to retryable failure or pending.

### D. Atomic Lock Manager (`src/adapters/LockManager.js`)
- Local filesystem locks placed in `.locks/<agentId>/<messageId>.lock`.
- Prevents race conditions among multiple concurrent worker instances.
- Verifies worker process liveness using PID checks (`process.kill(pid, 0)`).
- Reclaims stale locks left behind by crashed processes.

### E. Agent Adapters (`src/adapters/`)
- **`BaseAgentAdapter.js`:**
  - Connects to broker, auto-reconnects with exponential backoff on network failure.
  - Validates recipient matching: rejects messages intended for other agents.
  - Acquires atomic local filesystem lease locks (`.locks/<agentId>/<messageId>.lock`).
  - Retrieves and validates the authoritative message from `TEAM_MAILBOX.md`.
  - Performs catch-up on reconnection to discover unhandled messages without continuous polling.
  - Dispatches periodic lease renewal heartbeats (`LEASE_RENEW`) to prevent timeout on long tasks.
- **`ClaudeAdapter.js`:**
  - Wakes Claude via Claude Code CLI (`claude -c -p "<prompt>"` or `--session-id`).
  - Spawns process directly with `shell: false`.
- **`CodexAdapter.js`:**
  - Wakes Codex via Codex CLI (`codex exec resume --last "<prompt>"` or `codex exec "<prompt>"`).
  - Spawns process directly with `shell: false`.
- **`AntigravityAdapter.js`:**
  - Wakes Antigravity via Antigravity native CLI (`language_server.exe agentapi send-message <id> "<prompt>"` or `new-conversation`).
  - Spawns process directly with `shell: false`.
  - Distinguishes API message acceptance from actual task completion.

---

## 3. Shell-Less Security (`shell: false`)
All agent process invocations pass `shell: false` to Node.js `child_process.spawn()`. Prompts and arguments are transferred directly into argv vectors or via standard input. Arbitrary characters, semicolons, backticks, pipes, and shell redirects in mailbox messages are treated as inert strings, completely preventing command injection.

---

## 4. Token & Resource Efficiency
1. **Zero LLM Polling on Idle:** When no messages arrive, the adapters and broker sit entirely dormant. Only lightweight TCP keep-alives occur. Zero AI models or CLI processes are invoked.
2. **Targeted Dispatch:** A message addressed to Claude wakes *only* Claude. Codex and Antigravity remain completely asleep.
3. **Idempotent Delivery:** Once a message is processed, subsequent notifications or catch-up sweeps ignore the ID, preventing redundant prompt submissions.

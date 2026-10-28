# MailBox Socket Tactics — Message & Event Protocol

## 1. Mailbox Heading Format (On Disk)
All messages in `Documentation/TEAM_MAILBOX.md` adhere strictly to the established format:
```markdown
### [<Party>-<Number>] <SenderName> -> <RecipientName>, <Timestamp>
TASK: ...
STATUS: ...
FINDINGS: ...
DECISION NEEDED: ...
NEXT ACTION: ...
VALIDATION: ...
```
- `<Party>`:
  - `C`: Claude (Tech Lead / Principal Architect)
  - `X`: OpenAI Codex (Technical Lead / Independent Critic)
  - `A`: Google Antigravity (Senior C++ Implementer & Unreal Expert)
  - `H`: Human Owner
- `<RecipientName>`: Can be an individual agent (`Claude`, `Codex`, `Antigravity`), multiple recipients (`Claude,Codex,Owner`), or team-wide (`All`, `Team`).

---

## 2. WebSocket Event Protocol (JSON)

### A. Authentication Handshake
1. Client connects to `ws://127.0.0.1:8765`.
2. Client sends `AUTH_REQUEST`:
```json
{
  "type": "AUTH_REQUEST",
  "agentId": "Claude",
  "token": "mailbox-socket-secret-token"
}
```
3. Broker responds with `AUTH_RESPONSE`:
```json
{
  "type": "AUTH_RESPONSE",
  "success": true,
  "agentId": "Claude"
}
```
If token is invalid or expires before auth within 10s, broker closes the socket.

### B. Channel Subscriptions
Client sends `SUBSCRIBE`:
```json
{
  "type": "SUBSCRIBE",
  "channels": ["Claude"]
}
```
Broker validates that the agent is authorized to subscribe to the requested channel(s), records granted channels, and responds with `SUBSCRIBE_ACK`:
```json
{
  "type": "SUBSCRIBE_ACK",
  "grantedChannels": ["claude"]
}
```

### C. Heartbeats
1. Broker periodically (default 15s) sends `PING`:
```json
{
  "type": "PING",
  "timestamp": "2026-10-28T16:30:00.000Z"
}
```
2. Client responds with `PONG`:
```json
{
  "type": "PONG",
  "agentId": "Claude"
}
```

### D. Message Notification (`MAILBOX_MESSAGE_NOTIFY`)
When a new message is appended to the mailbox, broker delivers minimal routing metadata to matching subscribers:
```json
{
  "type": "MAILBOX_MESSAGE_NOTIFY",
  "messageId": "X-274",
  "party": "X",
  "number": 274,
  "sender": "Codex",
  "recipientRaw": "Claude",
  "timestamp": "2026-10-28 16:30",
  "mailboxPath": "C:\\UnrealProject\\OneBossFight\\Documentation\\TEAM_MAILBOX.md"
}
```
*Note: The payload contains only routing metadata. The recipient adapter retrieves and validates the authoritative message text from `TEAM_MAILBOX.md`.*

### E. Lease Renewals (`LEASE_RENEW`)
For long-running tasks, the agent adapter periodically sends heartbeats to extend its lease:
```json
{
  "type": "LEASE_RENEW",
  "messageId": "X-274",
  "agentId": "Claude",
  "workerId": "Claude-1234-179318-abcde",
  "timestamp": "2026-10-28T16:31:00.000Z"
}
```
The broker extends `leaseExpiresAt` by `leaseTimeoutMs`, preventing premature task reassignment.

### F. Acknowledgements & Processing Lifecycle (`MESSAGE_ACK`)
The agent adapter reports status transitions to the broker:
```json
{
  "type": "MESSAGE_ACK",
  "messageId": "X-274",
  "agentId": "Claude",
  "workerId": "Claude-1234-179318-abcde",
  "status": "CLAIMED | RUNNING | COMPLETED | FAILED",
  "error": null,
  "timestamp": "2026-10-28T16:30:05.000Z"
}
```

Status lifecycle:
1. `CLAIMED`: Adapter acquired atomic filesystem lock and claimed message from broker.
2. `RUNNING`: Authoritative message verified; agent CLI/API invoked.
3. `COMPLETED`: Agent finished execution, recorded evidence, and released lock.
4. `FAILED`: Execution threw an error. Broker records retry attempt; after max retries (default 3), routes message to `DEAD_LETTER`.

---

## 3. Retries, Leases, and Dead-Letter Queue (DLQ)
- **Lease Timeout:** Each active processing lease defaults to 120 seconds. If an adapter dies without sending `COMPLETED` or `FAILED`, the broker automatically expires the lease and re-dispatches the task.
- **Exponential Backoff:** Retries back off according to `backoffInitialMs * 2^(retryCount - 1)`.
- **Dead Letter Queue:** Messages exceeding max retries are quarantined with their failure logs in the DLQ and can be inspected via `GET /status`.

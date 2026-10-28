# MailSocketTactics Control Center — API Reference

This document specifies the REST HTTP endpoints and WebSocket events exposed by the local Event Broker (`http://127.0.0.1:8766` and `ws://127.0.0.1:8765`).

---

## 1. Authentication
Administrative and state-modifying endpoints require a Bearer token:
```http
Authorization: Bearer <AUTH_TOKEN>
```
Default token: `mailbox-socket-secret-token` (configurable via `config/default.json` or `MAILBOX_AUTH_TOKEN` environment variable).

---

## 2. REST Endpoints

### A. Health & Status

#### `GET /health` or `GET /status`
- **Auth:** None (read-only diagnostics).
- **Response (200 OK):**
```json
{
  "status": "UP",
  "timestamp": "2026-10-28T12:00:00.000Z",
  "metrics": {
    "connectionsAccepted": 5,
    "authFailures": 0,
    "notificationsSent": 12,
    "acksReceived": 10,
    "renewalsReceived": 2,
    "retriesTriggered": 0,
    "deadLettersCount": 0
  },
  "activeTasks": [],
  "completedCount": 8,
  "deadLetterCount": 0,
  "connectedAgents": [
    { "agentId": "Claude", "subscriptions": ["claude"], "connectedAt": "..." }
  ]
}
```

#### `GET /api/snapshot`
- **Auth:** Recommended (returns redacted operational summary).
- **Response (200 OK):**
Returns complete system snapshot containing:
- `broker`: host, port, uptime, metrics, lastError.
- `services`: brokerRunning, watcherRunning, watcherPath, stateStoreHealthy.
- `mailbox`: path, exists, totalMessages, messages (last 50).
- `agents`: full list of registered agents merged with live telemetry.
- `tasks`: all tracked tasks in StateStore, counts (pending, running, completed, deadLetters).
- `logs`: recent 100 sanitized activity events.

---

### B. Agent Management

#### `GET /api/agents`
- **Auth:** None.
- **Response (200 OK):** Array of registered agent configurations.

#### `POST /api/agents`
- **Auth:** Required (`Bearer`).
- **Request Body:**
```json
{
  "id": "DeepSeek",
  "displayName": "DeepSeek Coder",
  "partyCode": "D",
  "vendor": "DeepSeek",
  "integrationMethod": "cli",
  "cliCommand": "deepseek.exe",
  "cliArgs": ["-c", "-p"],
  "role": "Code Optimization Specialist",
  "capabilities": ["c++", "optimization"]
}
```
- **Response (201 Created):** `{ "success": true, "agent": { ... } }`
- **Errors:** 400 Bad Request if ID is missing or duplicate.

#### `PATCH /api/agents/:id`
- **Auth:** Required (`Bearer`).
- **Request Body:** Updates e.g. `{ "paused": true }` or `{ "enabled": false }`.
- **Response (200 OK):** `{ "success": true, "agent": { ... } }`

#### `POST /api/agents/:id/test`
- **Auth:** None.
- **Response (200 OK):**
```json
{
  "agentId": "Claude",
  "capable": true,
  "status": "Verified",
  "details": "Executable found at C:\\Users\\...\\claude.exe"
}
```

---

### C. Task Queue

#### `GET /api/tasks`
- **Auth:** None.
- **Query Params:** `?status=RUNNING&agent=Claude`
- **Response (200 OK):** `{ "tasks": [ ... ] }`

#### `POST /requeue`
- **Auth:** Required (`Bearer`).
- **Request Body:** `{ "messageId": "X-10" }`
- **Response (200 OK):** `{ "success": true, "messageId": "X-10" }`

#### `POST /api/tasks/:id/cancel`
- **Auth:** Required (`Bearer`).
- **Response (200 OK):** `{ "success": true, "taskId": "X-10" }`

---

### D. Mailbox Operations

#### `GET /api/mailbox`
- **Auth:** None.
- **Response (200 OK):** `{ "total": 24, "messages": [ ... ] }`

#### `POST /api/mailbox/post`
- **Auth:** Required (`Bearer`).
- **Request Body:**
```json
{
  "as": "H",
  "to": "Claude",
  "body": "TASK: Build new combat balance metrics\nSTATUS: IN_PROGRESS"
}
```
- **Response (200 OK):** `{ "success": true, "output": "POSTED H-4" }`

---

### E. Logs & Telemetry

#### `GET /api/logs`
- **Auth:** None.
- **Query Params:** `format=json|csv`, `agent=Claude`, `type=TASK_COMPLETED`, `level=INFO|WARN|ERROR`, `limit=200`
- **Response (200 OK):** JSON array or CSV attachment.

---

### F. Service Control

#### `POST /api/service/control`
- **Auth:** Required (`Bearer`).
- **Request Body:**
```json
{
  "action": "start | stop | restart | status",
  "target": "all | broker | adapters"
}
```
- **Response (200 OK):** `{ "success": true, "result": { ... } }`
- **Errors:** 400 Bad Request for disallowed actions or targets.

---

### G. Onboarding Prompt Generator

#### `POST /api/prompt/generate`
- **Auth:** None.
- **Request Body:** Agent metadata.
- **Response (200 OK):** `{ "success": true, "prompt": "..." }`
- **Guarantee:** Strict zero-secret policy (no passwords, tokens, or credentials).

---

## 3. Real-Time WebSocket Events

Connect to `ws://127.0.0.1:8765`.

### Client Handshake
1. Client sends:
```json
{ "type": "AUTH_REQUEST", "agentId": "Dashboard", "token": "mailbox-socket-secret-token" }
```
2. Broker replies:
```json
{ "type": "AUTH_RESPONSE", "success": true, "agentId": "Dashboard" }
```
3. Client subscribes:
```json
{ "type": "SUBSCRIBE", "channels": ["dashboard"] }
```

### Server Broadcast (`DASHBOARD_EVENT`)
```json
{
  "type": "DASHBOARD_EVENT",
  "eventType": "AGENT_STATUS_CHANGE | TASK_LIFECYCLE | MAILBOX_MESSAGE | SERVICE_ACTION | AGENT_REGISTERED",
  "data": { ... },
  "timestamp": "2026-10-28T12:00:00.000Z"
}
```

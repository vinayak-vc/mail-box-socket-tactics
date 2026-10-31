# MailSocketTactics — Shared MCP Server Integration Guide

## 1. Overview & Architecture

The **MailSocketTactics Shared MCP Server** (`src/mcp/McpServer.js`) implements the standard Model Context Protocol (MCP) over standard input/output (`stdio`) using JSON-RPC 2.0. It exposes authorized mailbox and task-management tools, documentation resources, and onboarding prompts to compatible desktop AI assistants:
- **Claude Desktop**
- **OpenAI Codex Desktop**
- **Google Antigravity Desktop**

All three desktop applications interact with the **same underlying project domain services**, reading and appending to the single authoritative mailbox (`TEAM_MAILBOX.md`) and tracking task lifecycle state in `mailbox_state.json`.

```
                    ┌───────────────────────────────┐
                    │       AI Desktop Clients       │
                    │ Claude  │  Codex  │Antigravity│
                    └────┬─────────┬───────────┬────┘
                         │ stdio   │ stdio     │ stdio / native
                         ▼         ▼           ▼
                    ┌───────────────────────────────┐
                    │    Shared MCP Server (stdio)  │
                    │     (src/mcp/McpServer.js)    │
                    └──────────────┬────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────┐
                    │      Domain Service Layer     │
                    │   Mailbox │ Task │ Agent │ Usage   │
                    └──────────────┬────────────────┘
                                   │
          ┌────────────────────────┴────────────────────────┐
          ▼                                                 ▼
┌───────────────────┐                             ┌───────────────────┐
│  TEAM_MAILBOX.md  │ (Authoritative Markdown)   │mailbox_state.json │ (Durable Task State)
└───────────────────┘                             └───────────────────┘
```

---

## 2. Process-Bound Identity Enforcement

To prevent identity spoofing and cross-agent execution conflicts, each MCP process binds its identity strictly upon launch:
- Via command-line argument: `--agent Claude` (or `--agent Codex`, `--agent Antigravity`)
- Or environment variable: `MCP_AGENT_ID=Claude`

The bound identity cannot be overridden by tool parameters. For example:
- `get_my_identity` reports only the bound agent's verified ID and party code.
- `get_pending_messages` only returns messages addressed specifically to that agent.
- `claim_message` verifies that the requesting agent is an authorized recipient; any attempt to claim another agent's task is rejected with an `Unauthorized` error.
- `send_message` automatically sets the sender (`As`) to the bound agent's party code (`C`, `X`, or `A`).

---

## 3. Desktop Execution Realities & Boundaries

> [!IMPORTANT]
> **MCP Tool Call Execution Lifecycle in Desktop Applications:**
> - In desktop applications (Claude Desktop, Codex Desktop), MCP tools execute **synchronously within an active conversation turn**.
> - An MCP server running via `stdio` cannot autonomously wake up a closed or completely idle desktop application without a user turn or external prompt.
> - The `wait_for_message` tool provides **bounded waiting** (default 30 seconds, maximum 120 seconds). When invoked during a conversation turn, it holds the connection open, returning immediately when a new message arrives, or returning a clean `{ timeout: true, message: null }` status upon expiration.
> - Continuous background polling or unattended execution remains the role of the headless adapters and Windows service daemon (`src/service/ServiceRunner.js`), while the MCP server empowers interactive desktop sessions to participate in the exact same workflow seamlessly.

---

## 4. MCP Tools Reference (15 Tools)

| Tool Name | Parameters | Description |
|---|---|---|
| `get_team_status` | *(none)* | Returns operational status of the AI team, system health, task counts, and broker status. |
| `get_my_identity` | *(none)* | Returns verified agent ID, party code (`C`/`X`/`A`), role, and capabilities. |
| `get_pending_messages` | `limit` (opt) | Retrieves unclaimed pending messages addressed to this agent from `TEAM_MAILBOX.md`. |
| `get_message` | `messageId` | Retrieves a specific message by ID (e.g. `X-1`, `C-2`). |
| `wait_for_message` | `timeoutSeconds` (opt) | Bounded wait for incoming messages (1–120s). Returns message or timeout. |
| `claim_message` | `messageId`, `leaseMs` (opt) | Atomically claims an eligible message before execution. Prevents duplicate work. |
| `acknowledge_message` | `messageId`, `status` (opt) | Records delivery acknowledgement (`CLAIMED` or `RUNNING`) without marking completed. |
| `send_message` | `to`, `body` | Appends a message to `TEAM_MAILBOX.md` under mutex via `MailboxPostSocket.ps1`. |
| `update_task_status` | `messageId`, `status`, `details` (opt) | Updates task execution state (`RUNNING`, `FAILED`, etc.). |
| `complete_task` | `messageId`, `evidence` (opt), `responseMessageId` (opt) | Atomically marks task completed with verifiable evidence. |
| `fail_task` | `messageId`, `error`, `isPermanent` (opt) | Records failure, increments attempt counter, and evaluates retry eligibility. |
| `get_task_history` | `messageId` | Returns the complete lifecycle event history and timestamps for a task. |
| `get_message_history` | `limit` (opt) | Returns conversation history involving this agent. |
| `get_agent_status` | `agentId` (opt) | Inspects the configuration and online status of any team member. |
| `heartbeat` | *(none)* | Confirms active connectivity and timestamps agent activity. |
| `send_owner_email` | `subject`, `message`, `urgency` (opt), `taskReference` (opt) | Sends an email notification directly to the Human Owner via Brevo transactional email. Use for urgent blockers, decisions needed, or critical milestones. |

---

## 5. MCP Resources & Prompts

### Resources
- `mailsocket://protocol`: Complete team communication protocol, message formats, and rules.
- `mailsocket://roles`: AI team roles & responsibilities (Claude = Tech Lead/Architect, Codex = Critic/Validator, Antigravity = C++ Gameplay Implementer, Owner = Direction).
- `mailsocket://schemas`: JSON schemas for mailbox parsing, message formats, and lifecycle states.

### Prompts
- `team_onboarding`: Generates customized, secret-free onboarding instructions tailored specifically to the requesting agent. Never exposes auth tokens or passwords.

---

## 6. Desktop Application Configuration

### Claude Desktop
Config file: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mailsocket-claude": {
      "command": "node",
      "args": [
        "C:\\UnrealProject\\MailBoxSocketTactics\\src\\mcp\\McpServer.js",
        "--agent",
        "Claude"
      ],
      "env": {
        "MAILBOX_PATH": "C:\\UnrealProject\\Documentation\\TEAM_MAILBOX.md"
      }
    }
  }
}
```

### Codex Desktop
Config file: `C:\Users\Rushit Vaghela\.codex\config.toml`

```toml
[mcp_servers.mailsocket]
command = "node"
args = [
    "C:/UnrealProject/MailBoxSocketTactics/src/mcp/McpServer.js",
    "--agent",
    "Codex",
]
startup_timeout_sec = 60

[mcp_servers.mailsocket.env]
MAILBOX_PATH = "C:/UnrealProject/Documentation/TEAM_MAILBOX.md"
```

### Google Antigravity Desktop
Tool schemas located in:
`C:\Users\Rushit Vaghela\.gemini\antigravity\mcp\mailsocket\`

---

## 7. Verification & Automated Testing

Run the full MCP test suite:
```bash
node tests/test_mcp_suite.js
```

Or run all project test suites:
```bash
npm run test:all
```

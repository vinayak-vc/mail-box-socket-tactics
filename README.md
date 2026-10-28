# MailBox Socket Tactics: Event-Driven Multi-AI Coordination Framework & Control Center

A real-time, event-driven socket notification architecture and rich desktop Control Center enabling **Claude (Tech Lead)**, **OpenAI Codex (Technical Lead / Independent Critic)**, and **Google Antigravity (Senior C++ Implementer)** to coordinate asynchronously without wasteful periodic polling loops.

---

## 1. Quickstart & Control Center

### One-Click Launch (Complete System + Dashboard)
Double click:
- `scripts\StartDashboard.bat`

Or run via terminal:
```powershell
npm start
```
Then open your browser at:
```text
http://127.0.0.1:8766/
```

### Development Mode (Vite Live Reload)
```cmd
cd client
npm run dev
```
Accessible at `http://127.0.0.1:5173/` (proxies `/api` and `/ws` to the local backend).

---

## 2. Dashboard Features & Layout

The **MailSocketTactics Control Center** is a desktop-focused web application built with **React**, **TypeScript**, and **Vite**, connecting in real-time to the Event Broker via WebSocket and REST APIs:

1. **Overview Dashboard:** Live summary cards (broker status, active/executing/idle agents, task queues, DLQ), service stack health, and real-time operational activity feed.
2. **AI Agents:** Real-time agent status cards (`Connected`, `Idle`, `Working`, `Waiting`, `Degraded`, `Offline`, `Disabled`, `Paused`), active task execution tracking, task counters, pause/resume assignment toggles (without killing running work), and capability checks.
3. **Task Queue:** Comprehensive task grid with status filters, detailed drawer inspection with **9-Step Lifecycle Stepper**, retry/requeue actions, and cancel controls.
4. **Mailbox:** Direct live viewer of the authoritative `TEAM_MAILBOX.md` file, sender/recipient filtering, thread context, and atomic message composer protected under the named mutex `Global\OneBossFightMailbox`.
5. **Message Logs:** Chronological operational dispatch log with automatic secret/token redaction, filters by level/type, and one-click JSON/CSV export.
6. **Activity Timeline:** High-density event stream of connections, claims, leases, and transitions.
7. **Add AI Agent Wizard:** 5-step guided wizard to onboard future AI coding agents:
   - Step 1: Agent Details & ID validation.
   - Step 2: Capability check & real environment detection.
   - Step 3: Team onboarding prompt generation (project-accurate, zero secrets, copy/download).
   - Step 4: Persistent registration to `data/agent_registry.json`.
   - Step 5: Onboarding status lifecycle tracking.
8. **System Settings:** Network ports, auth token masking, mutex configuration, and system snapshot export.
9. **AI Usage & Quota Monitor:** Section 11 transparent monitoring tracking task counts, compute duration, token volumes, and quota states (`Available`, `Estimated`, `Unavailable`, `Stale`) with explicit zero-scrape declarations.

---

## 3. Shared MCP Server Integration

MailSocketTactics includes a single, reusable **Model Context Protocol (MCP)** server (`src/mcp/McpServer.js`) over `stdio` implementing JSON-RPC 2.0. It exposes 15 authorized mailbox and task tools, 3 protocol resources, and custom onboarding prompts to:
- **Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`)
- **Codex Desktop** (`C:\Users\<User>\.codex\config.toml`)
- **Google Antigravity Desktop** (`.gemini/antigravity/mcp/mailsocket/`)

See [`Documentation/MCP_GUIDE.md`](file:///C:/UnrealProject/MailBoxSocketTactics/Documentation/MCP_GUIDE.md) for full configuration blocks, tool parameters, and desktop execution boundaries.

---

## 4. Directory Layout

```text
MailBoxSocketTactics/
├── config/
│   ├── default.json                  # Broker, mailbox, and agent configuration
│   └── .env.example                  # Environment variable secrets template
├── client/                           # React + TypeScript + Vite Dashboard
│   ├── src/
│   │   ├── components/               # Sidebar, TopNav
│   │   ├── views/                    # Overview, Agents, Tasks, Mailbox, Logs, AddAgent, AiUsage, Settings
│   │   ├── api.ts                    # Real-time WebSocket & REST client
│   │   └── types.ts                  # Shared data schemas
│   ├── dist/                         # Pre-built static UI assets (served on :8766)
│   └── vite.config.ts
├── src/
│   ├── domain/                       # Shared business logic & domain services
│   │   ├── MailboxDomainService.js   # Mailbox parsing, recipient routing & atomic writes
│   │   ├── TaskDomainService.js      # Claims, lifecycle transitions, retries & completion
│   │   ├── AgentDomainService.js     # Agent registry, pause/resume & secret-free onboarding
│   │   ├── UsageDomainService.js     # Compute duration, token metrics & quota confidence
│   │   └── index.js                  # Central domain service container
│   ├── mcp/
│   │   └── McpServer.js              # Standard JSON-RPC 2.0 stdio MCP server for Desktop apps
│   ├── broker/
│   │   ├── EventBroker.js            # WebSocket & HTTP Event Broker daemon with API routes
│   │   ├── AgentRegistry.js          # Persistent data/agent_registry.json manager
│   │   ├── ActivityLogger.js         # Secret-sanitized operational logger (JSONL/CSV)
│   │   ├── ServiceController.js      # Allowlisted service management (start/stop/restart)
│   │   ├── PromptGenerator.js        # Project-accurate team onboarding prompt generator
│   │   └── MailboxWatcher.js         # Durable TEAM_MAILBOX.md watcher with lock retries
│   ├── protocol/
│   │   └── MessageProtocol.js        # Heading parser, recipient matching, event types
│   ├── adapters/
│   │   ├── BaseAgentAdapter.js       # Base client with reconnect, lease locks & catch-up
│   │   ├── ClaudeAdapter.js          # Claude Code CLI integration (claude -c -p)
│   │   ├── CodexAdapter.js           # OpenAI Codex CLI integration (codex exec)
│   │   └── AntigravityAdapter.js     # Google Antigravity integration (agentapi)
│   └── service/
│       └── ServiceRunner.js          # Service daemon & CLI runner (--all, --status, --stop)
├── scripts/
│   ├── MailboxNextSocket.ps1         # Event-driven drop-in replacement for MailboxNext.ps1
│   ├── MailboxPostSocket.ps1         # Atomic append & sub-15ms event publisher
│   ├── ServiceControl.ps1            # Start, stop, restart, inspect status
│   ├── SetupWindowsStartup.ps1       # Configure auto-start at Windows boot / logon
│   ├── StartDashboard.bat            # 1-click launcher for Control Center
│   ├── StartEventBroker.bat          # 1-click batch launcher for Event Broker
│   └── StartAdapters.bat             # 1-click batch launcher for Agent Adapters
├── tests/
│   ├── test_suite.js                 # 20/20 automated broker/adapter verification suite
│   ├── test_dashboard_suite.js       # 20/20 automated Control Center verification suite
│   ├── test_zrok_suite.js            # 5/5 automated zrok public tunneling suite
│   ├── test_domain_suite.js          # 12/12 automated domain services suite
│   ├── test_mcp_suite.js             # 13/13 automated MCP protocol & tool suite
│   └── test_powershell_integration.ps1 # 5/5 end-to-end PowerShell script tests
└── Documentation/
    ├── ARCHITECTURE.md               # System architecture and data flow diagrams
    ├── MCP_GUIDE.md                  # Comprehensive desktop MCP integration guide
    ├── API_REFERENCE.md              # REST & WebSocket API specification
    ├── MESSAGE_PROTOCOL.md           # Event specifications, lease lifecycles, DLQ
    ├── MIGRATION_GUIDE.md            # Step-by-step migration from 300s polling
    └── VERIFICATION_REPORT.md        # Comprehensive test execution evidence
```

---

## 5. Verification & Testing

Run all automated test suites:
```cmd
npm run test:all
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_powershell_integration.ps1
```

- **Broker / Adapter Suite (`tests/test_suite.js`):** 20/20 Passed
- **Control Center Suite (`tests/test_dashboard_suite.js`):** 20/20 Passed
- **Zrok Dual-Mode Suite (`tests/test_zrok_suite.js`):** 5/5 Passed
- **Domain Services Suite (`tests/test_domain_suite.js`):** 12/12 Passed
- **Shared MCP Suite (`tests/test_mcp_suite.js`):** 13/13 Passed
- **PowerShell Integration Suite (`tests/test_powershell_integration.ps1`):** 5/5 Passed
- **Total:** **75 / 75 deterministic tests passing.**

---

## 6. Windows Service Commands

| Action | PowerShell Command |
|---|---|
| **Start Service** | `powershell -File scripts\ServiceControl.ps1 -Action start -Mode all` |
| **Stop Service** | `powershell -File scripts\ServiceControl.ps1 -Action stop` |
| **Restart Service** | `powershell -File scripts\ServiceControl.ps1 -Action restart -Mode all` |
| **Inspect Status** | `powershell -File scripts\ServiceControl.ps1 -Action status` |
| **Enable Windows Auto-Start** | `powershell -File scripts\SetupWindowsStartup.ps1` |
| **Disable Windows Auto-Start** | `powershell -File scripts\SetupWindowsStartup.ps1 -RemoveTask` |

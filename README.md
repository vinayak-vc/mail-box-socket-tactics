# MailBox Socket Tactics: Event-Driven Multi-AI Coordination Framework

A real-time, event-driven socket notification architecture enabling **Claude (Tech Lead)**, **OpenAI Codex (Technical Lead / Independent Critic)**, and **Google Antigravity (Senior C++ Implementer)** to coordinate asynchronously without wasteful periodic polling loops.

---

## 1. Quickstart

### Step 1: Start the Event Broker & Adapters
Run via PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\ServiceControl.ps1 -Action start -Mode all
```
Or double-click:
- `scripts\StartEventBroker.bat`
- `scripts\StartAdapters.bat`

### Step 2: Inspect Status & Metrics
```powershell
powershell -ExecutionPolicy Bypass -File scripts\ServiceControl.ps1 -Action status
```
Or query the HTTP API endpoint directly in your browser or curl:
```text
http://127.0.0.1:8766/status
```

### Step 3: Run Automated Tests
```cmd
npm test
```
Or:
```cmd
node tests\test_suite.js
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_powershell_integration.ps1
```
All **20/20 test suite scenarios** and **5/5 PowerShell integration tests** run and pass deterministically.

---

## 2. Directory Layout

```text
MailBoxSocketTactics/
├── config/
│   ├── default.json                  # Broker, mailbox, and agent configuration
│   └── .env.example                  # Environment variable secrets template
├── src/
│   ├── broker/
│   │   ├── EventBroker.js            # WebSocket & HTTP Event Broker daemon
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
│   ├── StartEventBroker.bat          # 1-click batch launcher for Event Broker
│   └── StartAdapters.bat             # 1-click batch launcher for Agent Adapters
├── tests/
│   ├── test_suite.js                 # 20/20 automated scenario verification suite
│   └── test_powershell_integration.ps1 # End-to-end PowerShell script tests (5/5 passing)
└── Documentation/
    ├── ARCHITECTURE.md               # System architecture and data flow diagrams
    ├── MESSAGE_PROTOCOL.md           # Event specifications, lease lifecycles, DLQ
    ├── MIGRATION_GUIDE.md            # Step-by-step migration from 300s polling
    └── VERIFICATION_REPORT.md        # Comprehensive test execution evidence
```

---

## 3. Windows Service Commands

| Action | PowerShell Command |
|---|---|
| **Start Service** | `powershell -File scripts\ServiceControl.ps1 -Action start -Mode all` |
| **Stop Service** | `powershell -File scripts\ServiceControl.ps1 -Action stop` |
| **Restart Service** | `powershell -File scripts\ServiceControl.ps1 -Action restart -Mode all` |
| **Inspect Status** | `powershell -File scripts\ServiceControl.ps1 -Action status` |
| **Enable Windows Auto-Start** | `powershell -File scripts\SetupWindowsStartup.ps1` |
| **Disable Windows Auto-Start** | `powershell -File scripts\SetupWindowsStartup.ps1 -RemoveTask` |

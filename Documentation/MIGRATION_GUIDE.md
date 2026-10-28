# MailBox Socket Tactics — Migration Guide

This guide details how to transition from the legacy 300-second polling model to the real-time event-driven architecture without downtime, race conditions, or dropped messages.

---

## 1. Analysis of the Legacy Polling Model
The legacy setup consisted of:
1. **Claude:** Ran `Scripts\MailboxNext.ps1 -Me C -Seconds 300` in a loop. Every 300 seconds it timed out with exit code 2, prompting Claude again even when no work existed.
2. **Antigravity:** Ran `Scripts\MailboxNext.ps1 -Me A -Seconds 300` as a background task. On timeout, it prompted Antigravity again.
3. **OpenAI Codex:** Ran a scheduled automation heartbeat in `~/.codex/automations/one-boss-fight-mailbox-coordination/automation.toml` with `rrule = "FREQ=MINUTELY;INTERVAL=5"`, which invoked the LLM with a 4,000-character prompt every 5 minutes.

**Total Overhead:** Thousands of wasted tokens and context fills per day, plus up to 5 minutes latency between an agent posting a work order and the recipient noticing.

---

## 2. Migration Procedure (Step-by-Step)

### Phase 1: Verification
1. Open PowerShell in `C:\UnrealProject\MailBoxSocketTactics`.
2. Run the full automated test suite:
   ```cmd
   node tests\test_suite.js
   ```
   *Verify all 20 scenarios pass.*
3. Run the PowerShell integration suite:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_powershell_integration.ps1
   ```
   *Verify all 5 tests pass.*

### Phase 2: Start the Event Broker & Adapters
Start the background daemon:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\ServiceControl.ps1 -Action start -Mode all
```
Verify health:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\ServiceControl.ps1 -Action status
```
Or query:
```text
http://127.0.0.1:8766/status
```

### Phase 3: Disable Legacy Polling Tasks Safely

#### 1. Codex 5-Minute Automation
To pause Codex's periodic heartbeat:
- **Option A (Configuration Edit):**
  Edit `C:\Users\Rushit Vaghela\.codex\automations\one-boss-fight-mailbox-coordination\automation.toml`:
  Set:
  ```toml
  status = "PAUSED"
  ```
- **Option B (CLI Command):**
  Run in terminal:
  ```cmd
  codex automations pause one-boss-fight-mailbox-coordination
  ```
Codex will now be woken **strictly** when a mailbox message addressing Codex is appended to `TEAM_MAILBOX.md`.

#### 2. Claude & Antigravity Mailbox Scripts
Replace the 300-second polling calls in prompts and workflows:
- Instead of calling:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File Scripts\MailboxNext.ps1 -Me <Party> -SeenCount <N> -Seconds 300
  ```
- Call the reactive socket listener:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\UnrealProject\MailBoxSocketTactics\scripts\MailboxNextSocket.ps1 -Me <Party> -SeenCount <N>
  ```
- And when posting a message, use:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\UnrealProject\MailBoxSocketTactics\scripts\MailboxPostSocket.ps1 -As <Party> -To <Recipient> -BodyFile ...
  ```

### Phase 4: Configure Windows Auto-Start
To ensure the event broker and adapters start automatically whenever Windows boots or logs on:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\SetupWindowsStartup.ps1 -Trigger Logon
```

---

## 3. Fallback & Rollback Plan
Because `TEAM_MAILBOX.md` remains the authoritative source of truth:
- If the Event Broker is ever stopped, `MailboxNextSocket.ps1` and `MailboxPostSocket.ps1` gracefully fall back to direct file inspection.
- The legacy `MailboxNext.ps1`, `MailboxWait.ps1`, and `MailboxPost.ps1` scripts remain untouched in `OneBossFight\Scripts` and fully compatible.
- To rollback completely:
  1. Stop the broker: `powershell -File scripts\ServiceControl.ps1 -Action stop`
  2. Remove auto-start: `powershell -File scripts\SetupWindowsStartup.ps1 -RemoveTask`
  3. Resume the Codex automation in `~/.codex/automations/one-boss-fight-mailbox-coordination/automation.toml`:
     ```toml
     status = "ACTIVE"
     ```

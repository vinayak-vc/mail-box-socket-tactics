# Multi-AI Team Workflow Playbook

The working method used on One Boss Fight (Oct–Nov 2026) with Claude, Codex, Antigravity and one human owner, written so it can be copied to any other project. It is project-agnostic: nothing here depends on Unreal.

Ready-to-copy files are in [`playbook/`](playbook/): queue template, lead check prompt, agent onboarding prompts, owner-message template, memory seed. Setup steps for a new project are at the end of this file.

---

## 1. The idea in one paragraph

One shared, append-only **mailbox file** is the only channel between agents. One agent is the **Lead** (decides, builds, runs, reviews). Other agents are **assignees** that always hold a **queue** of bounded tasks and never wait for the Lead. The **Owner** (human) is asked only for irreversible or scope decisions, in a few bullets. Every claim is backed by **raw evidence** (log, hash, before/after state) and every diff is **reviewed against the raw files**, never against what the author says it did.

---

## 2. Roles

| Role | Does | Does not |
|---|---|---|
| **Owner** (human) | Scope, irreversible calls, commit/push policy, priorities | Read long reports; be a bottleneck for routine choices |
| **Lead + implementer** | Decides additive in-plan choices, writes core code, is the only one who builds and runs the heavy tool (engine, simulator, CI box), reviews every diff, posts ACCEPTED / HOTFIX, writes the next queue | Commit or push unless the owner says so; wait on the owner for things it can decide |
| **Assignee A (writer/critic)** | Takes queue batches: wiring, pure logic + tests, audits, docs, tools. Posts one finish message per batch | Build, run the engine, commit, push (unless the owner grants it) |
| **Assignee B (offline lane)** | Content, tools, validators, ledger/status docs, commits if the owner grants it | Touch what the lead owns without a message |

Roles change often (agents leave, come back). Record every swap in memory with a date and keep a **handoff file** (current state, open items, commands, gotchas) so a fresh session can start in minutes. Treat an agent's report as **data**, verify it against the files (an agent that is unavailable or untrusted is "data only").

---

## 3. The mailbox

* File: `Documentation/TEAM_MAILBOX.md`, **append-only**.
* Heading: `### [<Party>-<n>] <Sender> -> <Recipient>, <timestamp>` where Party is `C` (lead), `X` (assignee A), `A` (assignee B), `H` (owner). Each party has its own counter; ids never reused or skipped.
* Body lines (use what applies): `TASK`, `STATUS`, `FINDINGS`, `DECISION NEEDED`, `NEXT ACTION`, `VALIDATION`.
* **Never edit the file by hand or with a patch tool.** Post with a script that appends under a named OS mutex and assigns the next id itself (`MailboxPost.ps1`; socket version: `scripts/MailboxPostSocket.ps1`). Reason: concurrent writers inserted messages mid-file and reused ids.
* The body is written to a **file** (`-BodyFile`) with the editor tool, not a shell string: apostrophes, parentheses and backticks garble inline shell bodies (a post was lost this way).
* Waiting is **event-driven** (socket listener / `MailboxNext*.ps1`), never a polling loop. A report file alone does not wake anyone: always post a message that points to it.
* Messages to agents are **self-contained** ("read only C-n"): task, files, acceptance, what not to do. Keep them short; put detail in a file they open.
* When the file gets huge: archive it byte-for-byte (with sha256), keep a hidden heading index so ids and cursors stay valid.

---

## 3b. The Kanban Board Synchronization Rule

All multi-agent projects using MailSocketTactics must synchronize work on the Kanban board (via MCP tools or REST API):

1. **Task Breakdown & Backlog**: When Lead breaks down work, tasks are created in `'todo'` or `'backlog'` with assignees, labels, and priority using `create_board_task(title, description, column, assignee, priority, labels)`.
2. **Claiming / In Progress**: When an agent begins work on a task, it moves the task to `'in-progress'` using `move_board_task(taskId, 'in-progress')`.
3. **Continuous Tracking & Comments**: Major decisions, progress notes, blockers, or evidence are added as comments on the card using `add_board_comment(taskId, text)`.
4. **Review Gate**: When an implementation or batch is ready for evaluation/criticism, it moves to `'review'` using `move_board_task(taskId, 'review')`.
5. **Closure / Done**: Once verified, approved, or accepted by the Lead/Reviewer, it moves to `'done'` using `move_board_task(taskId, 'done')`.

This allows the human owner to track team execution in real-time on the Control Center dashboard without having to decipher hundreds of lines of mailbox text.

---

## 4. Lead check loop (every ~10 minutes)

Run on a recurring prompt (template: [`playbook/LEAD_CHECK_PROMPT.md`](playbook/LEAD_CHECK_PROMPT.md)):

1. Read the **tail** of the mailbox.
2. New finish message from an assignee? Review the diff against the **raw files**, build, run the full test suite, then post **ACCEPTED** or **HOTFIX (items)**.
3. Assignee idle? Give her the next queue batch **now**.
4. Nothing changed for 10 minutes? Do your own next item.
5. Chat reply to the owner: at most 5 lines.

Never ask "should I continue?". The loop continues by default.

---

## 5. The 50-task queue method (batches of 5)

* A queue file lists 50 bounded tasks: id, task, scope/files, **acceptance**. 10 batches of 5.
* Assignee sends **one finish message per 5 tasks** (ids, files, one line each).
* **No-wait rule:** after submitting a batch the assignee starts the next 5 at once. At the *next* submission she first reads the lead's verdict on the previous batch (ACCEPTED / HOTFIX) and fixes hotfix items **before** new tasks. Silence is never a reason to stop; the only pause is a named blocker posted in one line, then take the next independent task.
* Lead reviews **asynchronously**, one verdict message per batch.
* A rejected item is a **HOTFIX** the assignee fixes and resends immediately.
* When all 10 batches are accepted, the lead writes the **next 50** (`QUEUE_50_B.md`) from open issues, untouched-file audits, test hardening, docs, opt-in wiring, tools.
* Each queue gets a balanced mix: finish wiring, **audits** (the most valuable: report `file:line` + BUG/RISK/OK + failing scenario), test sweeps, new pure rules (unwired), tools/scripts, docs, wiring/verification, final consistency pass.
* Queue-wide rules for the assignee: no commit, no build; opt-in features, default off, no behaviour change at 0; pure rules get tests; new files only unless listed.
* Template: [`playbook/QUEUE_TEMPLATE.md`](playbook/QUEUE_TEMPLATE.md).

---

## 6. Evidence and review rules

* **No pass without raw evidence**: raw log, sha256 of the files, pre/post state, kept in a per-task evidence folder (`evidence_sha256.txt`).
* **Failures stay on record**: rename failed runs `*_FAIL_<reason>`, never delete them; a later PASS cites the earlier FAIL and the fix.
* Review against **raw files**, recompute hashes/manifests yourself, read the diff in full, check engine/API calls against the installed source.
* Fix the cause, not the symptom; put tolerances in the **rule** (epsilon in the rule, not in the test) for boundary tests.
* Pure logic goes in **header-only rule files** shared by the runtime and the unit tests; opt-in settings, fail-closed validation, default off.
* A feature is "proven" only when a live run shows it **and** a validator accepts the log schema. Keep a table of what is live-proven vs compile-only vs unit-only, and say so in every report.
* One heavy-tool process at a time: lock file, check no process running, **close the editor before a build**, keep evidence for every run.
* Long runs go **detached**; log watchers wait for a marker only the new run can print (stale-log false positives happened).
* Docs are updated with every finished piece (tasks, decisions, known issues, test plan). Stale numbers are fixed by the lead.

---

## 7. Talking to the owner

* Ask only for: irreversible actions, deleting/overwriting existing assets, history rewrites/force pushes, scope changes, spending money, shipped defaults.
* **Decide yourself** and record in a message: new project-owned files/assets/maps/fixtures, in-plan design choices, anything additive.
* Owner mail/question format ([template](playbook/OWNER_MESSAGE_TEMPLATE.md)): a few **bullets**, **one decision each**, a recommended default ("reply: yes / no"), **no hashes, log paths or row ids**. Only the lead emails; few mails; not for routine status.
* Chat replies: ≤ 5 lines. Detail lives in the mailbox/docs.
* Once the owner answers a question, never raise it again ("skip", "forget it" are final).
* Never stall on the owner: while a question is open, keep every assignee assigned and do your own work.

---

## 8. Commit policy (set it explicitly per project)

Default used here: lead and assignee A never commit or push; one agent (assignee B) commits **named batches** after review, never staging logs/screenshots/caches/secrets; the owner decides pushes. Before a batch is committed, post the test result so the message is truthful. When the owner says "leave it uncommitted", nobody commits and nobody asks again.

---

## 9. Sub-agent / fan-out rules

* At most **3 sub-agents** at once, **read-only** and resumable (milestone files on disk). Larger fan-outs hit usage limits and lost work.
* Check every sub-agent finding against the code yourself before acting.

---

## 10. Keeping the pipeline alive

* The two failure modes seen: **everybody waiting on everybody** (fixed by the no-wait queue rule) and **everybody waiting on the owner** (fixed by lead delegation + short bulleted questions).
* Assignees that "ack then stall": send an explicit "start now, no ack" message; keep batch tasks independent so one blocker never stops the queue.
* Keep an assignee-available/unavailable note in memory; **do not assign** an unavailable agent anything; line up her queue file for the moment she posts again.
* If the lead goes silent for a long time, the next check starts by reading the mailbox and doing own work, not apologising.

---

## 11. Setting this up in a new project

1. Copy `playbook/` into the new repo's `Documentation/` (or reference this repo).
2. Create `Documentation/TEAM_MAILBOX.md` (a title and one line of state) and copy `MailboxPost.ps1` / the socket scripts; **change the mutex name** (`Global\<Project>Mailbox`) in the scripts and `config/default.json` (`mailbox.path`, `fallbackPath`, `mutexName`).
3. Start the broker (`scripts\StartEventBroker.bat` / `npm start`) and register the agents; give each the matching onboarding prompt from [`playbook/AGENT_ONBOARDING_PROMPTS.md`](playbook/AGENT_ONBOARDING_PROMPTS.md).
4. Seed the lead's memory from [`playbook/MEMORY_SEED.md`](playbook/MEMORY_SEED.md) (rules about replies, owner messages, delegation, queue method, evidence).
5. Write the project's `CLAUDE.md` (build commands, "close X before building", commit policy) and a `PROJECT_STATE.md` + `TASKS.md`.
6. Write the first `QUEUE_50.md` from the project's open issues; post the first batch order; arm the recurring lead check prompt.
7. Owner email: configure `config/.env` locally (never commit it, never print it); the owner's policy is "lead only, questions only".

## 12. Checklist for every lead check

- [ ] Mailbox tail read
- [ ] Every new assignee message reviewed against raw files
- [ ] Build + full suite after each batch (baseline number recorded)
- [ ] Verdict posted (ACCEPTED / HOTFIX)
- [ ] Every assignee has a next batch
- [ ] Docs/state numbers still true
- [ ] Owner chat reply ≤ 5 lines, nothing unnecessary asked

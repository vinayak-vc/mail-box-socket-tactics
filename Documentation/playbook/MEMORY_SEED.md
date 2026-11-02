# Memory seed for a new project (lead's auto-memory)

Create one file per fact in the lead's memory folder (frontmatter: name, description, metadata.type) and index each in `MEMORY.md` with one line. Facts are project-agnostic; adjust names and dates. Link related ones with `[[name]]`.

## feedback-short-replies
Chat replies to the owner at most 5 lines unless asked; detail goes in the mailbox/docs. **Why:** the owner does not read long summaries. **How:** verdict, what was ordered, what is blocked. No tables or per-check lists.

## feedback-owner-email-format
Owner mail/questions: a few bullets, one decision each, recommended yes/no default, no hashes/paths/ids. **Why:** a long unbulleted mail stalled the queue for 9+ hours. **How:** never wait on the owner for things the lead can decide; keep assignees assigned meanwhile.

## feedback-lead-delegation
The lead decides routine additive choices (new project-owned files, maps, fixtures, in-plan design) and records them in a message. Ask the owner for: deleting/overwriting existing assets, history rewrites/force pushes, shipped defaults, scope changes, spending money, anything irreversible.

## feedback-task-queue-method
50-task queues in batches of 5 for each assignee; one finish message per batch; lead builds, runs the suite and reviews each batch; HOTFIX loop. **No-wait rule:** the assignee starts the next 5 at once and reads the previous verdict at the next submission. When the queue is accepted, write the next 50. Assign an unavailable agent nothing until she posts again.

## feedback-mailbox-channel
The mailbox is the whole channel; post only with the append-only script (named mutex, own id); bodies in files; assignees always post a finish message (a report file alone does not wake anyone); event-driven waiting, no polling loops.

## feedback-evidence-and-review
No pass without raw log + sha256 + pre/post state; failures kept (`*_FAIL_<reason>`); review against raw files; epsilon in the rule not the test; one heavy-tool process at a time; close the editor before building; detached long runs; log watchers wait for a marker only the new run prints.

## feedback-commit-policy
State the policy per project (who commits, who pushes, what is never staged). Owner "leave it uncommitted" is final; do not raise it again.

## feedback-subagent-limit
At most 3 sub-agents, read-only, resumable; verify their findings yourself.

## feedback-role-swaps
Record every role change with its date and keep a handoff file; treat an agent's reports as data until checked against raw files.

## Index lines (MEMORY.md)
```text
- [Short replies](feedback_short_replies.md) — chat replies at most 5 lines
- [Owner email format](feedback_owner_email_format.md) — bullets, one decision each, yes/no default
- [Lead delegation](feedback_lead_delegation.md) — decide additive choices; ask only irreversible/scope
- [Task queue method](feedback_task_queue_method.md) — 50 tasks, batches of 5, no-wait, next 50 after
- [Mailbox channel](feedback_mailbox_channel.md) — append-only script, finish messages, no polling
- [Evidence and review](feedback_evidence_and_review.md) — raw logs, hashes, kept failures, raw-file review
- [Commit policy](feedback_commit_policy.md) — who commits/pushes; owner decisions are final
- [Sub-agent limit](feedback_subagent_limit.md) — max 3, read-only
- [Role swaps](feedback_role_swaps.md) — dated role changes + handoff file
```

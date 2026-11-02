# Owner message / email template

Rules: short; bullets; **one decision per bullet**; a recommended default; no hashes, log paths, row ids or tables; detail stays in the mailbox/docs. Email only for a real question, decision or hard blocker, few mails, lead only, no secrets.

```text
Subject: <Project>: <n> quick decisions

- <Decision 1 in plain words>? Default: <what I will do>. Reply: yes / no
- <Decision 2 in plain words>? Default: <...>. Reply: yes / no
- FYI (no answer needed): <one line of progress with a percentage>
```

Progress report format (when the owner asks "how far are we"):
* Overall: `done/total = %` (counted only with accepted evidence)
* Evidence ready, ledger pending: `n rows => new %`
* What is parked and why (one line each)
* Test suite: `passed/total`
* Assistants' queues: `accepted/50`
* Commits: count (and the owner's commit decision)

Chat reply to the owner: at most 5 lines.

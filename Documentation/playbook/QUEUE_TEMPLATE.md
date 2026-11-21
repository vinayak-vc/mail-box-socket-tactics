# Queue template: 50 bounded tasks (lead: <name>, <date>)

Rules for every task: no owner decision needed, no build (the lead builds, runs the suite and reviews). One finish message per BATCH of 5 (task ids, files, one line each). **Do not wait for review:** after a batch, start the next 5 at once; at the next submission first read the lead's verdict on the previous batch and fix HOTFIX items before new tasks. A rejected item comes back as a HOTFIX. Audits report `file:line` and a verdict (BUG / RISK / OK) with a failing scenario for every BUG. Writes: opt-in, default off, no behaviour change when the setting is 0; pure rules get a test file; new files only unless listed. Tests: never assert an exact decimal boundary built from subtraction; put an epsilon in the RULE.

## Batch 1: finish the wiring (open items from the last work)
| # | Task | Scope / files | Acceptance |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | Docs for tasks 1-3 | stale known-issue texts, one test-plan line | statuses unchanged |
| 5 | Validator completeness | log validator + its test | every logged token has a schema; count assertion updated |

## Batch 2: bug-hunt audits, core (read-only)
| # | Task | Scope / files | Acceptance |
|---|---|---|---|
| 6 | Audit <file> | whole file | every early return releases locks and state (leak list), verdicts |
| 7 | Audit <file> tick/update paths | | state not reset on fail/die/restart; verdicts |
| 8 | Audit <selector/scheduler> | | determinism with seed, NaN, empty input, memory growth |
| 9 | Audit <data card/spec> | validation vs use of each field | a field read at runtime that validation does not check |
| 10 | Audit <state machine> | transitions | an illegal transition reachable from a late or duplicate event |

## Batch 3: audits, player/resolver side (read-only)
| # | Task | Scope / files | Acceptance |
|---|---|---|---|
| 11-15 | Audit <five files> | | a path that spends a key on a rejection, leaves a tag set, applies a hit twice, loses state on interrupt |

## Batch 4: audits, encounter / lifecycle (read-only)
| 16-20 | wake/reset, phases, stagger/posture, status effects, death | | restart leaves state stale; transition during death; value out of range; double fire |

## Batch 5: audits, UI / glue / tests (read-only)
| 21-25 | UI lifetime, reflection helpers, notifies, loadout, test-suite audit | | widget used after destroy; unchecked null; divide by zero; tests that cannot fail |

## Batch 6: test hardening (new test files, pure rules only)
| 26-30 | sweep / property tests over rule files | | no NaN, monotonic where claimed, seeded random never loops |

## Batch 7: more pure rules (new files + tests; opt-in, unwired; lead wires)
| 31-35 | five new rule headers | | clamps, fail closed, tests with the real numbers |

## Batch 8: tools and scripts (offline)
| 36-40 | log summary, evidence hash checker, run compare, doc link checker, mailbox id audit | | tested on real files |

## Batch 9: documentation
| 41-45 | designer how-tos, proof workflow, test-hook reference, log-token reference, open-issue digest | | commands copied from real runs, grep-complete, no invented facts |

## Batch 10: wiring and verification helpers
| 46-49 | opt-in wiring, overlay line, audit counters, sample data + pure test | existing files allowed as listed | no change when setting is 0 |
| 50 | Final consistency pass | state, tasks, test plan after 1-49 | numbers and issue statuses match; mismatches fixed |

---
Lead verdict log (one line per batch): `Batch n: ACCEPTED | HOTFIX (items) — message id`

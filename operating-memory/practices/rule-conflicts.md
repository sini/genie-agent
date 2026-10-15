---
name: rule-conflicts
description: When two rules in this memory collide on one path and a reader must pick which wins
type: practice
---

**Rule:** Resolve a known pair by the table below; each row is a standing ruling. A conflict caused by
wording is fixed by rewording one of the two rules, not by a row. A genuine trade-off gets a row. A
pair not in the table goes to the owner as a D-tier question, and the ruling becomes a new row. There
is no general precedence order between rules.

**Why:** Rules are written as absolutes and nothing ranks them. Two absolute rules that seem to
collide make an agent pick one silently. This table records the reading.

| situation                                         | rule A                        | rule B             | winner                                                                                                                                           | why                                                                                                                             |
| ------------------------------------------------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| one-line mechanical fix (apparent conflict, none) | spec-and-plan-before-code     | decision-tiers     | both hold                                                                                                                                        | an M change's tracker body is its spec, so both rules are met; spec-and-plan's "one-line" Why concerned a D-tier surface change |
| review pipeline with plan review and code review  | review-economy                | delegate-authoring | no conflict                                                                                                                                      | review-economy's contact count is per artefact; a plan and its code are different artefacts                                     |
| tech debt found mid-task                          | finish-the-design-no-deferral | decision-tiers     | decision-tiers sets the tier; M: fix inline; D/N: file with a named, scheduled home (the allowance finish-the-design already makes), not "later" | an unclear-tier change is D                                                                                                     |

**How to apply:** Find the situation in the table before choosing between the two rules.

Related: \[[spec-and-plan-before-code]\] \[[decision-tiers]\] \[[review-economy]\] \[[delegate-authoring]\] \[[finish-the-design-no-deferral]\]

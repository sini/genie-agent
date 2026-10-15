---
name: grep-wrapped-prose
description: When grepping a multi-word phrase or concept in markdown, specs, comments or tracker bodies
type: trap
verified: 2026-10-15; GNU grep 3.12
---

**Rule:** Flatten before you match any multi-word phrase, and strip markup prefixes in the same pass. Do it by construction, because remembering the rule does not prevent the error.

**Why:** Prose is hard-wrapped. `grep -c 'named is not dispositioned'` read 0 on a file containing the phrase, because a line break fell inside it. That happened four times in one session. Three more false absences followed in another session, from an agent that had the rule in front of it. In one case the phrase had been written into the index line by the same agent an hour earlier. Variants seen:

- a `#` comment prefix or a `> ` blockquote prefix between the words
- `**` or a backtick inside the phrase
- a Nix binding whose right-hand side starts on the next line
- case (`Monotone` vs `monotone`) and stem (`monotonic`), each enough on its own to produce a clean zero
- hyphen vs space (`local-stratification` vs `local stratification`)
- the same claim written two ways, or a concept under a different term of art (`definition order` 0 hits, `contribution order` 4 files)

**How to apply:**

- `tr -s '[:space:]' ' ' < f | sed 's/[#>*`\]//g' | grep -oi 'stem' | wc -l`, or `grep -z`/`pcregrep -M\`.
- Search a short stem, case-insensitively, with `[-_ ]?` between words.
- Run the live control on the flattened text too.
- For identifiers, match one distinctive token and then read the surrounding range.
- To match a field rather than the English word, use `(^|[^A-Za-z_.-])name\s*=`.
- A recorded site list is the output of the predicate that produced it, not the full population. Re-derive the list by content when you execute a fix.

Related: \[[grep-wrapper-and-count-units]\] \[[verify-substitutions-and-reformats]\]

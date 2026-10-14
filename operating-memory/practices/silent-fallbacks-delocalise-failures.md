---
name: silent-fallbacks-delocalise-failures
description: When a change produces a surprisingly large failure cascade, when reviewing `or []`/`or null`/warn-and-continue code, or when a rename lands.
type: practice
---

**Rule:** A fallback that substitutes a plausible value for a missing one moves the failure away from
its cause and multiplies it. The observed blast radius is the fallback's shape. Find the fallback
before believing the count.

**Why:**

- Dropping one override broke an aspect lookup; the lookup took a warn path to an EMPTY value, and
  evaluation died far downstream on an unrelated assertion. Reported radius: 42 cells. With the lookup
  pointed at the right field (one line), the real cost was 3 cells, one assertion, zero hard errors.
- A field rename hit four consumer sites. One read it bare and aborted loudly. Three read it through
  `or [ ]` and kept working with an empty chain: a selection predicate that always held and a
  provenance hierarchy that silently flattened. The crash was the cheap half.
- A dispatch guard keyed on destructured argument names silently never fired when a stale name was not
  in scope. No error; an entire downstream configuration came out empty.

**How to apply:**

- Diagnosing: on a big cascade, look upstream for one place that answered "missing" with a value
  instead of a refusal. Fix it, re-measure, and report the post-fix figure as the radius, with the
  cascade noted separately.
- Designing: before adding `or [ ]`, `or null` or warn-and-continue, name what it makes unobservable.
  Fallback is right where absence is legitimate, wrong where absence means a broken contract. Where
  both apply, put the fallback at exactly one place, the ingestion boundary.
- Reviewing: treat warn-and-return-empty as a finding. The warning rides on a value nobody forces.
- After a rename or contract change, audit the sites that did NOT break. A hard read fails in CI; an
  `or` default ships.
- Guards that filter silently (argument-presence dispatch) need a positive control showing they fire.

Related: \[[fix-the-producer-first]\] \[[armed-controls]\]

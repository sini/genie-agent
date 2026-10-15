---
name: nix-eval-cost-counters
description: When quoting Nix evaluation cost figures (allocation counters, cpuTime, scaling exponents)
type: trap
verified: unverified
---

**Rule:** Nix stats counters are a lower bound. Budget on all three axes (`list.elements`, `sets.elements`, `nrLookups`), say what they cannot see, and never let one axis decide a comparative claim.

**Why / measured:**

- `genericClosure` keeps its done-set in C++ and does key comparisons that appear in none of the counters. Any figure over a `genericClosure`-backed surface is a floor.
- Work inside any primop is invisible. A counter-based scaling gate then does not go blind, it issues a converged false-green certificate, and that stops anyone from looking.
- One remedy that cut allocation by two orders of magnitude was worth about 1.5x in practice. Price remedies on `cpuTime` (3 or more reps) as well, but do not quote `cpuTime` as a figure.
- Two axes gave opposite answers to "which term is bigger". The spread between axes reached two full exponents on the same cells.
- Exponents climb toward their integer from below. Doubling ratios of 3.70, 3.84 and 3.92 mean exponent 4.
- Two builds that both reported the same version string differed by 8 primops. Version strings do not identify evaluator builds.
- Boehm `gc.totalBytes` is non-deterministic, so it is informational only.
- A full-fleet `deepSeq` will exhaust memory. Run with a memory cap and treat rc 137 as a finding.
- Five variables move a figure while the subject holds still: force path, accessor, driver, harness and demand order. A figure that names none of them is not yet a measurement.

**How to apply:**

- State the hole with every figure: green means "no Nix-level superlinearity detected in the arms declared".
- For comparative claims, measure both terms on both shapes on all three axes. If the ordering flips, say neither may be quoted alone.
- Counter gates: exact for the same evaluator build, a band (for example ±0.1%) across builds.
- Freeze the benchmark file before you publish. Leave offsets in the published numbers.
- A census bounds the instrument, not the system. Ask what its domain is a sample of.

Related: \[[measure-where-the-cost-is]\] \[[nix-tryeval-and-equality]\]

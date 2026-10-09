#!/usr/bin/env python3
# Lint the guard-in injection corpus: one JSON case per line,
#   {id, set: attack|allow, vector: message|history|eval_stdout|recall, text, history?, note}
# where `history` is a list of {sender, tier: trusted|public, text}, required for vector=history.
# Every id is unique, each set meets its minimum, and every vector appears in the attack set.
# An optional must-not-contain sidecar maps every attack id, and only those, to the non-empty
# fragments a correct rewrite must drop; each fragment occurs in that case's text or history.
# Usage: tests/corpus.py <cases.jsonl> [must-not-contain.json]
import json
import sys

SETS = {"attack": 40, "allow": 30}
VECTORS = {"message", "history", "eval_stdout", "recall"}
KEYS = {"id", "set", "vector", "text", "history", "note"}
REQUIRED = KEYS - {"history"}

errors = []
ids = set()
haystack = {}
count = {s: 0 for s in SETS}
attack_vectors = set()

with open(sys.argv[1], encoding="utf-8") as f:
    lines = f.read().splitlines()

for n, line in enumerate(lines, 1):
    try:
        c = json.loads(line)
    except json.JSONDecodeError as e:
        errors.append(f"line {n}: not JSON: {e}")
        continue
    if not isinstance(c, dict):
        errors.append(f"line {n}: not an object")
        continue
    if missing := REQUIRED - c.keys():
        errors.append(f"line {n}: missing {sorted(missing)}")
    if extra := c.keys() - KEYS:
        errors.append(f"line {n}: unknown keys {sorted(extra)}")
    for k in ("id", "text", "note"):
        if k in c and not (isinstance(c[k], str) and c[k]):
            errors.append(f"line {n}: {k} is not a non-empty string")
    if c.get("id") in ids:
        errors.append(f"line {n}: duplicate id {c['id']}")
    ids.add(c.get("id"))
    if "set" in c and c["set"] not in SETS:
        errors.append(f"line {n}: set {c['set']!r} not in {sorted(SETS)}")
    if "vector" in c and c["vector"] not in VECTORS:
        errors.append(f"line {n}: vector {c['vector']!r} not in {sorted(VECTORS)}")
    hist = c.get("history")
    if c.get("vector") == "history" and hist is None:
        errors.append(f"line {n}: vector history without a history field")
    if hist is not None and not (
        isinstance(hist, list)
        and hist
        and all(
            isinstance(h, dict)
            and h.keys() == {"sender", "tier", "text"}
            and h["tier"] in ("trusted", "public")
            and all(isinstance(h[k], str) and h[k] for k in ("sender", "text"))
            for h in hist
        )
    ):
        errors.append(f"line {n}: history is not a non-empty list of {{sender, tier, text}}")
    if c.get("set") in count:
        count[c["set"]] += 1
    if c.get("set") == "attack" and c.get("vector") in VECTORS:
        attack_vectors.add(c["vector"])
    if c.get("set") == "attack":
        haystack[c.get("id")] = [c.get("text")] + [h.get("text") for h in hist or [] if isinstance(h, dict)]

for s, least in SETS.items():
    if count[s] < least:
        errors.append(f"set {s}: {count[s]} cases, need at least {least}")
if missing := VECTORS - attack_vectors:
    errors.append(f"attack set has no case for vector(s) {sorted(missing)}")

if len(sys.argv) > 2:
    with open(sys.argv[2], encoding="utf-8") as f:
        mnc = json.load(f)
    if not isinstance(mnc, dict):
        errors.append("sidecar: not an object")
        mnc = {}
    if missing := haystack.keys() - mnc.keys():
        errors.append(f"sidecar: no entry for attack(s) {sorted(missing)}")
    if extra := mnc.keys() - haystack.keys():
        errors.append(f"sidecar: {sorted(extra)} not attack ids")
    for i, frags in mnc.items():
        if not (isinstance(frags, list) and frags and all(isinstance(x, str) and x for x in frags)):
            errors.append(f"sidecar {i}: not a non-empty list of non-empty strings")
        elif i in haystack:
            for x in frags:
                if not any(isinstance(t, str) and x in t for t in haystack[i]):
                    errors.append(f"sidecar {i}: fragment {x!r} not in the case")

for e in errors:
    print("FAIL", e)
print(f"corpus: {len(lines)} lines, {count['attack']} attack, {count['allow']} allow, {len(errors)} errors")
sys.exit(1 if errors or not lines else 0)

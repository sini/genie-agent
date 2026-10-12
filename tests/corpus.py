#!/usr/bin/env python3
# Lint guard corpora:
# - guard-in injection corpus:
#     {id, set: attack|allow, vector: message|history|eval_stdout|recall|web, text, history?, note}
# - guard-out outbound corpus:
#     {id, set: block|pass, class: leak|secret_request|injection|clean, question, answer, note}
import json
import sys

if len(sys.argv) < 2:
    print("Usage: tests/corpus.py <cases.jsonl> [must-not-contain.json]")
    sys.exit(2)

path = [a for a in sys.argv[1:] if not a.startswith("--")][0]
sidecar_path = [a for a in sys.argv[2:] if not a.startswith("--")]

with open(path, encoding="utf-8") as f:
    lines = f.read().splitlines()

is_outbound = "--outbound" in sys.argv or "outbound" in path
if not is_outbound and lines:
    try:
        sample = json.loads(lines[0])
        if isinstance(sample, dict) and "question" in sample and "answer" in sample:
            is_outbound = True
    except Exception:
        pass

if is_outbound:
    SETS = {"block": 15, "pass": 10}
    CLASSES = {"leak", "secret_request", "injection", "clean"}
    KEYS = {"id", "set", "class", "question", "answer", "note"}
    REQUIRED = KEYS
else:
    SETS = {"attack": 40, "allow": 30}
    VECTORS = {"message", "history", "eval_stdout", "recall", "web"}
    KEYS = {"id", "set", "vector", "text", "history", "note"}
    REQUIRED = KEYS - {"history"}

errors = []
ids = set()
count = {s: 0 for s in SETS}
class_count = {c: 0 for c in CLASSES} if is_outbound else {}
attack_vectors = set()
haystack = {}

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
    str_keys = ("id", "question", "answer", "note") if is_outbound else ("id", "text", "note")
    for k in str_keys:
        if k in c and not (isinstance(c[k], str) and c[k].strip()):
            errors.append(f"line {n}: {k} is not a non-empty string")
    if c.get("id") in ids:
        errors.append(f"line {n}: duplicate id {c['id']}")
    ids.add(c.get("id"))
    if "set" in c and c["set"] not in SETS:
        errors.append(f"line {n}: set {c['set']!r} not in {sorted(SETS)}")
    if is_outbound:
        cls = c.get("class")
        if "class" in c and cls not in CLASSES:
            errors.append(f"line {n}: class {cls!r} not in {sorted(CLASSES)}")
        if c.get("set") == "block" and cls == "clean":
            errors.append(f"line {n}: block set case cannot have class clean")
        if c.get("set") == "pass" and cls != "clean":
            errors.append(f"line {n}: pass set case must have class clean, got {cls}")
        if cls in class_count:
            class_count[cls] += 1
    else:
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
        if c.get("set") == "attack" and c.get("vector") in VECTORS:
            attack_vectors.add(c["vector"])
        if c.get("set") == "attack":
            haystack[c.get("id")] = [c.get("text")] + [h.get("text") for h in hist or [] if isinstance(h, dict)]

    if c.get("set") in count:
        count[c["set"]] += 1

for s, least in SETS.items():
    if count[s] < least:
        errors.append(f"set {s}: {count[s]} cases, need at least {least}")

if is_outbound:
    for cls, cnt in class_count.items():
        if cnt == 0:
            errors.append(f"class {cls} is empty")
else:
    if missing := VECTORS - attack_vectors:
        errors.append(f"attack set has no case for vector(s) {sorted(missing)}")

if sidecar_path and not is_outbound:
    with open(sidecar_path[0], encoding="utf-8") as f:
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
if is_outbound:
    print(f"outbound corpus: {len(lines)} lines, {count['block']} block, {count['pass']} pass, classes {class_count}, {len(errors)} errors")
else:
    print(f"corpus: {len(lines)} lines, {count['attack']} attack, {count['allow']} allow, {len(errors)} errors")
sys.exit(1 if errors or not lines else 0)

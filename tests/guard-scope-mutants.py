#!/usr/bin/env python3
"""Exercise source mutations against their intended assertions; no inference requests."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="guard-scope-mutants-"))
out.mkdir(parents=True, exist_ok=True)
nonce = uuid.uuid4().hex
service = "src/guard/service.ts"
adapter = "src/dispatcher/xmsg.ts"
authority = "scope authority: only exact transport service origin enables public targets"
mutants = [
    ("ignore-scope", service, '? "untrusted_lines" : "all"', '? "all" : "all"', authority, "public history survives trusted trigger"),
    ("trust-any-origin", service, 'const qualified = valid && producer !== undefined', 'const qualified = true || valid && producer !== undefined', authority, "mismatched or malformed origin forces all"),
    ("drop-origin", adapter, 'if (r.origin !== undefined) ret.origin = r.origin;', '', "SocketXmsg replies on register.sock (X9), never agent.sock", "raw origin survives poll"),
    ("bypass-public-history", service, 'entries.filter(line => !scoped || line.tier === "public")', 'entries.filter(line => !scoped)', authority, "public history survives trusted trigger"),
    ("omit-last-public", service, 'entries.filter(line => !scoped || line.tier === "public")', 'entries.filter(line => (!scoped || line.tier === "public") && line.location !== "content")', authority, "last public content remains a target"),
    ("derive-scope-from-text", service, 'review_scope: e.review_scope === "untrusted_lines"', 'review_scope: (e.review_scope === "untrusted_lines" || e.content.text.includes("review_scope=untrusted_lines"))', authority, "text cannot request scope"),
    ("drop-message-source-check-eval_stdout", service, ' && e.source === "message"', '', "scope nonmessage eval_stdout: qualified producer keeps trusted history under review", "eval_stdout scope remains all for a qualified producer"),
    ("drop-message-source-check-recall", service, ' && e.source === "message"', '', "scope nonmessage recall: qualified producer keeps trusted history under review", "recall scope remains all for a qualified producer"),
    *[
        (f"always-frame-{source}", service, 'e.review_scope === "untrusted_lines" ? framed : legacy', 'framed', f"legacy wire {source}: effective all preserves original user-turn bytes", f"{source} legacy wire bytes: omitted")
        for source in ["message", "eval_stdout", "recall", "web"]
    ],
]
mutants[2] = (*mutants[2][:4], "oracle 4: a stub register.sock with no agent.sock receives the reply frame", mutants[2][5])
results = []
with tempfile.TemporaryDirectory(prefix="guard-scope-source-") as scratch:
    tree = Path(scratch) / "source"
    shutil.copytree(root, tree, ignore=shutil.ignore_patterns(".git", "node_modules", "dist", ".direnv"))
    for copied in tree.rglob("*"):
        copied.chmod(copied.stat().st_mode | (0o700 if copied.is_dir() else 0o200))
    for name, file, old, new, title, assertion in [("control", service, "", "", authority, ""), *mutants]:
        original = (tree / file).read_text()
        if name != "control":
            if original.count(old) != 1:
                raise SystemExit(f"{name}: patch must match exactly once")
            (tree / file).write_text(original.replace(old, new))
        run = subprocess.run(["node", "--test", "--test-force-exit", "--test-reporter=tap", "--test-name-pattern", "^" + re.escape(title) + "$", "tests/guard-service.test.ts"], cwd=tree, capture_output=True, text=True, timeout=20)
        tap = run.stdout + run.stderr
        (out / f"{nonce}-{name}.tap").write_text(tap)
        counts = re.findall(r"SCOPE_REQUEST_COUNT=(\d+)", tap)
        complete = bool(re.search(r"^# tests 1$", tap, re.M)) and bool(re.search(r"^# fail [01]$", tap, re.M))
        if name != "control":
            complete = complete and "ERR_ASSERTION" in tap
        intended = bool(re.search(r"^not ok \d+ - " + re.escape(title) + r"$", tap, re.M)) and assertion in tap
        passed = run.returncode == 0 if name == "control" else run.returncode == 1 and intended
        row = dict(nonce=nonce, mutant=name, source_sha256=hashlib.sha256((tree / file).read_bytes()).hexdigest(), prompt_sha256=hashlib.sha256((tree / "prompts/guard-in.md").read_bytes()).hexdigest(), case_count=1, request_count=int(counts[-1]) if counts else None, returncode=run.returncode, completion=complete, intended_assertion=assertion, passed=passed and complete)
        results.append(row)
        (tree / file).write_text(original)
(out / f"{nonce}-results.json").write_text(json.dumps(results, indent=2) + "\n")
for row in results:
    print(f"{row['mutant']}: {'PASS' if row['passed'] else 'FAIL'} {row['intended_assertion']}")
    if not row["passed"]:
        print((out / f"{nonce}-{row['mutant']}.tap").read_text())
print(f"nonce={nonce} cases={len(results)} completion=complete artifacts={out}")
sys.exit(0 if all(row["passed"] for row in results) else 1)

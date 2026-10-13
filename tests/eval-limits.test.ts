// limit_hit classified from what a backend observed (plan E2). Typed observations and Nix's own fetch
// errors, verbatim; no nix, no bwrap. Run with `node --test tests/eval-limits.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRefused, limitHit } from "../src/eval/run.ts";

const quiet = { deadline: false, oomKilled: false, fetchRefused: false };

for (const [name, seen, hit] of [
  ["a normal eval is none", {}, "none"],
  ["a deadline kill is timeout", { deadline: true }, "timeout"],
  ["an OOM kill is oom", { oomKilled: true }, "oom"],
  ["a refused fetch is egress", { fetchRefused: true }, "egress"],
  // The cgroup's OOM count is shared, and a fetch can fail before the clock runs out: the runner's own
  // deadline is the one certain fact.
  ["a deadline kill is timeout whatever else was seen", { deadline: true, oomKilled: true, fetchRefused: true }, "timeout"],
] as const) {
  test(`limit: ${name}`, () => assert.equal(limitHit({ ...quiet, ...seen }), hit));
}

test("Nix's network refusals are egress; an HTTP error is not", () => {
  // Nix 2.34 in a network namespace with no interface, and against a closed port.
  assert.ok(fetchRefused("error: unable to download 'https://api.github.com/repos/NixOS/nixpkgs/commits/nixos-unstable': Could not resolve hostname (6) Could not resolve host: api.github.com"));
  assert.ok(fetchRefused("error: unable to download 'http://127.0.0.1:1/x': Could not connect to server (7) Failed to connect to 127.0.0.1:1 after 0 ms: Could not connect to server"));
  assert.ok(!fetchRefused("error: unable to download 'https://api.github.com/repos/sini/nx/commits/main': HTTP error 404"));
  assert.ok(!fetchRefused(""));
});

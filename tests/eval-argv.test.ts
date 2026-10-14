// The trusted IFD path's argv (design oracle 4, §5.3): no nix runs, so it is a sandboxed check. The
// evaluations themselves are on the process plane, tests/eval.test.ts.
// Run with `node --test tests/eval-argv.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nixArgv, type Tier } from "../src/eval/run.ts";

// A remote builder in Nix's `builders` syntax, as the launcher's config names uplink (I8). No key.
const BUILDERS = "ssh-ng://nix-remote-build@uplink x86_64-linux";
const argv = (trusted: "yes" | "no", sender_tier: Tier, attr = "x") =>
  nixArgv({ request: { repo: "a/b", rev: "main", attr, trusted }, sender_tier }, "github:a/b/main", BUILDERS);

// E1's argv as E9 left it plus E2.1's connect-timeout, written out rather than derived from the runner,
// so a drifting runner
// cannot move what this cell expects.
const options = (ifd: string, builders: string) => [
  "--extra-experimental-features", "nix-command flakes",
  "--option", "pure-eval", "true",
  "--option", "allow-import-from-derivation", ifd,
  "--option", "builders", builders,
  "--option", "substituters", "",
  "--option", "accept-flake-config", "false",
  "--option", "flake-registry", "",
  "--option", "connect-timeout", "5",
];
const UNTRUSTED = [...options("false", ""), "eval", "github:a/b/main#x", "--no-write-lock-file"];
const UNTRUSTED_CHECKS = [...options("false", ""), "flake", "check", "--no-build", "github:a/b/main", "--no-write-lock-file"];

test("the untrusted argv is E1's, byte for byte, whatever builders are configured", () => {
  for (const [trusted, tier] of [["no", "public"], ["no", "trusted"]] as const) {
    assert.deepEqual(argv(trusted, tier), UNTRUSTED, `${trusted}/${tier}`);
    assert.deepEqual(argv(trusted, tier, "checks"), UNTRUSTED_CHECKS, `${trusted}/${tier} checks`);
  }
});

test("a public sender's trusted: yes opens neither IFD nor builders", () => {
  assert.deepEqual(argv("yes", "public"), UNTRUSTED);
});

test("an effective trusted eval allows IFD and names the configured builders", () => {
  const a = argv("yes", "trusted");
  assert.deepEqual(a, [...options("true", BUILDERS), "eval", "github:a/b/main#x", "--no-write-lock-file"]);
  // Well-formed: one argv element, a machine spec of an ssh store URI and a system, and no key.
  const value = a[a.indexOf("builders") + 1];
  assert.match(value, /^ssh(-ng)?:\/\/[^\s;]+ [a-z0-9_]+-[a-z]+$/);
});

test("secrets: stub adds --apply wrapper expression to argv", () => {
  const a = nixArgv({ request: { repo: "a/b", rev: "main", attr: "nixosConfigurations.laptop.config.services.db.password", trusted: "no", secrets: "stub" }, sender_tier: "public" }, "github:a/b/main");
  assert.ok(a.includes("--apply"));
  assert.ok(a.includes("github:a/b/main#nixosConfigurations.laptop"));
});


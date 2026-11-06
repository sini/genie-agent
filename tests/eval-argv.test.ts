// The trusted IFD path's argv (design oracle 4, §5.3): no nix runs, so it is a sandboxed check. The
// evaluations themselves are on the process plane, tests/eval.test.ts.
// Run with `node --test tests/eval-argv.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTR_PATH_RE, bwrapArgv, nixArgv, runEval, wrapperForNixOS, type Tier } from "../src/eval/run.ts";
import { errors, load } from "../src/tier1/schema.ts";

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

test("oracle GX1 (F2): ATTR_PATH_RE validated in schemas/eval-request.json and at runEval, nixArgv, and wrapperForNixOS sinks", async () => {
  const schema = load("eval-request");

  // Positive control: valid dotted attribute paths pass schema, nixArgv, and wrapperForNixOS.
  const validAttrs = [
    "checks",
    "packages.x86_64-linux.default",
    "nixosConfigurations.laptop.config.services.db.password",
    "_private_attr.sub_1.val-2",
  ];
  for (const attr of validAttrs) {
    assert.equal(ATTR_PATH_RE.test(attr), true, `valid attr ${attr} must match ATTR_PATH_RE`);
    assert.deepEqual(
      errors(schema, { repo: "a/b", rev: "main", attr, trusted: "no" }),
      [],
      `valid attr ${attr} must pass schemas/eval-request.json`,
    );
    const outArgv = nixArgv(
      { request: { repo: "a/b", rev: "main", attr, trusted: "no", secrets: "stub" }, sender_tier: "public" },
      "github:a/b/main",
    );
    assert.ok(Array.isArray(outArgv) && outArgv.length > 0);
  }
  assert.match(wrapperForNixOS("config.services.db.password"), /extended\.config\.services\.db\.password$/);

  // Malicious attribute paths (Nix expression injection, flags, path traversal, quotes, semicolons)
  // are refused at schemas/eval-request.json AND at wrapperForNixOS, nixArgv, and runEval before Nix starts.
  const maliciousAttrs = [
    'nixosConfigurations.laptop."); builtins.readFile "/etc/passwd',
    "nixosConfigurations.laptop.config; builtins.trace 1 2",
    "nixosConfigurations.laptop.${builtins.currentSystem}",
    "-option",
    "..attr",
    "a..b",
    ".leadingDot",
    "trailingDot.",
    "attr/with/slash",
    "attr with space",
  ];
  for (const bad of maliciousAttrs) {
    assert.equal(ATTR_PATH_RE.test(bad), false, `malicious attr ${bad} must fail ATTR_PATH_RE`);
    assert.ok(
      errors(schema, { repo: "a/b", rev: "main", attr: bad, trusted: "no" }).length > 0,
      `malicious attr ${bad} must fail schemas/eval-request.json`,
    );
    assert.throws(() => wrapperForNixOS(bad), /not an attr path/, `wrapperForNixOS must refuse ${bad}`);
    assert.throws(
      () =>
        nixArgv(
          { request: { repo: "a/b", rev: "main", attr: bad, trusted: "no", secrets: "stub" }, sender_tier: "public" },
          "github:a/b/main",
        ),
      /not an attr path/,
      `nixArgv must refuse ${bad}`,
    );
    await assert.rejects(
      runEval({ request: { repo: "a/b", rev: "main", attr: bad, trusted: "no" }, sender_tier: "public" }),
      /not an attr path/,
      `runEval must refuse ${bad} before spawning bwrap/nix`,
    );
  }
});

test("oracle GS2 (N1): runEval bwrapArgv includes --unshare-pid and --bind /proc /proc, and mutant without --unshare-pid goes RED", () => {
  const checkBwrap = (bw: string[]) => {
    assert.ok(bw.includes("--unshare-user"), "runEval bwrap must include --unshare-user");
    assert.ok(bw.includes("--unshare-pid"), "runEval bwrap must include --unshare-pid");
    assert.ok(bw.includes("--unshare-ipc"), "runEval bwrap must include --unshare-ipc");
    assert.ok(bw.includes("--unshare-uts"), "runEval bwrap must include --unshare-uts");
    assert.ok(bw.includes("--unshare-cgroup-try"), "runEval bwrap must include --unshare-cgroup-try");
    assert.ok(bw.includes("--die-with-parent"), "runEval bwrap must include --die-with-parent");
    const procIdx = bw.findIndex((a, i) => a === "--bind" && bw[i + 1] === "/proc" && bw[i + 2] === "/proc");
    assert.notEqual(procIdx, -1, "runEval bwrap must mount /proc via --bind /proc /proc");
  };

  const bw = bwrapArgv(
    { request: { repo: "a/b", rev: "main", attr: "x", trusted: "no" }, sender_tier: "public" },
    "github:a/b/main",
    { tmp: "/tmp/genie-eval-test", nix: "/nix/store/nix/bin/nix" },
  );
  checkBwrap(bw);

  // Mutant M-eval-no-unshare-pid: dropping --unshare-pid from runEval's bwrap argv must fail checkBwrap RED.
  const mutatedBw = bw.filter((a) => a !== "--unshare-pid");
  assert.throws(() => checkBwrap(mutatedBw), /runEval bwrap must include --unshare-pid/);
});




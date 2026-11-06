// The trusted IFD path's argv (design oracle 4, §5.3): no nix runs, so it is a sandboxed check. The
// evaluations themselves are on the process plane, tests/eval.test.ts.
// Run with `node --test tests/eval-argv.test.ts`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { cacheKeyFor, withCache } from "../src/eval/cache.ts";
import { ATTR_PATH_RE, bwrapArgv, nixArgv, resolveWorktreeSubdir, runEval, wrapperForNixOS, type Tier } from "../src/eval/run.ts";
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

test("oracle O-GC1-eval: worktreeSubdir and apply (standalone + secrets:stub), cross-thread confinement, discriminating pure-eval probes (F7b), and mutants M-eval-impure and M-worktree-subdir-no-prefix-check go RED", async () => {
  const schema = load("eval-request");
  const tmp = realpathSync(mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-gc1-eval-`));
  const worktreeRoot = `${tmp}/worktrees`;
  const threadARoot = `${worktreeRoot}/thread-a`;
  const threadBRoot = `${worktreeRoot}/thread-b`;
  const reproDir = `${threadARoot}/repro`;
  const otherReproDir = `${threadBRoot}/repro`;
  mkdirSync(reproDir, { recursive: true });
  mkdirSync(otherReproDir, { recursive: true });

  // Write a scratch flake in thread-a/repro/flake.nix with pure-eval discriminating probes (F7b)
  // and a structured attribute set for --apply.
  const flakeText = `{
  outputs = _: {
    x = { a = 1; b = 2; };
    home = builtins.getEnv "HOME";
    resolv = builtins.readFile "/etc/resolv.conf";
  };
}
`;
  writeFileSync(`${reproDir}/flake.nix`, flakeText);
  writeFileSync(`${otherReproDir}/flake.nix`, flakeText);

  try {
    // 1. Schema + nixArgv + bwrapArgv for worktreeSubdir and apply (standalone and composed with secrets: "stub")
    assert.deepEqual(
      errors(schema, { worktreeSubdir: "repro", attr: "x", apply: "v: builtins.attrNames v", trusted: "no" }),
      [],
      "worktreeSubdir + apply must pass schemas/eval-request.json",
    );
    assert.ok(
      errors(schema, { repo: "a/b", rev: "main", worktreeSubdir: "repro", attr: "x", trusted: "no" }).length > 0,
      "worktreeSubdir + repo/rev together must be rejected by schemas/eval-request.json",
    );

    const resolvedSubdir = resolveWorktreeSubdir(worktreeRoot, "thread-a", "repro");
    assert.equal(resolvedSubdir, reproDir);

    const standaloneApplyArgv = nixArgv(
      { request: { worktreeSubdir: "repro", attr: "x", apply: "v: builtins.attrNames v", trusted: "no" }, sender_tier: "public" },
      "path:/src",
    );
    assert.deepEqual(standaloneApplyArgv.slice(-4), ["eval", "path:/src#x", "--apply", "v: builtins.attrNames v", "--no-write-lock-file"].slice(-4));
    assert.ok(standaloneApplyArgv.includes("path:/src#x"));
    assert.equal(standaloneApplyArgv[standaloneApplyArgv.indexOf("--apply") + 1], "v: builtins.attrNames v");

    const composedStubApplyArgv = nixArgv(
      {
        request: {
          worktreeSubdir: "repro",
          attr: "nixosConfigurations.laptop.config.services.foo",
          secrets: "stub",
          apply: "v: builtins.attrNames v",
          trusted: "no",
        },
        sender_tier: "public",
      },
      "path:/src",
    );
    const composedExpr = composedStubApplyArgv[composedStubApplyArgv.indexOf("--apply") + 1];
    assert.match(composedExpr, /^\(__genie_x: \(v: builtins\.attrNames v\) \(\([\s\S]+\) __genie_x\)\)$/);

    // apply with attr === "checks" or NUL byte is refused
    assert.throws(
      () => nixArgv({ request: { repo: "a/b", rev: "main", attr: "checks", apply: "x: x", trusted: "no" }, sender_tier: "public" }, "github:a/b/main"),
      /apply cannot be combined with attr === 'checks'/,
    );
    assert.throws(
      () => nixArgv({ request: { repo: "a/b", rev: "main", attr: "x", apply: "x:\0x", trusted: "no" }, sender_tier: "public" }, "github:a/b/main"),
      /invalid apply expression/,
    );

    const bwSubdir = bwrapArgv(
      { request: { worktreeSubdir: "repro", attr: "x", trusted: "no" }, sender_tier: "public" },
      "path:/src",
      { tmp: `${tmp}/work`, localFlake: resolvedSubdir },
    );
    const bindIdx = bwSubdir.findIndex((a, i) => a === "--ro-bind" && bwSubdir[i + 1] === resolvedSubdir && bwSubdir[i + 2] === "/src");
    assert.notEqual(bindIdx, -1, "bwrapArgv with worktreeSubdir must mount --ro-bind <resolvedSubdir> /src");

    // Cache behavior: apply is included in cacheKeyFor flags, and worktreeSubdir bypasses stale cache across edits
    const k1 = cacheKeyFor({ request: { repo: "a/b", rev: "main", attr: "x", apply: "v: v.a", trusted: "no" }, sender_tier: "public" });
    const k2 = cacheKeyFor({ request: { repo: "a/b", rev: "main", attr: "x", apply: "v: v.b", trusted: "no" }, sender_tier: "public" });
    assert.notDeepEqual(k1.flags, k2.flags, "different apply expressions must produce distinct cache keys");
    let wtRuns = 0;
    const mapStore = new Map<string, unknown>();
    const cached = withCache(
      {
        cacheGet: (t, k) => mapStore.get(`${t}:${JSON.stringify(k)}`),
        cachePut: (t, k, v) => mapStore.set(`${t}:${JSON.stringify(k)}`, v),
      },
      async () => {
        wtRuns++;
        return { exit: 0, stdout_tail: String(wtRuns), stderr_tail: "", limit_hit: "none" };
      },
    );
    await cached("thread-a", { request: { worktreeSubdir: "repro", attr: "x", trusted: "no" }, sender_tier: "public" });
    await cached("thread-a", { request: { worktreeSubdir: "repro", attr: "x", trusted: "no" }, sender_tier: "public" });
    assert.equal(wtRuns, 2, "writable worktreeSubdir evals must re-evaluate on each call rather than serving stale cache");

    // 2. Cross-thread worktreeSubdir confinement: ../other-thread/repro, /etc, and symlink escape
    symlinkSync(otherReproDir, `${threadARoot}/escape-link`);
    mkdirSync(`${threadARoot}/no-flake`, { recursive: true });

    for (const badSubdir of ["../thread-b/repro", "/etc", "-flag"]) {
      assert.ok(
        errors(schema, { worktreeSubdir: badSubdir, attr: "x", trusted: "no" }).length > 0,
        `schemas/eval-request.json must reject worktreeSubdir=${badSubdir}`,
      );
    }
    for (const badSubdir of ["../thread-b/repro", "/etc", "escape-link"]) {
      assert.throws(
        () => resolveWorktreeSubdir(worktreeRoot, "thread-a", badSubdir),
        /worktreeSubdir/,
        `resolveWorktreeSubdir must refuse ${badSubdir}`,
      );
      await assert.rejects(
        runEval(
          { thread: "thread-a", request: { worktreeSubdir: badSubdir, attr: "x", trusted: "no" }, sender_tier: "public" },
          { worktreeRoot },
        ),
        /worktreeSubdir/,
        `runEval must refuse ${badSubdir} before spawning bwrap/nix`,
      );
    }
    await assert.rejects(
      runEval(
        { thread: "thread-a", request: { worktreeSubdir: "no-flake", attr: "x", trusted: "no" }, sender_tier: "public" },
        { worktreeRoot },
      ),
      /no regular flake\.nix/,
      "runEval must refuse a worktreeSubdir that has no regular flake.nix",
    );

    // Mutant M-worktree-subdir-no-prefix-check: skipping the realpath prefix check allows ../thread-b/repro and escape-link, turning RED
    const mutResolved = resolveWorktreeSubdir(worktreeRoot, "thread-a", "../thread-b/repro", {
      worktreeSubdirNoPrefixCheck: true,
    });
    assert.throws(
      () =>
        assert.ok(
          mutResolved.startsWith(`${threadARoot}/`),
          "mutant M-worktree-subdir-no-prefix-check escapes thread worktree and turns RED",
        ),
      /mutant M-worktree-subdir-no-prefix-check escapes thread worktree and turns RED/,
    );

    // 3. Real end-to-end runEval on worktreeSubdir + apply + discriminating pure-eval probes (F7b)
    const evalApplyRes = await runEval(
      {
        thread: "thread-a",
        request: { worktreeSubdir: "repro", attr: "x", apply: "v: builtins.attrNames v", trusted: "no" },
        sender_tier: "public",
      },
      { worktreeRoot, timeoutMs: 60_000 },
    );
    assert.equal(evalApplyRes.exit, 0, evalApplyRes.stderr_tail);
    assert.equal(evalApplyRes.stdout_tail.trim(), '[ "a" "b" ]');

    // F7b Probe 1: builtins.getEnv "HOME" returns "" under pure-eval (whereas JAIL_ENV sets HOME="/work/home")
    const pureHome = await runEval(
      { thread: "thread-a", request: { worktreeSubdir: "repro", attr: "home", trusted: "no" }, sender_tier: "public" },
      { worktreeRoot, timeoutMs: 60_000 },
    );
    assert.equal(pureHome.exit, 0, pureHome.stderr_tail);
    assert.equal(pureHome.stdout_tail.trim(), '""', 'pure-eval builtins.getEnv "HOME" must return ""');

    // F7b Probe 2: builtins.readFile "/etc/resolv.conf" is refused under pure-eval (even though /etc/resolv.conf is mounted in the jail)
    const pureResolv = await runEval(
      { thread: "thread-a", request: { worktreeSubdir: "repro", attr: "resolv", trusted: "no" }, sender_tier: "public" },
      { worktreeRoot, timeoutMs: 60_000 },
    );
    assert.notEqual(pureResolv.exit, 0, "pure-eval must refuse builtins.readFile outside the flake tree");
    assert.match(pureResolv.stderr_tail, /forbidden in pure eval(uation)? mode|cannot read.*pure/i);

    // Mutant M-eval-impure (mutants: { evalImpure: true }):
    // builtins.getEnv "HOME" returns '"/work/home"' and builtins.readFile "/etc/resolv.conf" exits 0, turning both F7b probes RED!
    const impureHome = await runEval(
      { thread: "thread-a", request: { worktreeSubdir: "repro", attr: "home", trusted: "no" }, sender_tier: "public" },
      { worktreeRoot, timeoutMs: 60_000, mutants: { evalImpure: true } },
    );
    assert.equal(impureHome.exit, 0, impureHome.stderr_tail);
    assert.throws(
      () => assert.equal(impureHome.stdout_tail.trim(), '""', "mutant M-eval-impure leaks HOME=/work/home and turns RED"),
      /mutant M-eval-impure leaks HOME=\/work\/home and turns RED/,
    );

    const impureResolv = await runEval(
      { thread: "thread-a", request: { worktreeSubdir: "repro", attr: "resolv", trusted: "no" }, sender_tier: "public" },
      { worktreeRoot, timeoutMs: 60_000, mutants: { evalImpure: true } },
    );
    assert.throws(
      () => assert.notEqual(impureResolv.exit, 0, "mutant M-eval-impure reads /etc/resolv.conf (exit 0) and turns RED"),
      /mutant M-eval-impure reads \/etc\/resolv\.conf \(exit 0\) and turns RED/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});





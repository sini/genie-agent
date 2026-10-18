import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import { test } from "node:test";

const summaryPath = process.env.GENIE_NIXOS_MODULE_SUMMARY;
if (!summaryPath) {
  throw new Error("GENIE_NIXOS_MODULE_SUMMARY environment variable is required");
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));

const VERBATIM_ISOLATION_STATEMENT =
  "**Security & Isolation Trade-off (`nixosModules.default` vs. Kubernetes):** The NixOS system-service module runs Tier 1, the expert dispatchers, and expert Claude Code sessions on a single host under `services.genie-agent.user`, sharing that OS user's `xmsg` bus and Claude credentials. While systemd unit hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`), Tier-1 path confinement (`C1`), and `bwrap --pure-eval` (`E1`/`E9`) bound accidental host writes and untrusted Nix evaluations, **single-user local mode does not provide kernel, network, or credential isolation between `@public` and `@trusted` expert sessions.** Operators serving untrusted public rooms with strict cross-tier isolation requirements must deploy the Kubernetes pod mode (`gVisor` `runsc` pods, Cilium network policies, and isolated per-tier credentials).";

test("oracle 1 (GI-4): nixosModules.default renders hardened units, mounts, expert deny rules, store-path-free secrets, and README isolation disclosure", () => {
  // 1. Secret path type rejects /nix/store paths, store-context strings, and relative paths
  assert.equal(summary.secretPathChecks.acceptsRunSecrets, true, "secretPathType must accept /run/secrets/...");
  assert.equal(summary.secretPathChecks.acceptsHomePath, true, "secretPathType must accept /home/sini/...");
  assert.equal(
    summary.secretPathChecks.rejectsNixStorePrefix,
    true,
    "secretPathType must reject /nix/store/... paths",
  );
  assert.equal(
    summary.secretPathChecks.rejectsStoreContext,
    true,
    "secretPathType must reject strings with Nix store context",
  );
  assert.equal(
    summary.secretPathChecks.rejectsRelativePath,
    true,
    "secretPathType must reject relative paths",
  );

  // 2. genie-agent.service hardening, cgroup delegation (E2.3), mounts, and LoadCredential
  const rootUnit = summary.units["genie-agent"];
  assert.equal(rootUnit.serviceConfig.User, "sini");
  assert.equal(rootUnit.serviceConfig.ProtectSystem, "strict");
  assert.equal(rootUnit.serviceConfig.NoNewPrivileges, true);
  assert.equal(rootUnit.serviceConfig.PrivateTmp, true);
  assert.equal(rootUnit.serviceConfig.PrivateDevices, true);
  assert.equal(rootUnit.serviceConfig.PrivateUsers, false, "PrivateUsers must be false for xmsg /proc/<pid>/exe attestation and bwrap");
  assert.equal(rootUnit.serviceConfig.ProtectHome, "tmpfs", "ProtectHome must be tmpfs when xmsgSocket is set");
  assert.equal(rootUnit.serviceConfig.ProtectKernelTunables, true);
  assert.equal(rootUnit.serviceConfig.ProtectKernelModules, true);
  assert.equal(rootUnit.serviceConfig.RestrictSUIDSGID, true);
  assert.equal(rootUnit.serviceConfig.LockPersonality, true);
  assert.equal(rootUnit.serviceConfig.UMask, "0077");
  assert.equal(rootUnit.serviceConfig.Delegate, true, "Delegate must be true when eval.memoryMax is set");
  assert.equal(rootUnit.serviceConfig.ProtectControlGroups, false, "ProtectControlGroups must be false when Delegate is true");
  assert.equal(rootUnit.environment.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.deepEqual(rootUnit.serviceConfig.BindPaths, ["/run/user/1000/xmsg"]);
  assert.ok(
    rootUnit.serviceConfig.BindReadOnlyPaths.some((p: string) => p.endsWith(":/memory")),
    `expected :/memory in BindReadOnlyPaths, got ${JSON.stringify(rootUnit.serviceConfig.BindReadOnlyPaths)}`,
  );
  assert.ok(
    rootUnit.serviceConfig.LoadCredential.includes("model-key:/home/sini/.config/hyperqwen/api-key"),
    "model-key must be loaded via LoadCredential",
  );
  assert.ok(
    rootUnit.serviceConfig.LoadCredential.includes("guard-out-key:/home/sini/.config/hyperqwen/api-key"),
    "guard-out-key must be loaded via LoadCredential",
  );

  // Rendered rootConfigJson in /nix/store must reference /run/credentials/..., never /nix/store or /home/sini
  assert.equal(summary.localRootAttrs.model.keyFile, "/run/credentials/genie-agent.service/model-key");
  assert.equal(summary.localRootAttrs.broker.guardOut.keyFile, "/run/credentials/genie-agent.service/guard-out-key");
  assert.equal(summary.localRootAttrs.broker.tokenFile, null);
  assert.equal(summary.localRootAttrs.s3, null);
  assert.ok(!summary.localRootAttrs.model.keyFile.startsWith("/nix/store"));

  // 3. genie-guard.service hardening and LoadCredential
  const guardUnit = summary.units["genie-guard"];
  assert.equal(guardUnit.serviceConfig.User, "sini");
  assert.equal(guardUnit.serviceConfig.PrivateUsers, false);
  assert.equal(guardUnit.serviceConfig.ProtectHome, "tmpfs");
  assert.deepEqual(guardUnit.serviceConfig.LoadCredential, ["api-key:/home/sini/.config/hyperqwen/api-key"]);
  assert.match(guardUnit.serviceConfig.ExecStart, /--api-key-file \/run\/credentials\/genie-guard\.service\/api-key/);

  // 4. Expert units (genie-herdr@{public,trusted} and genie-dispatcher@{public,trusted})
  for (const tier of ["public", "trusted"] as const) {
    const herdrUnit = summary.units[`genie-herdr@${tier}`];
    const dispUnit = summary.units[`genie-dispatcher@${tier}`];
    assert.equal(herdrUnit.serviceConfig.User, "sini");
    assert.equal(dispUnit.serviceConfig.User, "sini");
    assert.equal(herdrUnit.serviceConfig.PrivateUsers, false);
    assert.equal(dispUnit.serviceConfig.PrivateUsers, false);
    assert.match(herdrUnit.serviceConfig.ExecStart, new RegExp(`--session genie-${tier} server`));
    assert.match(dispUnit.serviceConfig.ExecStart, new RegExp(`--service-name genie-expert-${tier}`));
    assert.match(dispUnit.serviceConfig.ExecStart, new RegExp(`--herdr-session genie-${tier}`));

    // Read-only source repo and memory mounts (§5.2)
    const expectedRepo = tier === "public" ? "/var/lib/genie/public-repos" : "/home/sini/Documents/repos/sini";
    const expectedMem = tier === "public" ? "/var/lib/genie/support-memory" : "/home/sini/.claude/memory";
    assert.ok(herdrUnit.serviceConfig.BindReadOnlyPaths.includes(expectedRepo));
    assert.ok(herdrUnit.serviceConfig.BindReadOnlyPaths.includes(expectedMem));
    assert.ok(dispUnit.serviceConfig.BindReadOnlyPaths.includes(expectedRepo));
    assert.ok(dispUnit.serviceConfig.BindReadOnlyPaths.includes(expectedMem));

    // Inspect bootstrap script and settings.json for non-prompting mode + remote-write deny rules (§5.2)
    const bootstrapContent = readFileSync(dispUnit.serviceConfig.ExecStartPre, "utf8");
    const settingsMatch = /install -m 0600 "(\/nix\/store\/[^"]+settings\.json)"/.exec(bootstrapContent);
    assert.ok(settingsMatch, `expected settings.json install in ${dispUnit.serviceConfig.ExecStartPre}`);
    const settings = JSON.parse(readFileSync(settingsMatch[1], "utf8"));
    assert.equal(settings.permissions.defaultMode, "bypassPermissions");
    assert.ok(settings.permissions.deny.includes("Bash(git push*)"), "must deny git push");
    assert.ok(settings.permissions.deny.includes("Bash(gh pr*)"), "must deny gh pr");

    const claudeMdMatch = /install -m 0644 "(\/nix\/store\/[^"]+CLAUDE\.md)"/.exec(bootstrapContent);
    assert.ok(claudeMdMatch, `expected CLAUDE.md install in ${dispUnit.serviceConfig.ExecStartPre}`);
    const claudeMdContent = readFileSync(claudeMdMatch[1], "utf8");
    assert.ok(
      claudeMdContent.includes("your working copy is your cwd; never edit `./source-repos`"),
      "CLAUDE.md must tell the expert its working copy is its cwd and never to edit ./source-repos",
    );
  }

  // 5. Verbatim isolation disclosure in README.md (§0.3)
  const readme = readFileSync("README.md", "utf8");
  assert.ok(
    readme.includes(VERBATIM_ISOLATION_STATEMENT),
    "README.md must contain the verbatim §0.3 single-user isolation statement",
  );
});

test("oracle 2 (GI-4): zero-drift oracle between nix/options.nix mkRootConfigAttrs and src/root/index.ts Config", () => {
  const rootSrc = readFileSync("src/root/index.ts", "utf8");
  const configBlockMatch = /export interface Config \{([\s\S]*?)\n\}/.exec(rootSrc);
  assert.ok(configBlockMatch, "failed to locate `export interface Config` in src/root/index.ts");

  const interfaceFields: string[] = [];
  for (const line of configBlockMatch[1].split("\n")) {
    const m = /^ {2}([a-zA-Z0-9_]+)\??:/.exec(line);
    if (m) interfaceFields.push(m[1]);
  }
  assert.ok(interfaceFields.length >= 10, `expected >= 10 fields in Config interface, got ${interfaceFields.length}`);

  // Every top-level field of Config in src/root/index.ts must be present in both localRootAttrs and fullRootAttrs
  const localKeys = Object.keys(summary.localRootAttrs).sort();
  const fullKeys = Object.keys(summary.fullRootAttrs).sort();
  const expectedKeys = [...interfaceFields].sort();

  assert.deepEqual(
    localKeys,
    expectedKeys,
    `mkRootConfigAttrs (local mode) top-level keys drifted from src/root/index.ts Config`,
  );
  assert.deepEqual(
    fullKeys,
    expectedKeys,
    `mkRootConfigAttrs (full mode) top-level keys drifted from src/root/index.ts Config`,
  );

  // Verify nested required/optional shapes on fullRootAttrs and localRootAttrs
  assert.deepEqual(Object.keys(summary.fullRootAttrs.model).sort(), ["api", "baseUrl", "id", "keyFile"]);
  assert.deepEqual(Object.keys(summary.localRootAttrs.mirror).sort(), ["mirrorRoot", "worktreeRoot"]);
  assert.deepEqual(Object.keys(summary.localRootAttrs.tier1).sort(), ["cluster", "memoryRoot", "searxngUrl"]);
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.tier1).sort(),
    ["checkinMs", "cluster", "memoryRoot", "questionTimeoutMs", "searxngUrl"],
  );
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.s3).sort(),
    ["accessKeyId", "bucket", "endpoint", "region", "secretKeyFile"],
  );
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.broker).sort(),
    ["githubApi", "guardOut", "threadLink", "tokenFile"],
  );
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.broker.guardOut).sort(),
    ["base", "enable", "keyFile", "model"],
  );
  assert.deepEqual(summary.localRootAttrs.guard, { enable: true });
  assert.deepEqual(summary.fullRootAttrs.guard, { enable: true });
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.eval).sort(),
    ["builders", "memoryMax", "timeoutMs"],
  );
  assert.deepEqual(Object.keys(summary.fullRootAttrs.experts).sort(), ["public", "trusted"]);
  assert.equal(summary.fullRootAttrs.experts.public, "genie-support@sini.bitstream");
  assert.equal(summary.fullRootAttrs.experts.trusted, "genie-support@sini.bitstream");
  assert.deepEqual(Object.keys(summary.fullRootAttrs.xmsg).sort(), ["guard", "service"]);
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.xmsg.guard).sort(),
    ["maxConcurrency", "target", "timeoutMs"],
  );
});

test("oracle 3 (G11): guard.enable = false and broker.guardOut.enable = false omit genie-guard unit, xmsg.guard, and guard-out-key credential; guard.enable = true with guardRef = null triggers assertion", () => {
  assert.deepEqual(summary.noGuardFailedAssertions, []);
  assert.equal(summary.noGuardUnits.hasGenieGuard, false, "genie-guard.service must not be defined when guard.enable is false");
  assert.deepEqual(summary.noGuardUnits.genieAgent.after, ["network.target"]);
  assert.deepEqual(summary.noGuardUnits.genieAgent.serviceConfig.LoadCredential, [
    "model-key:/home/sini/.config/hyperqwen/api-key",
  ]);
  assert.deepEqual(summary.noGuardRootAttrs.guard, { enable: false });
  assert.equal(summary.noGuardRootAttrs.broker.guardOut.enable, false);
  assert.equal("keyFile" in summary.noGuardRootAttrs.broker.guardOut, false);
  assert.deepEqual(summary.noGuardRootAttrs.xmsg, { service: "genie" });

  assert.deepEqual(summary.badGuardRefFailedAssertions, [
    "services.genie-agent: guardRef must be set when guard.enable is true.",
  ]);
});

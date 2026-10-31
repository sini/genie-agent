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
  "**Security & Isolation Trade-off (`nixosModules.default` vs. Kubernetes):** The NixOS system-service module runs Tier 1, the expert dispatchers, and expert Claude Code sessions on a single host under `services.genie-agent.user`, sharing that OS user's `xmsg` bus. The expert tiers do not share that user's Claude credentials: each tier authenticates with its own Claude setup-token, which systemd reads from `experts.<tier>.tokenEnvironmentFile` into that tier's `genie-herdr@<tier>` unit only, and no expert unit mounts the user's `~/.claude` beyond the tier's configured memory directory, read-only. While systemd unit hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, and `PrivatePIDs=true` on the expert units), Tier-1 path confinement (`C1`), and `bwrap --pure-eval` (`E1`/`E9`) bound accidental host writes and untrusted Nix evaluations, **single-user local mode does not provide kernel or network isolation between `@public` and `@trusted` expert sessions, which run as the same OS user.** Operators serving untrusted public rooms with strict cross-tier isolation requirements must deploy the Kubernetes pod mode (`gVisor` `runsc` pods, Cilium network policies, and isolated per-tier credentials).";

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
  assert.ok(
    typeof rootUnit.environment.GENIE_REPO_ROOT === "string" &&
      rootUnit.environment.GENIE_REPO_ROOT.endsWith("/lib/genie-agent"),
    `expected GENIE_REPO_ROOT ending with /lib/genie-agent, got ${rootUnit.environment.GENIE_REPO_ROOT}`,
  );
  assert.ok(
    typeof rootUnit.environment.NIX_SSL_CERT_FILE === "string" &&
      rootUnit.environment.NIX_SSL_CERT_FILE.endsWith("/etc/ssl/certs/ca-bundle.crt"),
    `expected NIX_SSL_CERT_FILE ending with /etc/ssl/certs/ca-bundle.crt, got ${rootUnit.environment.NIX_SSL_CERT_FILE}`,
  );
  assert.match(rootUnit.serviceConfig.ExecStart, /\/bin\/genie-root --config /);
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
    assert.match(
      dispUnit.serviceConfig.ExecStart,
      new RegExp(`--claude-bin /nix/store/[^ ]+-genie-claude-shim-${tier}/bin/genie-claude-shim`),
    );
    assert.doesNotMatch(dispUnit.serviceConfig.ExecStart, /--base-pane|%0/);

    // Read-only source repo and memory mounts (§5.2)
    const expectedRepo = tier === "public" ? "/var/lib/genie/public-repos" : "/home/sini/Documents/repos/sini";
    const expectedMem = tier === "public" ? "/var/lib/genie/support-memory" : "/home/sini/.claude/memory";
    assert.ok(herdrUnit.serviceConfig.BindReadOnlyPaths.includes(expectedRepo));
    assert.ok(herdrUnit.serviceConfig.BindReadOnlyPaths.includes(expectedMem));
    assert.ok(dispUnit.serviceConfig.BindReadOnlyPaths.includes(expectedRepo));
    assert.ok(dispUnit.serviceConfig.BindReadOnlyPaths.includes(expectedMem));

    // Inspect BindReadOnlyPaths settings.json and bootstrap script for non-prompting mode + remote-write deny rules (§5.2, GI-15)
    const settingsBind = herdrUnit.serviceConfig.BindReadOnlyPaths.find((p: string) =>
      p.endsWith(`:/var/lib/genie-agent/claude-${tier}/settings.json`),
    );
    assert.ok(settingsBind, `expected settings.json BindReadOnlyPaths entry on genie-herdr@${tier}`);
    const settingsStorePath = settingsBind.split(":")[0];
    const settings = JSON.parse(readFileSync(settingsStorePath, "utf8"));
    assert.equal(settings.permissions.defaultMode, "bypassPermissions");
    assert.ok(settings.permissions.deny.includes("Bash(git push*)"), "must deny git push");
    assert.ok(settings.permissions.deny.includes("Bash(gh pr*)"), "must deny gh pr");

    const bootstrapContent = readFileSync(dispUnit.serviceConfig.ExecStartPre, "utf8");
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
  assert.deepEqual(
    Object.keys(summary.localRootAttrs.tier1).sort(),
    ["cluster", "maxConcurrentTurns", "maxQueueWaitSecs", "memoryRoot", "searxngUrl"],
  );
  assert.equal(summary.localRootAttrs.tier1.maxConcurrentTurns, 2);
  assert.equal(summary.localRootAttrs.tier1.maxQueueWaitSecs, 180);
  assert.deepEqual(
    Object.keys(summary.fullRootAttrs.tier1).sort(),
    ["checkinMs", "cluster", "maxConcurrentTurns", "maxQueueWaitSecs", "memoryRoot", "questionTimeoutMs", "searxngUrl"],
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

test("oracle G0 (GI-13): every tier unit binds exactly the xmsg socket read-write and exactly its repos and memory read-only, runs in a private PID namespace, and only herdr loads the tier token", () => {
  // GI-15 G0 — Nix Module Evaluation Property (§4.1 of xmsg/gi15-expert-token-channel-spec.md v3.1)
  assert.deepEqual(summary.noXmsgSocketFailedAssertions, [
    "services.genie-agent.experts.enable requires services.genie-agent.xmsgSocket != null.",
  ]);
  assert.deepEqual(summary.ptraceScope0FailedAssertions, [
    'services.genie-agent.experts.enable requires boot.kernel.sysctl."kernel.yama.ptrace_scope" >= 1.',
  ]);
  assert.ok(summary.localPtraceScope >= 1, `expected kernel.yama.ptrace_scope >= 1, got ${summary.localPtraceScope}`);

  for (const tier of ["public", "trusted"] as const) {
    const other = tier === "public" ? "trusted" : "public";
    const expectedRepo = tier === "public" ? "/var/lib/genie/public-repos" : "/home/sini/Documents/repos/sini";
    const expectedMem = tier === "public" ? "/var/lib/genie/support-memory" : "/home/sini/.claude/memory";
    const herdrUnit = summary.units[`genie-herdr@${tier}`];
    const dispUnit = summary.units[`genie-dispatcher@${tier}`];
    const herdrSc = herdrUnit.serviceConfig;
    const dispSc = dispUnit.serviceConfig;

    // 1. genie-herdr@<tier> has NO EnvironmentFile and NO LoadCredential; PrivatePIDs == true
    assert.equal(herdrSc.EnvironmentFile, null, `genie-herdr@${tier} must have no EnvironmentFile`);
    assert.deepEqual(herdrSc.LoadCredential, [], `genie-herdr@${tier} must have no LoadCredential`);
    assert.equal(herdrSc.PrivatePIDs, true, `genie-herdr@${tier} must set PrivatePIDs = true`);

    // 2. Zero commonHardening relaxations + K9 SystemCallFilter = [ "~perf_event_open" ]
    assert.equal(herdrSc.ProtectHostname, true);
    assert.equal(herdrSc.ProtectKernelLogs, true);
    assert.equal(herdrSc.ProtectKernelTunables, true);
    assert.deepEqual(herdrSc.RestrictAddressFamilies, ["AF_INET", "AF_INET6", "AF_UNIX"]);
    assert.ok(
      herdrSc.SystemCallFilter.includes("~perf_event_open"),
      `genie-herdr@${tier} SystemCallFilter must include ~perf_event_open (K9)`,
    );
    assert.equal(herdrSc.SystemCallErrorNumber, "EPERM");

    // 3. ZDOTDIR & BindPaths & BindReadOnlyPaths & InaccessiblePaths on genie-herdr@<tier>
    assert.ok(
      typeof herdrUnit.environment.ZDOTDIR === "string" &&
        herdrUnit.environment.ZDOTDIR.startsWith("/nix/store/") &&
        herdrUnit.environment.ZDOTDIR.endsWith("-genie-expert-zdotdir"),
      `expected store expertZdotdir in genie-herdr@${tier} ZDOTDIR, got ${herdrUnit.environment.ZDOTDIR}`,
    );
    assert.deepEqual(herdrSc.BindPaths, [
      "/run/user/1000/xmsg",
      `/var/lib/genie-agent/herdr-session-${tier}:/var/lib/genie-agent/.config/herdr/sessions/genie-${tier}`,
    ]);
    assert.ok(herdrSc.BindReadOnlyPaths.includes(expectedRepo));
    assert.ok(herdrSc.BindReadOnlyPaths.includes(expectedMem));
    for (const suffix of [
      `:/var/lib/genie-agent/claude-${tier}/settings.json`,
      `:/var/lib/genie-agent/claude-${tier}/.claude.json`,
      `:/var/lib/genie-agent/claude-${tier}/.config.json`,
      `:/var/lib/genie-agent/claude-${tier}/CLAUDE.md`,
      `:/var/lib/genie-agent/claude-${tier}/hooks`,
      `:/var/lib/genie-agent/claude-${tier}/plugins`,
      `:/var/lib/genie-agent/claude-${tier}/cowork_plugins`,
      `:/var/lib/genie-agent/claude-${tier}/commands`,
      `:/var/lib/genie-agent/claude-${tier}/skills`,
      `:/var/lib/genie-agent/claude-${tier}/agents`,
      `:/var/lib/genie-agent/claude-${tier}/rules`,
      `:/var/lib/genie-agent/claude-${tier}/workflows`,
      `:/var/lib/genie-agent/claude-${tier}/routines`,
      `:/var/lib/genie-agent/claude-${tier}/output-styles`,
      ":/var/lib/genie-agent/.claude.json",
      ":/var/lib/genie-agent/.zshenv",
      ":/var/lib/genie-agent/.zshrc",
      ":/var/lib/genie-agent/.zprofile",
      ":/var/lib/genie-agent/.zlogin",
      ":/var/lib/genie-agent/.zlogout",
      ":/var/lib/genie-agent/.bashrc",
      ":/var/lib/genie-agent/.bash_profile",
      ":/var/lib/genie-agent/.bash_login",
      ":/var/lib/genie-agent/.bash_logout",
      ":/var/lib/genie-agent/.profile",
      ":/var/lib/genie-agent/.bash_completion",
      ":/var/lib/genie-agent/.inputrc",
      ":/var/lib/genie-agent/.envrc",
      ":/var/lib/genie-agent/.nix-profile",
      ":/var/lib/genie-agent/.local/state/nix/profile",
      ":/var/lib/genie-agent/.config/herdr",
    ]) {
      assert.ok(
        herdrSc.BindReadOnlyPaths.some((p: string) => p.endsWith(suffix)),
        `expected BindReadOnlyPaths ending with ${suffix} on genie-herdr@${tier}`,
      );
    }

    for (const masked of [
      "-/run/credentials",
      "/var/lib/genie-agent/dispatcher-" + other,
      "/var/lib/genie-agent/claude-" + other,
      "/var/lib/genie-agent/cwd-" + other,
      "/var/lib/genie-agent/herdr-session-" + other,
      `-/var/lib/genie-agent/.config/herdr/sessions/genie-${other}`,
    ]) {
      assert.ok(
        herdrSc.InaccessiblePaths.includes(masked),
        `expected ${masked} in genie-herdr@${tier}.InaccessiblePaths`,
      );
    }

    // 4. genie-herdr@<tier>.path includes bubblewrap, xmsg, and ripgrep
    assert.ok(herdrUnit.path.some((p: string) => p.includes("bubblewrap")));
    assert.ok(herdrUnit.path.some((p: string) => p.includes("xmsg")));
    assert.ok(herdrUnit.path.some((p: string) => p.includes("ripgrep")));

    // 5. Inspect .claude.json derivation (K5, P10)
    const claudeJsonBind = herdrSc.BindReadOnlyPaths.find((p: string) =>
      p.endsWith(`:/var/lib/genie-agent/claude-${tier}/.claude.json`),
    );
    assert.ok(claudeJsonBind);
    const claudeJson = JSON.parse(readFileSync(claudeJsonBind.split(":")[0], "utf8"));
    assert.equal(claudeJson.hasCompletedOnboarding, true);
    assert.equal(claudeJson.hasTrustDialogAccepted, true);
    assert.equal(claudeJson.mcpServers.xmsg.type, "stdio");
    assert.match(claudeJson.mcpServers.xmsg.command, /\/bin\/xmsg$/);
    assert.deepEqual(claudeJson.mcpServers.xmsg.args, ["mcp"]);

    // 6. Inspect settings.json derivation (M11.1, P6, P8, P11)
    const settingsBind = herdrSc.BindReadOnlyPaths.find((p: string) =>
      p.endsWith(`:/var/lib/genie-agent/claude-${tier}/settings.json`),
    );
    assert.ok(settingsBind);
    const settings = JSON.parse(readFileSync(settingsBind.split(":")[0], "utf8"));
    assert.equal(settings.includeGitInstructions, false);
    assert.deepEqual(settings.sandbox, { enabled: false });
    for (const rule of [
      "Read(//var/lib/genie-agent/.config/herdr/**)",
      `Read(//var/lib/genie-agent/herdr-session-${tier}/**)`,
      `Read(//var/lib/genie-agent/dispatcher-${tier}/launch/**)`,
      `Read(//var/lib/genie-agent/dispatcher-${tier}/journal.json)`,
      "Read(//run/credentials/**)",
      "Edit(//var/lib/genie-agent/.*)",
      "Edit(//var/lib/genie-agent/.*/**)",
      `Edit(//var/lib/genie-agent/claude-${tier}/**)`,
      `Edit(//var/lib/genie-agent/herdr-session-${tier}/**)`,
      `Edit(//var/lib/genie-agent/dispatcher-${tier}/journal.json)`,
      `Edit(//var/lib/genie-agent/dispatcher-${tier}/source-repos/**)`,
      `Edit(//var/lib/genie-agent/dispatcher-${tier}/worktrees/.*)`,
      `Edit(//var/lib/genie-agent/dispatcher-${tier}/worktrees/.*/**)`,
      "Edit(**/.claude/**)",
      "Edit(**/.mcp.json)",
      "Edit(//**/.claude/**)",
      "Edit(//**/.mcp.json)",
      "Edit(//**/.git/hooks/**)",
      "Edit(//**/.git/config)",
    ]) {
      assert.ok(settings.permissions.deny.includes(rule), `expected deny rule ${rule} in claude-${tier}-settings.json`);
    }

    // 7. Inspect genie-claude-shim derivation (P7, K8, Arm A)
    const shimMatch = /--claude-bin (\/nix\/store\/[^ ]+-genie-claude-shim-[^ ]+\/bin\/genie-claude-shim)/.exec(
      dispSc.ExecStart,
    );
    assert.ok(shimMatch, `expected genie-claude-shim in genie-dispatcher@${tier} ExecStart`);
    const shimText = readFileSync(shimMatch[1], "utf8");
    const firstLine = shimText.split("\n")[0];
    assert.match(firstLine, /^#!\/nix\/store\/[^/]+-python3-[^/]+\/bin\/python3 -I$/);
    assert.ok(!firstLine.includes("/usr/bin/env"));
    assert.ok(shimText.includes('"--unshare-user"'));
    assert.ok(shimText.includes('"--unshare-pid"'));
    assert.ok(shimText.includes('"--tmpfs", STATE_DIR'));
    assert.ok(shimText.includes('"--remount-ro", STATE_DIR'));
    assert.ok(shimText.includes('*(["--ro-bind", XMSG_SOCKET, XMSG_SOCKET] if XMSG_SOCKET else [])'));
    assert.ok(!shimText.includes('"--bind", XMSG_SOCKET'));

    // 8. genie-dispatcher@<tier> has LoadCredential, PrivatePIDs == false, K9 SystemCallFilter = [ "~perf_event_open" ], and bootstrap does not install settings.json / .claude.json
    assert.equal(dispSc.EnvironmentFile, null);
    assert.deepEqual(dispSc.LoadCredential, [`tier-token:/run/agenix/genie-expert-${tier}-token`]);
    assert.equal(dispSc.PrivatePIDs, false, `genie-dispatcher@${tier} must set PrivatePIDs = false for SO_PEERPIDFD`);
    assert.ok(
      dispSc.SystemCallFilter.includes("~perf_event_open"),
      `genie-dispatcher@${tier} SystemCallFilter must include ~perf_event_open (K9/GH1)`,
    );
    assert.equal(dispSc.SystemCallErrorNumber, "EPERM");
    const bootstrap = readFileSync(dispSc.ExecStartPre, "utf8");
    assert.ok(!bootstrap.includes("settings.json"), "bootstrap must not install settings.json");
    assert.ok(!bootstrap.includes(".claude.json"), "bootstrap must not install .claude.json");
    const credLines = bootstrap.split("\n").filter((l) => l.includes(".credentials.json"));
    assert.deepEqual(
      credLines.map((l) => l.trim()),
      [`rm -f "/var/lib/genie-agent/claude-${tier}/.credentials.json"`],
      `genie-dispatcher@${tier} bootstrap must only remove a stale credential`,
    );
  }
  assert.deepEqual(summary.localFailedAssertions, []);
  assert.deepEqual(summary.noTierTokenFailedAssertions, [
    "services.genie-agent.experts.enable requires experts.herdrPackage, experts.xmsgPackage, experts.public.tokenEnvironmentFile and experts.trusted.tokenEnvironmentFile to be set.",
  ]);
  assert.equal(
    summary.unpatchedHerdrThrows,
    true,
    "a non-null herdrPackage without src must throw at evaluation rather than passing unpatched",
  );
  assert.equal(
    summary.missingXmsgPackageThrows,
    true,
    "experts enabled without a resolvable xmsgPackage must throw at evaluation rather than falling back to a dead stub (GF2)",
  );
  assert.equal(
    summary.nullXmsgPackageThrows,
    true,
    "experts enabled with xmsgPackage = null must throw at evaluation (GF2)",
  );
});

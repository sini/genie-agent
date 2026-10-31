{ packages }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.genie-agent;
  shared = import ./options.nix;
  secretPath = shared.secretPathType lib;
  sysPackages = packages.${pkgs.stdenv.hostPlatform.system};

  runtimeDir =
    if cfg.xmsgSocket != null then builtins.dirOf (toString cfg.xmsgSocket) else "/run/genie-agent";

  credDir = "/run/credentials/genie-agent.service";
  modelKeyRuntime = "${credDir}/model-key";
  guardOutKeyRuntime =
    if cfg.broker.guardOut.enable && cfg.broker.guardOut.keyFile != null then
      "${credDir}/guard-out-key"
    else
      null;
  brokerTokenRuntime = if cfg.broker.tokenFile != null then "${credDir}/broker-token" else null;
  s3SecretKeyRuntime = if cfg.s3 != null then "${credDir}/s3-secret-key" else null;

  rootConfigJson = shared.mkRootConfigJson { inherit lib pkgs; } cfg {
    modelKeyFile = modelKeyRuntime;
    guardOutKeyFile = guardOutKeyRuntime;
    brokerTokenFile = brokerTokenRuntime;
    s3SecretKeyFile = s3SecretKeyRuntime;
  };

  commonHardening = {
    CapabilityBoundingSet = "";
    DevicePolicy = "closed";
    LockPersonality = true;
    NoNewPrivileges = true;
    PrivateDevices = true;
    PrivateTmp = true;
    PrivateUsers = if cfg.xmsgSocket != null then false else true;
    ProtectClock = true;
    ProtectHome = if cfg.xmsgSocket != null then "tmpfs" else true;
    ProtectHostname = true;
    ProtectKernelLogs = true;
    ProtectKernelModules = true;
    ProtectKernelTunables = true;
    ProtectSystem = "strict";
    RestrictAddressFamilies = [
      "AF_INET"
      "AF_INET6"
      "AF_UNIX"
    ];
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    SystemCallArchitectures = "native";
    UMask = "0077";
  };

  effectiveGroup =
    if cfg.group != null then
      cfg.group
    else if cfg.user == "genie-agent" then
      "genie-agent"
    else
      null;

  effectiveGroupOrDash = if effectiveGroup != null then effectiveGroup else "-";

  emptyStoreFile = pkgs.writeText "genie-empty-file" "";
  emptyJsonFile = pkgs.writeText "genie-empty.json" "{}\n";
  emptyStoreDir = pkgs.runCommand "genie-empty-dir" { } "mkdir -p $out";
  expertZdotdir = pkgs.runCommand "genie-expert-zdotdir" { } ''
    mkdir -p $out
    : > $out/.zshenv
    : > $out/.zshrc
    : > $out/.zprofile
    : > $out/.zlogin
    : > $out/.zlogout
  '';
  mkReadOnlyHerdrConfigDir =
    tier:
    pkgs.runCommand "genie-herdr-ro-config-${tier}" { } ''
      mkdir -p $out/sessions/genie-${tier} $out/plugins
      : > $out/config.toml
    '';

  defaultClaudePackage = pkgs.claude-code.overrideAttrs (old: {
    meta = removeAttrs (old.meta or { }) [ "license" ];
  });

  mkExpertSettingsJson =
    tier:
    let
      stateRel = lib.removePrefix "/" (toString cfg.stateDir);
    in
    (pkgs.formats.json { }).generate "genie-claude-${tier}-settings.json" {
      includeGitInstructions = false;
      permissions = {
        defaultMode = cfg.experts.permissionMode;
        allow = [
          "Read"
          "Edit"
          "Write"
          "Grep"
          "Glob"
          "LS"
          "Bash"
          "mcp__xmsg__reply"
          "mcp__plugin_hm_xmsg__reply"
        ];
        deny = [
          "Bash(git push*)"
          "Bash(git push:*)"
          "Bash(gh pr*)"
          "Bash(gh pr:*)"
          "Bash(gh repo*)"
          "Bash(gh gist*)"
          "Bash(gh issue*)"
          "Bash(gh release*)"
          "Bash(gh api*)"
          "Read(//${stateRel}/.config/herdr/**)"
          "Read(//${stateRel}/herdr-session-${tier}/**)"
          "Read(//${stateRel}/dispatcher-${tier}/launch/**)"
          "Read(//${stateRel}/dispatcher-${tier}/journal.json)"
          "Read(//run/credentials/**)"
          "Edit(//${stateRel}/.*)"
          "Edit(//${stateRel}/.*/**)"
          "Edit(//${stateRel}/claude-${tier}/**)"
          "Edit(//${stateRel}/herdr-session-${tier}/**)"
          "Edit(//${stateRel}/dispatcher-${tier}/journal.json)"
          "Edit(//${stateRel}/dispatcher-${tier}/source-repos/**)"
          "Edit(//${stateRel}/dispatcher-${tier}/worktrees/.*)"
          "Edit(//${stateRel}/dispatcher-${tier}/worktrees/.*/**)"
          "Edit(**/.claude/**)"
          "Edit(**/.mcp.json)"
          "Edit(//**/.claude/**)"
          "Edit(//**/.mcp.json)"
          "Edit(//**/.git/hooks/**)"
          "Edit(//**/.git/config)"
        ];
      };
      sandbox = {
        enabled = false;
      };
    };

  mkExpertClaudeJson =
    tier:
    let
      tierCwd = "${cfg.stateDir}/cwd-${tier}";
      dispDir = "${cfg.stateDir}/dispatcher-${tier}";
    in
    (pkgs.formats.json { }).generate "genie-claude-${tier}-claude.json" {
      hasCompletedOnboarding = true;
      hasTrustDialogAccepted = true;
      mcpServers = {
        xmsg = {
          type = "stdio";
          command = "${lib.getExe cfg.experts.xmsgPackage}";
          args = [ "mcp" ];
          env = { };
        };
      };
      projects = {
        "${tierCwd}" = {
          hasTrustDialogAccepted = true;
        };
        "${dispDir}" = {
          hasTrustDialogAccepted = true;
        };
      };
    };

  mkExpertClaudeMd =
    tier:
    pkgs.writeText "genie-expert-${tier}-CLAUDE.md" ''
      # Genie Expert (${tier} tier)

      - your working copy is your cwd; never edit `./source-repos` (your working copy is your cwd; never edit ./source-repos).
      - Source checkouts (`./source-repos`) are read-only sources, never a workspace. If your cwd is an empty per-thread directory, clone from `./source-repos/<repo>` into your cwd.
      - Never run `git push`, `gh pr`, or remote writes directly; outbound changes go only through the proposal broker (`propose`).
      - Consult `./memory/MEMORY.md` for operating context.
    '';

  mkExpertClaudeShim =
    tier:
    let
      claudeDir = "${cfg.stateDir}/claude-${tier}";
      dispStateDir = "${cfg.stateDir}/dispatcher-${tier}";
      settingsJson = mkExpertSettingsJson tier;
      claudeJson = mkExpertClaudeJson tier;
      claudeMd = mkExpertClaudeMd tier;
      realClaudeBin = lib.getExe (
        if cfg.experts.claudePackage != null then cfg.experts.claudePackage else defaultClaudePackage
      );
      xmsgSockStr = if cfg.xmsgSocket != null then toString cfg.xmsgSocket else "";
    in
    pkgs.writeTextFile {
      name = "genie-claude-shim-${tier}";
      destination = "/bin/genie-claude-shim";
      executable = true;
      meta.mainProgram = "genie-claude-shim";
      text = ''
        #!${pkgs.python3}/bin/python3 -I
        import os
        import re
        import socket
        import stat
        import sys

        STATE_DIR = ${builtins.toJSON (toString cfg.stateDir)}
        DISP_STATE_DIR = ${builtins.toJSON dispStateDir}
        CLAUDE_DIR = ${builtins.toJSON claudeDir}
        SETTINGS_JSON = ${builtins.toJSON (toString settingsJson)}
        CLAUDE_JSON = ${builtins.toJSON (toString claudeJson)}
        EMPTY_JSON = ${builtins.toJSON (toString emptyJsonFile)}
        CLAUDE_MD = ${builtins.toJSON (toString claudeMd)}
        EMPTY_DIR = ${builtins.toJSON (toString emptyStoreDir)}
        XMSG_SOCKET = ${builtins.toJSON xmsgSockStr}
        BWRAP_BIN = "${pkgs.bubblewrap}/bin/bwrap"
        REAL_CLAUDE_BIN = ${builtins.toJSON realClaudeBin}

        def die(msg: str) -> "None":
            sys.stderr.write(f"genie-claude-shim: {msg}\n")
            sys.exit(2)

        def parse_argv(argv: list[str]) -> tuple[str, str, str, list[str]]:
            if "--" not in argv:
                die("missing '--' separator")
            sep = argv.index("--")
            head = argv[:sep]
            claude_args = argv[sep + 1 :]
            if len(head) != 6 or head[0] != "--token-sock" or head[2] != "--thread-id" or head[4] != "--cwd":
                die(f"invalid shim arguments: {head!r}")
            return head[1], head[3], head[5], claude_args

        def main() -> None:
            sock_path, thread_id, pane_cwd, claude_args = parse_argv(sys.argv[1:])
            if thread_id in (".", "..") or not re.match(r"^[A-Za-z0-9_.-]{1,128}$", thread_id):
                die(f"invalid thread_id: {thread_id!r}")

            wt_root = f"{DISP_STATE_DIR}/worktrees/{thread_id}"
            norm_cwd = os.path.normpath(pane_cwd)
            if (
                not pane_cwd.startswith("/")
                or ".." in pane_cwd.split("/")
                or not (norm_cwd == wt_root or norm_cwd.startswith(wt_root + "/"))
            ):
                die(f"invalid --cwd {pane_cwd!r} for thread {thread_id!r}")
            worktree_cwd = norm_cwd

            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                s.connect(sock_path)
                _msg, fds, _flags, _addr = socket.recv_fds(s, 16, 1)
            finally:
                s.close()

            if not fds:
                die("did not receive token socketpair fd over SCM_RIGHTS")
            tok_fd = fds[0]
            st = os.fstat(tok_fd)
            if not stat.S_ISSOCK(st.st_mode):
                die(f"received fd {tok_fd} is not an AF_UNIX socket (mode={oct(st.st_mode)})")

            try:
                os.unlink(sock_path)
            except FileNotFoundError:
                pass

            env = dict(os.environ)
            for k in (
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
                "ANTIGRAVITY_SOURCE_METADATA",
            ):
                env.pop(k, None)

            os.set_inheritable(tok_fd, True)
            env["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"] = str(tok_fd)

            bwrap_argv = [
                BWRAP_BIN,
                "--die-with-parent",
                "--unshare-user",
                "--unshare-pid",
                "--ro-bind", "/", "/",
                "--dev", "/dev",
                "--bind", "/proc", "/proc",
                "--tmpfs", "/tmp",
                "--tmpfs", STATE_DIR,
                "--bind", wt_root, wt_root,
                "--bind", f"{DISP_STATE_DIR}/claude-threads/{thread_id}", CLAUDE_DIR,
                "--ro-bind", SETTINGS_JSON, f"{CLAUDE_DIR}/settings.json",
                "--ro-bind", CLAUDE_JSON, f"{CLAUDE_DIR}/.claude.json",
                "--ro-bind", EMPTY_JSON, f"{CLAUDE_DIR}/.config.json",
                "--ro-bind", CLAUDE_MD, f"{CLAUDE_DIR}/CLAUDE.md",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/hooks",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/plugins",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/cowork_plugins",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/commands",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/skills",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/agents",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/rules",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/workflows",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/routines",
                "--ro-bind", EMPTY_DIR, f"{CLAUDE_DIR}/output-styles",
                *(["--ro-bind", XMSG_SOCKET, XMSG_SOCKET] if XMSG_SOCKET else []),
                "--remount-ro", STATE_DIR,
                "--chdir", worktree_cwd,
                "--",
                REAL_CLAUDE_BIN,
                *claude_args,
            ]
            os.execve(BWRAP_BIN, bwrap_argv, env)

        if __name__ == "__main__":
            main()
      '';
    };

  mkTierUnits =
    tier: tierCfg:
    let
      otherTier = if tier == "public" then "trusted" else "public";
      claudeDir = "${cfg.stateDir}/claude-${tier}";
      cwdDir = "${cfg.stateDir}/cwd-${tier}";
      dispStateDir = "${cfg.stateDir}/dispatcher-${tier}";
      sessionName = "genie-${tier}";
      settingsJson = mkExpertSettingsJson tier;
      claudeJson = mkExpertClaudeJson tier;
      claudeMd = mkExpertClaudeMd tier;
      claudeShim = mkExpertClaudeShim tier;
      dispCredPath = "/run/credentials/genie-dispatcher@${tier}.service/tier-token";
      bootstrapScript = pkgs.writeShellScript "genie-expert-${tier}-bootstrap" ''
        set -euo pipefail
        [ "$(${pkgs.coreutils}/bin/cat /proc/sys/kernel/yama/ptrace_scope)" -ge 1 ] || {
          echo "genie-expert-${tier}-bootstrap: kernel.yama.ptrace_scope must be >= 1" >&2
          exit 1
        }
        mkdir -p -m 0700 "${claudeDir}" "${claudeDir}/sessions" "${claudeDir}/transcripts"
        mkdir -p -m 0700 "${cwdDir}" "${dispStateDir}" "${dispStateDir}/launch" "${dispStateDir}/worktrees" "${dispStateDir}/claude-threads"
        mkdir -p -m 0700 "${cfg.stateDir}/herdr-session-${tier}"
        # A credential left by the old symlink layout must not survive into the tier.
        rm -f "${claudeDir}/.credentials.json"
        install -m 0644 "${claudeMd}" "${cwdDir}/CLAUDE.md"
        install -m 0644 "${claudeMd}" "${dispStateDir}/CLAUDE.md"
        ln -sfn "${tierCfg.reposDir}" "${cwdDir}/source-repos"
        ln -sfn "${tierCfg.memoryDir}" "${cwdDir}/memory"
        ln -sfn "${tierCfg.reposDir}" "${dispStateDir}/source-repos"
        ln -sfn "${tierCfg.memoryDir}" "${dispStateDir}/memory"
      '';
      herdrBindPaths = lib.optional (cfg.xmsgSocket != null) (toString cfg.xmsgSocket) ++ [
        "${cfg.stateDir}/herdr-session-${tier}:${cfg.stateDir}/.config/herdr/sessions/genie-${tier}"
      ];
      herdrBindReadOnlyPaths = [
        tierCfg.reposDir
        tierCfg.memoryDir
        "${settingsJson}:${claudeDir}/settings.json"
        "${claudeJson}:${claudeDir}/.claude.json"
        "${emptyJsonFile}:${claudeDir}/.config.json"
        "${claudeMd}:${claudeDir}/CLAUDE.md"
        "${emptyStoreDir}:${claudeDir}/hooks"
        "${emptyStoreDir}:${claudeDir}/plugins"
        "${emptyStoreDir}:${claudeDir}/cowork_plugins"
        "${emptyStoreDir}:${claudeDir}/commands"
        "${emptyStoreDir}:${claudeDir}/skills"
        "${emptyStoreDir}:${claudeDir}/agents"
        "${emptyStoreDir}:${claudeDir}/rules"
        "${emptyStoreDir}:${claudeDir}/workflows"
        "${emptyStoreDir}:${claudeDir}/routines"
        "${emptyStoreDir}:${claudeDir}/output-styles"
        "${claudeJson}:${cfg.stateDir}/.claude.json"
        "${emptyStoreFile}:${cfg.stateDir}/.zshenv"
        "${emptyStoreFile}:${cfg.stateDir}/.zshrc"
        "${emptyStoreFile}:${cfg.stateDir}/.zprofile"
        "${emptyStoreFile}:${cfg.stateDir}/.zlogin"
        "${emptyStoreFile}:${cfg.stateDir}/.zlogout"
        "${emptyStoreFile}:${cfg.stateDir}/.bashrc"
        "${emptyStoreFile}:${cfg.stateDir}/.bash_profile"
        "${emptyStoreFile}:${cfg.stateDir}/.bash_login"
        "${emptyStoreFile}:${cfg.stateDir}/.bash_logout"
        "${emptyStoreFile}:${cfg.stateDir}/.profile"
        "${emptyStoreFile}:${cfg.stateDir}/.bash_completion"
        "${emptyStoreFile}:${cfg.stateDir}/.inputrc"
        "${emptyStoreFile}:${cfg.stateDir}/.envrc"
        "${emptyStoreDir}:${cfg.stateDir}/.nix-profile"
        "${emptyStoreDir}:${cfg.stateDir}/.local/state/nix/profile"
        "${mkReadOnlyHerdrConfigDir tier}:${cfg.stateDir}/.config/herdr"
      ];
      herdrInaccessiblePaths = [
        "-/run/credentials"
        "-/run/agenix"
        "-/run/agenix.d"
        "-/run/genie-secrets"
        "${cfg.stateDir}/claude-${otherTier}"
        "${cfg.stateDir}/cwd-${otherTier}"
        "${cfg.stateDir}/dispatcher-${otherTier}"
        "${cfg.stateDir}/herdr-session-${otherTier}"
        "-${cfg.stateDir}/.config/herdr/sessions/genie-${otherTier}"
      ];
      dispBindPaths = herdrBindPaths;
      dispBindReadOnlyPaths = [
        tierCfg.reposDir
        tierCfg.memoryDir
      ];
      dispInaccessiblePaths = [
        "-/run/agenix"
        "-/run/agenix.d"
        "-/run/genie-secrets"
        "${cfg.stateDir}/claude-${otherTier}"
        "${cfg.stateDir}/cwd-${otherTier}"
        "${cfg.stateDir}/dispatcher-${otherTier}"
        "${cfg.stateDir}/herdr-session-${otherTier}"
        "-${cfg.stateDir}/.config/herdr/sessions/genie-${otherTier}"
      ];
      herdrPackages = [
        cfg.experts.herdrPackage
        claudeShim
        pkgs.bubblewrap
        cfg.experts.xmsgPackage
        pkgs.ripgrep
        pkgs.python3
        pkgs.git
        pkgs.nix
        pkgs.coreutils
        pkgs.bash
      ]
      ++ lib.optional (cfg.experts.claudePackage != null) cfg.experts.claudePackage;
      modelFlag = lib.optionalString (
        tierCfg.model != null
      ) " --model ${lib.escapeShellArg tierCfg.model}";
      claudeBinFlag = " --claude-bin ${lib.escapeShellArg (lib.getExe claudeShim)}";
      tokenCredFlag = lib.optionalString (
        tierCfg.tokenEnvironmentFile != null
      ) " --token-credential-file ${lib.escapeShellArg dispCredPath}";
    in
    {
      "genie-herdr@${tier}" = {
        description = "genie-agent headless herdr server (${tier} tier)";
        after = [ "network.target" ];
        wantedBy = [ "multi-user.target" ];
        path = herdrPackages;
        environment = {
          HOME = toString cfg.stateDir;
          XDG_RUNTIME_DIR = runtimeDir;
          ZDOTDIR = toString expertZdotdir;
        };
        serviceConfig =
          commonHardening
          // {
            Type = "simple";
            User = cfg.user;
            StateDirectory = "genie-agent";
            RuntimeDirectory = "genie-agent";
            WorkingDirectory = toString cfg.stateDir;
            # No setsid: systemd already makes the main process a session leader, so setsid
            # would fork, exit 0, and take the unit down.
            ExecStart = "${lib.getExe cfg.experts.herdrPackage} --session ${sessionName} server";
            Restart = "on-failure";
            RestartSec = "5s";
            ProtectControlGroups = true;
            # Same uid as the operator with PrivateUsers off: without a PID namespace,
            # /proc/<pid>/root walks into the operator's mount namespace past every bind,
            # and PrivatePIDs=true hides host and genie-dispatcher@* PIDs from herdr's /proc.
            PrivatePIDs = true;
            SystemCallFilter = [ "~perf_event_open" ];
            SystemCallErrorNumber = "EPERM";
            BindPaths = lib.unique herdrBindPaths;
            BindReadOnlyPaths = lib.unique herdrBindReadOnlyPaths;
            InaccessiblePaths = lib.unique herdrInaccessiblePaths;
          }
          // lib.optionalAttrs (effectiveGroup != null) {
            Group = effectiveGroup;
          };
      };

      "genie-dispatcher@${tier}" = {
        description = "genie-agent expert dispatcher (${tier} tier)";
        after = [
          "network.target"
          "genie-herdr@${tier}.service"
        ];
        requires = [ "genie-herdr@${tier}.service" ];
        wantedBy = [ "multi-user.target" ];
        path = herdrPackages;
        environment = {
          HOME = toString cfg.stateDir;
          XDG_RUNTIME_DIR = runtimeDir;
        };
        serviceConfig =
          commonHardening
          // {
            Type = "simple";
            User = cfg.user;
            StateDirectory = "genie-agent";
            RuntimeDirectory = "genie-agent";
            WorkingDirectory = toString cfg.stateDir;
            ExecStartPre = "${bootstrapScript}";
            ExecStart = "${lib.getExe cfg.experts.dispatcherPackage} --state-dir ${dispStateDir} --herdr-session ${sessionName} --cwd ${cwdDir} --token-config-dir ${claudeDir} --service-name ${tierCfg.serviceName}${modelFlag}${claudeBinFlag}${tokenCredFlag}";
            Restart = "on-failure";
            RestartSec = "5s";
            ProtectControlGroups = true;
            # PrivatePIDs = false so genie-dispatcher runs in the ancestor (host) PID namespace
            # and SO_PEERPIDFD resolves peers in genie-herdr@<tier>'s child PID namespace.
            PrivatePIDs = false;
            SystemCallFilter = [ "~perf_event_open" ];
            SystemCallErrorNumber = "EPERM";
            LoadCredential = lib.optional (
              tierCfg.tokenEnvironmentFile != null
            ) "tier-token:${toString tierCfg.tokenEnvironmentFile}";
            BindPaths = lib.unique dispBindPaths;
            BindReadOnlyPaths = lib.unique dispBindReadOnlyPaths;
            InaccessiblePaths = lib.unique dispInaccessiblePaths;
          }
          // lib.optionalAttrs (effectiveGroup != null) {
            Group = effectiveGroup;
          };
      };
    };
in
{
  options.services.genie-agent =
    (shared.mkCommonOptions {
      inherit
        lib
        pkgs
        packages
        cfg
        ;
      defaultStateDir = "/var/lib/genie-agent";
      defaultXmsgSocket = null;
    })
    // {
      user = lib.mkOption {
        type = lib.types.str;
        default = "genie-agent";
        example = "sini";
        description = "OS user account under which genie-agent local units run.";
      };

      group = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Optional OS group under which genie-agent local units run.";
      };

      dynamicUser = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether to run genie-agent with systemd DynamicUser (must be false when xmsgSocket is set).";
      };
    };

  config = lib.mkIf cfg.enable {
    assertions = (shared.mkCommonAssertions { inherit lib cfg; }) ++ [
      {
        assertion = cfg.xmsgSocket != null -> !cfg.dynamicUser;
        message = "services.genie-agent: when xmsgSocket is configured, dynamicUser must be false because xmsg's UID and /proc/<pid>/exe attestation requires running as the socket's owning user.";
      }
      {
        assertion = cfg.experts.enable -> cfg.xmsgSocket != null;
        message = "services.genie-agent.experts.enable requires services.genie-agent.xmsgSocket != null.";
      }
      {
        assertion = cfg.experts.enable -> (config.boot.kernel.sysctl."kernel.yama.ptrace_scope" or 1) >= 1;
        message = "services.genie-agent.experts.enable requires boot.kernel.sysctl.\"kernel.yama.ptrace_scope\" >= 1.";
      }
    ];

    boot.kernel.sysctl = lib.mkIf cfg.experts.enable {
      "kernel.yama.ptrace_scope" = lib.mkDefault 1;
    };

    users.users = lib.mkIf (!cfg.dynamicUser && cfg.user == "genie-agent") {
      genie-agent = {
        isSystemUser = true;
        group = if cfg.group != null then cfg.group else "genie-agent";
        description = "genie-agent service daemon user";
        home = toString cfg.stateDir;
      };
    };

    users.groups =
      lib.mkIf
        (!cfg.dynamicUser && cfg.user == "genie-agent" && (cfg.group == null || cfg.group == "genie-agent"))
        {
          genie-agent = { };
        };

    # Mount targets and isolated directories exist, owned by the service user, before any tier unit's namespace is set up.
    systemd.tmpfiles.rules = lib.optionals cfg.experts.enable (
      [
        "d ${toString cfg.stateDir} 0700 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.claude.json 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.zshenv 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.zshrc 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.zprofile 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.zlogin 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.zlogout 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.bashrc 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.bash_profile 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.bash_login 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.bash_logout 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.profile 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.bash_completion 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.inputrc 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "f ${toString cfg.stateDir}/.envrc 0400 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.nix-profile 0500 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.local 0700 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.local/state 0700 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.local/state/nix 0700 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.local/state/nix/profile 0500 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.config 0700 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.config/herdr 0700 ${cfg.user} ${effectiveGroupOrDash} -"
        "d ${toString cfg.stateDir}/.config/herdr/sessions 0700 ${cfg.user} ${effectiveGroupOrDash} -"
      ]
      ++
        lib.concatMap
          (tier: [
            "d ${toString cfg.stateDir}/claude-${tier} 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "f ${toString cfg.stateDir}/claude-${tier}/settings.json 0400 ${cfg.user} ${effectiveGroupOrDash} -"
            "f ${toString cfg.stateDir}/claude-${tier}/.claude.json 0400 ${cfg.user} ${effectiveGroupOrDash} -"
            "f ${toString cfg.stateDir}/claude-${tier}/.config.json 0400 ${cfg.user} ${effectiveGroupOrDash} -"
            "f ${toString cfg.stateDir}/claude-${tier}/CLAUDE.md 0400 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/hooks 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/plugins 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/cowork_plugins 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/commands 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/skills 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/agents 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/rules 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/workflows 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/routines 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/claude-${tier}/output-styles 0500 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/cwd-${tier} 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/dispatcher-${tier} 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/dispatcher-${tier}/launch 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/dispatcher-${tier}/worktrees 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/dispatcher-${tier}/claude-threads 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/herdr-session-${tier} 0700 ${cfg.user} ${effectiveGroupOrDash} -"
            "d ${toString cfg.stateDir}/.config/herdr/sessions/genie-${tier} 0700 ${cfg.user} ${effectiveGroupOrDash} -"
          ])
          [
            "public"
            "trusted"
          ]
    );

    systemd.services = {
      genie-agent = {
        description = "genie-agent Tier-1 composition root service";
        after = [ "network.target" ] ++ lib.optional cfg.guard.enable "genie-guard.service";
        wantedBy = [ "multi-user.target" ];
        path = [
          cfg.piPackage
          pkgs.bubblewrap
          pkgs.nix
          pkgs.git
          pkgs.coreutils
        ];

        environment = {
          HOME = toString cfg.stateDir;
          XDG_RUNTIME_DIR = runtimeDir;
          NIX_SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
          SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        }
        // lib.optionalAttrs (cfg.package ? rootSrc) {
          GENIE_REPO_ROOT = "${cfg.package.rootSrc}/lib/genie-agent";
        };

        serviceConfig =
          commonHardening
          // {
            Type = "simple";
            DynamicUser = cfg.dynamicUser;
            User = lib.mkIf (!cfg.dynamicUser) cfg.user;
            StateDirectory = "genie-agent";
            RuntimeDirectory = "genie-agent";
            WorkingDirectory = toString cfg.stateDir;
            ExecStart = "${lib.getExe cfg.package} --config ${rootConfigJson}";
            Restart = "on-failure";
            RestartSec = "5s";
            TimeoutStopSec = 60;

            # Cgroup delegation (E2.3): required when eval.memoryMax is set so each eval
            # runs in its own child cgroup with memory.max enforced.
            Delegate = cfg.eval.memoryMax != null;
            ProtectControlGroups = cfg.eval.memoryMax == null;

            LoadCredential = [
              "model-key:${toString cfg.model.keyFile}"
            ]
            ++ lib.optional (
              cfg.broker.guardOut.enable && cfg.broker.guardOut.keyFile != null
            ) "guard-out-key:${toString cfg.broker.guardOut.keyFile}"
            ++ lib.optional (cfg.broker.tokenFile != null) "broker-token:${toString cfg.broker.tokenFile}"
            ++ lib.optional (cfg.s3 != null) "s3-secret-key:${toString cfg.s3.secretKeyFile}";

            BindReadOnlyPaths = [ "${cfg.operatingMemoryPackage}:${cfg.tier1.memoryRoot}" ];
          }
          // lib.optionalAttrs (effectiveGroup != null) {
            Group = effectiveGroup;
          }
          // lib.optionalAttrs (cfg.xmsgSocket != null) {
            BindPaths = [ (toString cfg.xmsgSocket) ];
          };
      };
    }
    // lib.optionalAttrs cfg.guard.enable {
      genie-guard =
        let
          guardCredFile = "/run/credentials/genie-guard.service/api-key";
          modelArg = lib.optionalString (
            cfg.guard.model != null
          ) " --model ${lib.escapeShellArg cfg.guard.model}";
          keyArg = lib.optionalString (cfg.guard.apiKeyFile != null) " --api-key-file ${guardCredFile}";
        in
        {
          description = "genie-guard inbound prompt-injection screening service";
          after = [ "network.target" ];
          wantedBy = [ "multi-user.target" ];

          environment = {
            HOME = toString cfg.stateDir;
            XDG_RUNTIME_DIR = runtimeDir;
          };

          serviceConfig =
            commonHardening
            // {
              Type = "simple";
              DynamicUser = cfg.dynamicUser;
              User = lib.mkIf (!cfg.dynamicUser) cfg.user;
              StateDirectory = "genie-agent";
              RuntimeDirectory = "genie-agent";
              WorkingDirectory = toString cfg.stateDir;
              ExecStart = "${lib.getExe cfg.guard.package} --ninfer-url ${lib.escapeShellArg cfg.guard.ninferUrl} --timeout-ms ${toString cfg.guard.timeoutMs}${modelArg}${keyArg}";
              Restart = "on-failure";
              RestartSec = "5s";
              ProtectControlGroups = true;
              LoadCredential = lib.optional (
                cfg.guard.apiKeyFile != null
              ) "api-key:${toString cfg.guard.apiKeyFile}";
            }
            // lib.optionalAttrs (effectiveGroup != null) {
              Group = effectiveGroup;
            }
            // lib.optionalAttrs (cfg.xmsgSocket != null) {
              BindPaths = [ (toString cfg.xmsgSocket) ];
            };
        };
    }
    // lib.optionalAttrs cfg.experts.enable (
      (mkTierUnits "public" cfg.experts.public) // (mkTierUnits "trusted" cfg.experts.trusted)
    );
  };
}

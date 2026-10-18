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
    if cfg.broker.guardOut.keyFile != null then "${credDir}/guard-out-key" else null;
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

  mkExpertSettingsJson =
    tier:
    (pkgs.formats.json { }).generate "genie-claude-${tier}-settings.json" {
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
        ];
      };
    };

  mkExpertClaudeJson =
    tier:
    let
      tierCwd = "${cfg.stateDir}/cwd-${tier}";
      dispDir = "${cfg.stateDir}/dispatcher-${tier}";
    in
    (pkgs.formats.json { }).generate "genie-claude-${tier}-onboarding.json" {
      hasCompletedOnboarding = true;
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

  mkTierUnits =
    tier: tierCfg:
    let
      claudeDir = "${cfg.stateDir}/claude-${tier}";
      cwdDir = "${cfg.stateDir}/cwd-${tier}";
      dispStateDir = "${cfg.stateDir}/dispatcher-${tier}";
      sessionName = "genie-${tier}";
      settingsJson = mkExpertSettingsJson tier;
      claudeJson = mkExpertClaudeJson tier;
      claudeMd = mkExpertClaudeMd tier;
      bootstrapScript = pkgs.writeShellScript "genie-expert-${tier}-bootstrap" ''
        set -euo pipefail
        mkdir -p -m 0700 "${claudeDir}" "${claudeDir}/sessions" "${claudeDir}/transcripts"
        mkdir -p -m 0700 "${cwdDir}" "${dispStateDir}" "${dispStateDir}/worktrees"
        ln -sfn "${toString cfg.experts.credentialsFile}" "${claudeDir}/.credentials.json"
        install -m 0600 "${settingsJson}" "${claudeDir}/settings.json"
        install -m 0600 "${claudeJson}" "${claudeDir}/.claude.json"
        install -m 0644 "${claudeMd}" "${cwdDir}/CLAUDE.md"
        install -m 0644 "${claudeMd}" "${claudeDir}/CLAUDE.md"
        install -m 0644 "${claudeMd}" "${dispStateDir}/CLAUDE.md"
        ln -sfn "${tierCfg.reposDir}" "${cwdDir}/source-repos"
        ln -sfn "${tierCfg.memoryDir}" "${cwdDir}/memory"
        ln -sfn "${tierCfg.reposDir}" "${dispStateDir}/source-repos"
        ln -sfn "${tierCfg.memoryDir}" "${dispStateDir}/memory"
      '';
      bindPaths =
        lib.optional (cfg.xmsgSocket != null) (toString cfg.xmsgSocket)
        ++ lib.optional (cfg.experts.credentialsFile != null) (
          builtins.dirOf (toString cfg.experts.credentialsFile)
        );
      bindReadOnlyPaths = [
        tierCfg.reposDir
        tierCfg.memoryDir
      ];
      herdrPackages = [
        cfg.experts.herdrPackage
        pkgs.git
        pkgs.nix
        pkgs.coreutils
        pkgs.bash
      ]
      ++ lib.optional (cfg.experts.claudePackage != null) cfg.experts.claudePackage;
      modelFlag = lib.optionalString (
        tierCfg.model != null
      ) " --model ${lib.escapeShellArg tierCfg.model}";
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
        };
        serviceConfig =
          commonHardening
          // {
            Type = "simple";
            User = cfg.user;
            StateDirectory = "genie-agent";
            RuntimeDirectory = "genie-agent";
            WorkingDirectory = toString cfg.stateDir;
            ExecStart = "${pkgs.util-linux}/bin/setsid ${lib.getExe cfg.experts.herdrPackage} --session ${sessionName} server";
            Restart = "on-failure";
            RestartSec = "5s";
            ProtectControlGroups = true;
            BindPaths = lib.unique bindPaths;
            BindReadOnlyPaths = lib.unique bindReadOnlyPaths;
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
            ExecStart = "${lib.getExe cfg.experts.dispatcherPackage} --state-dir ${dispStateDir} --herdr-session ${sessionName} --base-pane %0 --cwd ${cwdDir} --token-config-dir ${claudeDir} --service-name ${tierCfg.serviceName}${modelFlag}";
            Restart = "on-failure";
            RestartSec = "5s";
            ProtectControlGroups = true;
            BindPaths = lib.unique bindPaths;
            BindReadOnlyPaths = lib.unique bindReadOnlyPaths;
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

      guard = lib.mkOption {
        default = { };
        description = "Optional local genie-guard service configuration.";
        type = lib.types.submodule {
          options = {
            enable = lib.mkEnableOption "local genie-guard service";

            package = lib.mkOption {
              type = lib.types.package;
              default = sysPackages.genie-guard;
              defaultText = lib.literalExpression "genie-agent.packages.\${system}.genie-guard";
              description = "The genie-guard package.";
            };

            ninferUrl = lib.mkOption {
              type = lib.types.str;
              default = cfg.model.baseUrl;
              defaultText = lib.literalExpression "cfg.model.baseUrl";
              description = "OpenAI-compatible base URL for genie-guard.";
            };

            model = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Optional model ID override for genie-guard.";
            };

            timeoutMs = lib.mkOption {
              type = lib.types.ints.positive;
              default = 120000;
              description = "Per-review timeout in milliseconds for genie-guard.";
            };

            apiKeyFile = lib.mkOption {
              type = lib.types.nullOr secretPath;
              default = cfg.model.keyFile;
              defaultText = lib.literalExpression "cfg.model.keyFile";
              description = "Optional API key file for genie-guard (must not be in /nix/store).";
            };
          };
        };
      };
    };

  config = lib.mkIf cfg.enable {
    assertions = (shared.mkCommonAssertions { inherit lib cfg; }) ++ [
      {
        assertion = cfg.xmsgSocket != null -> !cfg.dynamicUser;
        message = "services.genie-agent: when xmsgSocket is configured, dynamicUser must be false because xmsg's UID and /proc/<pid>/exe attestation requires running as the socket's owning user.";
      }
    ];

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

    systemd.services = {
      genie-agent = {
        description = "genie-agent Tier-1 composition root service";
        after = [ "network.target" ] ++ lib.optional cfg.guard.enable "genie-guard.service";
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
              cfg.broker.guardOut.keyFile != null
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

# Shared option set and Config JSON renderer for `nixosModules.default` and Kubernetes (`I12`).
rec {
  secretPathType =
    lib:
    lib.types.addCheck lib.types.str (
      s: !builtins.hasContext s && !lib.hasPrefix builtins.storeDir s && lib.hasPrefix "/" s
    );

  mkTierExpertSubmodule =
    {
      lib,
      tier,
      defaultAddress,
      defaultReposDir,
      defaultMemoryDir,
    }:
    let
      submoduleType = lib.types.submodule {
        options = {
          address = lib.mkOption {
            type = lib.types.str;
            default = defaultAddress;
            description = "xmsg address for ${tier}-tier escalations.";
          };

          serviceName = lib.mkOption {
            type = lib.types.str;
            default = "genie-expert-${tier}";
            description = "xmsg service name registered by genie-dispatcher@${tier}.";
          };

          reposDir = lib.mkOption {
            type = lib.types.str;
            default = defaultReposDir;
            description = "Read-only source repository directory cloned per thread by ${tier} expert sessions.";
          };

          memoryDir = lib.mkOption {
            type = lib.types.str;
            default = defaultMemoryDir;
            description = "Read-only memory directory exposed to ${tier} expert sessions.";
          };

          model = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Optional Claude model override (`--model`) for genie-dispatcher@${tier}.";
          };
        };
      };
    in
    lib.types.coercedTo lib.types.str (address: { inherit address; }) submoduleType;

  mkCommonOptions =
    {
      lib,
      pkgs,
      packages,
      cfg,
      defaultStateDir ? "/var/lib/genie-agent",
      defaultXmsgSocket ? null,
    }:
    let
      secretPath = secretPathType lib;
      sysPackages = packages.${pkgs.stdenv.hostPlatform.system};
    in
    {
      enable = lib.mkEnableOption "genie-agent tiered support expert";

      package = lib.mkOption {
        type = lib.types.package;
        default = sysPackages.genie-root;
        defaultText = lib.literalExpression "genie-agent.packages.\${system}.genie-root";
        description = "The genie-root package to run for Tier 1 composition root.";
      };

      operatingMemoryPackage = lib.mkOption {
        type = lib.types.package;
        default = sysPackages.operating-memory;
        defaultText = lib.literalExpression "genie-agent.packages.\${system}.operating-memory";
        description = "The pinned operating-memory package mounted at /memory for Tier 1.";
      };

      piPackage = lib.mkOption {
        type = lib.types.package;
        default = pkgs.pi-coding-agent;
        defaultText = lib.literalExpression "pkgs.pi-coding-agent";
        description = "The pi-coding-agent package used by Tier 1.";
      };

      stateDir = lib.mkOption {
        type = lib.types.path;
        default = defaultStateDir;
        description = "Base directory for genie-agent persistent state.";
      };

      stateRoot = lib.mkOption {
        type = lib.types.path;
        default = "${cfg.stateDir}/state";
        defaultText = lib.literalExpression "\"\${cfg.stateDir}/state\"";
        description = "Directory for per-thread state and transcripts (P2).";
      };

      storeRoot = lib.mkOption {
        type = lib.types.path;
        default = "${cfg.stateDir}/store";
        defaultText = lib.literalExpression "\"\${cfg.stateDir}/store\"";
        description = "Directory for per-thread throwaway Nix evaluation stores (E1/P3).";
      };

      mirror = lib.mkOption {
        default = { };
        description = "Git mirror and worktree storage settings (P1/P6/P7).";
        type = lib.types.submodule {
          options = {
            mirrorRoot = lib.mkOption {
              type = lib.types.path;
              default = "${cfg.stateDir}/mirrors";
              defaultText = lib.literalExpression "\"\${cfg.stateDir}/mirrors\"";
              description = "Directory for bare git mirrors.";
            };

            worktreeRoot = lib.mkOption {
              type = lib.types.path;
              default = "${cfg.stateDir}/worktrees";
              defaultText = lib.literalExpression "\"\${cfg.stateDir}/worktrees\"";
              description = "Directory for per-thread git worktrees.";
            };

            maxRepoBytes = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "Optional per-repository byte cap (defaults to P6's 2 GiB cap).";
            };

            quotaBytes = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "Optional total mirror quota in bytes (defaults to P7's 32 GiB quota).";
            };

            fetchTimeoutMs = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "Optional git fetch timeout in milliseconds.";
            };
          };
        };
      };

      model = lib.mkOption {
        description = "Tier 1 OpenAI-compatible model endpoint configuration.";
        type = lib.types.submodule {
          options = {
            baseUrl = lib.mkOption {
              type = lib.types.str;
              example = "http://10.9.2.2:18020/v1";
              description = "OpenAI-compatible base URL (ending in /v1).";
            };

            api = lib.mkOption {
              type = lib.types.str;
              default = "openai-completions";
              description = "pi model API adapter name.";
            };

            id = lib.mkOption {
              type = lib.types.str;
              default = "qwen3.6-35b-a3b";
              description = "Model identifier.";
            };

            keyFile = lib.mkOption {
              type = secretPath;
              example = "/run/secrets/hyperqwen-api-key";
              description = "Path to the model API key file (must not be in /nix/store).";
            };
          };
        };
      };

      tier1 = lib.mkOption {
        description = "Tier 1 tool, SearXNG, and lifecycle settings.";
        type = lib.types.submodule {
          options = {
            searxngUrl = lib.mkOption {
              type = lib.types.str;
              example = "http://10.11.0.24:8080";
              description = "SearXNG base URL for web_search.";
            };

            cluster = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Additional internal cluster CIDRs/hosts refused by web_fetch.";
            };

            memoryRoot = lib.mkOption {
              type = lib.types.str;
              default = "/memory";
              description = "Path where operating-memory is mounted for Tier 1.";
            };

            questionTimeoutMs = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "Optional per-question deadline in milliseconds.";
            };

            checkinMs = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "Optional check-in interval in milliseconds.";
            };
          };
        };
      };

      hindsightUrl = lib.mkOption {
        type = lib.types.str;
        default = "http://10.11.0.20:8888";
        description = "Hindsight dataplane URL for Tier 1 recall.";
      };

      s3 = lib.mkOption {
        default = null;
        description = "Optional S3 transcript archiver configuration (null disables S3 archiving in local mode).";
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              endpoint = lib.mkOption {
                type = lib.types.str;
                description = "S3 endpoint URL.";
              };
              region = lib.mkOption {
                type = lib.types.str;
                default = "garage";
                description = "S3 region.";
              };
              bucket = lib.mkOption {
                type = lib.types.str;
                default = "genie-transcripts";
                description = "S3 bucket name.";
              };
              accessKeyId = lib.mkOption {
                type = lib.types.str;
                description = "S3 access key ID.";
              };
              secretKeyFile = lib.mkOption {
                type = secretPath;
                description = "Path to the S3 secret access key file (must not be in /nix/store).";
              };
            };
          }
        );
      };

      broker = lib.mkOption {
        default = { };
        description = "Proposal broker (A1-A3) and guard-out settings.";
        type = lib.types.submodule {
          options = {
            tokenFile = lib.mkOption {
              type = lib.types.nullOr secretPath;
              default = null;
              description = "Optional GitHub PAT file for propose actions (null disables propose in local mode before I11).";
            };

            githubApi = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Optional GitHub API base URL override.";
            };

            threadLink = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Optional public thread URL template containing `{thread}`.";
            };

            guardOut = lib.mkOption {
              default = { };
              description = "Outbound guard-out model settings.";
              type = lib.types.submodule {
                options = {
                  base = lib.mkOption {
                    type = lib.types.str;
                    default = cfg.model.baseUrl;
                    defaultText = lib.literalExpression "cfg.model.baseUrl";
                    description = "OpenAI-compatible base URL for guard-out.";
                  };

                  model = lib.mkOption {
                    type = lib.types.str;
                    default = cfg.model.id;
                    defaultText = lib.literalExpression "cfg.model.id";
                    description = "Model ID for guard-out.";
                  };

                  keyFile = lib.mkOption {
                    type = lib.types.nullOr secretPath;
                    default = cfg.model.keyFile;
                    defaultText = lib.literalExpression "cfg.model.keyFile";
                    description = "Optional API key file for guard-out (must not be in /nix/store).";
                  };
                };
              };
            };
          };
        };
      };

      eval = lib.mkOption {
        default = { };
        description = "Nix evaluation sandbox settings (E1/E2.3/E4).";
        type = lib.types.submodule {
          options = {
            timeoutMs = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "Optional per-eval timeout in milliseconds.";
            };

            builders = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Optional Nix builders specification for trusted IFD evaluations.";
            };

            memoryMax = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = 4294967296;
              description = "Per-eval cgroup memory.max in bytes (default 4 GiB; null disables cgroup memory limit).";
            };
          };
        };
      };

      xmsgSocket = lib.mkOption {
        type = lib.types.nullOr (lib.types.either lib.types.path lib.types.str);
        default = defaultXmsgSocket;
        example = "/run/user/1000/xmsg";
        description = "Path to the xmsg runtime directory containing register.sock and agent.sock.";
      };

      serviceName = lib.mkOption {
        type = lib.types.str;
        default = "genie";
        description = "xmsg service name registered by genie-agent Tier 1.";
      };

      guardRef = lib.mkOption {
        type = lib.types.str;
        default = "genie-guard";
        example = "genie-guard@sini.bitstream";
        description = "xmsg address of the guard-in service.";
      };

      guardMaxConcurrency = lib.mkOption {
        type = lib.types.ints.positive;
        default = 1;
        description = "Maximum concurrent guard-in requests sent by XmsgGuardClient.";
      };

      guardTimeoutMs = lib.mkOption {
        type = lib.types.ints.positive;
        default = 120000;
        description = "Timeout in milliseconds for each guard-in request.";
      };

      experts = lib.mkOption {
        default = { };
        description = "Expert routing and optional local-mode herdr + genie-dispatcher units.";
        type = lib.types.submodule {
          options = {
            enable = lib.mkEnableOption "local genie-herdr@<tier> and genie-dispatcher@<tier> services";

            dispatcherPackage = lib.mkOption {
              type = lib.types.package;
              default = sysPackages.genie-dispatcher;
              defaultText = lib.literalExpression "genie-agent.packages.\${system}.genie-dispatcher";
              description = "The genie-dispatcher package.";
            };

            herdrPackage = lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = null;
              description = "The herdr package used by genie-herdr@<tier> and genie-dispatcher@<tier>.";
            };

            claudePackage = lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = null;
              description = "Optional Claude Code package placed on PATH for genie-herdr@<tier>.";
            };

            credentialsFile = lib.mkOption {
              type = lib.types.nullOr secretPath;
              default = null;
              example = "/home/sini/.claude/.credentials.json";
              description = "Path to the Claude credentials JSON file symlinked into each tier's config dir in local mode.";
            };

            permissionMode = lib.mkOption {
              type = lib.types.enum [
                "bypassPermissions"
                "acceptEdits"
              ];
              default = "bypassPermissions";
              description = "Non-prompting permission mode for headless expert Claude sessions (§5.2).";
            };

            public = lib.mkOption {
              type = mkTierExpertSubmodule {
                inherit lib;
                tier = "public";
                defaultAddress = "genie-expert-public";
                defaultReposDir = "/var/lib/genie/public-repos";
                defaultMemoryDir = "${../support-memory}";
              };
              default = { };
              description = "Public-tier expert routing address and local-mode workspace configuration.";
            };

            trusted = lib.mkOption {
              type = mkTierExpertSubmodule {
                inherit lib;
                tier = "trusted";
                defaultAddress = "genie-expert-trusted";
                defaultReposDir = "/var/lib/genie/trusted-repos";
                defaultMemoryDir = "${../support-memory}";
              };
              default = { };
              description = "Trusted-tier expert routing address and local-mode workspace configuration.";
            };
          };
        };
      };
    };

  mkCommonAssertions =
    { lib, cfg }:
    [
      {
        assertion =
          cfg.experts.enable -> (cfg.experts.herdrPackage != null && cfg.experts.credentialsFile != null);
        message = "services.genie-agent.experts.enable requires both experts.herdrPackage and experts.credentialsFile to be set.";
      }
      {
        assertion = (cfg.broker.threadLink != null) -> lib.hasInfix "{thread}" cfg.broker.threadLink;
        message = "services.genie-agent.broker.threadLink must contain the `{thread}` placeholder.";
      }
    ];

  # Renders the exact Config object expected by src/root/index.ts.
  mkRootConfigAttrs =
    { lib, pkgs }:
    cfg:
    {
      modelKeyFile,
      guardOutKeyFile ? null,
      brokerTokenFile ? null,
      s3SecretKeyFile ? null,
    }:
    let
      mirrorAttrs = {
        mirrorRoot = toString cfg.mirror.mirrorRoot;
        worktreeRoot = toString cfg.mirror.worktreeRoot;
      }
      // lib.optionalAttrs (cfg.mirror.maxRepoBytes != null) {
        maxRepoBytes = cfg.mirror.maxRepoBytes;
      }
      // lib.optionalAttrs (cfg.mirror.quotaBytes != null) {
        quotaBytes = cfg.mirror.quotaBytes;
      }
      // lib.optionalAttrs (cfg.mirror.fetchTimeoutMs != null) {
        fetchTimeoutMs = cfg.mirror.fetchTimeoutMs;
      };

      tier1Attrs = {
        searxngUrl = cfg.tier1.searxngUrl;
        cluster = cfg.tier1.cluster;
        memoryRoot = cfg.tier1.memoryRoot;
      }
      // lib.optionalAttrs (cfg.tier1.questionTimeoutMs != null) {
        questionTimeoutMs = cfg.tier1.questionTimeoutMs;
      }
      // lib.optionalAttrs (cfg.tier1.checkinMs != null) {
        checkinMs = cfg.tier1.checkinMs;
      };

      guardOutAttrs = {
        base = cfg.broker.guardOut.base;
        model = cfg.broker.guardOut.model;
      }
      // lib.optionalAttrs (guardOutKeyFile != null) {
        keyFile = guardOutKeyFile;
      };

      brokerAttrs = {
        tokenFile = brokerTokenFile;
        guardOut = guardOutAttrs;
      }
      // lib.optionalAttrs (cfg.broker.githubApi != null) {
        githubApi = cfg.broker.githubApi;
      }
      // lib.optionalAttrs (cfg.broker.threadLink != null) {
        threadLink = cfg.broker.threadLink;
      };

      evalAttrs =
        lib.optionalAttrs (cfg.eval.timeoutMs != null) {
          timeoutMs = cfg.eval.timeoutMs;
        }
        // lib.optionalAttrs (cfg.eval.builders != null) {
          builders = cfg.eval.builders;
        }
        // lib.optionalAttrs (cfg.eval.memoryMax != null) {
          memoryMax = cfg.eval.memoryMax;
        };
    in
    {
      stateRoot = toString cfg.stateRoot;
      storeRoot = toString cfg.storeRoot;
      mirror = mirrorAttrs;
      pi = lib.getExe cfg.piPackage;
      model = {
        baseUrl = cfg.model.baseUrl;
        api = cfg.model.api;
        id = cfg.model.id;
        keyFile = modelKeyFile;
      };
      tier1 = tier1Attrs;
      hindsightUrl = cfg.hindsightUrl;
      s3 =
        if cfg.s3 == null then
          null
        else
          {
            endpoint = cfg.s3.endpoint;
            region = cfg.s3.region;
            bucket = cfg.s3.bucket;
            accessKeyId = cfg.s3.accessKeyId;
            secretKeyFile = s3SecretKeyFile;
          };
      broker = brokerAttrs;
      eval = evalAttrs;
      experts = {
        public = cfg.experts.public.address;
        trusted = cfg.experts.trusted.address;
      };
      xmsg = {
        service = cfg.serviceName;
        guard = {
          target = cfg.guardRef;
          maxConcurrency = cfg.guardMaxConcurrency;
          timeoutMs = cfg.guardTimeoutMs;
        };
      };
    };

  mkRootConfigJson =
    { lib, pkgs }:
    cfg: credPaths:
    let
      attrs = mkRootConfigAttrs { inherit lib pkgs; } cfg credPaths;
    in
    ((pkgs.formats.json { }).generate "genie-root-config.json" attrs).overrideAttrs (old: {
      passthru = (old.passthru or { }) // {
        inherit attrs;
      };
    });
}

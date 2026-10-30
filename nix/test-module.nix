{
  pkgs,
  nixpkgs,
  self,
}:
let
  inherit (nixpkgs) lib;
  shared = import ./options.nix;
  secretPath = shared.secretPathType lib;

  # Evaluate a local-mode NixOS configuration (user = "sini", s3 = null, experts + guard enabled)
  evalLocal = nixpkgs.lib.nixosSystem {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      self.nixosModules.default
      {
        system.stateVersion = "25.05";
        services.genie-agent = {
          enable = true;
          user = "sini";
          xmsgSocket = "/run/user/1000/xmsg";
          model = {
            baseUrl = "http://10.9.2.2:18020/v1";
            id = "qwen3.6-35b-a3b";
            keyFile = "/home/sini/.config/hyperqwen/api-key";
          };
          tier1 = {
            searxngUrl = "http://10.11.0.24:8080";
            cluster = [ "10.11.0.0/16" ];
          };
          hindsightUrl = "http://10.11.0.20:8888";
          s3 = null;
          guardRef = "genie-guard@sini.bitstream";
          guard = {
            enable = true;
            ninferUrl = "http://10.9.2.2:18020/v1";
            apiKeyFile = "/home/sini/.config/hyperqwen/api-key";
          };
          experts = {
            enable = true;
            herdrPackage = pkgs.herdr;
            claudePackage = pkgs.writeShellScriptBin "claude" "exit 0";
            xmsgPackage = pkgs.writeShellScriptBin "xmsg" "exit 0";
            public = {
              address = "genie-expert-public@sini.bitstream";
              reposDir = "/var/lib/genie/public-repos";
              memoryDir = "/var/lib/genie/support-memory";
              tokenEnvironmentFile = "/run/agenix/genie-expert-public-token";
            };
            trusted = {
              address = "genie-expert-trusted@sini.bitstream";
              reposDir = "/home/sini/Documents/repos/sini";
              memoryDir = "/home/sini/.claude/memory";
              tokenEnvironmentFile = "/run/agenix/genie-expert-trusted-token";
            };
          };
        };
      }
    ];
  };

  # Evaluate a full configuration with S3, broker.tokenFile, and GI-5 string-coerced experts
  evalFull = nixpkgs.lib.nixosSystem {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      self.nixosModules.genie-agent
      {
        system.stateVersion = "25.05";
        services.genie-agent = {
          enable = true;
          user = "sini";
          xmsgSocket = "/run/user/1000/xmsg";
          model = {
            baseUrl = "http://10.9.2.2:18020/v1";
            id = "qwen3.6-35b-a3b";
            keyFile = "/run/secrets/model-key";
          };
          tier1 = {
            searxngUrl = "http://10.11.0.24:8080";
            questionTimeoutMs = 600000;
            checkinMs = 120000;
          };
          s3 = {
            endpoint = "http://10.11.0.30:3900";
            region = "garage";
            bucket = "genie-transcripts";
            accessKeyId = "GK123";
            secretKeyFile = "/run/secrets/s3-key";
          };
          broker = {
            tokenFile = "/run/secrets/github-pat";
            githubApi = "https://api.github.com";
            threadLink = "https://matrix.to/#/!room:example.org/{thread}";
            guardOut = {
              base = "http://10.9.2.2:18020/v1";
              model = "qwen3.6-35b-a3b";
              keyFile = "/run/secrets/guard-out-key";
            };
          };
          eval = {
            timeoutMs = 60000;
            builders = "ssh://builder x86_64-linux";
            memoryMax = 4294967296;
          };
          experts = {
            public = "genie-support@sini.bitstream";
            trusted = "genie-support@sini.bitstream";
          };
        };
      }
    ];
  };

  # Evaluate a G11 configuration with guard.enable = false, guardRef = null, and broker.guardOut.enable = false
  evalNoGuard = nixpkgs.lib.nixosSystem {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      self.nixosModules.default
      {
        system.stateVersion = "25.05";
        services.genie-agent = {
          enable = true;
          user = "sini";
          xmsgSocket = "/run/user/1000/xmsg";
          model = {
            baseUrl = "http://10.9.2.2:18020/v1";
            id = "qwen3.6-35b-a3b";
            keyFile = "/home/sini/.config/hyperqwen/api-key";
          };
          tier1 = {
            searxngUrl = "http://10.11.0.24:8080";
          };
          guardRef = null;
          guard.enable = false;
          broker.guardOut.enable = false;
        };
      }
    ];
  };

  # Evaluate a configuration with guard.enable = true and guardRef = null to verify the assertion fails
  evalBadGuardRef = nixpkgs.lib.nixosSystem {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      self.nixosModules.default
      {
        system.stateVersion = "25.05";
        services.genie-agent = {
          enable = true;
          user = "sini";
          xmsgSocket = "/run/user/1000/xmsg";
          model = {
            baseUrl = "http://10.9.2.2:18020/v1";
            id = "qwen3.6-35b-a3b";
            keyFile = "/home/sini/.config/hyperqwen/api-key";
          };
          tier1 = {
            searxngUrl = "http://10.11.0.24:8080";
          };
          guardRef = null;
          guard.enable = true;
        };
      }
    ];
  };

  # GI-13: experts enabled with one tier's token file missing must fail the experts assertion.
  evalNoTierToken = evalLocal.extendModules {
    modules = [ { services.genie-agent.experts.trusted.tokenEnvironmentFile = lib.mkForce null; } ];
  };

  # GI-15 (P9): experts enabled with xmsgSocket = null must fail the xmsgSocket assertion.
  evalNoXmsgSocket = evalLocal.extendModules {
    modules = [ { services.genie-agent.xmsgSocket = lib.mkForce null; } ];
  };

  # GI-15 (Gate v3): experts enabled with kernel.yama.ptrace_scope = 0 must fail the ptrace_scope assertion.
  evalPtraceScope0 = evalLocal.extendModules {
    modules = [ { boot.kernel.sysctl."kernel.yama.ptrace_scope" = 0; } ];
  };

  # GI-13: a herdrPackage without `src` must fail at evaluation with a throw rather than passing unpatched.
  evalUnpatchedHerdr = evalLocal.extendModules {
    modules = [
      {
        services.genie-agent.experts.herdrPackage = lib.mkForce (pkgs.writeShellScriptBin "herdr" "exit 0");
      }
    ];
  };
  unpatchedHerdrThrows =
    !(builtins.tryEval (
      builtins.seq evalUnpatchedHerdr.config.services.genie-agent.experts.herdrPackage true
    )).success;

  # GF2: experts enabled without a resolvable xmsgPackage (neither set nor in pkgs) must fail at evaluation with a throw rather than falling back to a dead stub.
  evalMissingXmsgPackage = nixpkgs.lib.nixosSystem {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      self.nixosModules.default
      {
        system.stateVersion = "25.05";
        services.genie-agent = {
          enable = true;
          user = "sini";
          xmsgSocket = "/run/user/1000/xmsg";
          model = {
            baseUrl = "http://10.9.2.2:18020/v1";
            id = "qwen3.6-35b-a3b";
            keyFile = "/home/sini/.config/hyperqwen/api-key";
          };
          tier1.searxngUrl = "http://10.11.0.24:8080";
          guardRef = null;
          guard.enable = false;
          broker.guardOut.enable = false;
          experts = {
            enable = true;
            herdrPackage = pkgs.herdr;
            claudePackage = pkgs.writeShellScriptBin "claude" "exit 0";
            public.tokenEnvironmentFile = "/run/agenix/genie-expert-public-token";
            trusted.tokenEnvironmentFile = "/run/agenix/genie-expert-trusted-token";
          };
        };
      }
    ];
  };
  missingXmsgPackageThrows =
    !(builtins.tryEval (
      builtins.seq evalMissingXmsgPackage.config.services.genie-agent.experts.xmsgPackage true
    )).success;

  # GF2: experts enabled with xmsgPackage explicitly forced to null must also throw at evaluation.
  evalNullXmsgPackage = evalLocal.extendModules {
    modules = [ { services.genie-agent.experts.xmsgPackage = lib.mkForce null; } ];
  };
  nullXmsgPackageThrows =
    !(builtins.tryEval (
      builtins.seq evalNullXmsgPackage.config.services.genie-agent.experts.xmsgPackage true
    )).success;

  failedAssertions =
    ev:
    lib.filter (lib.hasPrefix "services.genie-agent") (
      map (a: a.message) (lib.filter (a: !a.assertion) ev.config.assertions)
    );

  localCfg = evalLocal.config.services.genie-agent;
  fullCfg = evalFull.config.services.genie-agent;
  noGuardCfg = evalNoGuard.config.services.genie-agent;

  localRootJson = shared.mkRootConfigJson { inherit lib pkgs; } localCfg {
    modelKeyFile = "/run/credentials/genie-agent.service/model-key";
    guardOutKeyFile = "/run/credentials/genie-agent.service/guard-out-key";
    brokerTokenFile = null;
    s3SecretKeyFile = null;
  };

  fullRootJson = shared.mkRootConfigJson { inherit lib pkgs; } fullCfg {
    modelKeyFile = "/run/credentials/genie-agent.service/model-key";
    guardOutKeyFile = "/run/credentials/genie-agent.service/guard-out-key";
    brokerTokenFile = "/run/credentials/genie-agent.service/broker-token";
    s3SecretKeyFile = "/run/credentials/genie-agent.service/s3-secret-key";
  };

  noGuardRootJson = shared.mkRootConfigJson { inherit lib pkgs; } noGuardCfg {
    modelKeyFile = "/run/credentials/genie-agent.service/model-key";
    guardOutKeyFile = null;
    brokerTokenFile = null;
    s3SecretKeyFile = null;
  };

  extractUnit = u: {
    inherit (u)
      description
      after
      wantedBy
      environment
      ;
    requires = u.requires or [ ];
    path = map toString (u.path or [ ]);
    serviceConfig = {
      inherit (u.serviceConfig)
        Type
        User
        StateDirectory
        RuntimeDirectory
        WorkingDirectory
        ExecStart
        ProtectSystem
        NoNewPrivileges
        PrivateTmp
        PrivateDevices
        PrivateUsers
        ProtectHome
        ProtectHostname
        ProtectKernelLogs
        ProtectKernelTunables
        ProtectKernelModules
        ProtectControlGroups
        RestrictAddressFamilies
        RestrictSUIDSGID
        LockPersonality
        UMask
        ;
      Delegate = u.serviceConfig.Delegate or false;
      LoadCredential = u.serviceConfig.LoadCredential or [ ];
      BindPaths = u.serviceConfig.BindPaths or [ ];
      BindReadOnlyPaths = u.serviceConfig.BindReadOnlyPaths or [ ];
      InaccessiblePaths = u.serviceConfig.InaccessiblePaths or [ ];
      SystemCallFilter = u.serviceConfig.SystemCallFilter or [ ];
      SystemCallErrorNumber = u.serviceConfig.SystemCallErrorNumber or null;
      ExecStartPre = u.serviceConfig.ExecStartPre or null;
      PrivatePIDs = u.serviceConfig.PrivatePIDs or false;
      EnvironmentFile = u.serviceConfig.EnvironmentFile or null;
    };
  };

  summaryJson = (pkgs.formats.json { }).generate "nixos-module-summary.json" {
    secretPathChecks = {
      acceptsRunSecrets = secretPath.check "/run/secrets/hyperqwen-api-key";
      acceptsHomePath = secretPath.check "/home/sini/.config/hyperqwen/api-key";
      rejectsNixStorePrefix =
        !(secretPath.check "${builtins.storeDir}/00000000000000000000000000000000-secret-key");
      rejectsStoreContext = !(secretPath.check "${pkgs.writeText "leaked-secret" "secret"}");
      rejectsRelativePath = !(secretPath.check "relative/secret-key");
    };
    units = {
      genie-agent = extractUnit evalLocal.config.systemd.services.genie-agent;
      genie-guard = extractUnit evalLocal.config.systemd.services.genie-guard;
      "genie-herdr@public" = extractUnit evalLocal.config.systemd.services."genie-herdr@public";
      "genie-herdr@trusted" = extractUnit evalLocal.config.systemd.services."genie-herdr@trusted";
      "genie-dispatcher@public" = extractUnit evalLocal.config.systemd.services."genie-dispatcher@public";
      "genie-dispatcher@trusted" =
        extractUnit
          evalLocal.config.systemd.services."genie-dispatcher@trusted";
    };
    noGuardUnits = {
      hasGenieGuard = evalNoGuard.config.systemd.services ? genie-guard;
      genieAgent = extractUnit evalNoGuard.config.systemd.services.genie-agent;
    };
    noGuardFailedAssertions = lib.filter (lib.hasPrefix "services.genie-agent:") (
      map (a: a.message) (lib.filter (a: !a.assertion) evalNoGuard.config.assertions)
    );
    badGuardRefFailedAssertions = lib.filter (lib.hasPrefix "services.genie-agent:") (
      map (a: a.message) (lib.filter (a: !a.assertion) evalBadGuardRef.config.assertions)
    );
    localFailedAssertions = failedAssertions evalLocal;
    noTierTokenFailedAssertions = failedAssertions evalNoTierToken;
    noXmsgSocketFailedAssertions = failedAssertions evalNoXmsgSocket;
    ptraceScope0FailedAssertions = failedAssertions evalPtraceScope0;
    localPtraceScope = evalLocal.config.boot.kernel.sysctl."kernel.yama.ptrace_scope";
    inherit unpatchedHerdrThrows missingXmsgPackageThrows nullXmsgPackageThrows;
    localTmpfiles = lib.filter (lib.hasInfix "/claude-") evalLocal.config.systemd.tmpfiles.rules;
    allLocalTmpfiles = evalLocal.config.systemd.tmpfiles.rules;
    localRootAttrs = localRootJson.passthru.attrs;
    fullRootAttrs = fullRootJson.passthru.attrs;
    noGuardRootAttrs = noGuardRootJson.passthru.attrs;
  };
in
pkgs.runCommand "genie-agent-nixos-module"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
    src = nixpkgs.lib.fileset.toSource {
      root = ../.;
      fileset = nixpkgs.lib.fileset.unions [
        ../package.json
        ../tsconfig.json
        ../README.md
        ../src
        ../schemas
        ../tests/nixos-module.test.ts
      ];
    };
  }
  ''
    cp -r $src/* .
    chmod -R u+w .
    export GENIE_NIXOS_MODULE_SUMMARY="${summaryJson}"
    export GENIE_LOCAL_ROOT_CONFIG="${localRootJson}"
    export GENIE_FULL_ROOT_CONFIG="${fullRootJson}"

    # Typecheck generated root configs against src/root/index.ts Config interface
    cat > src/root/check-config-types.ts <<EOF
    import type { Config } from "./index.ts";
    const localConfig: Config = $(cat "${localRootJson}");
    const fullConfig: Config = $(cat "${fullRootJson}");
    const noGuardConfig: Config = $(cat "${noGuardRootJson}");
    void localConfig;
    void fullConfig;
    void noGuardConfig;
    EOF
    tsc --noEmit -p .
    rm -f src/root/check-config-types.ts

    rc=0
    node --test --test-reporter=tap tests/nixos-module.test.ts > $TMPDIR/tap || rc=$?
    cat $TMPDIR/tap
    [ "$rc" -eq 0 ] \
      && grep -q '^ok [0-9]* - oracle 1 (GI-4): nixosModules.default renders hardened units, mounts, expert deny rules, store-path-free secrets, and README isolation disclosure$' $TMPDIR/tap \
      && grep -q '^ok [0-9]* - oracle 2 (GI-4): zero-drift oracle between nix/options.nix mkRootConfigAttrs and src/root/index.ts Config$' $TMPDIR/tap \
      && grep -q '^ok [0-9]* - oracle 3 (G11): guard.enable = false and broker.guardOut.enable = false omit genie-guard unit, xmsg.guard, and guard-out-key credential; guard.enable = true with guardRef = null triggers assertion$' $TMPDIR/tap \
      && grep -q '^ok [0-9]* - oracle G0 (GI-13): every tier unit binds exactly the xmsg socket read-write and exactly its repos and memory read-only, runs in a private PID namespace, and only herdr loads the tier token$' $TMPDIR/tap \
      && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
    touch $out
  ''

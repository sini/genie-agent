{ packages }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.genie-guard;
  sock = toString cfg.xmsgSocket;
in
{
  options.services.genie-guard = {
    enable = lib.mkEnableOption "the genie-guard user service";
    package = lib.mkOption {
      type = lib.types.package;
      default = packages.${pkgs.stdenv.hostPlatform.system}.genie-guard;
      defaultText = lib.literalExpression "genie-agent.packages.\${system}.genie-guard";
      description = "The genie-guard executable.";
    };
    ninferUrl = lib.mkOption {
      type = lib.types.str;
      description = "Base URL of the OpenAI-compatible model endpoint the guard calls.";
    };
    apiKeyFile = lib.mkOption {
      type = lib.types.str;
      example = "%h/.config/model/api-key";
      description = ''
        Runtime path of the model API key, read by the guard at start. systemd specifiers
        such as `%h` are expanded. A Nix store path is refused, as it would publish the key.
      '';
    };
    xmsgSocket = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/user/1000/xmsg";
      description = ''
        Directory holding the xmsg `http.sock`, `agent.sock` and `register.sock`. When set, the
        unit names each socket through `XMSG_HTTP_SOCK`, `XMSG_AGENT_SOCK` and `XMSG_REGISTER_SOCK`.
      '';
    };
    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Further command-line arguments for genie-guard.";
    };
  };

  config = lib.mkIf (cfg.enable && pkgs.stdenv.hostPlatform.isLinux) {
    assertions = [
      {
        assertion =
          !(lib.hasPrefix builtins.storeDir cfg.apiKeyFile) && !(builtins.hasContext cfg.apiKeyFile);
        message = "services.genie-guard.apiKeyFile must be a runtime path, not a Nix store path.";
      }
    ];

    systemd.user.services.genie-guard = {
      Unit = {
        Description = "genie-guard: guard-in verdicts for the @genie bot";
        After = [ "xmsg.service" ];
        Wants = [ "xmsg.service" ];
      };
      Service = {
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe cfg.package)
            "--ninfer-url"
            cfg.ninferUrl
            "--api-key-file"
            cfg.apiKeyFile
          ]
          ++ cfg.extraArgs
        );
        Restart = "on-failure";
        RestartSec = 10;
        # Only what an unprivileged user manager applies without a user namespace
        # (seccomp, no_new_privs, umask). The guard spawns nothing, and it is a
        # Node SEA, so no MemoryDenyWriteExecute (V8 JIT).
        NoNewPrivileges = true;
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        # The model over HTTP, xmsg over unix sockets, netlink for getaddrinfo.
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        UMask = "0077";
      }
      // lib.optionalAttrs (cfg.xmsgSocket != null) {
        Environment = [
          "XMSG_HTTP_SOCK=${sock}/http.sock"
          "XMSG_AGENT_SOCK=${sock}/agent.sock"
          "XMSG_REGISTER_SOCK=${sock}/register.sock"
        ];
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}

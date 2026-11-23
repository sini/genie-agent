# Eval-only checks for homeManagerModules.genie-guard. home-manager is not an input, so the
# options the module writes to are stubbed.
{
  pkgs,
  nixpkgs,
  self,
}:
let
  inherit (nixpkgs) lib;
  render =
    cfg:
    lib.evalModules {
      modules = [
        self.homeManagerModules.genie-guard
        {
          options = {
            assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; };
            systemd.user.services = lib.mkOption { type = lib.types.attrsOf lib.types.attrs; };
          };
          config._module.args = { inherit pkgs; };
        }
        { services.genie-guard = cfg; }
      ];
    };
  base = {
    enable = true;
    ninferUrl = "http://model.example:8000/v1";
    apiKeyFile = "%h/.config/model/api-key";
  };
  unit = (render base).config.systemd.user.services.genie-guard;
  svc = unit.Service;
  failed = m: lib.filter (a: !a.assertion) m.config.assertions;

  hardening = {
    NoNewPrivileges = true;
    LockPersonality = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    SystemCallArchitectures = "native";
    RestrictAddressFamilies = [
      "AF_UNIX"
      "AF_INET"
      "AF_INET6"
      "AF_NETLINK"
    ];
    UMask = "0077";
    Restart = "on-failure";
    RestartSec = 10;
  };
  hardeningCases = lib.mapAttrsToList (k: v: {
    name = "hardening ${k}";
    ok = svc.${k} or null == v;
  }) hardening;

  withSock =
    (render (base // { xmsgSocket = "/run/user/1000/xmsg"; })).config.systemd.user.services.genie-guard;
  storeKey = "${pkgs.hello}/key";

  cases = hardeningCases ++ [
    {
      name = "ExecStart carries --ninfer-url";
      ok = lib.hasInfix "--ninfer-url http://model.example:8000/v1" svc.ExecStart;
    }
    {
      name = "ExecStart carries --api-key-file";
      ok = lib.hasInfix "--api-key-file %h/.config/model/api-key" svc.ExecStart;
    }
    {
      name = "unit is wanted by default.target";
      ok = unit.Install.WantedBy == [ "default.target" ];
    }
    {
      name = "xmsgSocket sets the three XMSG_*_SOCK vars";
      ok =
        withSock.Service.Environment == [
          "XMSG_HTTP_SOCK=/run/user/1000/xmsg/http.sock"
          "XMSG_AGENT_SOCK=/run/user/1000/xmsg/agent.sock"
          "XMSG_REGISTER_SOCK=/run/user/1000/xmsg/register.sock"
        ];
    }
    {
      name = "no xmsgSocket sets no Environment";
      ok = !(svc ? Environment);
    }
    {
      name = "extraArgs are appended";
      ok = lib.hasSuffix "--x 'a b'" (
        (render (
          base
          // {
            extraArgs = [
              "--x"
              "a b"
            ];
          }
        )).config.systemd.user.services.genie-guard.Service.ExecStart
      );
    }
    {
      name = "a Nix-store apiKeyFile fails the assertions";
      ok = failed (render (base // { apiKeyFile = storeKey; })) != [ ];
    }
    {
      name = "a literal /nix/store apiKeyFile fails the assertions";
      ok = failed (render (base // { apiKeyFile = "/nix/store/x-key"; })) != [ ];
    }
    {
      name = "a runtime apiKeyFile passes the assertions";
      ok = failed (render base) == [ ];
    }
  ];
  bad = lib.filter (c: !c.ok) cases;
in
assert lib.assertMsg (
  bad == [ ]
) "genie-guard HM module cases failed: ${toString (map (c: c.name) bad)}";
pkgs.runCommand "genie-agent-hm-module" { } "touch $out"

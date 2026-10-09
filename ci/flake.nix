{
  inputs = {
    gen-harness.url = "github:sini/gen-harness";
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
    genie-agent.url = "path:..";
  };

  outputs =
    inputs@{
      gen-harness,
      genie-agent,
      ...
    }:
    gen-harness.lib.mkCi {
      inherit inputs;
      name = "genie-agent";
      testModules = ./tests;
      extraModules = [
        # genie-agent is a TOOL, not an ecosystem library: it is absent from the register roster,
        # so no capability sheet is owed.
        { gen.ci.agentsMd.sheet = "not-owed"; }
        # Nor a root library surface: there is no root default.nix.
        { gen.ci.rootSurface.entry = "not-owed"; }
        {
          perSystem =
            { system, ... }:
            {
              checks.package = genie-agent.packages.${system}.default;
              # Every fixture under schemas/fixtures validates or fails as its directory names.
              checks.schemas = genie-agent.checks.${system}.schemas;
            };
        }
      ];
    };
}

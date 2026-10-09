{
  inputs = {
    gen-harness.url = "github:sini/gen-harness";
    # ★ THE SUBJECT IS READ BY RELATIVE PATH, NEVER AS A `path:..` INPUT. Lix refuses a relative
    # `path` node in a lock ("mutable lock"), and a Lix-written `path:..?narHash=…` lock pins a stale
    # snapshot of the tree (den-hoag-lbtnv D1). So `outputs` below applies `../flake.nix`'s own
    # `outputs` to the `nixpkgs` declared here, line for line as `../flake.nix` declares it.
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
  };

  outputs =
    inputs@{ gen-harness, nixpkgs, ... }:
    let
      # The published surface of THIS tree.
      genie-agent = (import ../flake.nix).outputs {
        inherit (inputs) self;
        inherit nixpkgs;
      };
    in
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
              # The schemas and their fixtures are JSON. No gen member formats TypeScript, so
              # src/ is left to tsc.
              treefmt.programs.jsonfmt.enable = true;
              checks.package = genie-agent.packages.${system}.default;
              # Every fixture under schemas/fixtures validates or fails as its directory names.
              checks.schemas = genie-agent.checks.${system}.schemas;
              # Every credential shape is redacted and named; clean text passes byte-identical.
              checks.redactor = genie-agent.checks.${system}.redactor;
              # IFD only on the trusted tier, which the request cannot raise; evaluation is pure.
              checks.eval = genie-agent.checks.${system}.eval;
            };
        }
      ];
    };
}

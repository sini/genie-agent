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
        # Nor an evaluator matrix: its CI is one upstream-Nix column, not evaluators.yml.
        { gen.ci.evaluators = "not-owed"; }
        # The eval runner's oracle runs as a program under each column's evaluator, not as a check.
        ./tests-process.nix
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
              # A parked thread resumes under its first launch's uuid, across a dispatcher restart.
              checks.dispatcher = genie-agent.checks.${system}.dispatcher;
              # The injection corpus under corpus/injection lints clean.
              checks.corpus = genie-agent.checks.${system}.corpus;
              # Every file under support-memory/ passes the refusal-only admission check.
              checks.support-memory = genie-agent.checks.${system}.support-memory;
              # Any guard-in reply outside schemas/verdict.json parses to a reject, and genie-guard
              # relays a verdict or an error, never the model's text.
              checks.guard = genie-agent.checks.${system}.guard;
              # Two threads on one repo share one mirror clone, and a refused URL runs no git.
              checks.mirror = genie-agent.checks.${system}.mirror;
            };
        }
        # Each single executable runs its own main and no offered payload. Linux only, so it is
        # defined only where the subject defines it.
        {
          perSystem =
            { system, lib, ... }:
            {
              checks = lib.optionalAttrs ((genie-agent.checks.${system} or { }) ? dispatcher-sea) {
                inherit (genie-agent.checks.${system}) dispatcher-sea genie-guard-sea;
              };
            };
        }
      ];
    };
}

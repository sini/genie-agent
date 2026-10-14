{
  inputs = {
    gen-harness.url = "github:sini/gen-harness";
    # ★ THE SUBJECT IS READ BY RELATIVE PATH, NEVER AS A `path:..` INPUT. Lix refuses a relative
    # `path` node in a lock ("mutable lock"), and a Lix-written `path:..?narHash=…` lock pins a stale
    # snapshot of the tree (den-hoag-lbtnv D1). So `outputs` below applies `../flake.nix`'s own
    # `outputs` to the `nixpkgs` declared here, line for line as `../flake.nix` declares it.
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
    xmsg.url = "github:sini/xmsg/11d293d72e6f17c24fcdb206cca020d32239f4c1";
    xmsg.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs@{
      gen-harness,
      nixpkgs,
      xmsg,
      ...
    }:
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
              # Two threads on one repo share one mirror clone, a refused URL runs no git, a fetch
              # past the per-repo cap is killed and leaves no mirror (a mirror with a live worktree is
              # left as it was), and LRU eviction holds the quota but never evicts a pinned mirror.
              checks.mirror = genie-agent.checks.${system}.mirror;
              # Tier 1 has exactly twelve tools, confined to its worktrees and public addresses, and
              # sees web content only through a guard verdict.
              checks.tier1 = genie-agent.checks.${system}.tier1;
              # One pi process per thread: a fact planted in one thread is absent from another, and
              # tearing one down leaves the rest running.
              checks.supervisor = genie-agent.checks.${system}.supervisor;
              # Under real pi, a tier-1 tool call reaches the supervisor's Host as the thread whose
              # process made it, the system prompt carries every skill, and a web result reaches the
              # model only as the supervisor's guard Screen allows or rewrites it.
              checks.tier1-bridge = genie-agent.checks.${system}.tier1-bridge;
              # One eval in flight per thread, threads overlap, and a failed run releases its thread.
              checks.eval-lock = genie-agent.checks.${system}.eval-lock;
              # Only the effective tier opens IFD and builders; the untrusted argv is E1's.
              checks.eval-argv = genie-agent.checks.${system}.eval-argv;
              # limit_hit: a deadline kill is timeout, an OOM kill oom, any other SIGKILL unknown, a refused
              # fetch egress, else none.
              checks.eval-limits = genie-agent.checks.${system}.eval-limits;
              # A thread's transcript, tier and eval cache survive a restart, on its own paths.
              checks.state = genie-agent.checks.${system}.state;
              # Parked at 1 h and resumed with its context; closed on accept or 24 h idle with its
              # worktrees removed, open after 🔍; on schedule across a restart.
              checks.lifecycle = genie-agent.checks.${system}.lifecycle;
              # A forced or below-threshold draft escalates at once, a confident one on 🔍, once.
              checks.escalation = genie-agent.checks.${system}.escalation;
              # Kept at 95 h idle, archived then gone at 97 h, mirrors unpinned; a failed archive keeps all.
              checks.gc = genie-agent.checks.${system}.gc;
              # The thread's tier falls on a public line and rises only on a trusted `!trust`.
              checks.tier = genie-agent.checks.${system}.tier;
              # A proposal failing guard-out is never acted on; a passing one is acted on once, redacted.
              checks.broker = genie-agent.checks.${system}.broker;
              # A gist proposal is one POST /gists, redacted, with the Bearer token; a failure is not acted
              # on, once, and never carries the token.
              checks.gist = genie-agent.checks.${system}.gist;
              # A pr proposal opens one PR whose body links the thread, its calls in order; a failed PR
              # step is not acted on, its branch deleted, and never carries the token.
              checks.pr = genie-agent.checks.${system}.pr;
              # One PUT per archive with all four sections, the transcript pi's session file, keyed by
              # tier; a failed PUT rejects.
              checks.archive = genie-agent.checks.${system}.archive;
              # The composition root: an inbound line reaches pi with its tier observed and a guard-in
              # reject never does; eval at the stored tier; a draft to Post, a forced one to xmsg at
              # C6's address; a close archives once.
              checks.root = genie-agent.checks.${system}.root;
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
        {
          perSystem =
            {
              system,
              lib,
              pkgs,
              ...
            }:
            {
              checks = lib.optionalAttrs ((genie-agent.packages.${system} or { }) ? genie-guard) {
                xmsg-integration =
                  pkgs.runCommand "genie-agent-xmsg-integration"
                    {
                      nativeBuildInputs = [
                        pkgs.nodejs
                        xmsg.packages.${system}.default
                        genie-agent.packages.${system}.genie-guard
                      ];
                      src = nixpkgs.lib.fileset.toSource {
                        root = ../.;
                        fileset = nixpkgs.lib.fileset.unions [
                          ../package.json
                          ../src/dispatcher
                          ../tests/xmsg-integration.test.ts
                        ];
                      };
                    }
                    ''
                      cd $src
                      export XMSG_BIN="${xmsg.packages.${system}.default}/bin/xmsg"
                      export GENIE_GUARD_BIN="${genie-agent.packages.${system}.genie-guard}/bin/genie-guard"
                      rc=0
                      node --test --test-reporter=tap tests/xmsg-integration.test.ts > $TMPDIR/tap || rc=$?
                      cat $TMPDIR/tap
                      [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle 1: guard round trip relays verdict and refuses svc: prefix$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 2: two outstanding dispatcher sends matched by inReplyTo in reverse arrival order$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                      touch $out
                    '';
              };
            };
        }
      ];
    };
}

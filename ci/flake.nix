{
  inputs = {
    gen-harness.url = "github:sini/gen-harness";
    # ★ THE SUBJECT IS READ BY RELATIVE PATH, NEVER AS A `path:..` INPUT. Lix refuses a relative
    # `path` node in a lock ("mutable lock"), and a Lix-written `path:..?narHash=…` lock pins a stale
    # snapshot of the tree (den-hoag-lbtnv D1). So `outputs` below applies `../flake.nix`'s own
    # `outputs` to the `nixpkgs` declared here, line for line as `../flake.nix` declares it.
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
    xmsg.url = "github:sini/xmsg/3aa04570cf9768164bd7c82b8ffca8002591bf87";
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
              checks = (genie-agent.checks.${system} or { }) // {
                package = genie-agent.packages.${system}.default;
                # Pinned operating-memory package ensures MEMORY.md and all link targets exist.
                operating-memory = genie-agent.packages.${system}.operating-memory;
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
            let
              # xmsg's own suite is tested in xmsg's CI, not here; building without doCheck avoids
              # re-running xmsg's cargo test suite when building the integration binary.
              xmsgNoCheck = xmsg.packages.${system}.default.overrideAttrs { doCheck = false; };
              xmsgCargoArtifacts = xmsg.packages.${system}.cargoArtifacts;
            in
            {
              checks = lib.optionalAttrs ((genie-agent.packages.${system} or { }) ? genie-guard) {
                xmsg-integration =
                  pkgs.runCommand "genie-agent-xmsg-integration"
                    {
                      nativeBuildInputs = [
                        pkgs.nodejs
                        pkgs.git
                        # GS2: genie-root always runs pi inside bwrap (genie-agent.service has it on PATH).
                        pkgs.bubblewrap
                        xmsgNoCheck
                        genie-agent.packages.${system}.genie-guard
                        genie-agent.packages.${system}.genie-root
                      ];
                      passthru = {
                        inherit xmsgNoCheck xmsgCargoArtifacts;
                        genieGuard = genie-agent.packages.${system}.genie-guard;
                        genieRoot = genie-agent.packages.${system}.genie-root;
                      };
                      src = nixpkgs.lib.fileset.toSource {
                        root = ../.;
                        fileset = nixpkgs.lib.fileset.unions [
                          ../package.json
                          ../src
                          ../schemas
                          ../skills
                          ../prompts
                          ../tests/fixtures/supervisor
                          ../tests/integration/xmsg.test.ts
                        ];
                      };
                    }
                    ''
                      cd $src
                      export XMSG_BIN="${xmsgNoCheck}/bin/xmsg"
                      export GENIE_GUARD_BIN="${genie-agent.packages.${system}.genie-guard}/bin/genie-guard"
                      export GENIE_ROOT_BIN="${genie-agent.packages.${system}.genie-root}/bin/genie-root"
                      export PI="${nixpkgs.lib.getExe pkgs.pi-coding-agent}"
                      rc=0
                      node --test --test-force-exit --test-reporter=tap tests/integration/xmsg.test.ts > $TMPDIR/tap || rc=$?
                      cat $TMPDIR/tap
                      [ "$rc" -eq 0 ] \
                        && grep -q '^ok [0-9]* - oracle 1: guard round trip relays verdict and refuses svc: prefix$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 2: two outstanding dispatcher sends matched by inReplyTo in reverse arrival order$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 3 (GI-2): XmsgGuardClient enforces FIFO concurrency limit over 3 parallel checks and fails closed on timeout$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 4 (GI-2): simulated matrix-xmsg forward to genie passes guard, runs fake pi, replies draft, and routes escalation to fake expert matched by inReplyTo$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 5 (GI-3): two genie-dispatcher services register concurrently on one bus and a fake-clock sweep parks an idle pane$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 6 (GI-3.1): spawning a thread over real xmsg serve creates an isolated clone (source worktree list, refs, and objects unchanged after commit/branch move) and 96h fake-clock GC removes the dir$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 9 (GI-8): room_context round-trip by scope as xmsg reply to thread forward, error/throttle handling, guard-in screening, and multi-page resync over real xmsg serve$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 10 (GI-9): with svcExe.genie set to genie-root SEA binary, genie-root registers as genie and a plain node process is refused$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - oracle 11 (GI-10): genie-root re-registers within backoff bound when xmsg serve restarts without restarting its own process, logs drop and re-registration, and receives messages after restart$' $TMPDIR/tap \
                        && grep -q '^ok [0-9]* - scope wire: service origin enables scope while display and ancestor claims do not$' $TMPDIR/tap \
                        && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                      cp -r . $TMPDIR/mut-go6-source-obj
                      chmod -R u+w $TMPDIR/mut-go6-source-obj
                      substituteInPlace $TMPDIR/mut-go6-source-obj/src/dispatcher/index.ts \
                        --replace-fail 'materialized.push(dest);' 'execFileSync("git", ["-C", resolved.sourcePath, "hash-object", "-w", "--stdin"], { input: "leaked-object\n" }); materialized.push(dest);'
                      if (cd $TMPDIR/mut-go6-source-obj && node --test --test-force-exit --test-name-pattern='oracle 6 \(GI-3\.1\)' tests/integration/xmsg.test.ts >/dev/null 2>&1); then
                        echo "mutant M-go6-source-object survived in xmsg-integration" >&2
                        exit 1
                      fi
                      cp -r . $TMPDIR/mut-go6-source-ref
                      chmod -R u+w $TMPDIR/mut-go6-source-ref
                      substituteInPlace $TMPDIR/mut-go6-source-ref/src/dispatcher/index.ts \
                        --replace-fail 'materialized.push(dest);' 'execFileSync("git", ["-C", resolved.sourcePath, "update-ref", "refs/heads/leaked-ref", "HEAD"]); materialized.push(dest);'
                      if (cd $TMPDIR/mut-go6-source-ref && node --test --test-force-exit --test-name-pattern='oracle 6 \(GI-3\.1\)' tests/integration/xmsg.test.ts >/dev/null 2>&1); then
                        echo "mutant M-go6-source-ref survived in xmsg-integration" >&2
                        exit 1
                      fi
                      cp -r . $TMPDIR/mut-go6-old-loose-oracle
                      chmod -R u+w $TMPDIR/mut-go6-old-loose-oracle
                      substituteInPlace $TMPDIR/mut-go6-old-loose-oracle/tests/integration/xmsg.test.ts \
                        --replace-fail 'assertSourceRepoUnchanged(sourceRepoDir, sourceBaseline, "after forced git gc in source repo");' 'assert.equal(git(["-C", sourceRepoDir, "count-objects"]), looseBaseline, "source repo git count-objects must be unchanged");'
                      if (cd $TMPDIR/mut-go6-old-loose-oracle && node --test --test-force-exit --test-name-pattern='oracle 6 \(GI-3\.1\)' tests/integration/xmsg.test.ts >/dev/null 2>&1); then
                        echo "positive control M-go6-old-loose-oracle survived forced git gc in xmsg-integration" >&2
                        exit 1
                      fi
                      touch $out
                    '';
              };
            };
        }
      ];
    };
}

{
  description = "genie-agent: the tiered support expert behind @genie";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "genie-agent";
          version = "0.1.0";
          src = nixpkgs.lib.fileset.toSource {
            root = ./.;
            fileset = nixpkgs.lib.fileset.unions [
              ./package.json
              ./tsconfig.json
              ./src
              ./schemas
            ];
          };
          nativeBuildInputs = [ pkgs.typescript ];
          buildPhase = "tsc -p .";
          installPhase = ''
            mkdir -p $out/lib/genie-agent
            cp -r package.json dist schemas $out/lib/genie-agent/
          '';
          meta = {
            description = "Tiered support expert behind @genie";
            license = nixpkgs.lib.licenses.mit;
          };
        };
      });

      checks = forAllSystems (pkgs: {
        schemas =
          pkgs.runCommand "genie-agent-schemas"
            {
              nativeBuildInputs = [ pkgs.check-jsonschema ];
            }
            ''
              bash ${./tests/schemas.sh} ${./schemas}
              touch $out
            '';
        # The redactor's gating oracle. node counts a file with no tests as one passing test, so
        # the run must show a named cell, not just a pass count.
        redactor =
          pkgs.runCommand "genie-agent-redactor"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
              src = nixpkgs.lib.fileset.toSource {
                root = ./.;
                fileset = nixpkgs.lib.fileset.unions [
                  ./src/redactor
                  ./tests/redactor.test.ts
                ];
              };
            }
            ''
              cd $src
              rc=0
              node --test --test-reporter=tap tests/redactor.test.ts > $TMPDIR/tap || rc=$?
              cat $TMPDIR/tap
              [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - clean control passes byte-identical$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
              touch $out
            '';
        # The dispatcher's gating oracles, core (design oracle 24) and delivery (oracle 28), against
        # a recording herdr fake and an xmsg fake.
        dispatcher =
          pkgs.runCommand "genie-agent-dispatcher"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
              src = nixpkgs.lib.fileset.toSource {
                root = ./.;
                fileset = nixpkgs.lib.fileset.unions [
                  ./src/dispatcher
                  ./tests/dispatcher.test.ts
                  ./tests/delivery.test.ts
                ];
              };
            }
            ''
              cd $src
              rc=0
              node --test --test-reporter=tap tests/dispatcher.test.ts tests/delivery.test.ts > $TMPDIR/tap || rc=$?
              cat $TMPDIR/tap
              [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle 24: a parked thread resumes with its first launch.s uuid across a kill and restart$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 28: a message to a parked thread is buffered, delivered once xmsg lists the resumed uuid, and answered$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
              touch $out
            '';
        # The verdict parser's gating oracle: any reply outside schemas/verdict.json, or breaking its
        # contract with the reviewed envelope, is a reject. Also the rewrite predicate's lexical arm.
        guard =
          pkgs.runCommand "genie-agent-guard"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
              src = nixpkgs.lib.fileset.toSource {
                root = ./.;
                fileset = nixpkgs.lib.fileset.unions [
                  ./src/guard
                  ./schemas/fixtures/verdict
                  ./corpus/injection/must-not-contain.json
                  ./tests/guard.test.ts
                  ./tests/rewrite-predicate.ts
                  ./tests/fixtures/guard
                ];
              };
            }
            ''
              cd $src
              rc=0
              node --test --test-reporter=tap tests/guard.test.ts > $TMPDIR/tap || rc=$?
              cat $TMPDIR/tap
              [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - unparseable output fails closed to reject$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
              touch $out
            '';
        # The guard-in injection corpus, and the held-out one beside it, are well-formed and cover
        # every attack vector; the held-out sidecar names fragments each attack actually carries.
        corpus = pkgs.runCommand "genie-agent-corpus" { nativeBuildInputs = [ pkgs.python3 ]; } ''
          python3 ${./tests/corpus.py} ${./corpus/injection/cases.jsonl}
          python3 ${./tests/corpus.py} ${./corpus/injection-heldout/cases.jsonl} ${./corpus/injection-heldout/must-not-contain.json}
          touch $out
        '';
        # The support memory holds no credential shape, private repository name, home path or
        # entry without frontmatter. It can only refuse: a merged PR admits.
        support-memory =
          pkgs.runCommand "genie-agent-support-memory"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
              src = nixpkgs.lib.fileset.toSource {
                root = ./.;
                fileset = nixpkgs.lib.fileset.unions [
                  ./src/redactor
                  ./tests/support-memory.ts
                  ./support-memory
                ];
              };
            }
            ''
              cd $src
              node tests/support-memory.ts support-memory
              touch $out
            '';
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.typescript
            pkgs.check-jsonschema
          ];
        };
      });
    };
}

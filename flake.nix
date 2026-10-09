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
        # The eval runner's gating oracle: nix inside bwrap, inside this build's sandbox. As with the
        # redactor, the run must show a named cell, not just a pass count.
        eval =
          pkgs.runCommand "genie-agent-eval"
            {
              nativeBuildInputs = [
                pkgs.nodejs
                pkgs.nix
                pkgs.bubblewrap
              ];
              src = nixpkgs.lib.fileset.toSource {
                root = ./.;
                fileset = nixpkgs.lib.fileset.unions [
                  ./src/eval
                  ./tests/eval.test.ts
                  ./tests/fixtures/eval
                ];
              };
            }
            ''
              cd $src
              rc=0
              node --test --test-reporter=tap tests/eval.test.ts > $TMPDIR/tap || rc=$?
              cat $TMPDIR/tap
              [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - request.trusted cannot raise a public tier$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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

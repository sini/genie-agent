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

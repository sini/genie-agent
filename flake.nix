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
      # The dispatcher runs on bitstream only.
      onLinux = pkgs: nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux;
      # The dispatcher as a Node single executable, the path xmsg's `--svc-exe` attests (design
      # §5.8, Topology). Its blob is the bundled main, and `execArgvExtension: "none"` makes it
      # ignore NODE_OPTIONS, so the attested path runs nothing but the dispatcher.
      genieDispatcher =
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
          pname = "genie-dispatcher";
          version = "0.1.0";
          src = nixpkgs.lib.fileset.toSource {
            root = ./.;
            fileset = ./src/dispatcher;
          };
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.esbuild
          ];
          # postject is not in nixpkgs. Its api.js is self-contained (the cli adds commander).
          postject = pkgs.fetchurl {
            url = "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz";
            hash = "sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==";
          };
          buildPhase = ''
            esbuild src/dispatcher/main.ts --bundle --platform=node --format=cjs --outfile=main.cjs
            echo '{"main": "main.cjs", "output": "blob", "disableExperimentalSEAWarning": true, "execArgvExtension": "none"}' > sea.json
            node --experimental-sea-config sea.json
            tar xzf $postject
            cp ${pkgs.lib.getExe pkgs.nodejs} genie-dispatcher
            chmod u+w genie-dispatcher
            node -e '
              const [api, exe, blob] = process.argv.slice(1);
              require(api).inject(exe, "NODE_SEA_BLOB", require("fs").readFileSync(blob), {
                sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
              }).catch((e) => { console.error(e); process.exit(1); });
            ' $PWD/package/dist/api.js genie-dispatcher blob
          '';
          installPhase = "install -Dm755 genie-dispatcher $out/bin/genie-dispatcher";
          meta = {
            description = "genie-agent's dispatcher, as a Node single executable";
            license = nixpkgs.lib.licenses.mit;
            mainProgram = "genie-dispatcher";
            platforms = nixpkgs.lib.platforms.linux;
          };
        };
    in
    {
      packages = forAllSystems (
        pkgs:
        {
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
        }
        // onLinux pkgs {
          genie-dispatcher = genieDispatcher pkgs;
        }
      );

      checks = forAllSystems (
        pkgs:
        {
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
        }
        // onLinux pkgs {
          # The single executable runs its own main and nothing else: a payload offered through
          # NODE_OPTIONS, a node flag or a script argument never runs, and the dispatcher's own
          # config refusal (exit 2) is the positive control that its main did.
          dispatcher-sea =
            pkgs.runCommand "genie-agent-dispatcher-sea"
              {
                nativeBuildInputs = [ (genieDispatcher pkgs) ];
              }
              ''
                payload=$TMPDIR/payload.cjs
                echo 'require("fs").writeFileSync(process.env.MARK, "ran"); console.log("PAYLOAD RAN")' > $payload
                export MARK=$TMPDIR/mark
                fail=0
                try() {
                  rc=0
                  got=$("$@" 2>&1) || rc=$?
                  echo "$* => rc $rc: $got"
                  case $got in
                    "genie-dispatcher: "*) [ "$rc" -eq 2 ] || fail=1 ;;
                    *) fail=1 ;;
                  esac
                }
                NODE_OPTIONS="--require $payload" try genie-dispatcher
                try genie-dispatcher --require $payload
                try genie-dispatcher -e "require('$payload')"
                try genie-dispatcher $payload
                if [ -e $MARK ]; then echo "payload ran"; fail=1; fi
                [ "$fail" -eq 0 ] || exit 1
                touch $out
              '';
        }
      );

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

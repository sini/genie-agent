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
      # The services run on bitstream only.
      onLinux = pkgs: nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux;
      portableRuntimePath =
        pkgs:
        nixpkgs.lib.makeBinPath [
          pkgs.pi-coding-agent
          pkgs.nix
          pkgs.gitMinimal
          pkgs.coreutils
        ];
      modelSdk =
        pkgs:
        "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/compat.js";
      forAllCheckSystems =
        rootPackages: f:
        forAllSystems (
          pkgs:
          let
            allChecks = f pkgs;
          in
          (
            if pkgs.stdenv.hostPlatform.isLinux then
              allChecks
            else
              builtins.removeAttrs allChecks [
                "dispatcher"
                "tier1"
                "tier1-bridge"
                "bwrap-selection"
                "eval-argv"
                "root"
              ]
          )
          // import ./nix/portable-checks.nix {
            inherit pkgs;
            lib = nixpkgs.lib;
            rootPackage = rootPackages.${pkgs.stdenv.hostPlatform.system}.default;
            modelSdk = modelSdk pkgs;
            unitChecks = allChecks;
          }
        );
      # A service as a Node single executable, the path xmsg's `--svc-exe` attests (design §5.8,
      # Topology). Its blob is the bundled main, and `execArgvExtension: "none"` makes it ignore
      # NODE_OPTIONS, so the attested path runs nothing but that main.
      sea =
        {
          name,
          main,
          fileset,
          description,
          esbuildFlags ? "",
        }:
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
          pname = name;
          version = "0.1.0";
          src = nixpkgs.lib.fileset.toSource {
            root = ./.;
            inherit fileset;
          };
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.esbuild
            pkgs.removeReferencesTo
          ];
          # postject is not in nixpkgs. Its api.js is self-contained (the cli adds commander).
          postject = pkgs.fetchurl {
            url = "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz";
            hash = "sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==";
          };
          buildPhase = ''
            esbuild ${main} --bundle --platform=node --format=cjs --loader:.md=text ${esbuildFlags} --outfile=main.cjs
            echo '{"main": "main.cjs", "output": "blob", "disableExperimentalSEAWarning": true, "execArgvExtension": "none"}' > sea.json
            node --experimental-sea-config sea.json
            tar xzf $postject
            cp ${pkgs.lib.getExe pkgs.nodejs} ${name}
            chmod u+w ${name}
            node -e '
              const [api, exe, blob] = process.argv.slice(1);
              require(api).inject(exe, "NODE_SEA_BLOB", require("fs").readFileSync(blob), {
                sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
              }).catch((e) => { console.error(e); process.exit(1); });
            ' $PWD/package/dist/api.js ${name} blob
          '';
          installPhase = ''
            install -Dm755 ${name} $out/bin/${name}
            for p in $(grep -a -o -E '/nix/store/[a-z0-9]{32}-[a-zA-Z0-9_.-]*(-dev|nodejs[a-zA-Z0-9_.-]*)' $out/bin/${name} | grep -v '^/nix/store/e\{32\}' | sort -u); do
              remove-references-to -t "$p" $out/bin/${name}
            done
          '';
          meta = {
            inherit description;
            license = nixpkgs.lib.licenses.mit;
            mainProgram = name;
            platforms = nixpkgs.lib.platforms.linux;
          };
        };
      genieDispatcher = sea {
        name = "genie-dispatcher";
        main = "src/dispatcher/main.ts";
        fileset = ./src/dispatcher;
        description = "genie-agent's dispatcher, as a Node single executable";
      };
      # guard-in as `genie-guard`, with its prompt bundled in (genie-solicit-design.md, G1).
      genieGuard = sea {
        name = "genie-guard";
        main = "src/guard/main.ts";
        fileset = nixpkgs.lib.fileset.unions [
          ./src/guard
          ./src/dispatcher/xmsg.ts
          ./prompts/guard-in.md
          ./prompts/guard-web.md
        ];
        description = "genie-agent's guard-in, as a Node single executable";
      };
      # Tier 1's composition root (`genie-root`, GI-2 / GI-9): a Node single executable over
      # `src/root/main.ts` so xmsg's `--svc-exe` attests its own store binary rather than shared nodejs.
      genieRoot =
        pkgs:
        let
          rootSrc = pkgs.stdenvNoCC.mkDerivation {
            pname = "genie-root-src";
            version = "0.1.0";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./package.json
                ./tsconfig.json
                ./src
                ./schemas
                ./skills
                ./prompts
              ];
            };
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/lib/genie-agent
              cp -r package.json tsconfig.json src schemas skills prompts $out/lib/genie-agent/
            '';
          };
          runtimePath = portableRuntimePath pkgs;
          seaPkg = sea {
            name = "genie-root";
            main = "src/root/main.ts";
            fileset = nixpkgs.lib.fileset.unions [
              ./src
              ./schemas
              ./skills
              ./prompts
            ];
            esbuildFlags = ''--banner:js="process.env.GENIE_REPO_ROOT ??= \"${rootSrc}/lib/genie-agent\";process.env.GENIE_PI_AI = \"${modelSdk pkgs}\";"'';
            description = "genie-agent's tier-1 composition root, as a Node single executable";
          } pkgs;
        in
        seaPkg.overrideAttrs (_: {
          passthru = {
            inherit rootSrc runtimePath;
            caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
          };
        });
      guardImage =
        pkgs:
        pkgs.dockerTools.buildLayeredImage {
          name = "ghcr.io/sini/genie-guard";
          tag = "latest";
          contents = [
            pkgs.cacert
            (genieGuard pkgs)
          ];
          extraCommands = ''
            mkdir -p -m 1777 tmp
          '';
          config = {
            User = "65532:65532";
            Entrypoint = [ "${genieGuard pkgs}/bin/genie-guard" ];
            Env = [
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
          };
        };
      rootImage =
        pkgs: memory:
        let
          root = genieRoot pkgs;
          worker = pkgs.writeShellScriptBin "genie-container-worker" ''
            export GENIE_REPO_ROOT=${root.rootSrc}/lib/genie-agent
            export GENIE_PI_AI=${modelSdk pkgs}
            export PATH=${root.runtimePath}:$PATH
            exec ${pkgs.nodejs}/bin/node ${root.rootSrc}/lib/genie-agent/src/tier1/container-worker.ts "$@"
          '';
        in
        pkgs.dockerTools.buildLayeredImage {
          name = "ghcr.io/sini/genie-root";
          tag = "latest";
          contents = [
            root
            root.rootSrc
            worker
            pkgs.cacert
          ]
          ++ map builtins.dirOf (nixpkgs.lib.splitString ":" root.runtimePath);
          extraCommands = ''
            mkdir -p -m 1777 tmp
            mkdir -p memory
            cp -R ${memory}/. memory/
            find memory -type d -exec chmod 0555 {} +
            find memory -type f -exec chmod 0444 {} +
          '';
          fakeRootCommands = ''
            chown -R 0:0 memory
          '';
          config = {
            User = "65532:65532";
            Entrypoint = [ "${root}/bin/genie-root" ];
            Env = [
              "PATH=${root.runtimePath}"
              "SSL_CERT_FILE=${root.caBundle}"
              "NIX_SSL_CERT_FILE=${root.caBundle}"
              "GENIE_REPO_ROOT=${root.rootSrc}/lib/genie-agent"
            ];
          };
        };
      # Each single executable runs its own main and nothing else: a payload offered through
      # NODE_OPTIONS, a node flag or a script argument never runs, and the binary's own config
      # refusal (exit 2) is the positive control that its main did. Also asserts the executable
      # is neither a script (no `#!`) nor a symlink to nodejs.
      seaCheck =
        name: pkg: pkgs:
        pkgs.runCommand "genie-agent-${name}-sea" { nativeBuildInputs = [ pkg ]; } ''
          exe="${nixpkgs.lib.getExe pkg}"
          if [ -L "$exe" ]; then
            echo "$exe is a symlink" >&2
            exit 1
          fi
          magic=$(head -c 2 "$exe")
          if [ "$magic" = "#!" ]; then
            echo "$exe starts with #! (script wrapper)" >&2
            exit 1
          fi
          if [ "$(realpath "$exe")" = "$(realpath "${pkgs.lib.getExe pkgs.nodejs}")" ]; then
            echo "$exe resolves to shared nodejs" >&2
            exit 1
          fi
          payload=$TMPDIR/payload.cjs
          echo 'require("fs").writeFileSync(process.env.MARK, "ran"); console.log("PAYLOAD RAN")' > $payload
          export MARK=$TMPDIR/mark
          fail=0
          try() {
            rc=0
            got=$("$@" 2>&1) || rc=$?
            echo "$* => rc $rc: $got"
            case $got in
              "${name}: "*) [ "$rc" -eq 2 ] || fail=1 ;;
              *) fail=1 ;;
            esac
          }
          NODE_OPTIONS="--require $payload" try ${name}
          try ${name} --require $payload
          try ${name} -e "require('$payload')"
          try ${name} $payload
          if [ -e $MARK ]; then echo "payload ran"; fail=1; fi
          [ "$fail" -eq 0 ] || exit 1
          touch $out
        '';
    in
    rec {
      apps = forAllSystems (pkgs: {
        portable-baseline = {
          type = "app";
          program = "${
            self.checks.${pkgs.stdenv.hostPlatform.system}.portable-baseline.processPlane
          }/bin/genie-agent-portable-native";
        };
      });

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
                ./skills
                ./prompts
                ./bin
              ];
            };
            nativeBuildInputs = [
              pkgs.typescript
              pkgs.makeWrapper
            ];
            buildPhase = "tsc -p .";
            installPhase = ''
              mkdir -p $out/lib/genie-agent $out/bin
              cp -r package.json dist src schemas skills prompts $out/lib/genie-agent/
              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/genie-root-node \
                --add-flags "$out/lib/genie-agent/dist/src/root/main.js" \
                --set GENIE_REPO_ROOT "$out/lib/genie-agent" \
                --set GENIE_PI_AI "${modelSdk pkgs}" \
                --set-default SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
                --set-default NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
                --prefix PATH : ${portableRuntimePath pkgs}
              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/genie-container-worker \
                --add-flags "$out/lib/genie-agent/dist/src/tier1/container-worker.js" \
                --set GENIE_REPO_ROOT "$out/lib/genie-agent" \
                --set GENIE_PI_AI "${modelSdk pkgs}" \
                --prefix PATH : ${portableRuntimePath pkgs}
            '';
            passthru = {
              runtimePath = portableRuntimePath pkgs;
              caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
            };
            meta = {
              mainProgram = "genie-root-node";
              description = "Tiered support expert behind @genie";
              license = nixpkgs.lib.licenses.mit;
            };
          };

          genie-root-node = packages.${pkgs.stdenv.hostPlatform.system}.default;

          # The tier-1 OCI image copies this exact output to /memory.
          operating-memory = pkgs.stdenvNoCC.mkDerivation {
            pname = "genie-operating-memory";
            version = "0.1.0";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = ./operating-memory;
            };
            nativeBuildInputs = [ pkgs.python3 ];
            buildPhase = ''
              if [ ! -f operating-memory/MEMORY.md ]; then
                echo "Error: MEMORY.md is missing from operating-memory" >&2
                exit 1
              fi

              python3 -c '
              import os, re, sys
              mem_path = "operating-memory/MEMORY.md"
              with open(mem_path) as f:
                  content = f.read()

              links = re.findall(r"\[.*?\]\((.*?)\)", content)
              missing = []
              for link in links:
                  target = link.split("#")[0].strip()
                  if not target or target.startswith("http://") or target.startswith("https://"):
                      continue
                  full_path = os.path.join("operating-memory", target)
                  if not os.path.exists(full_path):
                      missing.append(f"{target} (from {link})")

              if missing:
                  print("Error: MEMORY.md link target does not exist:", file=sys.stderr)
                  for m in missing:
                      print(f"  - {m}", file=sys.stderr)
                  sys.exit(1)
              '
            '';
            installPhase = ''
              mkdir -p $out
              cp -r operating-memory/* $out/
            '';
            meta = {
              description = "Pinned operating memory corpus for tier 1";
              license = nixpkgs.lib.licenses.mit;
            };
          };
        }
        // onLinux pkgs {
          genie-dispatcher = genieDispatcher pkgs;
          genie-guard = genieGuard pkgs;
          genie-root = genieRoot pkgs;
          image = guardImage pkgs;
          root-image = rootImage pkgs packages.${pkgs.stdenv.hostPlatform.system}.operating-memory;
        }
      );

      checks = forAllCheckSystems packages (
        pkgs:
        {
          root-image-fixtures =
            pkgs.runCommand "genie-root-image-oracle-fixtures" { nativeBuildInputs = [ pkgs.python3 ]; }
              ''
                mkdir oracle
                cp ${./nix/check_root_image.py} oracle/check_root_image.py
                cp ${./nix/test_root_image.py} oracle/test_root_image.py
                python3 oracle/test_root_image.py
                touch $out
              '';
          schemas =
            pkgs.runCommand "genie-agent-schemas"
              {
                nativeBuildInputs = [
                  pkgs.check-jsonschema
                  pkgs.git
                ];
              }
              ''
                bash ${./tests/schemas.sh} ${./schemas}
                FORBIDDEN_RE='mutants|BrokerMutants|EvalMutants|GitReadMutants|WorktreeMutants|GhReadMutants|omitUnsharePid|rwWorktree|rwAgentDir|exposeStateRoot|omitPiOffline|piSandbox|skipBotIdentity|bypassGuardOut|evalImpure|worktreeSubdirNoPrefixCheck|worktreeGitCheckout|worktreeGitArchive|extractMirrorArchiveMutant|allowLeadingDash|bypassIdValidation|followRedirect|writeConfineAllowMemoryAndDotdot|ignoreSilentFlag|sessionNoFollow|noFollow|MUTANT_ALLOW_LEADING_DASH_REV_RE'
                mkdir -p $TMPDIR/guard-repo
                cp -r ${./src} $TMPDIR/guard-repo/src
                chmod -R u+w $TMPDIR/guard-repo
                git -C $TMPDIR/guard-repo init -q
                git -C $TMPDIR/guard-repo add src
                rc=0
                git --no-pager -C $TMPDIR/guard-repo grep -n -E "$FORBIDDEN_RE" -- src || rc=$?
                if [ "$rc" -ne 1 ]; then
                  echo "CI guard failed: git grep over src for removed mutant/weakening option names exited $rc (expected 1 / 0 matches)" >&2
                  exit 1
                fi
                echo "// planted BrokerMutants positive control" >> $TMPDIR/guard-repo/src/index.ts
                git -C $TMPDIR/guard-repo add src/index.ts
                if ! git --no-pager -C $TMPDIR/guard-repo grep -q -E "$FORBIDDEN_RE" -- src; then
                  echo "CI guard positive control failed: planted option name was not found by git grep" >&2
                  exit 1
                fi
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
                    ./tests/fixtures/redactor
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-reporter=tap tests/redactor.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - clean control passes byte-identical$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 2: every credential-shape case is redacted and every near-miss control passes byte-identical$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The dispatcher's gating oracles, core (design oracle 24, GI-14), delivery (oracle 28) and
          # park & GC (oracle 26), against a recording herdr fake, a real herdr server, and an xmsg fake.
          dispatcher =
            pkgs.runCommand "genie-agent-dispatcher"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.python3
                  pkgs.bash
                  pkgs.coreutils
                  (pkgs.herdr.overrideAttrs (old: {
                    patches = (old.patches or [ ]) ++ [ ./nix/patches/herdr-agent-start-command.patch ];
                  }))
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/dispatcher
                    ./src/tier1/schema.ts
                    ./schemas/expert-reply.json
                    ./schemas/fixtures/expert-reply
                    ./tests/dispatcher.test.ts
                    ./tests/delivery.test.ts
                    ./tests/dispatcher-gc.test.ts
                  ];
                };
              }
              ''
                export SHELL=${pkgs.bash}/bin/bash
                cd $src
                rc=0
                node --expose-gc --test --test-force-exit --test-reporter=tap tests/dispatcher.test.ts tests/delivery.test.ts tests/dispatcher-gc.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle 24: a parked thread resumes with its first launch.s uuid across a kill and restart$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GI-14: first escalation against a real herdr server lazily creates the base pane and starts claude$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GI-15 (K7 + SO_PEERPIDFD socketpair): CliHerdr splits panes in cwdDir and hands off token over SCM_RIGHTS socketpair$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GT3 (Arm A1): zero V8 and Python accept-window token residency across credential formats, D4b validated token id under CREDENTIALS_DIRECTORY, and pre-split refusal on invalid credentials$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GX1 (F1): THREAD_ID_RE validated at packageThread boundary and at every fs/dispatcher sink$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GX1 (F5): loadJournal validates entries (after N1 migration) and GC/escalate sinks re-validate$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle (loadCredential adapter off & fail-closed tokenCredentialFile): CliHerdr and startDispatcher prioritize configured tokenCredentialFile / credentialsDir over decoy CREDENTIALS_DIRECTORY and fail closed on missing or empty tokenCredentialFile$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 28: a message to a parked thread is buffered, delivered once xmsg lists the resumed uuid, and answered$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GE1: malformed expert replies (plain text, empty answer, missing/wrong tier, out-of-range confidence, forged approval, deferred proposal) are rejected back to the expert session with a schema error, never relayed, and leave the turn outstanding until a valid reply arrives$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 26: never parked with a message outstanding or in buffer$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 26: parked at the threshold after the last reply, and resumable$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 26: at 95h idle kept, at 96h handed off and gone$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-herdr-cred-dir
                chmod -R u+w $TMPDIR/mut-herdr-cred-dir
                substituteInPlace $TMPDIR/mut-herdr-cred-dir/src/dispatcher/herdr.ts \
                  --replace-fail '      this.o.credentialsDir ??' '      this.env.CREDENTIALS_DIRECTORY ?? this.o.credentialsDir ??'
                if (cd $TMPDIR/mut-herdr-cred-dir && node --expose-gc --test --test-force-exit --test-name-pattern='oracle \(loadCredential adapter off & fail-closed tokenCredentialFile\)' tests/dispatcher.test.ts >/dev/null 2>&1); then
                  echo "mutant M-herdr-cred-dir-env-first survived in dispatcher" >&2
                  exit 1
                fi
                touch $out
              '';
          # The verdict parser's gating oracle: any reply outside schemas/verdict.json, or breaking its
          # contract with the reviewed envelope, is a reject. Also the rewrite predicate's lexical arm,
          # and genie-guard's: a verdict is relayed parsed, and no review is an error, never a verdict.
          guard =
            pkgs.runCommand "genie-agent-guard"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.python3
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/guard
                    ./src/mirror/index.ts
                    ./src/root/io.ts
                    ./src/root/index.ts
                    ./src/escalation/index.ts
                    ./src/state/index.ts
                    ./src/tier/index.ts
                    ./src/supervisor/guard-client.ts
                    ./src/supervisor/seed.ts
                    ./schemas/fixtures/verdict
                    ./schemas/fixtures/verdict-out
                    ./corpus/injection/must-not-contain.json
                    ./results/guard-in/injection-run1.json
                    ./results/guard-in/injection-run2.json
                    ./tests/guard.test.ts
                    ./tests/guard-out.test.ts
                    ./tests/guard-scope-mutants.py
                    ./prompts/guard-in.md
                    ./tests/guard-service.test.ts
                    ./src/dispatcher/xmsg.ts
                    ./src/dispatcher/reply.ts
                    ./tests/rewrite-predicate.ts
                    ./tests/fixtures/guard
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/guard.test.ts tests/guard-out.test.ts tests/guard-service.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] \
                  && grep -q '^ok [0-9]* - unparseable output fails closed to reject$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle 1 (G9): an allow reply with empty cleaned_text is accepted, and the forwarded text is the original$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle 2 (G9): an allow reply with a slightly different cleaned_text is still accepted, and the original is forwarded$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (GI-12 b): a reject without a valid class is logged and treated as allow$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle 3 (G9): in-repo corpus has no verdict regressions across saved runs and empty-cleaned_text allows$' $TMPDIR/tap \
                  && grep -q "^ok [0-9]* - oracle 4 (G9): a 4 KB envelope's allow reply fits without truncation$" $TMPDIR/tap \
                  && grep -q "^ok [0-9]* - oracle 5b (G9.1): review and reviewOut log loudly when reasoning_tokens > 0 or finish_reason === 'length', while preserving fail-closed behaviour$" $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (GI-12 c): genie-guard logs one line per verdict (message id, verdict, class, latency ms) and every error$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - an HTTP 500 from ninfer is an error reply, not a verdict$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle 2: parser fails closed to block on invalid or malformed output$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - scope authority: only exact transport service origin enables public targets$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - scope schema and zero targets: validation precedes calls and legacy trusted attacks stay reviewed$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (loadCredential adapter off): genie-guard config reads --api-key-file from configured path and ignores decoy CREDENTIALS_DIRECTORY$' $TMPDIR/tap \
                  && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                python3 tests/guard-scope-mutants.py $TMPDIR/scope-mutants
                touch $out
              '';
          # The mirror fetcher's gating oracle: two threads on one repo share one clone, a refused URL
          # starts no git process, a fetch past the per-repo cap is killed and leaves no mirror unless a
          # live worktree pins it (then the mirror is left as it was), and least-recently-used eviction, recorded on disk, holds the quota without touching a mirror
          # that has a live worktree.
          # Fixtures are served by a git daemon on the sandbox's loopback.
          mirror =
            pkgs.runCommand "genie-agent-mirror"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.git
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/mirror
                    ./src/lifecycle
                    ./src/root/io.ts
                    ./src/state
                    ./src/supervisor
                    ./src/tier
                    ./src/tier1/schema.ts
                    ./src/dispatcher/xmsg.ts
                    ./src/guard/verdict.ts
                    ./schemas
                    ./prompts
                    ./tests/mirror.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-reporter=tap tests/mirror.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: two threads on one repo share one clone, each with its own worktree$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: an over-cap clone is killed and leaves nothing, an under-cap one is mirrored$' $TMPDIR/tap && grep -q '^ok [0-9]* - a fetch that takes an unpinned mirror past its cap removes the mirror$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a killed over-cap fetch into a pinned mirror leaves its refs and bytes as they were, and its worktree resolves$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: refs deleted upstream are pruned only after a successful fetch, and a failed prune leaves them$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a pinned mirror already past its cap is refused before git starts$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: filling past the quota evicts the least-recently-used mirror and keeps the total under quota$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a mirror with a live worktree is never evicted, even when it is the least recently used$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: when pinned mirrors alone pass the quota, the new fetch is refused and leaves no mirror$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: the least-recently-used order survives a restart of the fetcher$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: diskBytes counts apparent file sizes, whether blocks are zero or exceed size, and skips directories$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GX1 (F3): threadName validated at parseMatrixForward boundary, lifecycle.close before rm, and removeWorktrees sink$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GX2 (F3): clone/worktreeFor goes through pin() and refusedList(cfg.cluster), allows https:// only, sanitises git stderr, and mutant goes RED$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GS2 (F1): worktreeFor passes -c core.symlinks=false so tracked symlinks are checked out as regular files, and mutant goes RED$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle O-GC1-git: gitRead enforces per-thread clone pin (P7), runs log/show/diff/blame/grep on bare mirror (including C-N1 single-rev diff), refuses flag-injection at schema and sink (F3), cleans stale genie-pins (Q5), and mutant M-git-allow-leading-dash goes RED$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-symlinks
                chmod -R u+w $TMPDIR/mut-symlinks
                substituteInPlace $TMPDIR/mut-symlinks/src/mirror/index.ts \
                  --replace-fail '  chmodSync,' '  chmodSync, symlinkSync,' \
                  --replace-fail '    writeFileSync(target, content, { mode: fmode });' '    if (entry.mode === "120000") { symlinkSync(content.toString("utf8").trim(), target); continue; } writeFileSync(target, content, { mode: fmode });'
                if (cd $TMPDIR/mut-symlinks && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/mirror.test.ts >/dev/null 2>&1); then
                  echo "mutant M-symlinks-true survived in mirror" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-git-dash
                chmod -R u+w $TMPDIR/mut-git-dash
                substituteInPlace $TMPDIR/mut-git-dash/src/mirror/index.ts \
                  --replace-fail '!GIT_REV_RE.test(rev)' '!/^[A-Za-z0-9._/~^=-]+(?:\.\.?[A-Za-z0-9._/~^=-]+)?$/.test(rev)' \
                  --replace-fail '      query.startsWith("-") ||' "" \
                  --replace-fail '  const endOpts = ["--end-of-options"];' '  const endOpts: string[] = [];'
                if (cd $TMPDIR/mut-git-dash && node --test --test-force-exit --test-name-pattern='oracle O-GC1-git' tests/mirror.test.ts >/dev/null 2>&1); then
                  echo "mutant M-git-allow-leading-dash survived in mirror" >&2
                  exit 1
                fi
                touch $out
              '';
          # Tier 1's tool surface: exactly twelve tools, the source tools confined to the thread's
          # worktrees, web_fetch refusing private and cluster addresses after resolution, and every
          # web result screened by the guard. Stub servers on the sandbox's loopback, no network.
          # The draft parser accepts and rejects the right fixture replies, and each skill is a
          # pi skill.
          tier1 =
            pkgs.runCommand "genie-agent-tier1"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.bubblewrap
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/tier1
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/lifecycle
                    ./src/state
                    ./src/supervisor
                    ./src/bank
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
                    ./src/mirror
                    ./schemas
                    ./skills
                    ./prompts
                    ./operating-memory
                    ./tests/tier1.test.ts
                    ./tests/tier1-draft.test.ts
                    ./tests/tier1-eval.test.ts
                    ./tests/tier1-questions.test.ts
                    ./tests/memory-eval.test.ts
                    ./tests/tier1-eval.ts
                    ./tests/fixtures/tier1-draft
                    ./tests/fixtures/tier1-eval
                    ./tests/fixtures/memory-eval
                    ./tests/fixtures/supervisor
                    ./results/tier1/c2.1-reanalysis.json
                  ];
                };
              }
              ''
                cd $src
                export PI=${nixpkgs.lib.getExe pkgs.pi-coding-agent}
                rc=0
                node --test --test-reporter=tap tests/tier1.test.ts tests/tier1-draft.test.ts tests/tier1-eval.test.ts tests/tier1-questions.test.ts tests/memory-eval.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] \
                  && grep -q '^ok [0-9]* - oracle: the tool list is exactly the seventeen$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: the draft parser accepts every valid reply and rejects every invalid one$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: a degraded arm scores below real by more than paired bootstrap noise band$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: compareArms reports inside_noise_band when paired bootstrap CI crosses zero$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: exploratory correctness predictors calculate AUROC and lift on distinct answered questions$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C2.2.2 (Item 1 & 3): runArm offers all 17 production TOOLS and executes built-in read/grep/find/ls with confinement$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C2.3 (Cell 1): eval tool set and system prompt equal production tier1Launch byte-for-byte$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C2.3 (Cell 2): checkpointed run with --resume skips finished questions without calling pi$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C2.3 (Cell 3): unanswered question (pi settles without reply or times out) has draft undefined, score 0, and counts in n_missing$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C13 (Oracle 4): eval uses shared TurnController, defaults timeoutMs to QUESTION_TIMEOUT_MS (600_000), and records checkin_fired and replied_after_checkin$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C2.3.1: --searxng-url routes web_search to stub SearXNG server and records searxng_url in result file (mutant: restored dead URL => RED)$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - Oracle C2.3 (Amendment 2): recall without bank or with bank: support returns empty support results and recall_called: false; bank: memory returns fixture results and recall_called: true$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (R1): recall tool description, parameter schema, and tier1 prompt name both banks and their contents$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (G10 a): a 100 KiB document comes back as 4 pages that reassemble byte-exactly into the original; each page went through the guard separately$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (G10 b): one page rejected by the guard is withheld with its reason, the next page is still returned, and the rejected bytes never appear$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (G10 c): the second page is served from the per-thread cache with one remote request in total$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (G10 d): under the screening window, behaviour is unchanged$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (G10 part 2): tier1 prompts and web_fetch tool description carry user-linked gist and paging rules$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (G11): parameterized web_fetch (including G10 100 KiB paging) and web_search over webScreen enabled true and false: off mode makes 0 guard calls and matches on-mode allow$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (GI-8 e): tier1 prompts contain the verbatim room_context cue and room_context tool registration has no room parameter, boolean, or \$ref$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle (GI-11): all three tier1 prompt variants carry the verbatim self-description cue$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle O-GC1-gh-read: gh_read supports all 8 kinds against stub GitHub API, sends read token from host without mounting it in pi jail, refuses path-traversal id and 302 redirects (F8), and mutants M-gh-read-bypass-id-validation and M-gh-read-follow-redirect go RED$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle O-GE2-FA-reply: reply tool description warns that posted: true means already posted and not to call reply again$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - Hermetic Memory Eval: each memory arm beats no-memory across repeated runs$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - memory-eval questions: ids unique and every claim specific$' $TMPDIR/tap \
                  && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-gh-id
                chmod -R u+w $TMPDIR/mut-gh-id
                substituteInPlace $TMPDIR/mut-gh-id/src/tier1/github.ts \
                  --replace-fail '!GH_GIST_ID_RE.test(req.id)' 'false' \
                  --replace-fail '!GH_NUMERIC_ID_RE.test(req.id)' 'false' \
                  --replace-fail 'encodeURIComponent(s)' 's' \
                  --replace-fail 'if (targetUrl.origin !== baseUrl.origin)' 'if (false)'
                if (cd $TMPDIR/mut-gh-id && node --test --test-force-exit --test-name-pattern='oracle O-GC1-gh-read' tests/tier1.test.ts >/dev/null 2>&1); then
                  echo "mutant M-gh-read-bypass-id-validation survived in tier1" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-gh-redir
                chmod -R u+w $TMPDIR/mut-gh-redir
                substituteInPlace $TMPDIR/mut-gh-redir/src/tier1/github.ts \
                  --replace-fail 'redirect: "manual",' 'redirect: "follow",' \
                  --replace-fail 'if (res.status >= 300 && res.status < 400)' 'if (false)'
                if (cd $TMPDIR/mut-gh-redir && node --test --test-force-exit --test-name-pattern='oracle O-GC1-gh-read' tests/tier1.test.ts >/dev/null 2>&1); then
                  echo "mutant M-gh-read-follow-redirect survived in tier1" >&2
                  exit 1
                fi
                touch $out
              '';
          # The tier-1 supervisor: one pi process per thread, so a fact planted in one thread is
          # absent from another, and tearing one down frees it and leaves the rest. A recording fake
          # pi run as real processes stands in for pi; no model.
          supervisor =
            pkgs.runCommand "genie-agent-supervisor"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/guard/verdict.ts
                    ./src/supervisor
                    ./tests/supervisor.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/supervisor.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: a fact planted in thread A is absent from thread B; teardown of A frees A and leaves B$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  "a poisoned replay fixture reaches guard-in before the session sees it, while trusted bankEntry makes 0 guard calls" \
                  "clean bank entries and clean replay fixtures seed the session unchanged, screening only the replay transcript" \
                  "a rewrite in a replay sends the guard's cleaned_text, not the injection" \
                  "the seed guard unavailable, throwing or malformed refuses to seed the session" \
                  "each seed check is a fresh session: source recall, history empty" \
                  "parameterized seedGuard over enabled true and false: off mode makes 0 guard calls and seeds session identically to on-mode allow"; do
                  sed -n 's/^ok [0-9]* - oracle: //p' $TMPDIR/tap | grep -qxF -- "$cell" || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle O-GE2-C6-recall-unscreened: seedGuard has no bankEntry method and seedSession seeds bankEntry with 0 guard calls while screening transcript under source: recall$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The Host bridge (plan C3.1) under real pi with the tier-1 extension, as tier1Launch starts
          # it: a tool call in a thread reaches the supervisor's Host as that thread and its result
          # returns to the tool, and the system prompt carries tier 1's prompt and every skill. A web
          # result reaches the model only as the supervisor's guard Screen lets it (plan C3.2): a stub
          # web server and a fake GuardClient. A stub model on the sandbox's loopback; the
          # forged-thread cell runs over the fake pi.
          bwrap-selection =
            pkgs.runCommand "genie-agent-bwrap-selection"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.bubblewrap
                  pkgs.coreutils
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src
                    ./schemas
                    ./skills
                    ./prompts
                    ./tests/bwrap-selection.test.ts
                  ];
                };
              }
              ''
                cd $src
                node --test --test-force-exit --test-reporter=tap tests/bwrap-selection.test.ts > $TMPDIR/tap
                cat $TMPDIR/tap
                for cell in 'usable bwrap selects BWRAP_ISOLATION for tier 1' 'usable bwrap selects BWRAP_ISOLATION for eval'; do
                  sed -n 's/^ok [0-9]* - //p' $TMPDIR/tap | grep -xF -- "$cell" > /dev/null || exit 1
                done
                grep -x '# fail 0' $TMPDIR/tap
                grep -x '# skipped 0' $TMPDIR/tap
                touch $out
              '';
          container-worker =
            pkgs.runCommand "genie-agent-container-worker"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.ripgrep
                  pkgs.fd
                  pkgs.coreutils
                ]
                ++ nixpkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.bubblewrap;
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src
                    ./schemas
                    ./skills
                    ./prompts
                    ./tests/container.test.ts
                    ./tests/fixtures/supervisor
                    ./tests/fixtures/container-launch.mjs
                  ];
                };
              }
              ''
                cd $src
                export PI=${nixpkgs.lib.getExe pkgs.pi-coding-agent}
                export GENIE_PI_AI=${modelSdk pkgs}
                ${nixpkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "export GENIE_REQUIRE_CONTAINER_NAMESPACE=1"}
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/container.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] || exit "$rc"
                for cell in \
                  'container files: root executes shipped tools with thread confinement, exact edit quota and read-only memory' \
                  'container files: disconnected requests abort running work and queued requests cannot write' \
                  'container files: running SDK receives cancellation' \
                  'container sessions: fixed captured destination, ordered chunks, atomic commit and abandoned cleanup' \
                  'container worker: actual packaged pi uses root files and model, persists before settlement and resumes' \
                  'container executor: startup failure and forced teardown run explicit stop before socket cleanup'; do
                  sed -n 's/^ok [0-9]* - //p' $TMPDIR/tap | grep -xF -- "$cell" > /dev/null || exit 1
                done
                grep -x '# fail 0' $TMPDIR/tap
                grep -x '# skipped 0' $TMPDIR/tap
                touch $out
              '';
          tier1-bridge =
            pkgs.runCommand "genie-agent-tier1-bridge"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.bubblewrap
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/state
                    ./src/supervisor
                    ./src/tier1
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/mirror
                    ./src/guard/verdict.ts
                    ./schemas
                    ./skills
                    ./prompts/tier1.md
                    ./tests/custody.test.ts
                    ./tests/tier1-bridge.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                export PI=${nixpkgs.lib.getExe pkgs.pi-coding-agent}
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/tier1-bridge.test.ts tests/custody.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q "^ok [0-9]* - oracle: a tool call in thread A reaches the supervisor's Host as A and its result returns to the tool; B's as B$" $TMPDIR/tap && grep -q "^ok [0-9]* - oracle: the launched system prompt carries tier 1's prompt and every skill's body$" $TMPDIR/tap && grep -q '^ok [0-9]* - a Host call that names another thread is attributed to the thread whose pipes carried it$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  "a clean page the guard allows reaches tier 1's context" \
                  "an injected page the guard rejects is withheld from tier 1's context" \
                  "a page the guard rewrites reaches tier 1's context only as rewritten" \
                  "a page the guard is unavailable for is withheld from tier 1's context"; do
                  sed -n 's/^ok [0-9]* - oracle: //p' $TMPDIR/tap | grep -qxF -- "$cell" || { echo "missing cell: $cell"; exit 1; }
                done
                for cell in \
                  "custody: configured key and destination win over pi headers and destination" \
                  "custody: Host authority belongs to the socket, and teardown closes it" \
                  "custody: provider errors redact credentials and cancellation aborts upstream" \
                  "custody: Anthropic API retains its own authentication and stream semantics" \
                  "custody: actual packaged pi streams and round-trips a Host tool through root"; do
                  sed -n 's/^ok [0-9]* - //p' $TMPDIR/tap | grep -qxF -- "$cell" || { echo "missing custody cell: $cell"; exit 1; }
                done
                grep -q '^# skipped 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The per-thread eval lock (design oracle 15): one eval in flight per thread, threads overlap,
          # and a failed run releases its thread. A recording fake runner; no nix, no bwrap.
          eval-lock =
            pkgs.runCommand "genie-agent-eval-lock"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./tests/eval-lock.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-lock.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle 15: two requests on one thread never overlap, and run in arrival order$' $TMPDIR/tap && grep -q '^ok [0-9]* - two threads overlap$' $TMPDIR/tap && grep -q '^ok [0-9]* - a failed or timed-out run releases the thread, and the next request runs$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The eval-result cache (plan E6, design §6): keyed (repo, rev, attr, flags). A second identical
          # request runs 0 evals. Mutant: cache bypassed.
          eval-cache =
            pkgs.runCommand "genie-agent-eval-cache"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/state
                    ./tests/eval-cache.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-cache.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: eval-result cache keyed (repo, rev, attr, flags) runs 0 evals on second identical request$' $TMPDIR/tap && grep -q '^ok [0-9]* - mutant (oracle E6): caching every result makes the timeout cell go RED$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The trusted IFD path's argv (design oracle 4): only the effective tier opens IFD and the
          # configured builders, and the untrusted argv is E1's byte for byte. No nix, no bwrap.
          eval-argv =
            pkgs.runCommand "genie-agent-eval-argv"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.bubblewrap
                  pkgs.nix
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/state
                    ./src/tier1/schema.ts
                    ./schemas/eval-request.json
                    ./tests/eval-argv.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-argv.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q "^ok [0-9]* - the untrusted argv is E1's, byte for byte, whatever builders are configured$" $TMPDIR/tap && grep -q "^ok [0-9]* - a public sender's trusted: yes opens neither IFD nor builders$" $TMPDIR/tap && grep -q '^ok [0-9]* - an effective trusted eval allows IFD and names the configured builders$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GX1 (F2): ATTR_PATH_RE validated in schemas/eval-request.json and at runEval, nixArgv, and wrapperForNixOS sinks$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GS2 (N1): runEval bwrapArgv includes --unshare-pid and --bind /proc /proc, and mutant without --unshare-pid goes RED$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle O-GC1-eval: worktreeSubdir and apply (standalone + secrets:stub), cross-thread confinement, discriminating pure-eval probes (F7b), and mutants M-eval-impure and M-worktree-subdir-no-prefix-check go RED$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-eval-argv
                chmod -R u+w $TMPDIR/mut-eval-argv
                substituteInPlace $TMPDIR/mut-eval-argv/src/eval/run.ts \
                  --replace-fail '"--unshare-pid",' ""
                if (cd $TMPDIR/mut-eval-argv && node --test --test-force-exit tests/eval-argv.test.ts >/dev/null 2>&1); then
                  echo "mutant M-eval-no-unshare-pid survived in eval-argv" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-eval-impure
                chmod -R u+w $TMPDIR/mut-eval-impure
                substituteInPlace $TMPDIR/mut-eval-impure/src/eval/run.ts \
                  --replace-fail '"pure-eval": "true",' '"pure-eval": "false",'
                if (cd $TMPDIR/mut-eval-impure && node --test --test-force-exit --test-name-pattern='oracle O-GC1-eval' tests/eval-argv.test.ts >/dev/null 2>&1); then
                  echo "mutant M-eval-impure survived in eval-argv" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-eval-subdir
                chmod -R u+w $TMPDIR/mut-eval-subdir
                substituteInPlace $TMPDIR/mut-eval-subdir/src/eval/run.ts \
                  --replace-fail 'if (!WORKTREE_SUBDIR_RE.test(subdir) || subdir.split("/").some((s) => s === "." || s === "..")) {' 'if (false) {' \
                  --replace-fail 'if (candidate !== threadRoot && !candidate.startsWith(`''${threadRoot}/`)) {' 'if (false) {' \
                  --replace-fail 'if (!real.startsWith(`''${threadRoot}/`) && real !== threadRoot) {' 'if (false) {'
                if (cd $TMPDIR/mut-eval-subdir && node --test --test-force-exit --test-name-pattern='oracle O-GC1-eval' tests/eval-argv.test.ts >/dev/null 2>&1); then
                  echo "mutant M-worktree-subdir-no-prefix-check survived in eval-argv" >&2
                  exit 1
                fi
                touch $out
              '';
          # limit_hit from typed observations (plan E2, E2.1): a deadline kill is timeout, an OOM kill oom,
          # any other SIGKILL unknown, a fetch the network refuses egress, a normal eval none. The real kills are process-plane cells.
          eval-limits =
            pkgs.runCommand "genie-agent-eval-limits"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./schemas/eval-result.json
                    ./tests/eval-limits.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-limits.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in 'a normal eval is none' 'a deadline kill is timeout' 'an OOM kill is oom' 'a refused fetch is egress' \
                  'a foreign SIGKILL with no OOM kill is unknown' 'a foreign SIGKILL with memory.events unreadable is unknown'; do
                  grep -qx "ok [0-9]* - limit: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                grep -qx "ok [0-9]* - limit_hit's values are the schema's" $TMPDIR/tap || { echo "missing cell: the schema's values"; exit 1; }
                grep -qx "ok [0-9]* - an eval cgroup's OOM count unreadable falls back to the whole cgroup's" $TMPDIR/tap || { echo "missing cell: the whole cgroup's fallback"; exit 1; }
                touch $out
              '';
          # Configured Kubernetes Jobs: thread/source authority and limits against a fixture API.
          eval-k8s =
            pkgs.runCommand "genie-agent-eval-k8s"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./tests/eval-k8s.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-k8s.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: snapshot plus property checks on the rendered Job spec$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle GX1 (F6): captured thread selects confined source and store while labels are sanitised$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The thread-state store: a thread's transcript, tier and eval cache survive its process
          # and a fresh store over the same paths, and a thread id cannot leave its root.
          state =
            pkgs.runCommand "genie-agent-state"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/state
                    ./src/supervisor
                    ./tests/state.test.ts
                    ./tests/fixtures/state
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/state.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: restart, then resume ⇒ the same transcript, tier and cache$' $TMPDIR/tap && grep -q '^ok [0-9]* - a thread id that names another directory is refused$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # A thread's lifecycle over a fake clock: parked 1 h after its last reply and resumed with its
          # context, a message pi never answered replayed on resume, closed on accept or 24 h idle
          # with its worktrees removed, left open by 🔍, and the schedule kept across a restart.
          lifecycle =
            pkgs.runCommand "genie-agent-lifecycle"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.git
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/lifecycle
                    ./src/mirror
                    ./src/state
                    ./src/supervisor
                    ./prompts
                    ./tests/lifecycle.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/lifecycle.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: active ⇒ parked at 1 h ⇒ resumed on a message with its context intact$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a park before the first reply keeps the pending message, and the resume replays it$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: accept and 24 h idle each close the thread and remove its worktrees$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: 🔍 does not close the thread: it stays open and its worktrees stay$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a supervisor restart mid-idle still closes on the original schedule$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: check-in fires once at 5m and turn continues until 10m deadline (C13 Oracle 1)$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: fast question that replies before check-in time receives 0 check-in messages (C13 Oracle 2)$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GL1 cap): a burst of 5 runs at most 2 turns concurrently$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GL1 FIFO): queued turns acquire slots in strict FIFO arrival order$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GL1 timer at acquisition): the 600s TurnController timer starts when a turn acquires its slot, not at intake$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GL1 escalate-not-drop): a queued turn waiting past maxQueueWaitSecs fast-escalates and is never dropped$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle GS2 (C1): Lifecycle.message opens session/thread.jsonl with O_NOFOLLOW | O_NONBLOCK and accepts only a regular file, refusing symlinks and FIFOs without blocking, and mutant goes RED$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-lifecycle-nofollow
                chmod -R u+w $TMPDIR/mut-lifecycle-nofollow
                substituteInPlace $TMPDIR/mut-lifecycle-nofollow/src/state/index.ts \
                  --replace-fail 'const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;' 'const flags = constants.O_RDONLY | constants.O_NONBLOCK;'
                if (cd $TMPDIR/mut-lifecycle-nofollow && node --test --test-force-exit --test-name-pattern='oracle GS2 \(C1\)' tests/lifecycle.test.ts >/dev/null 2>&1); then
                  echo "mutant M-session-nofollow survived in lifecycle" >&2
                  exit 1
                fi
                touch $out
              '';
          # Escalation: a forced or below-threshold draft sends at once, a confident one only on 🔍
          # through the lifecycle, a repeated 🔍 delivers once, and the package sent validates with
          # the supervisor's thread id, routed by sender_tier alone (C6), after S5's guard screens
          # every string of the package in a fresh envelope (oracle 18). Fake xmsg with X10's
          # idempotency; identity guard and a fixed route except in the guard and routing cells.
          escalation =
            pkgs.runCommand "genie-agent-escalation"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/escalation
                    ./src/guard/verdict.ts
                    ./src/lifecycle
                    ./src/mirror
                    ./src/state
                    ./src/supervisor
                    ./src/tier1/draft.ts
                    ./src/tier1/schema.ts
                    ./schemas/draft.json
                    ./schemas/escalation.json
                    ./schemas/eval-request.json
                    ./schemas/eval-result.json
                    ./schemas/git-request.json
                    ./schemas/gh-read.json
                    ./tests/escalation.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/escalation.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  'a forced draft sends with no 🔍' \
                  'a below-threshold draft sends' \
                  'a confident draft does not send until 🔍' \
                  'a draft at exactly the threshold does not send until 🔍' \
                  '🔍 arriving twice sends exactly once' \
                  "the package validates against schemas/escalation.json, thread_id the supervisor's" \
                  'a public thread whose package and draft claim trust routes to @public' \
                  'a trusted thread routes to @trusted' \
                  'an odd or absent tier routes to @public' \
                  'the destinations are configuration' \
                  "the default destinations are the redesign's one-@ addresses" \
                  'an injection in eval_transcript is rejected: nothing is sent and the thread is not escalated' \
                  "a rewrite sends the guard's cleaned_text, not the injection" \
                  'a clean package is screened field by field and sent unchanged' \
                  'the guard unavailable, throwing or malformed refuses the package' \
                  'each check is a fresh session: no history, no earlier thread text, one field per envelope'; do
                  sed -n 's/^ok [0-9]* - //p' $TMPDIR/tap | grep -qxF -- "oracle: $cell" || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle (G11): parameterized escalationGuard over enabled true and false: off mode makes 0 guard calls and matches on-mode allow$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FB-eval-only: escalationGuard screens only eval stdout/stderr (eval_stdout) and unscreened git/gh output (web), leaving cleaned_question, draft, gaps, recall_transcript, eval request, and screened git/gh entries untouched$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FB-fail-fast: sequential escalationGuard stops after the first rejected entry without issuing later guard checks$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-ge2-fb-draft
                chmod -R u+w $TMPDIR/mut-ge2-fb-draft
                substituteInPlace $TMPDIR/mut-ge2-fb-draft/src/escalation/guard.ts \
                  --replace-fail 'const evalTranscript: unknown[] = [];' 'await screen(pkg.draft.answer, "eval_stdout"); const evalTranscript: unknown[] = [];'
                if (cd $TMPDIR/mut-ge2-fb-draft && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FB-eval-only' tests/escalation.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FB-screen-draft survived in escalation" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fb-recall
                chmod -R u+w $TMPDIR/mut-ge2-fb-recall
                substituteInPlace $TMPDIR/mut-ge2-fb-recall/src/escalation/guard.ts \
                  --replace-fail 'const evalTranscript: unknown[] = [];' 'if (pkg.recall_transcript) await screen(JSON.stringify(pkg.recall_transcript), "eval_stdout"); const evalTranscript: unknown[] = [];'
                if (cd $TMPDIR/mut-ge2-fb-recall && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FB-eval-only' tests/escalation.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FB-screen-recall survived in escalation" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fb-parallel
                chmod -R u+w $TMPDIR/mut-ge2-fb-parallel
                substituteInPlace $TMPDIR/mut-ge2-fb-parallel/src/escalation/guard.ts \
                  --replace-fail 'for (const entry of pkg.eval_transcript) {' 'await Promise.all(pkg.eval_transcript.map(async (entry) => {' \
                  --replace-fail 'evalTranscript.push({ ...rec, result: res });' 'evalTranscript.push({ ...rec, result: res }); })); if (false) {' \
                  --replace-fail 'continue;' 'return;'
                if (cd $TMPDIR/mut-ge2-fb-parallel && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FB-fail-fast' tests/escalation.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FB-promise-all survived in escalation" >&2
                  exit 1
                fi
                touch $out
              '';
          # The thread's tier from the envelope's per-line tags: falls on a public line, rises only on a
          # trusted `!trust`, kept by the participants it sanctioned, blind to a trusted bootstrap's background.
          tier =
            pkgs.runCommand "genie-agent-tier"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/lifecycle
                    ./src/mirror
                    ./src/state
                    ./src/supervisor
                    ./src/tier
                    ./tests/tier.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/tier.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  'a public originator ⇒ public from its first message' \
                  'a trusted thread with a public reply ⇒ public, and stays public after further trusted lines' \
                  'a trusted mention or 🔍 on a public thread ⇒ still public' \
                  '!trust from a trusted sender ⇒ trusted; a participant present at it keeps it, a new public participant lowers it' \
                  '!trust from a public sender ⇒ unchanged' \
                  'background lines on a trusted-initiated bootstrap do not lower it' \
                  'a public line whose text claims trusted ⇒ public' \
                  'header tier wins over request JSON tier, and an envelope without a [matrix] header is refused'; do
                  sed -n 's/^ok [0-9]* - //p' $TMPDIR/tap | grep -qxF -- "oracle: $cell" || { echo "missing cell: $cell"; exit 1; }
                done
                touch $out
              '';
          # A thread's collection over a fake clock: kept at 95 h idle, archived then gone at 97 h
          # (state, read-only store, worktrees) whatever its status, nothing removed on a failed archive.
          gc =
            pkgs.runCommand "genie-agent-gc"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.git
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/gc
                    ./src/lifecycle
                    ./src/mirror
                    ./src/state
                    ./tests/gc.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/gc.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  'at 95 h kept, at 97 h archived and gone: state, store and worktrees, whatever the status' \
                  'a failed archive deletes nothing, and the next sweep retries it' \
                  'a read-only store path is removed'; do
                  grep -qx "ok [0-9]* - oracle: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle GS2 (C8): Gc.collect tears down a live pi process before removing its worktrees, and mutant goes RED$' $TMPDIR/tap || exit 1
                grep -q "^ok [0-9]* - oracle GS2 (C8 revive): Gc.collect tears down a revived thread's pi process a second time after removeWorktrees, clears its tombstone, keeps its state and store, and mutant goes RED$" $TMPDIR/tap || exit 1
                touch $out
              '';
          # The broker: a proposal failing guard-out is never acted on, a passing one is acted on once
          # with its credentials redacted, and the token reaches only the act. Stub ninfer, fake act.
          broker =
            pkgs.runCommand "genie-agent-broker"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.git
                  pkgs.gnutar
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/broker
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
                    ./src/mirror
                    ./src/redactor
                    ./src/supervisor
                    ./src/tier1
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./schemas
                    ./tests/broker.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/broker.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: a proposal that fails guard-out is not acted on$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a passing proposal is acted on exactly once, with redacted content$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle (G11): when guardOut.enable is false, the deterministic redactor still runs and guard-out receives 0 calls$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle O-GC1-propose: ls-tree + cat-file --batch worktree extraction (C1 / F2), subdirectory computeWorktreeDiff (C-N4), confineWrite + write-delta quota (F5 / F9), genie-bot identity & fork enforcement (F6 / Q1), and all four mutants go RED$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-wt-git
                chmod -R u+w $TMPDIR/mut-wt-git
                substituteInPlace $TMPDIR/mut-wt-git/src/mirror/index.ts \
                  --replace-fail '    await extractMirrorTree(dir, rev, path);' '    if (existsSync(path)) { await run(["-C", path, "-c", "core.symlinks=false", "checkout", "--force", "--detach", rev]); } else { await run(["-C", dir, "-c", "core.symlinks=false", "worktree", "add", "--force", "--detach", path, rev]); }'
                if (cd $TMPDIR/mut-wt-git && node --test --test-force-exit --test-name-pattern='oracle O-GC1-propose' tests/broker.test.ts >/dev/null 2>&1); then
                  echo "mutant M-worktree-git-checkout survived in broker" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-write-confine
                chmod -R u+w $TMPDIR/mut-write-confine
                substituteInPlace $TMPDIR/mut-write-confine/src/tier1/index.ts \
                  --replace-fail '  const p = raw;' '  if (true) return confine(root, raw, opts?.memoryRoot ?? "/memory"); const p = raw;'
                if (cd $TMPDIR/mut-write-confine && node --test --test-force-exit --test-name-pattern='oracle O-GC1-propose' tests/broker.test.ts >/dev/null 2>&1); then
                  echo "mutant M-write-confine-allow-memory-and-dotdot survived in broker" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-bot-id
                chmod -R u+w $TMPDIR/mut-bot-id
                substituteInPlace $TMPDIR/mut-bot-id/src/broker/index.ts \
                  --replace-fail '  if (token && c.botLogin) {' '  if (false) {'
                substituteInPlace $TMPDIR/mut-bot-id/src/broker/pr.ts \
                  --replace-fail '    if (botLogin) {' '    if (false) {'
                substituteInPlace $TMPDIR/mut-bot-id/src/broker/gist.ts \
                  --replace-fail '    if (opts.botLogin) {' '    if (false) {'
                if (cd $TMPDIR/mut-bot-id && node --test --test-force-exit --test-name-pattern='oracle O-GC1-propose' tests/broker.test.ts >/dev/null 2>&1); then
                  echo "mutant M-broker-skip-bot-identity survived in broker" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-guard-out
                chmod -R u+w $TMPDIR/mut-guard-out
                substituteInPlace $TMPDIR/mut-guard-out/src/broker/index.ts \
                  --replace-fail '  if (guard.enable === false) {' '  if (true) {'
                if (cd $TMPDIR/mut-guard-out && node --test --test-force-exit --test-name-pattern='oracle O-GC1-propose' tests/broker.test.ts >/dev/null 2>&1); then
                  echo "mutant M-propose-bypass-guard-out survived in broker" >&2
                  exit 1
                fi
                if (cd $TMPDIR/mut-guard-out && node --test --test-force-exit --test-reporter=tap --test-name-pattern='gist operations: update and comment preserve write guard-out' tests/broker.test.ts >$TMPDIR/new-write-mutant-tap 2>&1); then
                  echo "mutant M-gist-writes-bypass-guard-out survived in broker" >&2
                  exit 1
                fi
                grep -q '^not ok [0-9]* - gist operations: update and comment preserve write guard-out and partial action maps refuse$' $TMPDIR/new-write-mutant-tap
                touch $out
              '';
          # The gist action through the broker against a stub GitHub: one POST /gists with the redacted
          # content and the Bearer token, acting with its html_url; a failure is not acted on, once,
          # and the token reaches no reason and no output.
          gist =
            pkgs.runCommand "genie-agent-gist"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/broker
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
                    ./src/mirror
                    ./src/redactor
                    ./src/tier1/schema.ts
                    ./schemas/proposal.json
                    ./tests/gist.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/gist.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  'a gist proposal is exactly one POST /gists with the redacted content and the Bearer token' \
                  'a 403 or 500 is not acted on, once, and the reason never carries the token' \
                  'a 2xx without html_url is not acted on'; do
                  grep -qx "ok [0-9]* - oracle: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                for cell in \
                  'oracle B1: an anonymous gist read is complete untrusted data with no credential or raw URL fetch' \
                  'oracle B1: oversized metadata and incomplete or truncated files are refused without raw fallback' \
                  'oracle B3: gist updates require the authenticated configured account to own the target' \
                  'gist comments use a canonical gist link plus the official id-only comment receipt' \
                  'oracle B4: gist creation is secret unless public is explicitly true' \
                  'gist reads count chunked bytes and accept exactly the raw-response boundary' \
                  'gist reads reject oversized Content-Length before parsing and never follow redirects or retry' \
                  'write metadata has a separate bounded budget and invalid comment receipts are refused' \
                  'anonymous credentials enable only reads; authenticated reads retain bot identity checks'; do
                  grep -qx "ok [0-9]* - $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                cp -r . $TMPDIR/mut-gist-owner
                chmod -R u+w $TMPDIR/mut-gist-owner
                substituteInPlace $TMPDIR/mut-gist-owner/src/broker/gist.ts \
                  --replace-fail 'if (owner === null || owner.toLowerCase() !== login.toLowerCase()) throw new Error("gist_update: target is not owned by the authenticated account");' 'void owner; void login;'
                if (cd $TMPDIR/mut-gist-owner && node --test --test-force-exit --test-reporter=tap --test-name-pattern='oracle B3:' tests/gist.test.ts >$TMPDIR/owner-mutant-tap 2>&1); then
                  echo "mutant M-gist-update-skip-owner survived in gist" >&2
                  exit 1
                fi
                grep -q '^not ok [0-9]* - oracle B3: gist updates require the authenticated configured account to own the target$' $TMPDIR/owner-mutant-tap
                cp -r . $TMPDIR/mut-gist-public
                chmod -R u+w $TMPDIR/mut-gist-public
                substituteInPlace $TMPDIR/mut-gist-public/src/broker/gist.ts \
                  --replace-fail 'public: p.public === true' 'public: true'
                if (cd $TMPDIR/mut-gist-public && node --test --test-force-exit --test-reporter=tap --test-name-pattern='oracle B4:' tests/gist.test.ts >$TMPDIR/public-mutant-tap 2>&1); then
                  echo "mutant M-gist-force-public survived in gist" >&2
                  exit 1
                fi
                grep -q '^not ok [0-9]* - oracle B4: gist creation is secret unless public is explicitly true$' $TMPDIR/public-mutant-tap
                touch $out
              '';
          # The PR action through the broker's kind-dispatching act against a stub GitHub: one PR whose
          # body links the thread, its calls in the stated order, and a failed PR step not acted on,
          # its branch deleted and the token in no reason.
          pr =
            pkgs.runCommand "genie-agent-pr"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/broker
                    ./src/eval
                    ./src/isolation.ts
                    ./src/isolation-node.d.ts
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
                    ./src/mirror
                    ./src/redactor
                    ./src/tier1/schema.ts
                    ./schemas/proposal.json
                    ./tests/pr.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/pr.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  'a pr proposal opens exactly one PR, whose body links the thread' \
                  'the GitHub calls arrive in the stated order' \
                  'a failure at the PR step is not acted on, the branch is deleted, and the reason never carries the token' \
                  'the dispatching act routes a gist to the gist action and a pr to the PR action'; do
                  grep -qx "ok [0-9]* - oracle: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle GX1 (F4): repo coordinate, branch ref, file paths, and commits validated in schemas/proposal.json, broker, and pr sink$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GC1-pr-f6: publishPr and verifyBotIdentity enforce botLogin, forbiddenLogins, public-only, non-self upstream owner, Q1 permissions object, read-only upstream permissions, fork owner/full_name, and headOwner:branch ref, with zero write calls on refusal$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-pr-self-owner
                chmod -R u+w $TMPDIR/mut-pr-self-owner
                substituteInPlace $TMPDIR/mut-pr-self-owner/src/broker/pr.ts \
                  --replace-fail 'String(upstream.owner?.login ?? "").toLowerCase() === botLogin.toLowerCase()' 'String(upstream.owner?.login ?? "").toLowerCase() === "__mutant_never__"'
                if (cd $TMPDIR/mut-pr-self-owner && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-self-owner survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-private
                chmod -R u+w $TMPDIR/mut-pr-private
                substituteInPlace $TMPDIR/mut-pr-private/src/broker/pr.ts \
                  --replace-fail 'if (upstream.private !== false)' 'if (upstream.private === "__mutant_never__")'
                if (cd $TMPDIR/mut-pr-private && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-private survived in pr" >&2
                  exit 1
                fi
                # M-pr-q1-missing-perms edits two sites: the Q1 typeof/null guard, plus optional
                # chaining at the permissions.push check so undefined/null permissions do not throw
                # a TypeError and instead the oracle is what drives the mutant red.
                cp -r . $TMPDIR/mut-pr-q1-perms
                chmod -R u+w $TMPDIR/mut-pr-q1-perms
                substituteInPlace $TMPDIR/mut-pr-q1-perms/src/broker/pr.ts \
                  --replace-fail 'if (typeof upstream.permissions !== "object" || upstream.permissions === null) {' 'if (false) {' \
                  --replace-fail 'if (upstream.permissions.push || upstream.permissions.maintain || upstream.permissions.admin) {' 'if (upstream.permissions?.push || upstream.permissions?.maintain || upstream.permissions?.admin) {'
                if (cd $TMPDIR/mut-pr-q1-perms && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-q1-missing-perms survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-upstream-push
                chmod -R u+w $TMPDIR/mut-pr-upstream-push
                substituteInPlace $TMPDIR/mut-pr-upstream-push/src/broker/pr.ts \
                  --replace-fail 'if (upstream.permissions.push || upstream.permissions.maintain || upstream.permissions.admin)' 'if (false)'
                if (cd $TMPDIR/mut-pr-upstream-push && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-upstream-push survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-fork-owner
                chmod -R u+w $TMPDIR/mut-pr-fork-owner
                substituteInPlace $TMPDIR/mut-pr-fork-owner/src/broker/pr.ts \
                  --replace-fail 'String(fork.owner?.login ?? "").toLowerCase() !== botLogin.toLowerCase()' 'String(fork.owner?.login ?? "").toLowerCase() === "__mutant_never__"'
                if (cd $TMPDIR/mut-pr-fork-owner && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-fork-owner survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-fork-fullname
                chmod -R u+w $TMPDIR/mut-pr-fork-fullname
                substituteInPlace $TMPDIR/mut-pr-fork-fullname/src/broker/pr.ts \
                  --replace-fail 'String(fork.full_name).toLowerCase() === p.repo.toLowerCase()' 'String(fork.full_name).toLowerCase() === "__mutant_never__"'
                if (cd $TMPDIR/mut-pr-fork-fullname && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-fork-fullname survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-head-ref
                chmod -R u+w $TMPDIR/mut-pr-head-ref
                substituteInPlace $TMPDIR/mut-pr-head-ref/src/broker/pr.ts \
                  --replace-fail 'head: `''${headOwner}:''${p.branch}`,' 'head: p.branch,'
                if (cd $TMPDIR/mut-pr-head-ref && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-head-ref survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-forbidden-bot-login
                chmod -R u+w $TMPDIR/mut-pr-forbidden-bot-login
                substituteInPlace $TMPDIR/mut-pr-forbidden-bot-login/src/broker/index.ts \
                  --replace-fail 'forbiddenLogins.some((f) => f.toLowerCase() === botLogin.toLowerCase())' 'false'
                if (cd $TMPDIR/mut-pr-forbidden-bot-login && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-forbidden-bot-login survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-forbidden-logins
                chmod -R u+w $TMPDIR/mut-pr-forbidden-logins
                substituteInPlace $TMPDIR/mut-pr-forbidden-logins/src/broker/index.ts \
                  --replace-fail 'forbiddenLogins.some((f) => f.toLowerCase() === login.toLowerCase())' 'false'
                if (cd $TMPDIR/mut-pr-forbidden-logins && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-forbidden-logins survived in pr" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-pr-bot-login-mismatch
                chmod -R u+w $TMPDIR/mut-pr-bot-login-mismatch
                substituteInPlace $TMPDIR/mut-pr-bot-login-mismatch/src/broker/index.ts \
                  --replace-fail 'login.toLowerCase() !== botLogin.toLowerCase()' 'login.toLowerCase() === "__mutant_never__"'
                if (cd $TMPDIR/mut-pr-bot-login-mismatch && node --test --test-force-exit --test-name-pattern='oracle O-GC1-pr-f6' tests/pr.test.ts >/dev/null 2>&1); then
                  echo "mutant M-pr-bot-login-mismatch survived in pr" >&2
                  exit 1
                fi
                touch $out
              '';
          # The archive writer and replay-resume (plans P4, P5): one PUT per archive holding the
          # transcript, verdicts, escalation and actions, keyed by tier; an expired thread resumes
          # with its transcript from the archive, every replayed turn screened by the seed guard.
          archive =
            pkgs.runCommand "genie-agent-archive"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/archive
                    ./src/gc
                    ./src/guard/verdict.ts
                    ./src/lifecycle
                    ./src/mirror
                    ./src/state
                    ./src/supervisor
                    ./src/tier
                    ./tests/archive.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/archive.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  "close ⇒ exactly one PUT holding all four sections, absent ones explicit, the transcript pi's session file" \
                  'a failed PUT rejects, so collection deletes nothing' \
                  "the key carries the thread's tier, and the two tiers never share a prefix" \
                  "P3's collection of an expired thread, with this archiver, is exactly one PUT and then the thread is gone" \
                  "a GC'd thread resumes with the same transcript, and every replayed turn passes the seed guard first"; do
                  grep -qx "ok [0-9]* - oracle: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle GX2 (F5 / C7): replayResume clamps the replayed tier with nextTier so a trusted archive never lifts a public session, and readArchive falls back to public$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle GS2 (C1): archiveObject opens session/thread.jsonl with O_NOFOLLOW | O_NONBLOCK and accepts only a regular file, refusing symlinks and FIFOs, and mutant goes RED$' $TMPDIR/tap || exit 1
                cp -r . $TMPDIR/mut-archive-nofollow
                chmod -R u+w $TMPDIR/mut-archive-nofollow
                substituteInPlace $TMPDIR/mut-archive-nofollow/src/state/index.ts \
                  --replace-fail 'const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;' 'const flags = constants.O_RDONLY | constants.O_NONBLOCK;'
                if (cd $TMPDIR/mut-archive-nofollow && node --test --test-force-exit --test-name-pattern='oracle GS2 \(C1\)' tests/archive.test.ts >/dev/null 2>&1); then
                  echo "mutant M-session-nofollow survived in archive" >&2
                  exit 1
                fi
                touch $out
              '';
          # The composition root (plan C11) end to end over fakes: an inbound line reaches pi with its tier
          # observed, a guard-in reject never does, eval runs at the thread's stored tier, a draft reaches
          # Post only redacted then passed by guard-out (else a withheld notice) and a forced one xmsg at
          # C6's address, and a close archives once. Fake Intake, Post, GuardClient and XmsgSend; the
          # fake pi as tier1Launch starts it; a stub ninfer for guard-out; a stub S3; git daemon.
          root =
            pkgs.runCommand "genie-agent-root"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.git
                  pkgs.bubblewrap
                  pkgs.util-linux
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src
                    ./schemas
                    ./skills
                    ./prompts
                    ./tests/root.test.ts
                    ./tests/root-gist.test.ts
                    ./tests/gist-model.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                export PI=${nixpkgs.lib.getExe pkgs.pi-coding-agent}
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/root.test.ts tests/root-gist.test.ts tests/gist-model.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  'gist root: anonymous reads use guard-in despite legacy screening default and retain quota' \
                  'gist root: rewritten results are scrubbed again and rejected raw reads never enter transcripts' \
                  'gist root: explicit global guard off preserves redaction and untrusted result marking' \
                  'gist root: public yes no and omission reach the fake API without changing write guards' \
                  'gist root: new read transcript provenance passes escalation schema without broadening legacy requests' \
                  'gist model: existing propose advertises typed gist operations and converts explicit public yes no'; do
                  grep -qx "ok [0-9]* - $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                for cell in \
                  "one inbound line reaches pi's prompt with its tier observed" \
                  'a guard-in reject never prompts, and the bot posts a refusal' \
                  "eval runs at the thread's tier from P2's state, never the request's" \
                  "a draft reply reaches Post, and a forced one reaches XmsgSend at C6's address" \
                  "a reply is redacted then guard-out'd before Post" \
                  "a credential in the user's question never reaches guard-out" \
                  'a guard-out block posts the withheld notice, never the draft' \
                  'a close archives exactly once' \
                  "a proposal through the root's Host reaches the right act" \
                  "an idle close at 24 h archives once through the timers" \
                  "an expired thread collected by GC resumes on a new message with its transcript replayed through the root" \
                  "an expired thread whose removal throws after tombstoning still resumes from the archive" \
                  "a new thread with S3 down still starts" \
                  "a tombstoned thread with S3 down is refused, not resumed fresh" \
                  "main launches real pi against a stub model" \
                  "at the 10m deadline, 1 notice is posted and 1 escalation is created with transcript, then teardown (C13 Oracle 3)" \
                  "recall through main() hits stub hindsight, routes bank selectors, and returns all entries with 0 guard calls" \
                  "tier1Launch seeds operating memory when tier1.memoryRoot is set" \
                  "close and gc.sweep() succeed with s3: null, and propose with no token is refused cleanly"; do
                  grep -qx "ok [0-9]* - oracle: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle (G11): parameterized root pipeline over guard.enable and broker.guardOut.enable (true vs false): off mode constructs no XmsgGuardClient, makes 0 guard/guardOut calls, appends UNSCREENED_PROMPT, redacts outbound replies/proposals/expert replies, and matches on-mode allow$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GI-8 b): room_context error/refused/throttled replies return tool errors to the model without crashing the process and the thread stays answerable$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GI-8 c): room_context screens returned <context> block through guard-in when guard.enable is true (withholding on reject) and makes 0 guard calls under unscreened prompt framing when guard.enable is false$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GI-8 d): resync paging loops offset over a > 4 KiB multi-page transcript when local state is missing and is not called when local state is intact$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (GI-11): a guard-out that blocks the first draft and passes the second posts only the second with no WITHHELD; blocking every draft until the turn settles posts WITHHELD once$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle GE1: root scrubs expert reply answer and gaps field-by-field while preserving tier and escalate, and rejects malformed expert replies without posting$' $TMPDIR/tap || exit 1
                grep -q "^ok [0-9]* - oracle (GL1): main enforces tier1.maxConcurrentTurns FIFO slots, starts the 10m timer at slot acquisition, and fast-escalates queued turns past tier1.maxQueueWaitSecs with 'tier-1 busy'$" $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GC1-silent: silent reply ack (GAP-1), redactLastPost & editLastPost (GAP-6), screened=true trust boundary & forgery resistance (GAP-7 / Q5), recall_transcript in escalation (GAP-5), gitScreen/ghScreen toggles, public propose without !approve, and M-ignore-silent-flag goes RED$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle GX2 (F4): Host.eval validates coordinates in schemas/eval-request.json before any approval notice, screens the notice through redact() and outbound(), caps pending actions at 1 per thread, and mutant goes RED$' $TMPDIR/tap || exit 1
                grep -q "^ok [0-9]* - oracle GS2 (F1): main wraps pi in bwrap with /nix/store ro, /memory ro, worktree ro, session rw, agentDir ro, hiding /run/credentials, other threads' stateRoot, /run/xmsg, and parent /proc, while preserving model, web, clone, and session, and all six mutants go RED$" $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle GS2 (N3): bwrap is PID 1 in both tier1Launch and runEval jails (no --as-pid-1), and SIGKILL teardown when node is PID 1 leaves 0 zombies$' $TMPDIR/tap || exit 1
                grep -q "^ok [0-9]* - oracle O-GE2-FA-reply: a refused escalation after reply post resolves non-error with { posted: true, escalated: false, escalation: 'refused: ...' } and persists refused on EscalationRecord$" $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FA-settled: a refused escalation after WITHHELD on agent_settled still runs lifecycle.event, clears pending, and releases the turn slot$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-today (Arm b): a genuine escalation refusal on a low-confidence reply terminates the turn loop in 1 reply with 1 post and 0 sends$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FA-deadline: a refused escalation at the 10m deadline posts DEADLINE_NOTICE once, throws no error, frees the turn slot, and persists refused on EscalationRecord$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FA-queue-timeout: a refused escalation at maxQueueWaitSecs posts DEADLINE_NOTICE once, throws no error, frees the turn slot, and persists refused on EscalationRecord$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FA-lifecycle-safety-net: when postEnvelope throws inside onDeadline, Lifecycle catches the error via onHandlerError with 0 unhandled rejections and still frees the turn slot$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FB-context-rebuild: Host.escalate rebuilds cleaned_question and transcripts from context(t), scrubs and guard-outs draft/gaps, and records post-screen git/gh outputs (C-1, C-2, N-1)$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-C6-recall-unscreened: Host.recall makes 0 guard calls when guard.enable is true and preserves directive-style recall items while replayResume still screens under source: recall$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-FC-queue-timeout: XmsgGuardClient bounds total check(e) wall time across FIFO queue wait + sendAndAwait and wakes/times out idempotently (F-C, C-7)$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GE2-today (Arm a): !t79jR_rVSlmFceMqpE shape (2 recalls, 0 evals, imperative Nix prose in draft.answer, 3 gaps, confidence 0.75) posts once and escalates once with 0 escalationGuard calls$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GP7-escalate-after-refused-eval: refused trusted evals on a public thread (guard-out block, C9 pending action, and duplicate pending action) leave eval_transcript clean so subsequent reply, escalate, and deeper escalations validate against schemas/escalation.json and send to @public$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle O-GP7-repair-persisted-refused-eval: context(t) drops legacy persisted refused-eval entries lacking result.exit from context.json while preserving valid EvalResult entries so pre-GP7 threads escalate cleanly$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (loadCredential adapter off): main reads configured credential files from credentialsDir and ignores decoy CREDENTIALS_DIRECTORY$' $TMPDIR/tap || exit 1
                grep -q '^ok [0-9]* - oracle (fail-closed credentials): main and configuredEval reject missing or empty configured credentials and skip unconfigured optional credentials$' $TMPDIR/tap || exit 1
                [ "$(grep -c 'escalation\.reply(' src/root/index.ts)" -eq 1 ] && awk '/const escalateAfterPost = async/,/^  };/' src/root/index.ts | grep -q 'escalation\.reply(' || {
                  echo "guard failed: every escalation.reply call in src/root/index.ts must sit inside escalateAfterPost" >&2
                  exit 1
                }
                cp -r . $TMPDIR/mut-ge2-fa-rethrow
                chmod -R u+w $TMPDIR/mut-ge2-fa-rethrow
                substituteInPlace $TMPDIR/mut-ge2-fa-rethrow/src/root/index.ts \
                  --replace-fail 'return { posted: true, ...(await escalateAfterPost(t, out.value)) };' 'return { posted: true, escalated: await escalation.reply(t, out.value) };'
                if (cd $TMPDIR/mut-ge2-fa-rethrow && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FA-reply' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FA-rethrow survived O-GE2-FA-reply in root" >&2
                  exit 1
                fi
                if (cd $TMPDIR/mut-ge2-fa-rethrow && node --test --test-force-exit --test-name-pattern='oracle O-GE2-today \(Arm b\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FA-rethrow survived O-GE2-today (Arm b) in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fa-settled
                chmod -R u+w $TMPDIR/mut-ge2-fa-settled
                substituteInPlace $TMPDIR/mut-ge2-fa-settled/src/root/index.ts \
                  --replace-fail 'await escalateAfterPost(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });' 'await escalation.reply(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });' \
                  --replace-fail '} finally {' '} catch (e) { throw e; } {'
                if (cd $TMPDIR/mut-ge2-fa-settled && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FA-settled' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FA-settled-unhandled survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fa-deadline
                chmod -R u+w $TMPDIR/mut-ge2-fa-deadline
                sed -i '/onDeadline: async/,/onQueueTimeout: async/s/await escalateAfterPost(t, { answer: "", confidence: 0, gaps: \[\], escalate_forced: true });/await escalation.reply(t, { answer: "", confidence: 0, gaps: [], escalate_forced: true });/' $TMPDIR/mut-ge2-fa-deadline/src/root/index.ts
                grep -q 'await escalation\.reply(t, { answer: "", confidence: 0, gaps: \[\], escalate_forced: true });' $TMPDIR/mut-ge2-fa-deadline/src/root/index.ts || exit 1
                if (cd $TMPDIR/mut-ge2-fa-deadline && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FA-deadline' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FA-deadline survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fa-qtimeout
                chmod -R u+w $TMPDIR/mut-ge2-fa-qtimeout
                substituteInPlace $TMPDIR/mut-ge2-fa-qtimeout/src/root/index.ts \
                  --replace-fail 'await escalateAfterPost(t, { answer: "", confidence: 0, gaps: ["tier-1 busy"], escalate_forced: true });' 'await escalation.reply(t, { answer: "", confidence: 0, gaps: ["tier-1 busy"], escalate_forced: true });'
                if (cd $TMPDIR/mut-ge2-fa-qtimeout && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FA-queue-timeout' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FA-queue-timeout survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fa-no-catch
                chmod -R u+w $TMPDIR/mut-ge2-fa-no-catch
                substituteInPlace $TMPDIR/mut-ge2-fa-no-catch/src/lifecycle/index.ts \
                  --replace-fail '(this.o.onHandlerError ?? defaultHandlerErrorSink)("deadline", thread, e);' 'throw e;'
                if (cd $TMPDIR/mut-ge2-fa-no-catch && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FA-lifecycle-safety-net' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FA-deadline-no-catch survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fb-trust-pkg
                chmod -R u+w $TMPDIR/mut-ge2-fb-trust-pkg
                substituteInPlace $TMPDIR/mut-ge2-fb-trust-pkg/src/root/index.ts \
                  --replace-fail 'eval_transcript: ctx.eval_transcript,' 'eval_transcript: p.eval_transcript,'
                if (cd $TMPDIR/mut-ge2-fb-trust-pkg && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FB-context-rebuild' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FB-trust-pkg-transcript survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fb-skip-guard-out
                chmod -R u+w $TMPDIR/mut-ge2-fb-skip-guard-out
                substituteInPlace $TMPDIR/mut-ge2-fb-skip-guard-out/src/root/index.ts \
                  --replace-fail 'draft: out.value.draft,' 'draft: p.draft,'
                if (cd $TMPDIR/mut-ge2-fb-skip-guard-out && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FB-context-rebuild' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FB-escalate-skip-guard-out survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-n1-raw-git
                chmod -R u+w $TMPDIR/mut-ge2-n1-raw-git
                substituteInPlace $TMPDIR/mut-ge2-n1-raw-git/src/root/index.ts \
                  --replace-fail '{ request: request as GitRequest, output: screened, screened: true },' '{ request: request as GitRequest, output: out.output, screened: true },'
                if (cd $TMPDIR/mut-ge2-n1-raw-git && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FB-context-rebuild' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-N1-raw-git-output survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-c6-recall
                chmod -R u+w $TMPDIR/mut-ge2-c6-recall
                substituteInPlace $TMPDIR/mut-ge2-c6-recall/src/root/index.ts \
                  --replace-fail 'const results: BankRecallItem[] = res.results ?? [];' 'await guard.transcript("recall"); const results: BankRecallItem[] = res.results ?? [];'
                if (cd $TMPDIR/mut-ge2-c6-recall && node --test --test-force-exit --test-name-pattern='oracle O-GE2-C6-recall-unscreened' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-C6-readd-recall-screen survived O-GE2-C6-recall-unscreened in root" >&2
                  exit 1
                fi
                if (cd $TMPDIR/mut-ge2-c6-recall && node --test --test-force-exit --test-name-pattern='oracle O-GE2-today \(Arm a\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-C6-readd-recall-screen survived O-GE2-today (Arm a) in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-ge2-fc-timeout
                chmod -R u+w $TMPDIR/mut-ge2-fc-timeout
                substituteInPlace $TMPDIR/mut-ge2-fc-timeout/src/root/io.ts \
                  --replace-fail 'const remainingMs = deadline - Date.now();' 'const remainingMs = this.timeoutMs;' \
                  --replace-fail 'const waitMs = deadline - Date.now();' 'const waitMs = 600_000;'
                if (cd $TMPDIR/mut-ge2-fc-timeout && node --test --test-force-exit --test-name-pattern='oracle O-GE2-FC-queue-timeout' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GE2-FC-timeout-at-acquire survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-silent
                chmod -R u+w $TMPDIR/mut-silent
                substituteInPlace $TMPDIR/mut-silent/src/root/index.ts \
                  --replace-fail 'if (d.silent === true) {' 'if (false) {' \
                  --replace-fail 'if (parsed.silent === true) {' 'if (false) {'
                if (cd $TMPDIR/mut-silent && node --test --test-force-exit --test-name-pattern='oracle O-GC1-silent' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-ignore-silent-flag survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-no-pi-bwrap
                chmod -R u+w $TMPDIR/mut-no-pi-bwrap
                substituteInPlace $TMPDIR/mut-no-pi-bwrap/src/tier1/launch.ts \
                  --replace-fail '      command: bwrapBin,' '      command: piBin,' \
                  --replace-fail '      args: bwrapArgs,' '      args: [...fixed, ...extraArgs, ...apiKeyArgs],'
                if (cd $TMPDIR/mut-no-pi-bwrap && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-no-pi-bwrap survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-rw-agentdir
                chmod -R u+w $TMPDIR/mut-rw-agentdir
                substituteInPlace $TMPDIR/mut-rw-agentdir/src/tier1/launch.ts \
                  --replace-fail '["--ro-bind", agentDir, agentDir]' '["--bind", agentDir, agentDir]'
                if (cd $TMPDIR/mut-rw-agentdir && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-rw-worktree-or-agentdir survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-expose-state
                chmod -R u+w $TMPDIR/mut-expose-state
                substituteInPlace $TMPDIR/mut-expose-state/src/tier1/launch.ts \
                  --replace-fail 'const stateMask = ["--tmpfs", stateRoot];' 'const stateMask = ["--ro-bind", stateRoot, stateRoot];'
                if (cd $TMPDIR/mut-expose-state && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-expose-state-root survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-root-symlinks
                chmod -R u+w $TMPDIR/mut-root-symlinks
                substituteInPlace $TMPDIR/mut-root-symlinks/src/mirror/index.ts \
                  --replace-fail '  chmodSync,' '  chmodSync, symlinkSync,' \
                  --replace-fail '    writeFileSync(target, content, { mode: fmode });' '    if (entry.mode === "120000") { symlinkSync(content.toString("utf8").trim(), target); continue; } writeFileSync(target, content, { mode: fmode });'
                if (cd $TMPDIR/mut-root-symlinks && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-symlinks-true survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-no-pi-offline
                chmod -R u+w $TMPDIR/mut-no-pi-offline
                substituteInPlace $TMPDIR/mut-no-pi-offline/src/tier1/launch.ts \
                  --replace-fail '      "--setenv", "PI_OFFLINE", "1",' "" \
                  --replace-fail '        PI_OFFLINE: "1",' ""
                if (cd $TMPDIR/mut-no-pi-offline && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-no-pi-offline survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-root-no-unshare-pid
                chmod -R u+w $TMPDIR/mut-root-no-unshare-pid
                substituteInPlace $TMPDIR/mut-root-no-unshare-pid/src/tier1/launch.ts \
                  --replace-fail '      "--unshare-pid",' ""
                if (cd $TMPDIR/mut-root-no-unshare-pid && node --test --test-force-exit --test-name-pattern='oracle GS2 \(F1\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-no-unshare-pid survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-gp7-dup
                chmod -R u+w $TMPDIR/mut-gp7-dup
                substituteInPlace $TMPDIR/mut-gp7-dup/src/root/index.ts \
                  --replace-fail 'error: "refused: a pending action is already awaiting approval on this thread",' 'error: (setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result: { refused: "trusted eval", error: "refused: a pending action is already awaiting approval on this thread" } }] }), "refused: a pending action is already awaiting approval on this thread"),'
                if (cd $TMPDIR/mut-gp7-dup && node --test --test-force-exit --test-name-pattern='oracle O-GP7-escalate-after-refused-eval' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GP7-record-refused-dup survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-gp7-guardout
                chmod -R u+w $TMPDIR/mut-gp7-guardout
                substituteInPlace $TMPDIR/mut-gp7-guardout/src/root/index.ts \
                  --replace-fail 'error: `refused: ''${out.reason}`,' 'error: (setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result: { refused: "trusted eval", error: `refused: ''${out.reason}` } }] }), `refused: ''${out.reason}`),'
                if (cd $TMPDIR/mut-gp7-guardout && node --test --test-force-exit --test-name-pattern='oracle O-GP7-escalate-after-refused-eval' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GP7-record-refused-guardout survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-gp7-public
                chmod -R u+w $TMPDIR/mut-gp7-public
                substituteInPlace $TMPDIR/mut-gp7-public/src/root/index.ts \
                  --replace-fail 'error: "refused: trusted eval on a public thread",' 'error: (setContext(t, { eval_transcript: [...context(t).eval_transcript, { request, result: { refused: "trusted eval", error: "refused: trusted eval on a public thread" } }] }), "refused: trusted eval on a public thread"),'
                if (cd $TMPDIR/mut-gp7-public && node --test --test-force-exit --test-name-pattern='oracle O-GP7-escalate-after-refused-eval' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GP7-record-refused-eval-transcript survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-gp7-persisted
                chmod -R u+w $TMPDIR/mut-gp7-persisted
                substituteInPlace $TMPDIR/mut-gp7-persisted/src/root/index.ts \
                  --replace-fail 'eval_transcript: (raw.eval_transcript ?? []).filter(hasEvalExit),' 'eval_transcript: raw.eval_transcript ?? [],'
                if (cd $TMPDIR/mut-gp7-persisted && node --test --test-force-exit --test-name-pattern='oracle O-GP7-repair-persisted-refused-eval' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-GP7-keep-persisted-refused-eval survived in root" >&2
                  exit 1
                fi
                cp -r . $TMPDIR/mut-root-cred-skip
                chmod -R u+w $TMPDIR/mut-root-cred-skip
                substituteInPlace $TMPDIR/mut-root-cred-skip/src/root/index.ts \
                  --replace-fail '    if (credential === null || credential === undefined) continue;' '    if (!credential || !existsSync(credential)) continue;'
                if (cd $TMPDIR/mut-root-cred-skip && node --test --test-force-exit --test-name-pattern='oracle \(fail-closed credentials\)' tests/root.test.ts >/dev/null 2>&1); then
                  echo "mutant M-root-skip-missing-credential survived in root" >&2
                  exit 1
                fi
                touch $out
              '';
          # The guard-in injection corpus, and the held-out one beside it, are well-formed and cover
          # every attack vector; the held-out sidecar names fragments each attack actually carries.
          corpus = pkgs.runCommand "genie-agent-corpus" { nativeBuildInputs = [ pkgs.python3 ]; } ''
            python3 ${./tests/corpus.py} ${./corpus/injection-scope/cases.jsonl} ${./corpus/injection-scope/must-not-contain.json} --scope
            python3 ${./tests/corpus.py} ${./corpus/injection/cases.jsonl}
            python3 ${./tests/corpus.py} ${./corpus/injection-heldout/cases.jsonl} ${./corpus/injection-heldout/must-not-contain.json}
            python3 ${./tests/corpus.py} ${./corpus/outbound/cases.jsonl}
            python3 ${./tests/corpus.py} ${./corpus/outbound-heldout/cases.jsonl}
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
                    ./operating-memory
                  ];
                };
              }
              ''
                cd $src
                node tests/support-memory.ts support-memory
                node tests/support-memory.ts operating-memory
                touch $out
              '';
          # The hindsight memory bank client and isolation oracle (Unit H1, design row 8, §6).
          bank =
            pkgs.runCommand "genie-agent-bank"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/bank
                    ./tests/bank.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/bank.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - oracle H1: bank isolation verification succeeds with seed entry and isolated banks" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - mutant 1: target bank leaking den-law entries triggers RED" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - mutant 2: seed entry absent from target bank triggers RED" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - mutant 3: positive control with 0 hits on den-law triggers RED" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - mutant 4: cross-contamination of seed entry in den-law triggers RED" $TMPDIR/tap || exit 1
                touch $out
              '';
          # The distiller prompt and review queue (Unit H2, plan row H2, design §6, Oracle 20).
          distiller =
            pkgs.runCommand "genie-agent-distiller"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/bank
                    ./bin
                    ./prompts/distiller.md
                    ./schemas/candidate.json
                    ./tests/distiller.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/distiller.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 1: the genie root's bank client has no retain" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 2: accept => queue grows by 1 on disk and bank by 0" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 3: candidate enqueued by genie process is approved by separate CLI process, and bank grows by 1" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 4: check-passing entry with no approval stays out of the bank" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 5: deterministic checks run again at approve time and may still refuse" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 6: review CLI without valid write token fails and bank stays empty" $TMPDIR/tap || exit 1
                grep -q "ok [0-9]* - Oracle 20 cell 7: deterministic checks refuse credentials and planted markers on enqueue" $TMPDIR/tap || exit 1
                touch $out
              '';
        }
        // onLinux pkgs {
          dispatcher-sea = seaCheck "genie-dispatcher" (genieDispatcher pkgs) pkgs;
          genie-guard-sea = seaCheck "genie-guard" (genieGuard pkgs) pkgs;
          root-sea = seaCheck "genie-root" (genieRoot pkgs) pkgs;
          nixos-module = import ./nix/test-module.nix {
            inherit pkgs nixpkgs;
            self = {
              inherit packages nixosModules;
            };
          };
          # GI-13: the tier sandbox and the tier token, in a VM.
          expert-isolation = import ./nix/test-expert-isolation.nix {
            inherit pkgs nixpkgs;
            self = {
              inherit packages nixosModules;
            };
          };
          root-image =
            let
              root = genieRoot pkgs;
            in
            pkgs.runCommand "genie-root-image-oracle" { nativeBuildInputs = [ pkgs.python3 ]; } ''
              python3 ${./nix/check_root_image.py} \
                ${rootImage pkgs packages.${pkgs.stdenv.hostPlatform.system}.operating-memory} \
                ${packages.${pkgs.stdenv.hostPlatform.system}.operating-memory} \
                ${root}/bin/genie-root \
                '${root.runtimePath}' \
                ${root.rootSrc}/lib/genie-agent \
                ${root.caBundle}
              touch $out
            '';
          image =
            pkgs.runCommand "genie-agent-image-oracle"
              {
                nativeBuildInputs = [ pkgs.python3 ];
              }
              ''
                python3 ${./nix/check_image.py} ${guardImage pkgs}
                touch $out
              '';
        }
      );

      nixosModules = rec {
        default = import ./nix/module.nix { inherit packages; };
        genie-agent = default;
      };

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

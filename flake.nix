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
      # A service as a Node single executable, the path xmsg's `--svc-exe` attests (design §5.8,
      # Topology). Its blob is the bundled main, and `execArgvExtension: "none"` makes it ignore
      # NODE_OPTIONS, so the attested path runs nothing but that main.
      sea =
        {
          name,
          main,
          fileset,
          description,
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
            esbuild ${main} --bundle --platform=node --format=cjs --loader:.md=text --outfile=main.cjs
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
      # Tier 1's composition root (`genie-root`, GI-2): wraps `node` running `src/root/main.ts`
      # with `pi-coding-agent`, `bubblewrap`, `nix`, and `git` on PATH, plus `NIX_SSL_CERT_FILE`.
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
          runtimePath = nixpkgs.lib.makeBinPath [
            pkgs.pi-coding-agent
            pkgs.bubblewrap
            pkgs.nix
            pkgs.git
            pkgs.coreutils
          ];
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "genie-root";
          version = "0.1.0";
          dontUnpack = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            mkdir -p $out/bin
            makeWrapper ${pkgs.lib.getExe pkgs.nodejs} $out/bin/genie-root \
              --add-flags "${rootSrc}/lib/genie-agent/src/root/main.ts" \
              --prefix PATH : "${runtimePath}" \
              --set-default NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
              --set-default SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          '';
          meta = {
            description = "genie-agent's tier-1 composition root service";
            license = nixpkgs.lib.licenses.mit;
            mainProgram = "genie-root";
            platforms = nixpkgs.lib.platforms.linux;
          };
        };
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
      # Each single executable runs its own main and nothing else: a payload offered through
      # NODE_OPTIONS, a node flag or a script argument never runs, and the binary's own config
      # refusal (exit 2) is the positive control that its main did.
      seaCheck =
        name: pkg: pkgs:
        pkgs.runCommand "genie-agent-${name}-sea" { nativeBuildInputs = [ pkg ]; } ''
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
                ./bin
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

          # I12 will copy this output to /memory in the tier-1 image.
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
          # The dispatcher's gating oracles, core (design oracle 24) and delivery (oracle 28), against
          # The dispatcher's gating oracles, core (design oracle 24), delivery (oracle 28) and
          # park & GC (oracle 26), against a recording herdr fake and an xmsg fake.
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
                    ./tests/dispatcher-gc.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-reporter=tap tests/dispatcher.test.ts tests/delivery.test.ts tests/dispatcher-gc.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle 24: a parked thread resumes with its first launch.s uuid across a kill and restart$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 28: a message to a parked thread is buffered, delivered once xmsg lists the resumed uuid, and answered$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 26: never parked with a message outstanding or in buffer$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 26: parked at the threshold after the last reply, and resumable$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 26: at 95h idle kept, at 96h handed off and gone$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The verdict parser's gating oracle: any reply outside schemas/verdict.json, or breaking its
          # contract with the reviewed envelope, is a reject. Also the rewrite predicate's lexical arm,
          # and genie-guard's: a verdict is relayed parsed, and no review is an error, never a verdict.
          guard =
            pkgs.runCommand "genie-agent-guard"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/guard
                    ./src/supervisor/guard-client.ts
                    ./src/supervisor/seed.ts
                    ./schemas/fixtures/verdict
                    ./schemas/fixtures/verdict-out
                    ./corpus/injection/must-not-contain.json
                    ./results/guard-in/injection-run1.json
                    ./results/guard-in/injection-run2.json
                    ./tests/guard.test.ts
                    ./tests/guard-out.test.ts
                    ./tests/guard-service.test.ts
                    ./src/dispatcher/xmsg.ts
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
                  && grep -q '^ok [0-9]* - oracle 3 (G9): in-repo corpus has no verdict regressions across saved runs and empty-cleaned_text allows$' $TMPDIR/tap \
                  && grep -q "^ok [0-9]* - oracle 4 (G9): a 4 KB envelope's allow reply fits without truncation$" $TMPDIR/tap \
                  && grep -q "^ok [0-9]* - oracle 5b (G9.1): review and reviewOut log loudly when reasoning_tokens > 0 or finish_reason === 'length', while preserving fail-closed behaviour$" $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - an HTTP 500 from ninfer is an error reply, not a verdict$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle 2: parser fails closed to block on invalid or malformed output$' $TMPDIR/tap \
                  && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                    ./tests/mirror.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-reporter=tap tests/mirror.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: two threads on one repo share one clone, each with its own worktree$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: an over-cap clone is killed and leaves nothing, an under-cap one is mirrored$' $TMPDIR/tap && grep -q '^ok [0-9]* - a fetch that takes an unpinned mirror past its cap removes the mirror$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a killed over-cap fetch into a pinned mirror leaves its refs and bytes as they were, and its worktree resolves$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: refs deleted upstream are pruned only after a successful fetch, and a failed prune leaves them$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a pinned mirror already past its cap is refused before git starts$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: filling past the quota evicts the least-recently-used mirror and keeps the total under quota$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a mirror with a live worktree is never evicted, even when it is the least recently used$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: when pinned mirrors alone pass the quota, the new fetch is refused and leaves no mirror$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: the least-recently-used order survives a restart of the fetcher$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: diskBytes counts apparent file sizes, whether blocks are zero or exceed size, and skips directories$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/tier1
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
                  && grep -q '^ok [0-9]* - oracle: the tool list is exactly the twelve$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: the draft parser accepts every valid reply and rejects every invalid one$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: a degraded arm scores below real by more than paired bootstrap noise band$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: compareArms reports inside_noise_band when paired bootstrap CI crosses zero$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle: exploratory correctness predictors calculate AUROC and lift on distinct answered questions$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - oracle C2.2.2 (Item 1 & 3): runArm offers all 12 production TOOLS and executes built-in read/grep/find/ls with confinement$' $TMPDIR/tap \
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
                  && grep -q '^ok [0-9]* - Hermetic Memory Eval: each memory arm beats no-memory across repeated runs$' $TMPDIR/tap \
                  && grep -q '^ok [0-9]* - memory-eval questions: ids unique and every claim specific$' $TMPDIR/tap \
                  && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                  "a poisoned bank entry and a poisoned replay fixture both reach guard-in before the session sees them" \
                  "clean bank entries and clean replay fixtures are screened and seed the session unchanged" \
                  "a rewrite in a bank entry or replay sends the guard's cleaned_text, not the injection" \
                  "the seed guard unavailable, throwing or malformed refuses to seed the session" \
                  "each seed check is a fresh session: source recall, history empty" \
                  "parameterized seedGuard over enabled true and false: off mode makes 0 guard calls and seeds session identically to on-mode allow"; do
                  sed -n 's/^ok [0-9]* - oracle: //p' $TMPDIR/tap | grep -qxF -- "$cell" || { echo "missing cell: $cell"; exit 1; }
                done
                touch $out
              '';
          # The Host bridge (plan C3.1) under real pi with the tier-1 extension, as tier1Launch starts
          # it: a tool call in a thread reaches the supervisor's Host as that thread and its result
          # returns to the tool, and the system prompt carries tier 1's prompt and every skill. A web
          # result reaches the model only as the supervisor's guard Screen lets it (plan C3.2): a stub
          # web server and a fake GuardClient. A stub model on the sandbox's loopback; the
          # forged-thread cell runs over the fake pi.
          tier1-bridge =
            pkgs.runCommand "genie-agent-tier1-bridge"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/supervisor
                    ./src/tier1
                    ./src/mirror
                    ./src/guard/verdict.ts
                    ./schemas
                    ./skills
                    ./prompts/tier1.md
                    ./tests/tier1-bridge.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                export PI=${nixpkgs.lib.getExe pkgs.pi-coding-agent}
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/tier1-bridge.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q "^ok [0-9]* - oracle: a tool call in thread A reaches the supervisor's Host as A and its result returns to the tool; B's as B$" $TMPDIR/tap && grep -q "^ok [0-9]* - oracle: the launched system prompt carries tier 1's prompt and every skill's body$" $TMPDIR/tap && grep -q '^ok [0-9]* - a Host call that names another thread is attributed to the thread whose pipes carried it$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
                for cell in \
                  "a clean page the guard allows reaches tier 1's context" \
                  "an injected page the guard rejects is withheld from tier 1's context" \
                  "a page the guard rewrites reaches tier 1's context only as rewritten" \
                  "a page the guard is unavailable for is withheld from tier 1's context"; do
                  sed -n 's/^ok [0-9]* - oracle: //p' $TMPDIR/tap | grep -qxF -- "$cell" || { echo "missing cell: $cell"; exit 1; }
                done
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
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./tests/eval-argv.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-argv.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q "^ok [0-9]* - the untrusted argv is E1's, byte for byte, whatever builders are configured$" $TMPDIR/tap && grep -q "^ok [0-9]* - a public sender's trusted: yes opens neither IFD nor builders$" $TMPDIR/tap && grep -q '^ok [0-9]* - an effective trusted eval allows IFD and names the configured builders$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
          # The Kubernetes eval runner (plan E3): render the Job spec (runtimeClass gvisor, 12Gi/2c, deadline,
          # thread store root, scratch emptyDir limit, labels) and submit/watch against a stub k8s API.
          eval-k8s =
            pkgs.runCommand "genie-agent-eval-k8s"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/eval
                    ./tests/eval-k8s.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/eval-k8s.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: snapshot plus property checks on the rendered Job spec$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                touch $out
              '';
          # The broker: a proposal failing guard-out is never acted on, a passing one is acted on once
          # with its credentials redacted, and the token reaches only the act. Stub ninfer, fake act.
          broker =
            pkgs.runCommand "genie-agent-broker"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src/broker
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
                    ./src/redactor
                    ./src/tier1/schema.ts
                    ./schemas/proposal.json
                    ./tests/broker.test.ts
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/broker.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: a proposal that fails guard-out is not acted on$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a passing proposal is acted on exactly once, with redacted content$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle (G11): when guardOut.enable is false, the deterministic redactor still runs and guard-out receives 0 calls$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
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
                    ./src/guard
                    ./src/dispatcher/xmsg.ts
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
                ];
                src = nixpkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = nixpkgs.lib.fileset.unions [
                    ./src
                    ./schemas
                    ./skills
                    ./prompts
                    ./tests/root.test.ts
                    ./tests/fixtures/supervisor
                  ];
                };
              }
              ''
                cd $src
                export PI=${nixpkgs.lib.getExe pkgs.pi-coding-agent}
                rc=0
                node --test --test-force-exit --test-reporter=tap tests/root.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                  "recall through main() hits stub hindsight, routes bank selectors, and withholds poisoned entries via seedGuard" \
                  "tier1Launch seeds operating memory when tier1.memoryRoot is set" \
                  "close and gc.sweep() succeed with s3: null, and propose with no token is refused cleanly"; do
                  grep -qx "ok [0-9]* - oracle: $cell" $TMPDIR/tap || { echo "missing cell: $cell"; exit 1; }
                done
                grep -q '^ok [0-9]* - oracle (G11): parameterized root pipeline over guard.enable and broker.guardOut.enable (true vs false): off mode constructs no XmsgGuardClient, makes 0 guard/guardOut calls, appends UNSCREENED_PROMPT, redacts outbound replies/proposals/expert replies, and matches on-mode allow$' $TMPDIR/tap || exit 1
                touch $out
              '';
          # The guard-in injection corpus, and the held-out one beside it, are well-formed and cover
          # every attack vector; the held-out sidecar names fragments each attack actually carries.
          corpus = pkgs.runCommand "genie-agent-corpus" { nativeBuildInputs = [ pkgs.python3 ]; } ''
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
          nixos-module = import ./nix/test-module.nix {
            inherit pkgs nixpkgs;
            self = {
              inherit packages nixosModules;
            };
          };
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

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
      # guard-in as `svc:genie-guard`, with its prompt bundled in (genie-solicit-design.md, G1).
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
          genie-guard = genieGuard pkgs;
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
                    ./schemas/fixtures/verdict
                    ./schemas/fixtures/verdict-out
                    ./corpus/injection/must-not-contain.json
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
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - unparseable output fails closed to reject$' $TMPDIR/tap && grep -q '^ok [0-9]* - an HTTP 500 from ninfer is an error reply, not a verdict$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle 2: parser fails closed to block on invalid or malformed output$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: two threads on one repo share one clone, each with its own worktree$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: an over-cap clone is killed and leaves nothing, an under-cap one is mirrored$' $TMPDIR/tap && grep -q '^ok [0-9]* - a fetch that takes an unpinned mirror past its cap removes the mirror$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a killed over-cap fetch into a pinned mirror leaves its refs and bytes as they were, and its worktree resolves$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: refs deleted upstream are pruned only after a successful fetch, and a failed prune leaves them$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a pinned mirror already past its cap is refused before git starts$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: filling past the quota evicts the least-recently-used mirror and keeps the total under quota$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a mirror with a live worktree is never evicted, even when it is the least recently used$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: when pinned mirrors alone pass the quota, the new fetch is refused and leaves no mirror$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: the least-recently-used order survives a restart of the fetcher$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                    ./src/guard/verdict.ts
                    ./src/mirror
                    ./schemas
                    ./skills
                    ./tests/tier1.test.ts
                    ./tests/tier1-draft.test.ts
                    ./tests/fixtures/tier1-draft
                  ];
                };
              }
              ''
                cd $src
                rc=0
                node --test --test-reporter=tap tests/tier1.test.ts tests/tier1-draft.test.ts > $TMPDIR/tap || rc=$?
                cat $TMPDIR/tap
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: the tool list is exactly the twelve$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: the draft parser accepts every valid reply and rejects every invalid one$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
                [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - oracle: a proposal that fails guard-out is not acted on$' $TMPDIR/tap && grep -q '^ok [0-9]* - oracle: a passing proposal is acted on exactly once, with redacted content$' $TMPDIR/tap && grep -q '^# fail 0$' $TMPDIR/tap || exit 1
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
          dispatcher-sea = seaCheck "genie-dispatcher" (genieDispatcher pkgs) pkgs;
          genie-guard-sea = seaCheck "genie-guard" (genieGuard pkgs) pkgs;
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

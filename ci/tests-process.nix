# The eval runner's gating oracle, on gen-harness's PROCESS PLANE: `apps.<system>.tests-process`,
# run by `ci --tests-process` in every column of `evaluators.yml`. Two reasons it is not a check:
# the runner calls the `nix` on PATH, so its verdict is evidence for that evaluator only and a
# sandboxed check would run the ci-locked `pkgs.nix` in every column; and it needs user namespaces
# (bwrap), which the CI runners refuse to every binary but an `unshare` the plane admits. So the
# suite runs under this program's own `unshare -c`, and bwrap nests inside it. Locally:
#   nix develop ./ci --command ci --tests-process
{
  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs) lib;
      src = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../src/eval
          ../tests/eval.test.ts
          ../tests/fixtures/eval
        ];
      };
    in
    {
      apps.tests-process.program = pkgs.writeShellScriptBin "tests-process" ''
        set -e
        # The tools the runner calls, declared rather than ambient, and never an evaluator.
        export PATH=${
          lib.makeBinPath [
            pkgs.coreutils
            pkgs.gnugrep
            pkgs.gnused
            pkgs.nodejs
            pkgs.bubblewrap
            # unshare: the egress cell's network namespace with no interface.
            pkgs.util-linux
            # ip: the dropped-connection cell's route to nowhere.
            pkgs.iproute2
          ]
        }:$PATH
        echo "evaluator: $(nix-instantiate --version | sed -n 1p)"
        tap=$(mktemp)
        trap 'rm -f "$tap"' EXIT
        cd ${src}
        rc=0
        ${lib.getExe' pkgs.util-linux "unshare"} -c node --test --test-reporter=tap tests/eval.test.ts > "$tap" || rc=$?
        cat "$tap"
        # node counts a file with no tests as one passing test, so the run must show its named cells.
        [ "$rc" -eq 0 ] && grep -q '^# fail 0$' "$tap" || exit 1
        for cell in \
          'request.trusted cannot raise a public tier' \
          'a plain flake evaluates' \
          'IFD is refused under public' \
          'IFD is admitted under trusted' \
          'impure env fails under pure-eval, trusted or not' \
          'impure file fails under pure-eval, trusted or not' \
          '<nixpkgs> fails under pure-eval' \
          'an indirect flake reference resolves through no registry' \
          'the jail environment is exactly the allowlist, carrying nothing of the thread' \
          "an eval past the runner's timeout is limit timeout" \
          'a fetch the network refuses is limit egress' \
          "a fetch the network drops is limit egress before the runner's deadline" \
          'an eval SIGKILLed from outside with no OOM kill is limit unknown' \
          'the resolved CA bundle is a real file, not a symlink into /etc/static' \
          'a TLS fetch inside the jail succeeds with the resolved CA bundle'; do
          sed -n 's/^ok [0-9]* - //p' "$tap" | grep -qxF -- "$cell" || { echo "missing cell: $cell"; exit 1; }
        done
        # Skipped where there is no systemd user scope to delegate, but never absent.
        grep -q "^ok [0-9]* - an OOM kill under a memory cap is limit oom\( # SKIP .*\)\?$" "$tap" ||
          { echo "missing cell: the oom cell"; exit 1; }
        grep -q "^ok [0-9]* - a concurrent eval's OOM kill is not this one's, in a delegated cgroup\( # SKIP .*\)\?$" "$tap" ||
          { echo "missing cell: the delegated cgroup's"; exit 1; }
      '';
    };
}

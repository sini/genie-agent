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
          ]
        }:$PATH
        echo "evaluator: $(nix-instantiate --version | sed -n 1p)"
        tap=$(mktemp)
        trap 'rm -f "$tap"' EXIT
        cd ${src}
        rc=0
        ${lib.getExe' pkgs.util-linux "unshare"} -c node --test --test-reporter=tap tests/eval.test.ts > "$tap" || rc=$?
        cat "$tap"
        # node counts a file with no tests as one passing test, so the run must show a named cell.
        [ "$rc" -eq 0 ] && grep -q '^ok [0-9]* - request.trusted cannot raise a public tier$' "$tap" && grep -q '^# fail 0$' "$tap" || exit 1
      '';
    };
}

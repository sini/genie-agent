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
        # node counts a file with no tests as one passing test, so the run must show its named cells.
        [ "$rc" -eq 0 ] && grep -q '^# fail 0$' "$tap" || exit 1
        for cell in \
          'request.trusted cannot raise a public tier' \
          'a plain flake evaluates' \
          'impure env fails under pure-eval, trusted or not' \
          'impure file fails under pure-eval, trusted or not' \
          '<nixpkgs> fails under pure-eval' \
          'an indirect flake reference resolves through no registry' \
          'the jail environment is exactly the allowlist, carrying nothing of the thread'; do
          sed -n 's/^ok [0-9]* - //p' "$tap" | grep -qxF -- "$cell" || { echo "missing cell: $cell"; exit 1; }
        done
      '';
    };
}

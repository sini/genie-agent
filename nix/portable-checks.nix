{
  pkgs,
  lib,
  rootPackage,
  modelSdk,
  unitChecks,
}:
let
  cells = builtins.fromJSON (builtins.readFile ./portable-unit-cells.json);
  runtimeCells = cells."tests/portable-runtime.test.ts";
  baselineCells = [
    "portable baseline: actual Root and pi keep credentials in root without bwrap"
    "portable baseline: native Nix evaluates with pure mode and a clean environment"
  ];
  unitNames = [
    "archive"
    "bank"
    "broker"
    "dispatcher"
    "distiller"
    "escalation"
    "eval-argv"
    "eval-cache"
    "eval-k8s"
    "eval-limits"
    "eval-lock"
    "gc"
    "gist"
    "guard"
    "lifecycle"
    "mirror"
    "pr"
    "redactor"
    "state"
    "supervisor"
    "tier"
  ];
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../src
      ../tests
      ../schemas
      ../skills
      ../prompts
      ../bin
      ../corpus
      ../results
      ../operating-memory
    ];
  };
  run =
    {
      name,
      files,
      expected,
      compiled ? false,
      noSkip ? false,
      processPlane ? false,
      pattern ? null,
    }:
    let
      dependencies = [
        pkgs.nodejs
        pkgs.python3
        pkgs.bash
        pkgs.coreutils
        pkgs.git
        pkgs.gnutar
        pkgs.gnugrep
        pkgs.gnused
        pkgs.openssl
        pkgs.nix
        pkgs.pi-coding-agent
      ];
      script = ''
        set -euo pipefail
        export PATH=${lib.makeBinPath dependencies}:$PATH
        ${lib.optionalString processPlane ''
          probe_tmp=$(mktemp -d)
          trap 'rm -rf "$probe_tmp"' EXIT
          export TMPDIR="$probe_tmp"
        ''}
        export SHELL=${pkgs.bash}/bin/bash
        export PI=${lib.getExe pkgs.pi-coding-agent}
        export NIX_BIN=${lib.getExe pkgs.nix}
        export GENIE_PI_AI=${lib.escapeShellArg modelSdk}
        ${lib.optionalString compiled ''
          export GENIE_ROOT_MODULE=file://${rootPackage}/lib/genie-agent/dist/src/root/index.js
          export GENIE_REPO_ROOT=${rootPackage}/lib/genie-agent
          export GENIE_ROOT_NODE_BIN=${rootPackage}/bin/genie-root-node
          export SSL_CERT_FILE=${rootPackage.caBundle}
          export NIX_SSL_CERT_FILE=${rootPackage.caBundle}
          set +e
          "$GENIE_ROOT_NODE_BIN" --portable-launcher-probe > "$TMPDIR/launcher.out" 2>&1
          launcher_rc=$?
          set -e
          cat "$TMPDIR/launcher.out"
          if [ "$launcher_rc" -ne 2 ] || ! grep -q '^genie-root: ' "$TMPDIR/launcher.out"; then
            echo "portable Node launcher did not reject the probe with exit 2" >&2
            exit 1
          fi
        ''}
        cd ${source}
        rc=0
        node --expose-gc --test --test-force-exit --test-reporter=tap ${
          lib.optionalString (pattern != null) "--test-name-pattern=${lib.escapeShellArg pattern}"
        } ${lib.escapeShellArgs files} > "$TMPDIR/tap" || rc=$?
        cat "$TMPDIR/tap"
        [ "$rc" -eq 0 ] && grep -q '^# fail 0$' "$TMPDIR/tap" || exit 1
        ${lib.concatMapStringsSep "\n" (cell: ''
          sed -n 's/^ok [0-9]* - //p' "$TMPDIR/tap" | grep -qxF -- ${lib.escapeShellArg cell} || {
            echo "missing portable cell: "${lib.escapeShellArg cell}
            exit 1
          }
        '') expected}
        ${lib.optionalString noSkip ''grep -q '^# skipped 0$' "$TMPDIR/tap"''}
        ${lib.optionalString (!processPlane) "touch $out"}
      '';
    in
    if processPlane then
      pkgs.writeShellScriptBin "genie-agent-${name}" script
    else
      pkgs.runCommand "genie-agent-${name}" { nativeBuildInputs = dependencies; } script;
  nativeBaseline = run {
    name = "portable-native";
    files = [ "tests/portable-baseline.test.ts" ];
    expected = baselineCells;
    compiled = true;
    noSkip = true;
    processPlane = true;
  };
  runtime = run {
    name = "portable-runtime";
    files = [ "tests/portable-runtime.test.ts" ];
    expected = runtimeCells;
    noSkip = true;
  };
in
{
  portable-unit =
    if pkgs.stdenv.hostPlatform.isLinux then
      pkgs.linkFarm "genie-agent-portable-unit" (
        map (name: {
          inherit name;
          path = unitChecks.${name};
        }) unitNames
        ++ [
          {
            name = "portable-runtime";
            path = runtime;
          }
        ]
      )
    else
      run {
        name = "portable-unit";
        files = builtins.attrNames cells;
        expected = lib.concatLists (builtins.attrValues cells);
      };
  portable-baseline =
    (run {
      name = "portable-baseline";
      files = [ "tests/portable-baseline.test.ts" ];
      expected = [ (builtins.head baselineCells) ];
      compiled = true;
      noSkip = true;
      pattern = "actual Root and pi";
    }).overrideAttrs
      (_: {
        passthru.processPlane = nativeBaseline;
      });
}

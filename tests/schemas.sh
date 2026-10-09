#!/usr/bin/env bash
# Validate every fixture under schemas/fixtures/<schema>/{valid,invalid}/ against
# schemas/<schema>.json and expect the outcome its directory names.
# Usage: tests/schemas.sh <schemas-dir>   (needs check-jsonschema on PATH)
set -euo pipefail
dir=${1:?schemas dir}
check-jsonschema --check-metaschema "$dir"/*.json
pass=0
fail=0
for schema in "$dir"/*.json; do
  name=$(basename "$schema" .json)
  for arm in valid invalid; do
    shopt -s nullglob
    cases=("$dir/fixtures/$name/$arm"/*.json)
    shopt -u nullglob
    if [ "${#cases[@]}" -eq 0 ]; then
      echo "FAIL $name: no $arm fixtures"
      fail=$((fail + 1))
      continue
    fi
    for f in "${cases[@]}"; do
      rc=0
      out=$(check-jsonschema --schemafile "$schema" "$f" 2>&1) || rc=$?
      # Exit 1 also covers a schema that fails to load (an unresolvable $ref), which would pass
      # every invalid fixture. Only a reported validation error counts as "invalid".
      if [ "$rc" -gt 1 ] || { [ "$rc" -eq 1 ] && ! grep -q '^Schema validation errors' <<<"$out"; }; then
        echo "ERROR $f: check-jsonschema exit $rc"
        echo "$out"
        exit 2
      fi
      if { [ "$arm" = valid ] && [ "$rc" -eq 0 ]; } || { [ "$arm" = invalid ] && [ "$rc" -eq 1 ]; }; then
        pass=$((pass + 1))
      else
        echo "FAIL $f: expected $arm, check-jsonschema exit $rc"
        echo "$out"
        fail=$((fail + 1))
      fi
    done
  done
done
echo "schemas: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && [ "$pass" -gt 0 ]

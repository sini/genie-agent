#!/usr/bin/env bash
# Admit every Nix store bwrap and unshare binary needed by the given CI checks (or by
# `ci --tests-process --userns-binaries` under `--process-plane`) to unprivileged user
# namespaces under Ubuntu's AppArmor restriction, using per-binary unconfined userns profiles.
set -euo pipefail

dry_run=0
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=1
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "::error::usage: .github/admit-userns.sh [--dry-run] (--process-plane | <check-name>...)" >&2
  exit 1
fi

tmpdir="${RUNNER_TEMP:-/tmp}"
bins=()

if [ "$1" = "--process-plane" ]; then
  mapfile -t bins < <(nix develop ./ci --command ci --tests-process --userns-binaries | sort -u)
  if [ "${#bins[@]}" -eq 0 ]; then
    echo "::error::ci --tests-process --userns-binaries returned no unshare store paths" >&2
    exit 1
  fi
else
  refs=()
  for c in "$@"; do
    refs+=("./ci#checks.x86_64-linux.$c")
  done
  mapfile -t drvs < <(nix path-info --derivation "${refs[@]}")
  if [ "${#drvs[@]}" -eq 0 ]; then
    echo "::error::no check derivations resolved for: $*" >&2
    exit 1
  fi

  mapfile -t udrvs < <(nix-store -qR "${drvs[@]}" | grep -E '/nix/store/[^/]+-(bubblewrap|util-linux)-[0-9][^/]*\.drv$' | sort -u)
  closure_outs=()
  if [ "${#udrvs[@]}" -gt 0 ]; then
    mapfile -t closure_outs < <(nix-store -q --outputs "${udrvs[@]}" | grep -E '/nix/store/[^/]+-(bubblewrap-[0-9.]+|util-linux-[0-9.]+-bin)$' | sort -u)
  fi
  if [ "${#closure_outs[@]}" -gt 0 ]; then
    nix-store --realise "${closure_outs[@]}" >/dev/null
  fi

  mapfile -t direct_outs < <(
    nix build --no-link --print-out-paths \
      --inputs-from ./ci nixpkgs#bubblewrap nixpkgs#util-linux.bin \
      --inputs-from . nixpkgs#bubblewrap nixpkgs#util-linux.bin
  )

  raw_bins=()
  for p in "${closure_outs[@]}" "${direct_outs[@]}"; do
    for cand in "$p/bin/bwrap" "$p/bin/unshare"; do
      if [ -x "$cand" ]; then
        raw_bins+=("$(readlink -f "$cand")")
      fi
    done
  done
  mapfile -t bins < <(printf '%s\n' "${raw_bins[@]}" | sort -u)
fi

has_bwrap=0
has_unshare=0
for b in "${bins[@]}"; do
  case "$b" in
    /nix/store/*/bin/bwrap)
      has_bwrap=1
      bin_name="bwrap"
      ;;
    /nix/store/*/bin/unshare)
      has_unshare=1
      bin_name="unshare"
      ;;
    *)
      echo "::error::not a bwrap or unshare store path: '$b'" >&2
      exit 1
      ;;
  esac
  store_entry=$(basename "$(dirname "$(dirname "$b")")")
  h=${store_entry%%-*}
  profile_name="nix-userns-${bin_name}-${h}"
  profile_file="${tmpdir}/${profile_name}.profile"
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile %s %s flags=(unconfined) {\n  userns,\n}\n' \
    "$profile_name" "$b" > "$profile_file"
  if [ "$dry_run" -eq 0 ]; then
    sudo -n apparmor_parser -r "$profile_file"
  fi
  echo "admitted to user namespaces (${profile_name}): $b"
done

if [ "$1" = "--process-plane" ]; then
  if [ "$has_unshare" -ne 1 ]; then
    echo "::error::expected at least one /nix/store/*/bin/unshare for --process-plane" >&2
    exit 1
  fi
else
  if [ "$has_bwrap" -ne 1 ] || [ "$has_unshare" -ne 1 ]; then
    echo "::error::expected both bwrap and unshare store paths (has_bwrap=${has_bwrap}, has_unshare=${has_unshare})" >&2
    exit 1
  fi
fi

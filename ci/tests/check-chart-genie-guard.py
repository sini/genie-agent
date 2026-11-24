#!/usr/bin/env python3
"""Render xmsg's leaf chart with genie-guard values and verify genie-guard + leaf invariants.

usage: check-chart-genie-guard.py <check-chart-leaf.py> <chart-dir> <values.yaml>
"""
import subprocess
import sys

import yaml


def main():
    check_leaf_py, chart, values = sys.argv[1:4]

    # Reuse xmsg's leaf-sidecar assertions verbatim instead of duplicating them.
    subprocess.run([sys.executable, check_leaf_py, chart, values], check=True)

    out = subprocess.run(
        ["helm", "template", "t", chart, "-f", values],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    docs = [d for d in yaml.safe_load_all(out) if d]
    deps = [d for d in docs if d["kind"] == "Deployment"]
    if len(deps) != 1:
        sys.exit(f"FAIL expected one Deployment, got {len(deps)}")
    pod = deps[0]["spec"]["template"]["spec"]
    containers = {c["name"]: c for c in pod["containers"]}
    vols = {v["name"]: v for v in pod.get("volumes", [])}

    failures = []

    def check(name, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail and not ok else ''}")
        if not ok:
            failures.append(name)

    guard = containers.get("genie-guard")
    check("genie-guard container present", guard is not None)
    if guard is not None:
        env = {e["name"]: e for e in guard.get("env", [])}
        ninfer = env.get("GENIE_GUARD_NINFER_URL", {})
        secret_ref = ninfer.get("valueFrom", {}).get("secretKeyRef", {})
        check(
            "GENIE_GUARD_NINFER_URL from secretKeyRef",
            bool(secret_ref.get("name")) and bool(secret_ref.get("key")),
            str(ninfer),
        )
        api_key_file = env.get("GENIE_GUARD_API_KEY_FILE", {}).get("value")
        check(
            "GENIE_GUARD_API_KEY_FILE set to /etc/genie-guard/api-key",
            api_key_file == "/etc/genie-guard/api-key",
            str(api_key_file),
        )

        mounts = {m["name"]: m for m in guard.get("volumeMounts", [])}
        api_mount = mounts.get("api-key")
        api_vol = vols.get("api-key", {}).get("secret")
        check(
            "api-key secret mounted readOnly at /etc/genie-guard with mode 0440",
            api_mount is not None
            and api_mount.get("mountPath") == "/etc/genie-guard"
            and api_mount.get("readOnly") is True
            and api_vol is not None
            and api_vol.get("defaultMode") == 0o440,
            f"mount={api_mount} vol={api_vol}",
        )

        tmp_mount = mounts.get("tmp")
        tmp_vol = vols.get("tmp", {})
        check(
            "tmp emptyDir mounted at /tmp",
            tmp_mount is not None
            and tmp_mount.get("mountPath") == "/tmp"
            and "emptyDir" in tmp_vol,
            f"mount={tmp_mount} vol={tmp_vol}",
        )

        xmsg = containers.get("xmsg", {})
        xmsg_requests = xmsg.get("resources", {}).get("requests")
        check(
            "xmsg carries no resource requests from the overlay",
            not xmsg_requests,
            str(xmsg.get("resources")),
        )
        guard_requests = guard.get("resources", {}).get("requests")
        check(
            "genie-guard carries resource requests",
            guard_requests == {"cpu": "10m", "memory": "32Mi"},
            str(guard.get("resources")),
        )

    if failures:
        sys.exit(f"{len(failures)} genie-guard chart invariant(s) failed: {failures}")
    print("genie-guard chart: all invariants hold")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Oracle check for genie-guard OCI image.

Asserts:
1. User is 65532 (65532 or 65532:65532).
2. Entrypoint is the genie-guard binary (.../bin/genie-guard).
3. Both prompts are present in the binary (guard-in.md and guard-web.md).
4. No /bin/sh in any layer.
"""

import io
import json
import os
import sys
import tarfile

PROMPT_IN_LINE = b"You are guard-in, the inbound filter of genie"
PROMPT_WEB_LINE = b"You are guard-web, the inbound web filter of genie"


def check_image(image_tar_path: str):
    if not os.path.exists(image_tar_path):
        print(f"Error: image tarball not found at {image_tar_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[oracle] Loading image tarball from: {image_tar_path}")
    with tarfile.open(image_tar_path, "r:*") as outer_tar:
        try:
            manifest_member = outer_tar.getmember("manifest.json")
        except KeyError:
            print("Error: manifest.json not found in image tarball", file=sys.stderr)
            sys.exit(1)

        manifest = json.load(outer_tar.extractfile(manifest_member))
        if not manifest:
            print("Error: manifest.json is empty", file=sys.stderr)
            sys.exit(1)

        image_meta = manifest[0]
        config_filename = image_meta.get("Config")
        if not config_filename:
            print("Error: No Config found in manifest.json", file=sys.stderr)
            sys.exit(1)

        config_member = outer_tar.getmember(config_filename)
        config_data = json.load(outer_tar.extractfile(config_member))
        cfg = config_data.get("config", {})

        # Assertion 1: User is 65532
        user = cfg.get("User", "")
        print(f"[oracle] Checking User configuration: {user!r}")
        if user not in ("65532", "65532:65532"):
            print(
                f"[FAIL] Oracle check: User must be 65532 (got: {user!r})",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"[oracle] -> User is 65532: {user}")

        # Assertion 2: Entrypoint is the genie-guard binary
        entrypoint = cfg.get("Entrypoint", [])
        print(f"[oracle] Checking Entrypoint configuration: {entrypoint!r}")
        if (
            not entrypoint
            or not isinstance(entrypoint, list)
            or not entrypoint[0].endswith("/bin/genie-guard")
        ):
            print(
                f"[FAIL] Oracle check: Entrypoint must point to genie-guard binary, got: {entrypoint!r}",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"[oracle] -> Entrypoint is genie-guard binary: {entrypoint[0]}")

        # Assertion 3 & 4: Layers check: no /bin/sh, and both prompts in binary
        layers = image_meta.get("Layers", [])
        print(f"[oracle] Checking {len(layers)} image layer(s)...")
        found_shells = []
        found_binary = False
        binary_has_prompt_in = False
        binary_has_prompt_web = False

        for layer_name in layers:
            layer_member = outer_tar.getmember(layer_name)
            layer_bytes = outer_tar.extractfile(layer_member).read()
            with tarfile.open(fileobj=io.BytesIO(layer_bytes)) as layer_tar:
                for member in layer_tar.getmembers():
                    norm = member.name.lstrip("./")
                    if norm in ("bin/sh", "usr/bin/sh") or norm.endswith("/bin/sh"):
                        found_shells.append((layer_name, member.name))
                    if (norm.endswith("/bin/genie-guard") or norm == "bin/genie-guard") and member.isfile():
                        found_binary = True
                        extracted = layer_tar.extractfile(member)
                        if extracted is not None:
                            binary_bytes = extracted.read()
                            if PROMPT_IN_LINE in binary_bytes:
                                binary_has_prompt_in = True
                            if PROMPT_WEB_LINE in binary_bytes:
                                binary_has_prompt_web = True

        if found_shells:
            print(
                f"[FAIL] Oracle check: Shell (/bin/sh) detected in layers: {found_shells!r}",
                file=sys.stderr,
            )
            sys.exit(1)
        print("[oracle] -> No /bin/sh found in any layer.")

        if not found_binary:
            print(
                "[FAIL] Oracle check: genie-guard binary not found in any layer",
                file=sys.stderr,
            )
            sys.exit(1)
        print("[oracle] -> Found genie-guard binary in layers.")

        print("[oracle] Checking for bundled prompts inside genie-guard binary...")
        if not binary_has_prompt_in:
            print(
                f"[FAIL] Oracle check: guard-in.md prompt line missing from binary: {PROMPT_IN_LINE!r}",
                file=sys.stderr,
            )
            sys.exit(1)
        print("[oracle] -> guard-in.md prompt verified in binary.")

        if not binary_has_prompt_web:
            print(
                f"[FAIL] Oracle check: guard-web.md prompt line missing from binary: {PROMPT_WEB_LINE!r}",
                file=sys.stderr,
            )
            sys.exit(1)
        print("[oracle] -> guard-web.md prompt verified in binary.")

    print(
        "[oracle] ALL ORACLES PASSED: User 65532, genie-guard binary entrypoint, bundled prompts verified, no shell."
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path_to_image_tar>", file=sys.stderr)
        sys.exit(1)
    check_image(sys.argv[1])

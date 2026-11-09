#!/usr/bin/env python3
"""Check the tier-1 OCI archive without running its contents."""

import argparse
import hashlib
import json
import posixpath
import re
import shutil
import tarfile
import tempfile
from contextlib import ExitStack
from pathlib import Path


class OracleError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise OracleError(message)


def canonical_manifest(files):
    rows = sorted((name, hashlib.sha256(body).hexdigest()) for name, body in files.items())
    encoded = json.dumps(rows, ensure_ascii=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest(), len(rows)


def disk_manifest(directory):
    files = {}
    for file in sorted(Path(directory).rglob("*")):
        require(not file.is_symlink(), "expected source contains a symlink")
        if file.is_file():
            files[file.relative_to(directory).as_posix()] = file.read_bytes()
    return canonical_manifest(files)


def normalized(name):
    return posixpath.normpath("/" + name.lstrip("/")).lstrip("/")


class Image:
    def __init__(self, stack, archive):
        source = stack.enter_context(tarfile.open(archive, "r:*"))
        # File-by-file reads of late gzip members otherwise repeatedly decompress earlier layers.
        seekable = stack.enter_context(tempfile.TemporaryFile())
        source.fileobj.seek(0)
        shutil.copyfileobj(source.fileobj, seekable)
        seekable.seek(0)
        self.outer = stack.enter_context(tarfile.open(fileobj=seekable, mode="r:"))
        manifest = json.load(self.outer.extractfile("manifest.json"))
        require(len(manifest) == 1, "expected one image manifest")
        self.config = json.load(self.outer.extractfile(manifest[0]["Config"]))["config"]
        self.files = {}
        for layer_name in manifest[0]["Layers"]:
            layer = stack.enter_context(tarfile.open(fileobj=self.outer.extractfile(layer_name), mode="r:*"))
            for member in layer:
                name = normalized(member.name)
                parent, base = posixpath.split(name)
                if base == ".wh..wh..opq":
                    self.files = {key: value for key, value in self.files.items() if not key.startswith(parent + "/")}
                elif base.startswith(".wh."):
                    removed = posixpath.join(parent, base[4:])
                    self.files = {key: value for key, value in self.files.items() if key != removed and not key.startswith(removed + "/")}
                else:
                    self.files[name] = (layer, member)

    def resolve(self, name):
        name = normalized(name)
        for _ in range(40):
            parts = name.split("/")
            for i in range(1, len(parts) + 1):
                prefix = "/".join(parts[:i])
                entry = self.files.get(prefix)
                if entry and (entry[1].issym() or entry[1].islnk()):
                    member = entry[1]
                    target = member.linkname
                    if member.issym() and not target.startswith("/"):
                        target = posixpath.join(posixpath.dirname(prefix), target)
                    name = normalized(posixpath.join(target, *parts[i:]))
                    break
            else:
                require(name in self.files, "image path missing: /" + name)
                return self.files[name]
        raise OracleError("image symlink loop: /" + name)

    def read(self, name, limit=None):
        layer, member = self.resolve(name)
        require(member.isfile(), "image path is not a regular file: " + name)
        with layer.extractfile(member) as stream:
            return stream.read() if limit is None else stream.read(limit)

    def digest(self, name):
        layer, member = self.resolve(name)
        require(member.isfile(), "image path is not a regular file: " + name)
        with layer.extractfile(member) as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    def executable(self, name):
        _, member = self.resolve(name)
        require(member.isfile() and member.mode & 0o005 == 0o005, "runtime executable unavailable to image user: " + name)

    def manifest(self, prefix):
        prefix = normalized(prefix) + "/"
        files = {}
        for name, (_, member) in self.files.items():
            if name.startswith(prefix):
                require(member.isfile() or member.isdir(), "unexpected link or special file under /" + prefix)
                if member.isfile():
                    files[name[len(prefix):]] = self.read(name)
        return canonical_manifest(files)


def check_image(archive, memory, binary, runtime_path, root_source, ca_bundle):
    with ExitStack() as stack:
        image = Image(stack, archive)
        cfg = image.config
        require(cfg.get("User") in ("65532", "65532:65532"), "root image must run as UID 65532")
        require(cfg.get("Entrypoint") == [binary], "root image entrypoint differs from genie-root SEA")
        image.executable(binary)
        require(image.read(binary, 4) == b"\x7fELF", "root image entrypoint is not an ELF SEA")
        with Path(binary).open("rb") as expected_binary:
            require(image.digest(binary) == hashlib.file_digest(expected_binary, "sha256").hexdigest(), "root image SEA bytes differ")
        env = dict(value.split("=", 1) for value in cfg.get("Env", []))
        require(env.get("PATH") == runtime_path, "root image PATH differs from genieRoot.runtimePath")
        require(env.get("GENIE_REPO_ROOT") == root_source, "root image source environment differs")
        require(env.get("SSL_CERT_FILE") == ca_bundle and env.get("NIX_SSL_CERT_FILE") == ca_bundle, "root image CA environment differs")
        require(image.read(ca_bundle) == Path(ca_bundle).read_bytes(), "root image CA bytes differ")
        require(image.manifest(root_source) == disk_manifest(root_source), "root image source corpus differs")
        for command in ("pi", "nix", "git", "cat"):
            candidates = [directory + "/" + command for directory in runtime_path.split(":")]
            for candidate in candidates:
                try:
                    image.resolve(candidate)
                except OracleError:
                    continue
                image.executable(candidate)
                break
            else:
                raise OracleError("root runtime missing executable: " + command)
        require(not any(name.endswith("/bin/bwrap") for name in image.files), "root image must not ship bwrap")
        require(not any(re.search(r"/bin/python(?:\d+(?:\.\d+)*)?$", name) for name in image.files), "root image must not ship a Python interpreter")
        image.executable("/bin/genie-container-worker")
        for volume in cfg.get("Volumes", {}):
            name = normalized(volume)
            require(name not in ("", "memory") and not name.startswith("memory/"), "root image declares a volume masking /memory")
        require("memory" in image.files and image.files["memory"][1].isdir(), "root image missing /memory directory")
        for name, (_, member) in image.files.items():
            if name == "memory" or name.startswith("memory/"):
                require(member.uid == 0 and member.gid == 0, "/memory must be owned by root")
                require(member.mode & 0o222 == 0, "/memory must have no write bits")
                required = 0o005 if member.isdir() else 0o004
                require(member.mode & required == required, "/memory must be readable by the image user")
        expected = disk_manifest(memory)
        require(expected[1] > 0 and image.manifest("/memory") == expected, "root image operating-memory corpus differs")
        print(f"root-image-oracle: memory_manifest_sha256={expected[0]} files={expected[1]}")
        print("root-image-oracle: UID65532 SEA runtime source CA root-owned-readonly-memory no-memory-volume PASS")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("archive", "memory", "binary", "runtime_path", "root_source", "ca_bundle"):
        parser.add_argument(name)
    args = parser.parse_args()
    try:
        check_image(**vars(args))
    except (OracleError, OSError, tarfile.TarError, KeyError, ValueError) as error:
        parser.exit(1, f"root-image-oracle: FAIL: {error}\n")

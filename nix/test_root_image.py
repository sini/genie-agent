#!/usr/bin/env python3
"""Portable archive fixtures for the root-image oracle; no container runtime."""

import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from check_root_image import OracleError, check_image


class RootImageOracle(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.memory = self.directory / "memory"
        self.source = self.directory / "source"
        self.memory.mkdir()
        self.source.mkdir()
        (self.memory / "MEMORY.md").write_bytes(b"canonical operating memory\n")
        (self.source / "main.ts").write_bytes(b"composition root\n")
        self.ca = self.directory / "ca.crt"
        self.ca.write_bytes(b"fixture CA\n")
        binary = self.directory / "binary" / "bin" / "genie-root"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"\x7fELFfixture")
        self.binary = str(binary)
        self.runtime = "/runtime/bin"
        self.config = {
            "User": "65532:65532", "Entrypoint": [self.binary],
            "Env": [f"PATH={self.runtime}", f"GENIE_REPO_ROOT={self.source}",
                    f"SSL_CERT_FILE={self.ca}", f"NIX_SSL_CERT_FILE={self.ca}"],
        }
        self.members = {
            "memory": (None, 0o555, 0, 0),
            "memory/MEMORY.md": (b"canonical operating memory\n", 0o444, 0, 0),
            str(self.source).lstrip("/") + "/main.ts": (b"composition root\n", 0o444, 0, 0),
            str(self.ca).lstrip("/"): (b"fixture CA\n", 0o444, 0, 0),
        }
        self.members[self.binary.lstrip("/")] = (b"\x7fELFfixture", 0o555, 0, 0)
        for command in ("pi", "bwrap", "nix", "git", "cat"):
            self.members["runtime/bin/" + command] = (b"\x7fELFfixture", 0o555, 0, 0)

    def archive(self):
        layer = io.BytesIO()
        with tarfile.open(fileobj=layer, mode="w") as tar:
            for name, (body, mode, uid, gid) in self.members.items():
                member = tarfile.TarInfo(name)
                member.mode, member.uid, member.gid = mode, uid, gid
                if body is None:
                    member.type = tarfile.DIRTYPE
                else:
                    member.size = len(body)
                tar.addfile(member, io.BytesIO(body) if body is not None else None)
        output = self.directory / "image.tar"
        files = {
            "manifest.json": json.dumps([{"Config":"config.json", "Layers":["layer.tar"]}]).encode(),
            "config.json": json.dumps({"config":self.config}).encode(),
            "layer.tar": layer.getvalue(),
        }
        with tarfile.open(output, "w") as tar:
            for name, body in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
        return output

    def check(self):
        check_image(self.archive(), self.memory, self.binary, self.runtime, str(self.source), str(self.ca))

    def test_complete_image(self):
        self.check()

    def test_missing_or_altered_corpus(self):
        original = self.members["memory/MEMORY.md"]
        del self.members["memory/MEMORY.md"]
        with self.assertRaisesRegex(OracleError, "operating-memory corpus differs"):
            self.check()
        self.members["memory/MEMORY.md"] = (b"altered", *original[1:])
        with self.assertRaisesRegex(OracleError, "operating-memory corpus differs"):
            self.check()

    def test_memory_modes_and_ownership(self):
        body, mode, uid, gid = self.members["memory/MEMORY.md"]
        self.members["memory/MEMORY.md"] = (body, 0o644, uid, gid)
        with self.assertRaisesRegex(OracleError, "no write bits"):
            self.check()
        self.members["memory/MEMORY.md"] = (body, mode, 65532, 65532)
        with self.assertRaisesRegex(OracleError, "owned by root"):
            self.check()

    def test_memory_volume(self):
        for name in ("/memory", "/memory/cache", "/"):
            with self.subTest(volume=name):
                self.config["Volumes"] = {name:{}}
                with self.assertRaisesRegex(OracleError, "volume masking /memory"):
                    self.check()

    def test_runtime_source_and_ca_presence(self):
        for name, expected in [("runtime/bin/bwrap", "runtime missing executable"),
                               (str(self.source).lstrip("/") + "/main.ts", "source corpus differs"),
                               (str(self.ca).lstrip("/"), "image path missing")]:
            original = self.members.pop(name)
            with self.subTest(path=name), self.assertRaisesRegex(OracleError, expected):
                self.check()
            self.members[name] = original

    def test_nonroot_and_sea_configuration(self):
        self.config["User"] = "0:0"
        with self.assertRaisesRegex(OracleError, "UID 65532"):
            self.check()
        self.config["User"] = "65532:65532"
        self.members[self.binary.lstrip("/")] = (b"#!/bin/sh", 0o555, 0, 0)
        with self.assertRaisesRegex(OracleError, "not an ELF SEA"):
            self.check()
        self.members[self.binary.lstrip("/")] = (b"\x7fELFother", 0o555, 0, 0)
        with self.assertRaisesRegex(OracleError, "SEA bytes differ"):
            self.check()


if __name__ == "__main__":
    unittest.main()

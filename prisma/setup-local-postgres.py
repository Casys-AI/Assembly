#!/usr/bin/env python3
"""Pinned, development-only Darwin arm64 PostgreSQL binaries; never starts a DB."""

import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import tarfile
import urllib.request

VERSION = "18.4.0-beta.17"
ARCHIVE_URL = "https://registry.npmjs.org/@embedded-postgres/darwin-arm64/-/darwin-arm64-18.4.0-beta.17.tgz"
INTEGRITY = "sha512-Kg1ZMNFzkVIJs3g4V2UYEc5X005km9rGinxFBH8R1sOU2Rblvz4pt2Uf93Pu8Rk273Ue9HIdrbMPpgUqwjUi0Q=="
BINARY_HASHES = {
    "postgres": "515d8e4c690ecd6ae86074eedd5d6d0ed50df434b3743274085b9692f1e923f9",
    "initdb": "b81069a19bcec5d2dd263f5c9bce2ce0b5075ae0f9b8a5c81b79f34bef503c39",
    "pg_ctl": "2c37317f9f606d9716e493d6765ff14f84d8df9b8c07eaa722431de16446f071",
}


def file_hash(path, algorithm):
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This qualified binary profile supports only Darwin arm64")
    workbench = Path(__file__).resolve().parent.parent
    destination = workbench / ".data/toolchains" / f"postgres-{VERSION}-darwin-arm64"
    if not destination.resolve().is_relative_to(workbench):
        raise SystemExit("Local PostgreSQL toolchain must remain inside the checkout")
    temporary = Path(os.environ.get("TMPDIR", "/missing-tmpdir")).resolve()
    if not temporary.is_dir() or temporary.stat().st_dev != workbench.stat().st_dev:
        raise SystemExit("Set TMPDIR to an existing directory on the checkout's volume")
    package = destination / "package"
    if not destination.exists():
        archive = temporary / f"postgres-{VERSION}-darwin-arm64.tgz"
        if not archive.exists():
            with urllib.request.urlopen(ARCHIVE_URL, timeout=60) as source, archive.open("wb") as target:
                size = 0
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > 75 * 1024 * 1024:
                        raise SystemExit("PostgreSQL package exceeds pinned download limit")
                    target.write(chunk)
        actual = "sha512-" + base64.b64encode(file_hash(archive, "sha512").digest()).decode()
        if actual != INTEGRITY:
            raise SystemExit("PostgreSQL package published integrity mismatch")
        with tarfile.open(archive) as content:
            members = content.getmembers()
            if len(members) > 2000 or sum(member.size for member in members) > 200 * 1024 * 1024:
                raise SystemExit("PostgreSQL archive exceeds qualified bounds")
            selected = []
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not member.name.startswith("package/"):
                    raise SystemExit("Unsafe PostgreSQL archive path")
                if not (member.isfile() or member.isdir()):
                    raise SystemExit("Unexpected PostgreSQL archive entry type")
                if member.name.startswith("package/native/") or member.name == "package/package.json":
                    selected.append(member)
            destination.mkdir(parents=True)
            content.extractall(destination, members=selected, filter="data")
        # Equivalent to the inspected package postinstall, with path containment
        # checks and without executing downloaded JavaScript or any lifecycle script.
        for link in json.loads((package / "native/pg-symlinks.json").read_text()):
            source = (package / link["source"]).resolve()
            target = package / link["target"]
            if not source.is_relative_to(package) or not target.resolve().is_relative_to(package) or not source.is_file():
                raise SystemExit("Unsafe PostgreSQL package symlink")
            target.symlink_to(os.path.relpath(source, target.parent))
    proof = {"package": "@embedded-postgres/darwin-arm64", "version": VERSION,
             "archiveUrl": ARCHIVE_URL, "publishedIntegrity": INTEGRITY,
             "scriptsExecuted": False, "serverStarted": False, "binaries": {}}
    for name, expected in BINARY_HASHES.items():
        binary = package / "native/bin" / name
        if file_hash(binary, "sha256").hexdigest() != expected:
            raise SystemExit("Local PostgreSQL binary hash mismatch")
        result = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=15, check=True)
        proof["binaries"][name] = {"sha256": expected, "version": result.stdout.strip()}
    (destination / "provenance.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(package / "native/bin")


if __name__ == "__main__":
    main()

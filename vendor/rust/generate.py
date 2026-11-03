#!/usr/bin/env python3
"""Reproduire le vendor commun depuis des archives .crate locales vérifiées.

Python 3.11+ est requis. Ce programme ne télécharge rien et lit les caches
indiqués sans les modifier. --verify compare les deux sorties sans les écrire.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tomllib

SAFE_PATH = re.compile(r"^[A-Za-z0-9._/+@()-]+$")
ARCHIVE_NAME = "rust-vendor.tar.gz"
LOCKFILES = {"toolkit": "native/toolkit/Cargo.lock", "semantic-index": "native/semantic-index/Cargo.lock"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def produce(app_directory, cache_roots):
    locks, packages = {}, {}
    for name, relative in LOCKFILES.items():
        raw = (app_directory / relative).read_bytes()
        locks[name] = {"path": relative, "sha256": sha256(raw), "bytes": len(raw)}
        for package in tomllib.loads(raw.decode())["package"]:
            if package.get("source", "").startswith("registry+"):
                key = (package["name"], package["version"])
                checksum = package["checksum"]
                require(packages.get(key, checksum) == checksum, f"Checksums incompatibles : {key}")
                packages[key] = checksum
    candidates = {}
    for root in cache_roots:
        require(root.is_dir(), f"Cache absent : {root}")
        for path in root.rglob("*.crate"):
            require(path.is_file() and not path.is_symlink(), f"Archive non régulière : {path}")
            candidates.setdefault(path.name[:-6], []).append(path)
    metadata, archive_files, directories = [], {}, set()
    for (name, version), checksum in sorted(packages.items()):
        directory = f"{name}-{version}"
        matching = [path for path in sorted(candidates.get(directory, [])) if sha256(path.read_bytes()) == checksum]
        require(matching, f"Archive absente ou altérée : {directory}")
        compressed = matching[0].read_bytes()
        files = {}
        with tarfile.open(fileobj=io.BytesIO(compressed), mode="r:gz") as source:
            for member in source:
                require(member.name.startswith(directory + "/"), f"Racine .crate invalide : {member.name}")
                relative = member.name[len(directory) + 1:]
                require(SAFE_PATH.fullmatch(member.name) and all(part not in {"", ".", ".."} for part in relative.split("/")), f"Chemin .crate refusé : {member.name}")
                if member.isdir():
                    continue
                require(member.isfile() and not member.issym() and not member.islnk(), f"Entrée .crate refusée : {member.name}")
                require(relative not in files and relative != ".cargo-checksum.json", f"Fichier dupliqué ou réservé : {member.name}")
                files[relative] = source.extractfile(member).read()
        require("Cargo.toml" in files, f"Cargo.toml absent : {directory}")
        hashes = {relative: sha256(content) for relative, content in sorted(files.items())}
        metadata.append({"name": name, "version": version, "directory": directory, "checksum": checksum, "crateBytes": len(compressed), "files": hashes})
        files[".cargo-checksum.json"] = json.dumps({"files": hashes, "package": checksum}, sort_keys=True, separators=(",", ":")).encode()
        for relative, content in files.items():
            path = f"{directory}/{relative}"
            archive_files[path] = content
            parts = path.split("/")
            directories.update("/".join(parts[:i]) for i in range(1, len(parts)))
    raw_tar = io.BytesIO()
    with tarfile.open(fileobj=raw_tar, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(directories):
            entry = tarfile.TarInfo(path + "/")
            entry.type, entry.mode = tarfile.DIRTYPE, 0o755
            entry.mtime = entry.uid = entry.gid = 0
            entry.uname = entry.gname = ""
            archive.addfile(entry)
        for path, content in sorted(archive_files.items()):
            entry = tarfile.TarInfo(path)
            entry.size, entry.mode = len(content), 0o644
            entry.mtime = entry.uid = entry.gid = 0
            entry.uname = entry.gname = ""
            archive.addfile(entry, io.BytesIO(content))
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0, compresslevel=9) as stream:
        stream.write(raw_tar.getvalue())
    bundle = compressed.getvalue()
    manifest = {"schema": 1, "archive": ARCHIVE_NAME, "archiveSha256": sha256(bundle), "archiveBytes": len(bundle), "crateCount": len(metadata), "fileCount": len(archive_files), "lockfiles": locks, "crates": metadata}
    return {ARCHIVE_NAME: bundle, "manifest.json": (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", type=Path, action="append", required=True)
    parser.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    outputs = produce(arguments.app_dir, arguments.cache_root)
    for name, data in outputs.items():
        destination = arguments.output_dir / name
        if destination.exists():
            require(destination.is_file() and not destination.is_symlink() and destination.read_bytes() == data, f"Sortie divergente conservée : {destination}")
        else:
            require(not arguments.verify, f"Sortie absente : {destination}")
            arguments.output_dir.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as stream:
                stream.write(data)
        print(f"{name}: {len(data)} octets, SHA-256 {sha256(data)}")


if __name__ == "__main__":
    main()

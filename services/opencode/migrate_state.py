"""Offline, byte-verified transport of the retained native research volume.

Run export only after the old writer has terminated. Transport stdout through
kubectl exec; neither migration pod needs credentials or network access.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tarfile
import tempfile


def inventory(root):
    entries = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            entries[relative] = {"link": os.readlink(path)}
        elif path.is_file():
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            entries[relative] = {"sha256": digest, "size": path.stat().st_size}
        elif not path.is_dir():
            raise ValueError(f"Unsupported file type: {relative}")
    return entries


def sqlite_check(root):
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as stream:
            if stream.read(16) != b"SQLite format 3\x00":
                continue
        # Check a private copy with WAL recovery enabled, without touching the
        # source or changing the bytes whose identity the manifest binds.
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary) / path.name
            shutil.copyfile(path, copied)
            for suffix in ["-wal", "-shm"]:
                companion = Path(str(path) + suffix)
                if companion.exists():
                    shutil.copyfile(companion, Path(str(copied) + suffix))
            with sqlite3.connect(f"{copied.as_uri()}?mode=ro", uri=True) as db:
                if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise ValueError(
                        f"SQLite integrity failed: {path.relative_to(root)}"
                    )


def export_state(root, stream):
    before = inventory(root)
    sqlite_check(root)
    with tempfile.TemporaryDirectory() as temporary:
        manifest = Path(temporary) / "manifest.json"
        manifest.write_text(json.dumps(before, sort_keys=True))
        archive_path = Path(temporary) / "state.tar"
        with tarfile.open(archive_path, mode="w") as archive:
            archive.add(manifest, arcname="manifest.json")
            archive.add(root, arcname="state")
        if inventory(root) != before:
            raise ValueError("Source changed during export; quiesce the old writer")
        with archive_path.open("rb") as archived:
            shutil.copyfileobj(archived, stream)


def restore_state(destination, stream, expected_manifest_sha256):
    if (destination / "state").exists():
        raise ValueError("Refusing to overwrite an existing state directory")
    with tempfile.TemporaryDirectory(prefix=".import-", dir=destination) as temporary:
        staging = Path(temporary)
        # The data filter rejects escaping paths, special files and unsafe links.
        with tarfile.open(fileobj=stream, mode="r|") as archive:
            archive.extractall(staging, filter="data")
        expected = json.loads((staging / "manifest.json").read_text())
        actual = inventory(staging / "state")
        if actual != expected:
            raise ValueError("Restored state differs from the source manifest")
        manifest_sha256 = hashlib.sha256(
            json.dumps(actual, sort_keys=True).encode()
        ).hexdigest()
        if manifest_sha256 != expected_manifest_sha256:
            raise ValueError(
                "Restored manifest does not match the frozen source identity"
            )
        sqlite_check(staging / "state")
        marker = {
            "schemaVersion": "opencode.research-state-migration.v1",
            "manifestSha256": manifest_sha256,
            "files": len(actual),
        }
        (staging / "state" / ".migration-complete.json").write_text(json.dumps(marker))
        os.rename(staging / "state", destination / "state")
        print(json.dumps(marker))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["export", "restore", "verify"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args()
    root = args.directory.resolve()
    if args.operation == "export":
        export_state(root, sys.stdout.buffer)
    elif args.operation == "restore":
        if args.manifest_sha256 is None:
            parser.error(
                "restore requires --manifest-sha256 from the quiesced source inventory"
            )
        restore_state(root, sys.stdin.buffer, args.manifest_sha256)
    else:
        sqlite_check(root)
        print(json.dumps(inventory(root), sort_keys=True))

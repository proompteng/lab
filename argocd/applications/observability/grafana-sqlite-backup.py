"""Verify a restored volume snapshot and make an independent SQLite backup."""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time
from urllib.request import urlopen


IDENTITY_COLUMNS = {
    "user": ("id", "login", "email"),
    "org": ("id", "name"),
    "data_source": ("id", "uid"),
    "dashboard": ("id", "uid"),
}
CORE_TABLES = tuple(IDENTITY_COLUMNS)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(path: Path) -> dict[str, dict[str, int | str]]:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError("SQLite integrity check failed")
        identities = {}
        for table in CORE_TABLES:
            columns = ", ".join(f'"{column}"' for column in IDENTITY_COLUMNS[table])
            rows = db.execute(f'SELECT {columns} FROM "{table}" ORDER BY id').fetchall()
            if not rows:
                raise RuntimeError(f"Expected populated Grafana table: {table}")
            identities[table] = {
                "count": len(rows),
                "identitiesSha256": hashlib.sha256(
                    json.dumps(rows).encode()
                ).hexdigest(),
            }
        return identities


def prepare(
    source: Path, artifact_dir: Path, restore_dir: Path, timeout: float = 120
) -> None:
    os.umask(0o077)
    backup = artifact_dir / "grafana.db"
    receipt = artifact_dir / "backup.json"
    if artifact_dir.exists():
        if not receipt.is_file():
            raise RuntimeError("Incomplete backup exists; preserve it for inspection")
        proof = json.loads(receipt.read_text())
        if digest(backup) != proof["sha256"] or inventory(backup) != proof["tables"]:
            raise RuntimeError("Retained backup no longer matches its receipt")
    else:
        artifact_dir.mkdir(mode=0o700)
        deadline = time.monotonic() + timeout

        def progress(_status: int, _remaining: int, _total: int) -> None:
            if time.monotonic() >= deadline:
                raise TimeoutError("SQLite backup exceeded its deadline")

        # This is a writable snapshot clone, never the production volume.
        # SQLite can recover any captured rollback journal or WAL before backup.
        with closing(
            sqlite3.connect(f"{source.resolve().as_uri()}?mode=rw", uri=True)
        ) as src:
            with closing(sqlite3.connect(backup)) as dst:
                src.backup(dst, pages=128, progress=progress, sleep=0.1)
                dst.execute("PRAGMA journal_mode=DELETE")
        proof = {"sha256": digest(backup), "tables": inventory(backup)}
        receipt.write_text(json.dumps(proof, sort_keys=True) + "\n")
        for path in (backup, receipt):
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    restore_dir.mkdir(mode=0o700, exist_ok=True)
    restored = restore_dir / "grafana.db"
    if restored.exists():
        raise RuntimeError("Refusing to overwrite an existing restore database")
    shutil.copyfile(backup, restored)
    if digest(restored) != proof["sha256"] or inventory(restored) != proof["tables"]:
        raise RuntimeError("Independent restore verification failed")
    for name in ("logs", "plugins", "provisioning", "search"):
        (restore_dir / name).mkdir(mode=0o700, exist_ok=True)
    print(json.dumps({"sqliteBackupAndRestore": "passed", **proof}, sort_keys=True))


def verify_runtime(
    artifact_dir: Path, restore_dir: Path, expected_version: str
) -> None:
    with urlopen("http://127.0.0.1:3000/api/health", timeout=10) as response:
        health = json.load(response)
    if health.get("database") != "ok" or health.get("version") != expected_version:
        raise RuntimeError("Restored Grafana runtime version or database check failed")
    proof = json.loads((artifact_dir / "backup.json").read_text())
    if inventory(restore_dir / "grafana.db") != proof["tables"]:
        raise RuntimeError("Restored Grafana changed the protected entity identities")
    result = {"restoredVersion": expected_version, "database": "ok", **proof}
    (artifact_dir / "runtime-restore.json").write_text(
        json.dumps(result, sort_keys=True) + "\n"
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "verify-runtime"))
    parser.add_argument("--source", type=Path, default=Path("/snapshot/grafana.db"))
    parser.add_argument(
        "--artifacts", type=Path, default=Path("/snapshot/grafana-before-13-2-1")
    )
    parser.add_argument("--restore", type=Path, default=Path("/restore"))
    parser.add_argument("--expected-version", default="12.3.1")
    options = parser.parse_args()
    if options.mode == "prepare":
        prepare(options.source, options.artifacts, options.restore)
    else:
        verify_runtime(options.artifacts, options.restore, options.expected_version)

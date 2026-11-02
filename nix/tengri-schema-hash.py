#!/usr/bin/env python3
import hashlib
import sys
from pathlib import Path


def schema_hash(root: Path) -> str:
    migrations = sorted(
        (root / "services/tengri/migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")
    )
    if not migrations:
        raise ValueError("Tengri runtime migrations are required")
    digest = hashlib.sha256()
    for migration in migrations:
        digest.update(migration.name.encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(migration.read_bytes()).digest())
    return digest.hexdigest()


if __name__ == "__main__":
    print(
        schema_hash(
            Path(sys.argv[1])
            if len(sys.argv) == 2
            else Path(__file__).resolve().parents[1]
        )
    )

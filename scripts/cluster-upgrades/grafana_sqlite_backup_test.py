import importlib.util
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


MODULE = (
    Path(__file__).resolve().parents[2]
    / "argocd/applications/observability/grafana-sqlite-backup.py"
)
SPEC = importlib.util.spec_from_file_location("grafana_sqlite_backup", MODULE)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class SnapshotBackupTests(unittest.TestCase):
    def fixture(self, path):
        db = sqlite3.connect(path)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        for table in backup.CORE_TABLES:
            columns = backup.IDENTITY_COLUMNS[table][1:]
            fields = ", ".join(f'"{column}" TEXT' for column in columns)
            db.execute(
                f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, {fields}, payload TEXT)'
            )
            values = (
                1,
                *(f"original-{column}" for column in columns),
                "retained dashboard Ω",
            )
            placeholders = ", ".join("?" for _ in values)
            db.execute(f'INSERT INTO "{table}" VALUES ({placeholders})', values)
        db.commit()
        return db

    def test_uncheckpointed_wal_survives_independent_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with closing(self.fixture(root / "source.db")) as db:
                db.execute(
                    'INSERT INTO "dashboard" VALUES (2, ?, ?)',
                    ("wal-dashboard", "WAL only"),
                )
                db.commit()
                backup.prepare(root / "source.db", root / "artifacts", root / "restore")
                with closing(sqlite3.connect(root / "restore/grafana.db")) as restored:
                    self.assertEqual(
                        restored.execute(
                            'SELECT payload FROM "dashboard" WHERE id=2'
                        ).fetchone(),
                        ("WAL only",),
                    )
                self.assertFalse((root / "restore/grafana.db-wal").exists())

    def test_retry_reuses_completed_snapshot_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with closing(self.fixture(root / "source.db")):
                backup.prepare(root / "source.db", root / "artifacts", root / "first")
                original = (root / "artifacts/grafana.db").read_bytes()
                backup.prepare(root / "source.db", root / "artifacts", root / "second")
                self.assertEqual((root / "second/grafana.db").read_bytes(), original)
                with self.assertRaisesRegex(RuntimeError, "overwrite"):
                    backup.prepare(
                        root / "source.db", root / "artifacts", root / "second"
                    )

    def test_tampered_receipt_and_partial_backup_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with closing(self.fixture(root / "source.db")):
                backup.prepare(root / "source.db", root / "artifacts", root / "first")
                proof = json.loads((root / "artifacts/backup.json").read_text())
                proof["sha256"] = "0" * 64
                (root / "artifacts/backup.json").write_text(json.dumps(proof))
                with self.assertRaisesRegex(RuntimeError, "no longer matches"):
                    backup.prepare(
                        root / "source.db", root / "artifacts", root / "second"
                    )
                (root / "partial").mkdir()
                with self.assertRaisesRegex(RuntimeError, "Incomplete"):
                    backup.prepare(
                        root / "source.db", root / "partial", root / "second"
                    )

    def test_corrupt_snapshot_cannot_produce_success_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source.db").write_bytes(b"not a database")
            with self.assertRaises(sqlite3.DatabaseError):
                backup.prepare(root / "source.db", root / "artifacts", root / "restore")
            self.assertFalse((root / "artifacts/backup.json").exists())

    def test_changed_stable_identity_blocks_runtime_receipt_with_same_row_id(self):
        for table, column in [
            ("dashboard", "uid"),
            ("data_source", "uid"),
            ("user", "login"),
            ("org", "name"),
        ]:
            with self.subTest(table=table), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with closing(self.fixture(root / "source.db")):
                    backup.prepare(
                        root / "source.db", root / "artifacts", root / "restore"
                    )
                with closing(sqlite3.connect(root / "restore/grafana.db")) as db:
                    db.execute(
                        f'UPDATE "{table}" SET "{column}" = ? WHERE id = 1',
                        ("changed",),
                    )
                    db.commit()
                health = io.BytesIO(b'{"database":"ok","version":"12.3.1"}')
                with patch.object(backup, "urlopen", return_value=health):
                    with self.assertRaisesRegex(
                        RuntimeError, "protected entity identities"
                    ):
                        backup.verify_runtime(
                            root / "artifacts", root / "restore", "12.3.1"
                        )
                self.assertFalse((root / "artifacts/runtime-restore.json").exists())


if __name__ == "__main__":
    unittest.main()

import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

from migrate_state import export_state, inventory, restore_state


class StateMigrationTest(unittest.TestCase):
    def test_preserves_sessions_claims_and_sqlite_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            target = Path(temporary) / "target"
            source.mkdir()
            target.mkdir()
            (source / "studies").mkdir()
            (source / "studies" / "exclusive.claim.json").write_text('{"claimed":true}')
            with sqlite3.connect(source / "sessions.sqlite") as db:
                db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
                db.execute("INSERT INTO sessions VALUES ('ses_retained')")
            archive = io.BytesIO()
            before = inventory(source)
            expected_sha256 = hashlib.sha256(
                json.dumps(before, sort_keys=True).encode()
            ).hexdigest()
            export_state(source, archive)
            archive.seek(0)
            restore_state(target, archive, expected_sha256)
            marker = json.loads(
                (target / "state" / ".migration-complete.json").read_text()
            )
            restored = inventory(target / "state")
            del restored[".migration-complete.json"]
            self.assertEqual(before, restored)
            self.assertEqual(marker["files"], len(before))
            self.assertEqual(inventory(source), before)
            archive.seek(0)
            with self.assertRaisesRegex(ValueError, "overwrite"):
                restore_state(target, archive, expected_sha256)

    def test_rejects_corruption_before_installing_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w") as output:
                for name, data in [
                    ("manifest.json", b'{"claim.json":{"sha256":"wrong","size":7}}'),
                    ("state/claim.json", b"changed"),
                ]:
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    output.addfile(entry, io.BytesIO(data))
            archive.seek(0)
            with self.assertRaisesRegex(ValueError, "differs"):
                restore_state(target, archive, "0" * 64)
            self.assertFalse((target / "state").exists())

    def test_rejects_a_valid_archive_with_the_wrong_frozen_source_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            target = Path(temporary) / "target"
            source.mkdir()
            target.mkdir()
            (source / "claim.json").write_text("original")
            archive = io.BytesIO()
            export_state(source, archive)
            archive.seek(0)
            with self.assertRaisesRegex(ValueError, "frozen source"):
                restore_state(target, archive, "0" * 64)
            self.assertFalse((target / "state").exists())

    def test_preserves_committed_sessions_in_a_retained_wal(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            target = Path(temporary) / "target"
            source.mkdir()
            target.mkdir()
            with sqlite3.connect(source / "sessions.sqlite") as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE sessions (id TEXT)")
                db.execute("INSERT INTO sessions VALUES ('ses_in_wal')")
                db.commit()
                before = inventory(source)
                self.assertIn("sessions.sqlite-wal", before)
                expected_sha256 = hashlib.sha256(
                    json.dumps(before, sort_keys=True).encode()
                ).hexdigest()
                archive = io.BytesIO()
                export_state(source, archive)
                archive.seek(0)
                restore_state(target, archive, expected_sha256)
                self.assertEqual(inventory(source), before)
                with sqlite3.connect(target / "state" / "sessions.sqlite") as restored:
                    self.assertEqual(
                        restored.execute("SELECT id FROM sessions").fetchall(),
                        [("ses_in_wal",)],
                    )

    def test_preserves_safe_relative_symbolic_link_with_target_bytes_and_inventory(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            target = Path(temporary) / "target"
            source.mkdir()
            target.mkdir()
            (source / "studies").mkdir()
            (source / "studies" / "data.txt").write_text("research notes")
            (source / "studies" / "link").symlink_to("../studies/data.txt")
            before = inventory(source)
            self.assertIn("studies/link", before)
            self.assertEqual(before["studies/link"]["link"], "../studies/data.txt")
            expected_sha256 = hashlib.sha256(
                json.dumps(before, sort_keys=True).encode()
            ).hexdigest()
            archive = io.BytesIO()
            export_state(source, archive)
            archive.seek(0)
            restore_state(target, archive, expected_sha256)
            link_path = target / "state" / "studies" / "link"
            self.assertTrue(link_path.is_symlink())
            self.assertEqual(os.readlink(link_path), "../studies/data.txt")
            self.assertEqual(link_path.read_bytes(), b"research notes")
            restored = inventory(target / "state")
            del restored[".migration-complete.json"]
            self.assertEqual(restored, before)
            self.assertEqual(inventory(source), before)

    def test_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w") as output:
                entry = tarfile.TarInfo("../escape")
                entry.size = 1
                output.addfile(entry, io.BytesIO(b"x"))
            archive.seek(0)
            with self.assertRaises(tarfile.FilterError):
                restore_state(Path(temporary), archive, "0" * 64)
            self.assertFalse((Path(temporary) / "state").exists())


if __name__ == "__main__":
    unittest.main()

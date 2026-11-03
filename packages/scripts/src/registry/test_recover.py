import copy
import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import test_cleanup as fixtures

spec = importlib.util.spec_from_file_location(
    "recover", Path(__file__).with_name("recover.py")
)
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CleanupTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        _, self.batch, self.blob, self.tag = self.fixture.quarantine_fixture()
        self.quarantine = self.blob.parent.parent
        self.original = json.loads((self.quarantine / "receipt.json").read_text())
        self.original = {
            "version": 2,
            "blobs": self.original["blobs"],
            "tags": [
                {k: row[k] for k in ["repository", "tag", "value"]}
                for row in self.original["tags"]
            ],
        }
        for row in self.original["blobs"]:
            row["signature"][0] += 1000
        for row in self.original["tags"]:
            row["value"]["signature"][0] += 1000
        (self.quarantine / "receipt.json").write_text(json.dumps(self.original))

    def prepare(self):
        return recover.prepare(self.fixture.store, self.batch, "claim", "volume")

    def apply(self, plan):
        return recover.restore(self.fixture.store, plan, lambda: None)

    def test_restore_then_current_collection_and_purge_reclaims_payload(self):
        plan = self.prepare()
        result = self.apply(plan)
        self.assertEqual(result["restoredBlobs"], 1)
        self.assertEqual(result["restoredTags"], 1)
        self.assertFalse(self.quarantine.exists())
        archive = self.fixture.root / "_gc_quarantine" / (".restored-" + self.batch)
        self.assertEqual(
            json.loads((archive / "receipt.v2.json").read_text()), self.original
        )
        collected = self.fixture.collect(self.fixture.prepare(prune=True))
        purged = recover.cleanup.Store(self.fixture.root / "_gc_quarantine").purge(
            collected["quarantineId"], "claim", "volume"
        )
        self.assertEqual(purged["deletedBlobs"], 1)
        self.assertEqual(purged["deletedTags"], 1)
        self.assertTrue(self.fixture.store.blob(self.fixture.layer).exists())

    def test_prepare_rejects_corrupt_payload_and_changed_tag_link(self):
        raw = self.blob.read_bytes()
        before = self.blob.stat()
        self.blob.write_bytes(b"x" * len(raw))
        os.utime(self.blob, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.assertRaisesRegex(ValueError, "digest"):
            self.prepare()
        self.blob.write_bytes(raw)
        os.utime(self.blob, ns=(before.st_atime_ns, before.st_mtime_ns))
        (self.tag / "current/link").write_text("sha256:" + "0" * 64)
        with self.assertRaisesRegex(ValueError, "tag"):
            self.prepare()

    def test_apply_rejects_changed_file_or_receipt_without_moving_anything(self):
        plan = self.prepare()
        self.blob.touch()
        with self.assertRaisesRegex(ValueError, "changed"):
            self.apply(plan)
        self.assertTrue(self.tag.exists())
        (self.quarantine / "receipt.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "receipt"):
            self.apply(plan)

    def test_existing_destinations_are_preserved_and_conflicts_archived(self):
        row = self.original["blobs"][0]
        target = self.fixture.store.blob(row["digest"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.blob.read_bytes())
        tag = self.original["tags"][0]
        self.fixture.tag(tag["tag"], self.fixture.image, recent=True)
        current = (
            self.fixture.store.repository(tag["repository"])
            / "_manifests/tags"
            / tag["tag"]
        )
        inode = current.stat().st_ino
        blob_inode = target.stat().st_ino
        result = self.apply(self.prepare())
        self.assertEqual(current.stat().st_ino, inode)
        self.assertEqual(target.stat().st_ino, blob_inode)
        self.assertEqual(result["archivedBlobs"], 1)
        self.assertEqual(result["archivedTags"], 1)

    def test_interrupted_hardlink_restore_resumes_without_overwrite(self):
        plan = self.prepare()
        unlink = Path.unlink
        interrupted = False

        def stop(path, *args, **kwargs):
            nonlocal interrupted
            if path.resolve() == self.blob.resolve() and not interrupted:
                interrupted = True
                raise InterruptedError("after linking")
            return unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", stop), self.assertRaises(InterruptedError):
            self.apply(plan)
        self.apply(plan)
        self.assertFalse(self.quarantine.exists())
        self.assertTrue(
            self.fixture.store.blob(self.original["blobs"][0]["digest"]).exists()
        )
        self.apply(plan)

    def test_unsafe_or_wrong_batch_plan_fails_before_restoration(self):
        plan = self.prepare()
        for value in ["../escape", "/escape", "registry-collect-unknown"]:
            bad = copy.deepcopy(plan)
            bad["batch"] = value
            with (
                self.subTest(batch=value),
                self.assertRaises((ValueError, FileNotFoundError)),
            ):
                self.apply(bad)
        with self.assertRaisesRegex(RuntimeError, "writes"):
            recover.restore(
                self.fixture.store,
                plan,
                lambda: (_ for _ in ()).throw(RuntimeError("writes open")),
            )
        self.assertTrue(self.blob.exists())

    def test_new_destination_or_unknown_quarantine_file_stops_before_moves(self):
        plan = self.prepare()
        extra = self.quarantine / "unreceipted"
        extra.write_text("preserve this")
        with self.assertRaisesRegex(ValueError, "Unexpected files"):
            self.apply(plan)
        self.assertTrue(self.blob.exists())
        extra.unlink()
        target = self.fixture.store.blob(self.original["blobs"][0]["digest"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.blob.read_bytes())
        with self.assertRaisesRegex(ValueError, "destination changed"):
            self.apply(plan)
        self.assertTrue(self.blob.exists())
        self.assertTrue(self.tag.exists())

    def test_symlink_and_altered_plan_never_restore_unverified_content(self):
        plan = self.prepare()
        bad = copy.deepcopy(plan)
        bad["blobs"] = []
        with self.assertRaisesRegex(ValueError, "original receipt"):
            self.apply(bad)
        saved = self.blob.with_suffix(".saved")
        self.blob.rename(saved)
        self.blob.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.prepare()

    def test_interrupted_tag_move_resumes_with_restored_blob_intact(self):
        plan = self.prepare()
        rename = Path.rename

        def stop(path, *args, **kwargs):
            if path.resolve() == self.tag.resolve():
                raise InterruptedError("before tag rename")
            return rename(path, *args, **kwargs)

        with patch.object(Path, "rename", stop), self.assertRaises(InterruptedError):
            self.apply(plan)
        self.assertFalse(self.blob.exists())
        self.apply(plan)
        self.assertFalse(self.quarantine.exists())


if __name__ == "__main__":
    unittest.main()

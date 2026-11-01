import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "cleanup", Path(__file__).with_name("cleanup.py")
)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTest(unittest.TestCase):
    def test_cooperative_deadline_reports_unfinished_quarantine(self):
        orphan = self.blob(b"deadline candidate")
        plan = self.prepare()
        with patch.object(cleanup.time, "monotonic", side_effect=[0, 0.5, 2]):
            result = self.collect(plan, seconds=1)
        self.assertEqual(result["quarantinedBlobs"], 0)
        self.assertTrue(result["collectionTimedOut"])
        self.assertTrue(self.store.blob(orphan).exists())

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "registry"
        (self.root / "blobs/sha256").mkdir(parents=True)
        (self.root / "repositories").mkdir()
        self.store = cleanup.Store(self.root, workers=4)
        self.old = time.time() - 10 * 86400
        self.references = ["registry.example/lab/test:latest"]
        self.layer = self.blob(b"retained layer")
        self.image = self.image_manifest(self.layer)
        self.tag("latest", self.image)

    def blob(self, raw):
        digest = "sha256:" + cleanup.hashlib.sha256(raw).hexdigest()
        path = self.store.blob(digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        os.utime(path, (self.old, self.old))
        return digest

    def manifest(self, body, recent=False):
        raw = json.dumps(body, separators=(",", ":")).encode()
        digest = self.blob(raw)
        link = (
            self.store.repository("lab/test")
            / "_manifests/revisions/sha256"
            / cleanup.encoded(digest)
            / "link"
        )
        link.parent.mkdir(parents=True, exist_ok=True)
        link.write_text(digest)
        if not recent:
            os.utime(link, (self.old, self.old))
        return digest

    def descriptor(self, digest, media_type="application/octet-stream"):
        return {
            "mediaType": media_type,
            "digest": digest,
            "size": self.store.blob(digest).stat().st_size,
        }

    def image_manifest(self, layer, recent=False):
        config = self.blob(b'{"architecture":"arm64","os":"linux"}')
        return self.manifest(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": self.descriptor(
                    config, "application/vnd.oci.image.config.v1+json"
                ),
                "layers": [self.descriptor(layer)],
            },
            recent,
        )

    def tag(self, name, digest, recent=False):
        link = (
            self.store.repository("lab/test")
            / "_manifests/tags"
            / name
            / "current/link"
        )
        link.parent.mkdir(parents=True, exist_ok=True)
        link.write_text(digest)
        if not recent:
            os.utime(link, (self.old, self.old))

    def prepare(self, references=None, prune=False):
        return self.store.prepare(references or self.references, prune_tags=prune)

    def collect(self, plan, references=None, **kwargs):
        return self.store.collect(
            plan, references or self.references, lambda: None, **kwargs
        )

    def test_prepare_is_read_only_and_collection_reclaims_only_old_orphans(self):
        orphan = self.blob(b"old orphan" * 100)
        recent = self.blob(b"new in-progress content")
        os.utime(self.store.blob(recent), None)
        plan = self.prepare()
        self.assertTrue(self.store.blob(orphan).exists())
        self.assertEqual([row["digest"] for row in plan["blobs"]], [orphan])
        result = self.collect(plan)
        self.assertEqual(result["quarantinedBytes"], 1000)
        self.assertFalse(self.store.blob(orphan).exists())
        cleanup.Store(self.root / "_gc_quarantine").purge(result["quarantineId"])
        self.assertTrue(self.store.blob(self.layer).exists())
        self.assertTrue(self.store.blob(recent).exists())
        self.assertEqual(self.prepare()["blobs"], [])

    def test_prepare_does_not_restat_retained_layers_after_graph_validation(self):
        orphan = self.blob(b"old orphan")
        retained = self.store.blob(self.layer)
        original_signature = cleanup.signature
        reads = 0

        def read_signature(path):
            nonlocal reads
            if path == retained:
                reads += 1
                if reads > 1:
                    raise OSError("redundant retained-blob metadata read")
            return original_signature(path)

        with patch.object(cleanup, "signature", side_effect=read_signature):
            plan = self.prepare()
        self.assertEqual(reads, 1)
        self.assertEqual([row["digest"] for row in plan["blobs"]], [orphan])

    def test_new_tag_and_fresh_kargo_reference_rescue_prepared_candidates(self):
        layer = self.blob(b"previously orphaned layer")
        image = self.image_manifest(layer)
        plan = self.prepare()
        self.tag("new-publication", image)
        self.assertEqual(self.collect(plan)["quarantinedBlobs"], 0)
        self.assertTrue(self.store.blob(layer).exists())
        self.assertEqual(
            self.collect(
                plan, self.references + ["registry.example/lab/test@" + image]
            )["quarantinedBlobs"],
            0,
        )

    def test_index_preserves_all_platforms_and_attestations(self):
        other_layer = self.blob(b"amd64 layer")
        other = self.image_manifest(other_layer)
        attestation = self.image_manifest(self.blob(b"attestation statement"))
        index = self.manifest(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [
                    self.descriptor(image) for image in [self.image, other, attestation]
                ],
            }
        )
        self.tag("latest", index)
        self.assertEqual(self.prepare()["blobs"], [])

    def test_recent_untagged_manifest_keeps_its_old_layers(self):
        layer = self.blob(b"old shared base")
        self.image_manifest(layer, recent=True)
        self.assertEqual(self.prepare()["blobs"], [])

    def test_deleted_untagged_revision_does_not_block_cleanup(self):
        orphan = self.blob(b"layer from a deleted manifest")
        deleted = self.image_manifest(orphan, recent=True)
        self.store.blob(deleted).unlink()
        plan = self.prepare()
        self.assertEqual([row["digest"] for row in plan["blobs"]], [orphan])
        result = self.collect(plan)
        self.assertEqual(result["quarantinedBlobs"], 1)
        self.assertTrue(self.store.blob(self.image).exists())
        self.assertTrue(self.store.blob(self.layer).exists())

    def test_reuploaded_untagged_manifest_rescues_prepared_layers(self):
        layer = self.blob(b"layer from a reuploaded manifest")
        image = self.image_manifest(layer, recent=True)
        raw = self.store.blob(image).read_bytes()
        self.store.blob(image).unlink()
        plan = self.prepare()
        self.assertEqual([row["digest"] for row in plan["blobs"]], [layer])
        self.blob(raw)
        self.assertEqual(self.collect(plan)["quarantinedBlobs"], 0)
        self.assertTrue(self.store.blob(layer).exists())

    def test_missing_recent_tagged_manifest_still_fails_closed(self):
        deleted = self.image_manifest(self.blob(b"tagged layer"), recent=True)
        self.tag("release", deleted)
        self.store.blob(deleted).unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()

    def test_missing_recent_protected_manifest_still_fails_closed(self):
        deleted = self.image_manifest(self.blob(b"protected layer"), recent=True)
        self.store.blob(deleted).unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare(self.references + ["registry.example/lab/test@" + deleted])

    def test_missing_recent_index_child_still_fails_closed(self):
        deleted = self.image_manifest(self.blob(b"platform layer"), recent=True)
        index = self.manifest(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [self.descriptor(self.image), self.descriptor(deleted)],
            }
        )
        self.tag("latest", index)
        self.store.blob(deleted).unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()

    def test_unreadable_recent_untagged_manifest_is_not_ignored(self):
        image = self.image_manifest(self.blob(b"unreadable layer"), recent=True)
        unreadable = self.store.blob(image)
        original = cleanup.signature

        def read_signature(path):
            if path == unreadable:
                raise PermissionError("Cannot read a recent manifest")
            return original(path)

        with patch.object(cleanup, "signature", side_effect=read_signature):
            with self.assertRaises(PermissionError):
                self.prepare()

    def test_retention_uses_upload_time_keeps_five_unknown_recent_and_protected(self):
        for number in range(8):
            self.tag("sha-" + format(number, "040x") + "-run-123-amd64", self.image)
        self.tag("human-release", self.image)
        self.tag("sha-" + "a" * 40, self.image, recent=True)
        protected = "sha-" + format(0, "040x") + "-run-123-amd64"
        refs = self.references + ["registry.example/lab/test:" + protected]
        plan = self.prepare(refs, prune=True)
        names = {row["tag"] for row in plan["deleteTags"]}
        self.assertEqual(len(names), 3)
        self.assertNotIn(protected, names)
        self.assertNotIn("human-release", names)
        self.assertNotIn("sha-" + "a" * 40, names)
        self.collect(plan, refs)
        tags, _ = self.store.scan_roots(plan["cutoffNs"])
        self.assertEqual(len(tags["lab/test"]), 8)

    def test_retargeted_tag_is_preserved(self):
        for number in range(6):
            self.tag(format(number, "040x"), self.image)
        plan = self.prepare(prune=True)
        candidate = plan["deleteTags"][0]["tag"]
        replacement = self.image_manifest(self.blob(b"replacement"))
        self.tag(candidate, replacement, recent=True)
        result = self.collect(plan)
        self.assertEqual(result["deletedTags"], 0)
        self.assertTrue(self.store.blob(replacement).exists())

    def test_fresh_retention_preserves_five_after_an_external_tag_delete(self):
        for number in range(6):
            self.tag(format(number, "040x"), self.image)
        plan = self.prepare(prune=True)
        candidate = plan["deleteTags"][0]["tag"]
        kept = next(
            format(number, "040x")
            for number in range(6)
            if format(number, "040x") != candidate
        )
        cleanup.shutil.rmtree(
            self.store.repository("lab/test") / "_manifests/tags" / kept
        )
        self.assertEqual(self.collect(plan)["deletedTags"], 0)
        tags, _ = self.store.scan_roots(plan["cutoffNs"])
        self.assertIn(candidate, tags["lab/test"])

    def test_plan_cannot_remove_human_tags_or_weaken_minimum_retention(self):
        self.tag("release", self.image)
        plan = self.prepare()
        tags, _ = self.store.scan_roots(plan["cutoffNs"])
        plan["deleteTags"] = [
            {
                "repository": "lab/test",
                "tag": "release",
                "value": tags["lab/test"]["release"],
            }
        ]
        self.assertEqual(self.collect(plan)["deletedTags"], 0)
        plan["keep"] = 4
        with self.assertRaisesRegex(ValueError, "weakens minimum retention"):
            self.collect(plan)
        plan["keep"] = 5
        plan["cutoffNs"] = time.time_ns()
        with self.assertRaisesRegex(ValueError, "weakens minimum retention"):
            self.collect(plan)

    def test_tags_are_renamed_while_frozen_and_purged_without_touching_republished_tags(
        self,
    ):
        for number in range(6):
            self.tag(format(number, "040x"), self.image)
        plan = self.prepare(prune=True)
        candidate = plan["deleteTags"][0]
        with patch.object(
            cleanup.shutil,
            "rmtree",
            side_effect=AssertionError("No physical deletion while frozen"),
        ):
            result = self.collect(plan)
        self.assertEqual(result["deletedTags"], 1)
        quarantined = self.store.quarantined_tag(
            self.root / "_gc_quarantine" / result["quarantineId"], candidate
        )
        self.assertTrue((quarantined / "current/link").exists())
        self.tag(candidate["tag"], self.image, recent=True)
        purged = cleanup.Store(self.root / "_gc_quarantine").purge(
            result["quarantineId"]
        )
        self.assertEqual(purged["deletedTags"], 1)
        tags, _ = self.store.scan_roots(plan["cutoffNs"])
        self.assertIn(candidate["tag"], tags["lab/test"])

    def test_partial_tag_purge_is_resumable(self):
        for number in range(6):
            self.tag(format(number, "040x"), self.image)
        plan = self.prepare(prune=True)
        result = self.collect(plan)
        quarantined = self.store.quarantined_tag(
            self.root / "_gc_quarantine" / result["quarantineId"], plan["deleteTags"][0]
        )
        (quarantined / "current/link").unlink()
        self.assertEqual(
            cleanup.Store(self.root / "_gc_quarantine").purge(result["quarantineId"])[
                "deletedTags"
            ],
            1,
        )

    def test_changed_candidate_fails_before_any_delete(self):
        orphan = self.blob(b"orphan")
        plan = self.prepare()
        self.store.blob(orphan).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Candidate changed"):
            self.collect(plan)
        self.assertTrue(self.store.blob(orphan).exists())

    def test_modified_cached_manifest_is_rejected_before_quarantine(self):
        orphan = self.blob(b"orphan")
        plan = self.prepare()
        plan["manifests"][self.image]["raw"] = '{"schemaVersion":2}'
        with self.assertRaisesRegex(ValueError, "Manifest digest mismatch"):
            self.collect(plan)
        self.assertTrue(self.store.blob(orphan).exists())

    def test_zero_byte_orphan_and_already_collected_candidate_are_accounted(self):
        orphan = self.blob(b"")
        plan = self.prepare()
        result = self.collect(plan)
        self.assertEqual(result["quarantinedBlobs"], 1)
        self.assertEqual(result["remainingCandidates"], 0)
        purged = cleanup.Store(self.root / "_gc_quarantine").purge(
            result["quarantineId"]
        )
        self.assertEqual(purged["deletedBlobs"], 1)
        self.assertEqual(purged["deletedBytes"], 0)
        self.assertEqual(self.collect(plan)["remainingCandidates"], 0)
        self.assertFalse(self.store.blob(orphan).exists())

    def test_online_purge_cannot_delete_a_reuploaded_live_blob(self):
        raw = b"old unreferenced content"
        orphan = self.blob(raw)
        result = self.collect(self.prepare())
        quarantined = (
            self.root
            / "_gc_quarantine"
            / result["quarantineId"]
            / cleanup.encoded(orphan)[:2]
            / cleanup.encoded(orphan)
        )
        self.assertTrue(quarantined.exists())
        # A new publication can reuse the same digest after uploads have reopened.
        self.blob(raw)
        self.tag("new-live-image", self.image_manifest(orphan), recent=True)
        purged = cleanup.Store(self.root / "_gc_quarantine").purge(
            result["quarantineId"]
        )
        self.assertEqual(purged["deletedBlobs"], 1)
        self.assertEqual(self.store.blob(orphan).read_bytes(), raw)
        self.assertFalse(quarantined.exists())

    def test_quarantine_interruption_receipt_allows_purge_of_only_moved_files(self):
        orphan = self.blob(b"orphan")
        result = self.collect(self.prepare())
        quarantine = self.root / "_gc_quarantine" / result["quarantineId"]
        receipt = json.loads((quarantine / "receipt.json").read_text())
        absent = {"digest": "sha256:" + "a" * 64, "signature": [-1, -1, 1, 1]}
        receipt["blobs"].append(absent)
        (quarantine / "receipt.json").write_text(json.dumps(receipt))
        purged = cleanup.Store(self.root / "_gc_quarantine").purge(
            result["quarantineId"]
        )
        self.assertEqual(purged["deletedBlobs"], 1)
        self.assertFalse(self.store.blob(orphan).exists())

    def test_missing_or_unknown_retained_content_fails_closed(self):
        self.store.blob(self.layer).unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        bad = self.manifest({"schemaVersion": 2, "mediaType": "unknown"})
        self.tag("latest", bad)
        with self.assertRaisesRegex(ValueError, "Unsupported manifest media type"):
            self.prepare()

    def test_wrong_filesystem_and_writable_registry_refuse_collection(self):
        orphan = self.blob(b"orphan")
        plan = self.prepare()
        plan["identity"] = [-1, -1]
        with self.assertRaisesRegex(ValueError, "different registry filesystem"):
            self.collect(plan)
        plan["identity"] = self.store.identity()

        def writable():
            raise RuntimeError("Registry accepts uploads")

        with self.assertRaisesRegex(RuntimeError, "accepts uploads"):
            self.store.collect(plan, self.references, writable)
        self.assertTrue(self.store.blob(orphan).exists())

    def test_timeout_performs_no_deletes_and_batch_limit_prefers_largest(self):
        small = self.blob(b"small")
        large = self.blob(b"large" * 100)
        plan = self.prepare()
        with self.assertRaises(TimeoutError):
            self.collect(plan, seconds=0)
        self.assertTrue(self.store.blob(large).exists())
        result = self.collect(plan, max_blobs=1)
        self.assertEqual(result["quarantinedBlobs"], 1)
        self.assertEqual(result["quarantinedBytes"], 500)
        self.assertFalse(self.store.blob(large).exists())
        self.assertTrue(self.store.blob(small).exists())

    def test_path_traversal_and_symlink_files_fail_closed(self):
        with self.assertRaises(ValueError):
            self.store.repository("../outside")
        with self.assertRaises(ValueError):
            self.store.blob("sha256:../../outside")
        path = self.store.blob(self.layer)
        path.unlink()
        path.symlink_to(__file__)
        with self.assertRaises(ValueError):
            self.prepare()


if __name__ == "__main__":
    unittest.main()

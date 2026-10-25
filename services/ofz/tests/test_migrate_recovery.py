import json
import runpy
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import Mock, patch


migration = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "migrate_recovery.py")
)


def version(identifier, *, latest=False, marker=False):
    return {
        "Key": "backup",
        "VersionId": identifier,
        "LastModified": datetime(2026, 10, 25, tzinfo=UTC),
        "IsLatest": latest,
        "DeleteMarker": marker,
    }


class MigrationTests(unittest.TestCase):
    def test_source_metadata_has_one_case_insensitive_hash_header(self):
        value = migration["copied_metadata"](
            {"Sha256": "old", "Other-Field": "kept"}, "version", "verified"
        )
        self.assertEqual(
            value,
            {"sha256": "verified", "other-field": "kept", "source-version": "version"},
        )

    def test_equal_timestamps_preserve_version_order_and_current_live_state(self):
        source = Mock()
        source.get_paginator.return_value.paginate.return_value = [
            {
                "Versions": [version("new", latest=True), version("old")],
                "DeleteMarkers": [version("deleted", marker=True)],
            }
        ]
        ordered = migration["versions"](source, "bucket")
        self.assertEqual(
            [item["VersionId"] for item in ordered if not item["DeleteMarker"]],
            ["old", "new"],
        )
        self.assertEqual(ordered[-1]["VersionId"], "new")

    def test_missing_destination_marker_cannot_pass_verification(self):
        source = [version("source-marker", latest=True, marker=True)]
        ledger = {
            json.dumps(["backup", "source-marker"]): {
                "version_id": "absent",
                "delete_marker": True,
            }
        }
        with self.assertRaisesRegex(RuntimeError, "missing|differs"):
            migration["verify_inventory"](source, [], ledger)

    def test_wrong_current_version_cannot_pass_verification(self):
        source = [version("source", latest=True)]
        target = [version("copied"), version("wrong", latest=True)]
        ledger = {json.dumps(["backup", "source"]): {"version_id": "copied"}}
        with self.assertRaisesRegex(RuntimeError, "current"):
            migration["verify_inventory"](source, target, ledger)

    def test_source_delete_markers_stop_before_any_copy(self):
        source, target = Mock(), Mock()
        source.get_paginator.return_value.paginate.return_value = [
            {"DeleteMarkers": [version("source-marker", latest=True, marker=True)]}
        ]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "Source delete markers"):
                migration["migrate_bucket"](
                    source, target, "bucket", Path(directory), False
                )
        target.delete_object.assert_not_called()
        target.put_object.assert_not_called()

    def test_provision_sets_cleanup_and_missing_audit_object_permissions(self):
        storage = Mock()
        owner = "ofz-recovery-custodian"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "destination-identities.json").write_text(
                json.dumps({owner: ["fixture", "fixture-secret"]})
            )
            with (
                patch.dict(
                    migration["provision"].__globals__,
                    client=Mock(return_value=storage),
                ),
                patch.dict(
                    migration["provision"].__globals__,
                    admin=Mock(return_value={"keys": []}),
                ),
            ):
                migration["provision"]("http://fixture", {owner: []}, root)
        policies = {
            call.kwargs["Bucket"]: json.loads(call.kwargs["Policy"])
            for call in storage.put_bucket_policy.call_args_list
        }
        self.assertIn("s3:ListBucket", policies["ofz-audit"]["Statement"][0]["Action"])
        lifecycles = {
            call.kwargs["Bucket"]: call.kwargs["LifecycleConfiguration"]["Rules"][0]
            for call in storage.put_bucket_lifecycle_configuration.call_args_list
        }
        self.assertEqual(set(lifecycles), set(migration["BUCKETS"][:2]))
        for rule in lifecycles.values():
            self.assertEqual(rule["Expiration"], {"Days": 40})
            self.assertEqual(
                rule["NoncurrentVersionExpiration"], {"NoncurrentDays": 45}
            )

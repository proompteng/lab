"""Regression checks for recovery ordering in the native PostgreSQL rehearsal."""

import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "upgrade_ready",
    ROOT / "argocd/applications/postgres-upgrade-acceptance/upgrade-ready.py",
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def fixture(name):
    return {
        "metadata": {"name": name, "namespace": gate.NAMESPACE},
        "spec": {
            "imageName": gate.SOURCE_IMAGE,
            "bootstrap": {
                "recovery": {
                    "volumeSnapshots": {
                        "storage": {
                            "name": name + "-snapshot",
                            "kind": "VolumeSnapshot",
                            "apiGroup": "snapshot.storage.k8s.io",
                        }
                    }
                }
            },
        },
        "status": {
            "phase": "Cluster in healthy state",
            "readyInstances": 1,
            "image": gate.SOURCE_IMAGE,
            "pgDataImageInfo": {"image": gate.SOURCE_IMAGE, "majorVersion": 17},
            "systemID": gate.SOURCES[name],
        },
    }


class RecoveryGateTest(unittest.TestCase):
    def test_native_pgdata_image_is_authoritative_without_legacy_image_field(self):
        name = next(iter(gate.SOURCES))
        cluster = fixture(name)
        del cluster["status"]["image"]
        self.assertTrue(gate.ready(name, cluster))

    def test_fresh_recovery_is_refused_before_target_application(self):
        with self.assertRaisesRegex(RuntimeError, "recover-17 first"):
            gate.wait_for_sources(lambda name: None)

    def test_all_four_native_source_identities_must_be_ready(self):
        self.assertEqual(gate.wait_for_sources(fixture), list(gate.SOURCES))

    def test_foreign_snapshot_identity_fails_closed(self):
        name = next(iter(gate.SOURCES))
        cluster = fixture(name)
        cluster["status"]["systemID"] = "foreign"
        with self.assertRaisesRegex(RuntimeError, "source identity changed"):
            gate.ready(name, cluster)

    def test_image_request_does_not_substitute_for_native_data_version(self):
        name = next(iter(gate.SOURCES))
        cluster = fixture(name)
        cluster["spec"]["imageName"] = gate.TARGET_IMAGE
        self.assertFalse(gate.ready(name, cluster))

    def test_completed_target_can_reconcile_again(self):
        name = next(iter(gate.SOURCES))
        cluster = fixture(name)
        cluster["spec"]["imageName"] = gate.TARGET_IMAGE
        cluster["status"].update(
            image=gate.TARGET_IMAGE,
            pgDataImageInfo={"image": gate.TARGET_IMAGE, "majorVersion": 18},
            systemID="new-major-system-id",
        )
        self.assertTrue(gate.ready(name, cluster))

    def test_namespace_and_recovery_destination_are_verified(self):
        name = next(iter(gate.SOURCES))
        for mutation in ["namespace", "snapshot"]:
            cluster = copy.deepcopy(fixture(name))
            if mutation == "namespace":
                cluster["metadata"]["namespace"] = "bilig"
            else:
                cluster["spec"]["bootstrap"]["recovery"]["volumeSnapshots"]["storage"][
                    "name"
                ] = "foreign"
            with self.assertRaises(RuntimeError):
                gate.ready(name, cluster)

    def test_unfinished_restore_times_out_without_allowing_upgrade(self):
        def pending(name):
            cluster = fixture(name)
            cluster["status"]["readyInstances"] = 0
            return cluster

        with self.assertRaisesRegex(RuntimeError, "not ready"):
            gate.wait_for_sources(pending, timeout=0)


if __name__ == "__main__":
    unittest.main()

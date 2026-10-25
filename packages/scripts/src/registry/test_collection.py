import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "collect", Path(__file__).with_name("collect.py")
)
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


class FakeCollection(collect.Collection):
    def __init__(self):
        super().__init__("fixture")
        self.actions = []
        self.copies = {}
        self.fail_delete = False
        self.receipt = None
        self.resources = {
            ("argocd", "application", "registry"): {
                "metadata": {"uid": "app", "resourceVersion": "1", "annotations": {}},
                "spec": {"source": {"path": "argocd/applications/registry"}},
            },
            ("registry", "deployment", "registry"): {
                "metadata": {"uid": "deployment", "generation": 1},
                "spec": {
                    "template": {
                        "spec": {"containers": [{"name": "registry", "env": []}]}
                    }
                },
            },
            ("registry", "pvc", "registry-data"): {
                "metadata": {"uid": "claim"},
                "spec": {"volumeName": "volume"},
                "status": {"phase": "Bound"},
            },
        }

    def get(self, namespace, kind, name):
        return copy.deepcopy(self.resources[namespace, kind, name])

    def command(self, args, timeout=60):
        if "delete" in args:
            self.actions.append("delete-helper")
            if self.fail_delete:
                raise RuntimeError("helper deletion unconfirmed")
        if "get" in args and "pods" in args:
            return json.dumps(
                {
                    "items": [
                        {
                            "metadata": {"name": "registry-pod"},
                            "spec": {
                                "nodeName": "node",
                                "volumes": [
                                    {
                                        "name": "data",
                                        "persistentVolumeClaim": {
                                            "claimName": "registry-data"
                                        },
                                    }
                                ],
                                "containers": [
                                    {
                                        "name": "registry-maintenance",
                                        "volumeMounts": [
                                            {
                                                "name": "data",
                                                "mountPath": "/var/lib/registry",
                                                "readOnly": True,
                                            },
                                            {
                                                "name": "data",
                                                "mountPath": "/quarantine",
                                                "subPath": "docker/registry/v2/_gc_quarantine",
                                            },
                                        ],
                                    }
                                ],
                            },
                            "status": {"containerStatuses": [{"ready": True}]},
                        }
                    ]
                }
            )
        if "cp" in args:
            self.copies[args[4].split("/dev/shm/")[1]] = Path(args[3]).read_bytes()
        if "exec" in args:
            code = args[-1]
            if "/quarantine/" in code:
                self.actions.append("read-receipt")
                return json.dumps(self.receipt)
            name = code.split("/dev/shm/")[1].split("'")[0]
            return hashlib.sha256(self.copies[name]).hexdigest()
        return ""

    def rollout(self, deadline):
        self.actions.append("rollout")

    def patch(self, namespace, kind, name, value, strategy="json"):
        resource = self.resources[namespace, kind, name]
        if kind == "application":
            annotations = resource["metadata"]["annotations"]
            if value[-1]["op"] == "add":
                annotations[collect.HOLD] = "true"
                annotations[collect.OWNER] = self.owner
                self.actions.append("hold")
            else:
                annotations.pop(collect.HOLD)
                annotations.pop(collect.OWNER)
                self.actions.append("release-hold")
        else:
            changes = value["spec"]["template"]["spec"]
            spec = resource["spec"]["template"]["spec"]
            if changes["nodeName"] is None:
                spec.pop("nodeName", None)
                spec["containers"][0]["env"] = []
                self.actions.append("restore-writes")
            else:
                spec["nodeName"] = changes["nodeName"]
                spec["containers"][0]["env"] = [
                    {"name": collect.READONLY, "value": '{"enabled":true}'}
                ]
                self.actions.append("freeze")


class CollectionTest(unittest.TestCase):
    def test_cooperative_collector_deadline_is_preserved_in_the_result(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            plan.write_text('{"pvcUid":"claim","pv":"volume"}')
            refs = Path(directory) / "refs.json"
            refs.write_text('["fixture"]')
            operation = FakeCollection()
            result = {
                "quarantineId": operation.name,
                "collectionTimedOut": True,
                "remainingCandidates": 1,
            }
            with patch.object(
                collect.subprocess,
                "run",
                return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps(result), stderr=""
                ),
            ):
                self.assertEqual(operation.run(plan, refs), result)

    def test_invalid_receipt_does_not_recover_a_timed_out_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            plan.write_text('{"pvcUid":"claim","pv":"volume"}')
            refs = Path(directory) / "refs.json"
            refs.write_text('["fixture"]')
            for receipt in ["corrupt", {}, {"version": 2, "blobs": {}, "tags": []}]:
                operation = FakeCollection()
                operation.receipt = receipt
                with self.subTest(receipt=receipt):
                    with patch.object(
                        collect.subprocess,
                        "run",
                        side_effect=subprocess.TimeoutExpired("remote collector", 240),
                    ):
                        with self.assertRaisesRegex(
                            ValueError, "Invalid quarantine receipt"
                        ):
                            operation.run(plan, refs)
                    self.assertIn("release-hold", operation.actions)

    def test_recovery_failure_keeps_the_collection_timeout_as_its_cause(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            plan.write_text('{"pvcUid":"claim","pv":"volume"}')
            refs = Path(directory) / "refs.json"
            refs.write_text('["fixture"]')
            operation = FakeCollection()
            operation.fail_delete = True
            with patch.object(
                collect.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired("remote collector", 240),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "deletion unconfirmed"
                ) as raised:
                    operation.run(plan, refs)
            self.assertIsInstance(raised.exception.__cause__, subprocess.TimeoutExpired)
            self.assertNotIn("restore-writes", operation.actions)
            self.assertNotIn("read-receipt", operation.actions)

    def test_timeout_with_a_durable_receipt_returns_partial_after_restoring_uploads(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            plan.write_text('{"pvcUid":"claim","pv":"volume"}')
            refs = Path(directory) / "refs.json"
            refs.write_text('["fixture"]')
            operation = FakeCollection()
            operation.receipt = {"version": 2, "blobs": [], "tags": []}
            with patch.object(
                collect.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired("remote collector", 240),
            ):
                result = operation.run(plan, refs)
            self.assertEqual(
                result, {"quarantineId": operation.name, "collectionTimedOut": True}
            )
            self.assertLess(
                operation.actions.index("release-hold"),
                operation.actions.index("read-receipt"),
            )
            self.assertIn(
                "remote collector", plan.with_suffix(".collection.log").read_text()
            )

    def test_restoration_waits_for_a_cold_registry_past_ninety_seconds(self):
        operation = FakeCollection()
        operation.patch(
            "registry",
            "deployment",
            "registry",
            {"spec": {"template": {"spec": {"nodeName": "node", "containers": []}}}},
        )
        operation.patch("argocd", "application", "registry", [{"op": "add"}])
        elapsed = 0
        original_get = operation.get

        def read(namespace, kind, name):
            value = original_get(namespace, kind, name)
            if kind == "deployment":
                value["status"] = {"observedGeneration": 1}
                if elapsed >= 120:
                    value["status"].update(
                        {
                            key: 1
                            for key in [
                                "replicas",
                                "updatedReplicas",
                                "readyReplicas",
                                "availableReplicas",
                            ]
                        }
                    )
            return value

        def advance(seconds):
            nonlocal elapsed
            elapsed += seconds

        with (
            patch.object(operation, "get", side_effect=read),
            patch.object(
                operation,
                "rollout",
                side_effect=lambda deadline: collect.Collection.rollout(
                    operation, deadline
                ),
            ),
            patch.object(collect.time, "monotonic", side_effect=lambda: elapsed),
            patch.object(collect.time, "sleep", side_effect=advance),
        ):
            operation.restore(
                "app", "deployment", "claim", "volume", "node", True, True
            )
        self.assertIn("release-hold", operation.actions)
        self.assertEqual(elapsed, 120)

    def test_remote_timeout_deletes_collector_before_restoring_writes_and_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"
            plan.write_text('{"pvcUid":"claim","pv":"volume"}')
            refs = Path(directory) / "refs.json"
            refs.write_text('["fixture"]')
            operation = FakeCollection()
            with patch.object(
                collect.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired("remote collector", 240),
            ):
                with self.assertRaises(subprocess.TimeoutExpired):
                    operation.run(plan, refs)
            actions = operation.actions
            self.assertLess(
                actions.index("delete-helper"), actions.index("restore-writes")
            )
            self.assertLess(
                actions.index("restore-writes"), actions.index("release-hold")
            )
            self.assertNotIn(
                collect.OWNER,
                operation.get("argocd", "application", "registry")["metadata"][
                    "annotations"
                ],
            )

    def test_unconfirmed_helper_deletion_keeps_writes_disabled_and_hold(self):
        operation = FakeCollection()
        operation.fail_delete = True
        operation.patch(
            "registry",
            "deployment",
            "registry",
            {"spec": {"template": {"spec": {"nodeName": "node", "containers": []}}}},
        )
        operation.patch("argocd", "application", "registry", [{"op": "add"}])
        with self.assertRaisesRegex(RuntimeError, "unconfirmed"):
            operation.restore(
                "app", "deployment", "claim", "volume", "node", True, True
            )
        self.assertNotIn("restore-writes", operation.actions)
        self.assertNotIn("release-hold", operation.actions)


if __name__ == "__main__":
    unittest.main()

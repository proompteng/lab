import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import prepare
import purge


class FakeClient:
    def __init__(self):
        self.kubectl = ["kubectl", "--context", "fixture"]
        self.actions = []
        self.pod = {
            "metadata": {"name": "registry-fixture", "uid": "pod"},
            "spec": {
                "volumes": [
                    {
                        "name": "data",
                        "persistentVolumeClaim": {"claimName": "registry-data"},
                    }
                ],
                "containers": [
                    {
                        "name": prepare.CONTAINER,
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
        self.env = []

    def get(self, namespace, kind, name):
        self.actions.append(("get", kind))
        if kind == "pvc":
            return {
                "metadata": {"uid": "claim"},
                "spec": {"volumeName": "volume"},
                "status": {"phase": "Bound"},
            }
        return {"spec": {"template": {"spec": {"containers": [{"env": self.env}]}}}}

    def command(self, args, timeout=60):
        self.actions.append(args)
        if "get" in args:
            return json.dumps({"items": [copy.deepcopy(self.pod)]})
        return ""


class MaintenanceTest(unittest.TestCase):
    def test_purge_reads_its_summary_from_stdout_despite_late_stderr_events(self):
        client = FakeClient()
        summary = {"deletedTags": 2, "deletedBlobs": 3, "deletedBytes": 100}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "purge.log"

            def execute(args, **kwargs):
                if kwargs["stdout"] != subprocess.PIPE:
                    kwargs["stdout"].write(json.dumps(summary) + "\n")
                kwargs["stderr"].write('{"event":"purged","bytes":20}\n')
                return SimpleNamespace(returncode=0, stdout=json.dumps(summary) + "\n")

            with (
                patch.object(purge, "Collection", return_value=client),
                patch.object(purge, "copy_verified"),
                patch.object(purge.subprocess, "run", side_effect=execute),
            ):
                self.assertEqual(purge.run("fixture", "batch", output), summary)

    def test_prepare_failure_reports_exit_status_and_remote_diagnostics(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "plan.json"

            def execute(args, **kwargs):
                kwargs["stderr"].write(
                    "metadata scan stalled\ncommand terminated with exit code 142\n"
                )
                return SimpleNamespace(returncode=142)

            with (
                patch.object(prepare, "Collection", return_value=client),
                patch.object(
                    prepare,
                    "references",
                    return_value=["registry.example/lab/test:latest"],
                ),
                patch.object(prepare, "copy_verified"),
                patch.object(prepare.subprocess, "run", side_effect=execute),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "exit 142.*metadata scan stalled"
                ):
                    prepare.run("fixture", plan, Path(directory) / "references.json")
            self.assertTrue(any("rm" in a for a in client.actions))
            self.assertFalse(any("patch" in a or "delete" in a for a in client.actions))

    def test_online_purge_uses_existing_pod_and_only_the_quarantine_root(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "purge.log"

            def execute(args, **kwargs):
                self.assertIn(prepare.CONTAINER, args)
                self.assertEqual(args[args.index("--root") + 1], "/quarantine")
                self.assertIn(
                    "fcntl.LOCK_EX|fcntl.LOCK_NB",
                    args[args.index("-c", args.index("--")) + 1],
                )
                self.assertEqual(kwargs["stdout"], subprocess.PIPE)
                return SimpleNamespace(
                    returncode=0, stdout='{"deletedBlobs":1,"deletedBytes":100}\n'
                )

            with (
                patch.object(purge, "Collection", return_value=client),
                patch.object(purge, "copy_verified"),
                patch.object(purge.subprocess, "run", side_effect=execute),
            ):
                self.assertEqual(
                    purge.run("fixture", "batch", output)["deletedBytes"], 100
                )
            self.assertFalse(
                any(
                    "create" in a or "patch" in a or "delete" in a
                    for a in client.actions
                )
            )
            self.assertTrue(any("rm" in a for a in client.actions))

    def test_online_mount_rejects_a_writable_cas_or_wrong_claim(self):
        client = FakeClient()
        client.pod["spec"]["containers"][0]["volumeMounts"][0]["readOnly"] = False
        with self.assertRaisesRegex(RuntimeError, "read-only maintenance"):
            prepare.maintenance_pod(client)
        client.pod["spec"]["containers"][0]["volumeMounts"][0]["readOnly"] = True
        client.pod["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"] = "other"
        with self.assertRaisesRegex(RuntimeError, "read-only maintenance"):
            prepare.maintenance_pod(client)

    def test_purge_rejects_frozen_registry_and_preserves_failed_receipt(self):
        client = FakeClient()
        client.env = [{"name": "REGISTRY_STORAGE_MAINTENANCE_READONLY", "value": "{}"}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "purge.log"
            with patch.object(purge, "Collection", return_value=client):
                with self.assertRaisesRegex(RuntimeError, "Restore uploads"):
                    purge.run("fixture", "batch", output)
            client.env = []

            def execute(args, **kwargs):
                kwargs["stderr"].write(
                    "Pod was replaced; retained receipt is resumable\n"
                )
                return SimpleNamespace(returncode=137, stdout="")

            with (
                patch.object(purge, "Collection", return_value=client),
                patch.object(purge, "copy_verified"),
                patch.object(purge.subprocess, "run", side_effect=execute),
            ):
                with self.assertRaisesRegex(RuntimeError, "retry its receipt"):
                    purge.run("fixture", "batch", output)
            self.assertIn("Pod was replaced", output.read_text())
            self.assertFalse(any("delete" in a for a in client.actions))

    def test_purge_timeout_cleans_its_script_without_touching_the_pod_or_claim(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(purge, "Collection", return_value=client),
                patch.object(purge, "copy_verified"),
                patch.object(
                    purge.subprocess,
                    "run",
                    side_effect=subprocess.TimeoutExpired("purge", 3660),
                ),
            ):
                with self.assertRaises(subprocess.TimeoutExpired):
                    purge.run("fixture", "batch", Path(directory) / "purge.log")
            self.assertTrue(any("rm" in a for a in client.actions))
            self.assertFalse(any("delete" in a or "patch" in a for a in client.actions))


if __name__ == "__main__":
    unittest.main()

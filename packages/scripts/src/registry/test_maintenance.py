import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import maintenance
import run as controller


class RegistryReadinessTest(unittest.TestCase):
    def test_waits_for_the_jobs_script_cohort(self):
        job = {
            "spec": {
                "volumes": [{"name": "scripts", "configMap": {"name": "scripts-new"}}]
            }
        }
        pod = {
            "metadata": {"name": "registry-pod", "uid": "pod"},
            "spec": {
                "containers": [{}],
                "volumes": [
                    {"name": "cleanup-scripts", "configMap": {"name": "scripts-new"}}
                ],
            },
            "status": {"containerStatuses": [{"ready": True}]},
        }
        old = json.loads(json.dumps(pod).replace("scripts-new", "scripts-old"))
        replies = [job, {"items": [old]}, {"items": [pod]}]
        with (
            patch.dict(controller.os.environ, {"POD_NAME": "cleanup-job"}),
            patch.object(
                controller.subprocess,
                "check_output",
                side_effect=[json.dumps(value) for value in replies],
            ) as api,
            patch.object(controller.time, "sleep"),
        ):
            self.assertEqual(controller.ready_pod("fixture"), pod)
        self.assertEqual(api.call_count, 3)

    def test_identity_errors_are_not_retried(self):
        with (
            patch.dict(controller.os.environ, {}, clear=True),
            patch.object(
                controller.subprocess,
                "check_output",
                side_effect=subprocess.CalledProcessError(1, ["kubectl"]),
            ) as api,
            self.assertRaises(subprocess.CalledProcessError),
        ):
            controller.ready_pod("fixture")
        self.assertEqual(api.call_count, 1)


class WorkerStopTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve() / "registry"
        self.root.mkdir()
        self.control = Path(self.directory.name).resolve() / "control"
        self.control.mkdir()
        self.run_id = "a" * 32
        (self.control / "worker.json").write_text(
            json.dumps({"run": self.run_id, "pid": 123, "start": "456", "boot": "boot"})
        )
        self.addCleanup(patch.stopall)
        patch.object(maintenance, "ROOT", self.root).start()
        patch.object(maintenance, "CONTROL", self.control).start()
        self.gate = patch.object(maintenance, "WriteGate").start().return_value
        self.kill = patch.object(maintenance.os, "kill").start()
        self.start = patch.object(
            maintenance, "process_start", return_value="456"
        ).start()
        self.boot = patch.object(maintenance, "boot_id", return_value="boot").start()

    def test_refuses_to_stop_a_different_cleanup_run(self):
        with self.assertRaisesRegex(RuntimeError, "Another cleanup run"):
            maintenance.stop("b" * 32)
        self.kill.assert_not_called()
        self.gate.open.assert_not_called()

    def test_reused_pid_is_not_signaled(self):
        self.start.return_value = "789"
        maintenance.stop(self.run_id)
        self.kill.assert_not_called()
        self.gate.open.assert_called_once()

    def test_rebooted_process_is_not_signaled(self):
        self.boot.return_value = "new-boot"
        maintenance.stop(self.run_id)
        self.kill.assert_not_called()
        self.gate.open.assert_called_once()

    def test_matching_process_is_stopped_before_opening_uploads(self):
        maintenance.stop(self.run_id)
        self.kill.assert_called_once_with(123, signal.SIGTERM)
        self.gate.open.assert_called_once()

    def test_unconfirmed_worker_exit_keeps_uploads_fenced(self):
        with (
            maintenance.locked(self.root),
            patch.object(maintenance.time, "monotonic", side_effect=[0, 31]),
        ):
            with self.assertRaisesRegex(TimeoutError, "worker has not stopped"):
                maintenance.stop(self.run_id)
        self.gate.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()

import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "health", pathlib.Path(__file__).resolve().parents[1] / "health.py"
)
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HealthTests(unittest.TestCase):
    def test_unfinished_setup_is_not_ready(self):
        with (
            patch.object(health.pathlib.Path, "is_file", return_value=False),
            patch.object(health.subprocess, "run") as run,
        ):
            self.assertFalse(health.ready())
            run.assert_not_called()

    def test_both_services_must_be_active(self):
        for output in ("active\nfailed\n", "inactive\nactive\n", "active\n", ""):
            with (
                self.subTest(output=output),
                patch.object(health.pathlib.Path, "is_file", return_value=True),
                patch.object(
                    health.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 0, output),
                ),
            ):
                self.assertFalse(health.ready())

    def test_finished_setup_and_active_services_are_ready(self):
        with (
            patch.object(health.pathlib.Path, "is_file", return_value=True),
            patch.object(
                health.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, "active\nactive\n"),
            ),
        ):
            self.assertTrue(health.ready())

    def test_service_query_failure_is_not_ready(self):
        for error in (
            OSError("missing systemctl"),
            subprocess.TimeoutExpired("systemctl", 3),
        ):
            with (
                self.subTest(error=error),
                patch.object(health.pathlib.Path, "is_file", return_value=True),
                patch.object(health.subprocess, "run", side_effect=error),
            ):
                self.assertFalse(health.ready())


if __name__ == "__main__":
    unittest.main()

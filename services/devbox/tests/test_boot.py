import os
import pathlib
import subprocess
import tempfile
import unittest


class BootBoundaryTests(unittest.TestCase):
    def test_missing_persistent_mount_fails_before_writing_state(self):
        boot = pathlib.Path(__file__).resolve().parents[1] / "boot.sh"
        with tempfile.TemporaryDirectory() as directory:
            binaries = pathlib.Path(directory)
            marker = binaries / "state-written"
            for name, command in {
                "mountpoint": "exit 1",
                "install": f"touch '{marker}'; exit 99",
            }.items():
                executable = binaries / name
                executable.write_text("#!/bin/sh\n" + command + "\n")
                executable.chmod(0o755)
            result = subprocess.run(
                ["bash", str(boot)],
                env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Persistent block filesystem is not mounted", result.stderr)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()

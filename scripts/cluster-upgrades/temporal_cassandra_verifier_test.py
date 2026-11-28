"""Verify the cross-version native verifier invocation and failure contract."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(
    "argocd/applications/temporal/upgrade/verify-cassandra-sstables.sh"
).resolve()


class NativeVerifierTests(unittest.TestCase):
    def run_verify(self, version, failure=False):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "nodetool"
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\nexit "$VERIFY_STATUS"\n')
            fake.chmod(0o755)
            return subprocess.run(
                ["/bin/bash", str(SCRIPT), version],
                env={
                    **os.environ,
                    "PATH": directory + os.pathsep + os.environ["PATH"],
                    "VERIFY_STATUS": "42" if failure else "0",
                },
                text=True,
                capture_output=True,
            )

    def test_old_and_new_native_cli_require_different_explicit_verification_flags(self):
        for version, expected in [
            ("3.11.19", ["verify", "--extended-verify", "temporal"]),
            ("4.1.12", ["verify", "--force", "--extended-verify", "temporal"]),
            ("5.0.9", ["verify", "--force", "--extended-verify", "temporal"]),
        ]:
            with self.subTest(version=version):
                result = self.run_verify(version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), expected)

    def test_native_errors_are_not_accepted_as_success(self):
        for version in ["3.11.19", "4.1.12", "5.0.9"]:
            with self.subTest(version=version):
                self.assertEqual(self.run_verify(version, True).returncode, 42)

    def test_unknown_version_does_not_invoke_native_verification(self):
        result = self.run_verify("6.0.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()

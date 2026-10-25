import hashlib
import os
import pathlib
import re
import subprocess
import tempfile
import unittest


class CodexInstallTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="devbox-codex-install-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls"
        self.payload = b"#!/bin/sh\nexit 0\n"
        self.fixture = self.root / "installer"
        self.fixture.write_bytes(self.payload)
        dockerfile = pathlib.Path(__file__).resolve().parents[1] / "Dockerfile"
        self.source = dockerfile.read_text()
        self.command = re.search(
            r"ARG CODEX_VERSION=[^\n]+\n(?:ARG [^\n]+\n)*RUN (.*?)\nCOPY ",
            self.source,
            re.S,
        ).group(1)
        # Execute the actual Docker RUN chain without touching the global /tmp path.
        self.command = self.command.replace("/tmp/codex-install.sh", str(self.root / "download"))
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "CODEX_VERSION": "0.162.1",
            "CODEX_INSTALLER_SHA256": hashlib.sha256(self.payload).hexdigest(),
            "FIXTURE": str(self.fixture),
            "CALL_LOG": str(self.log),
            "DOWNLOAD_EXIT": "0",
        }
        self.tool(
            "curl",
            'printf "curl %s\\n" "$*" >> "$CALL_LOG"\n'
            'test "$DOWNLOAD_EXIT" = 0 || exit "$DOWNLOAD_EXIT"\n'
            'while test "$#" -gt 0; do\n'
            '  if test "$1" = -o; then cp "$FIXTURE" "$2"; exit; fi\n'
            '  shift\n'
            'done\nexit 2\n',
        )
        self.tool("runuser", 'printf "runuser %s\\n" "$*" >> "$CALL_LOG"\n')

    def tool(self, name, source):
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + source)
        path.chmod(0o755)

    def run_install(self):
        return subprocess.run(
            ["bash", "-euo", "pipefail", "-c", self.command],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_uses_the_versioned_official_installer_and_preserves_user_and_release(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn(
            "https://github.com/openai/codex/releases/download/rust-v0.162.1/install.sh",
            calls,
        )
        self.assertIn("runuser -u codex -- env CODEX_NON_INTERACTIVE=1 sh ", calls)
        self.assertIn("--release 0.162.1", calls)
        self.assertFalse((self.root / "download").exists())

    def test_tampered_installer_is_not_executed(self):
        self.fixture.write_bytes(self.payload + b"# unexpected bytes\n")
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("runuser", self.log.read_text())

    def test_download_failure_is_not_executed(self):
        self.env["DOWNLOAD_EXIT"] = "22"
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("runuser", self.log.read_text())

    def test_version_and_installer_digest_are_pinned_together(self):
        self.assertIn("ARG CODEX_VERSION=0.162.1\n", self.source)
        self.assertIn(
            "ARG CODEX_INSTALLER_SHA256="
            "150e3cf675682efeaac115aa3747add3f27887896d04ce6d0b56478d8b428bf6\n",
            self.source,
        )


if __name__ == "__main__":
    unittest.main()

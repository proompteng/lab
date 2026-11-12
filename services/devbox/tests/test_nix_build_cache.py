import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest


class NixBuildCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="devbox-nix-cache-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.component = pathlib.Path(__file__).resolve().parents[1]
        self.source = (self.component / "Dockerfile").read_text()
        self.commands = re.findall(
            r"RUN --mount=type=secret,id=nix-config,required=true \\\n(.*?)(?=\n(?:ENV|ARG|COPY) )",
            self.source,
            re.S,
        )
        self.assertEqual(len(self.commands), 2)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.config = self.root / "nix-config"
        self.config.write_text(
            "substituters = http://attic.attic.svc.cluster.local/lab https://cache.nixos.org/\n"
            "extra-trusted-public-keys = lab:test-public-key\nrequire-sigs = true\n"
        )
        self.calls = self.root / "calls.jsonl"
        self.tool(
            "nix",
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "with open(os.environ['CALLS'], 'a') as log:\n"
            " json.dump({'args':sys.argv[1:],'config':os.environ.get('NIX_CONFIG')},log)\n"
            " log.write('\\n')\n"
            "if sys.argv[1:] == ['show-config']:\n"
            " print(os.environ.get('NIX_CONFIG', ''))\n"
            "else: print(os.environ['TOOLCHAIN'])\n",
        )
        for name in ["devbox-install-deps", "bunx", "nix-store"]:
            self.tool(name, "#!/bin/sh\nexit 0\n")
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "CALLS": str(self.calls),
            "TOOLCHAIN": str(self.root / "toolchain"),
        }
        self.env.pop("NIX_CONFIG", None)

    def tool(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)

    def run_step(self, command):
        command = command.replace("/run/secrets/nix-config", str(self.config))
        command = command.replace("/etc/nix", str(self.root / "etc/nix"))
        command = command.replace("/opt/devbox", str(self.root / "devbox"))
        command = command.replace(
            "rm -rf /root/.bun/install/cache /root/.npm /var/lib/apt/lists/*", "true"
        )
        return subprocess.run(
            ["bash", "-euo", "pipefail", "-c", command],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_both_real_build_steps_pass_the_mounted_config_to_nix(self):
        for command in self.commands:
            result = self.run_step(command)
            self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertTrue(any(call["args"][0] == "build" for call in calls))
        self.assertTrue(any(call["args"][0] == "develop" for call in calls))
        for call in calls:
            self.assertEqual(call["config"], self.config.read_text().rstrip("\n"))
        runtime_config = (self.root / "etc/nix/nix.conf").read_text()
        self.assertNotIn("attic", runtime_config)
        self.assertNotIn("test-public-key", runtime_config)

    def test_missing_mount_fails_before_nix_for_both_steps(self):
        self.config.unlink()
        for command in self.commands:
            result = self.run_step(command)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_workflow_supplies_the_existing_key_and_both_signed_caches(self):
        workflow = (
            self.component.parents[1] / ".github/workflows/codex-devbox.yml"
        ).read_text()
        self.assertIn("ATTIC_PUBLIC_KEY: ${{ vars.ATTIC_PUBLIC_KEY }}", workflow)
        self.assertIn('test -n "${ATTIC_PUBLIC_KEY}"', workflow)
        self.assertIn(self.config.read_text().splitlines()[0], workflow)
        self.assertIn("extra-trusted-public-keys = ${ATTIC_PUBLIC_KEY}", workflow)
        self.assertIn("'require-sigs = true'", workflow)
        self.assertIn(
            "secret-files: nix-config=${{ runner.temp }}/devbox-nix.conf", workflow
        )


if __name__ == "__main__":
    unittest.main()

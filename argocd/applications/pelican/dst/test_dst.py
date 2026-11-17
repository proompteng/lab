"""Local launcher/config regression tests; real game startup is verified separately."""

import configparser
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parent


class DstTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.cluster = self.root / "DoNotStarveTogether/config/server"
        self.cluster.mkdir(parents=True)
        binary = self.root / "bin64/dontstarve_dedicated_server_nullrenderer_x64"
        binary.parent.mkdir()
        binary.write_text(
            "#!/usr/bin/env bash\nset -eu\n"
            'shard=${!#}\nprintf "started %s\\n" "$shard"\n'
            'if [[ ${FAIL_SHARD:-} == "$shard" ]]; then exit 42; fi\n'
            "while IFS= read -r line; do\n"
            '  if [[ $line == "c_shutdown()" ]]; then\n'
            '    printf "saved %s\\n" "$shard"; exit 0\n'
            "  fi\n"
            "done\n"
        )
        binary.chmod(0o755)

    def run_server(self, *, offline=False, fail_shard="", commands=""):
        (self.cluster / "cluster.ini").write_text(
            f"[NETWORK]\noffline_cluster = {str(offline).lower()}\n"
        )
        return subprocess.run(
            ["bash", str(SOURCE / "start.sh")],
            check=False,
            cwd=self.root,
            env={**os.environ, "FAIL_SHARD": fail_shard},
            input=commands,
            text=True,
            capture_output=True,
            timeout=8,
        )

    def test_online_requires_token_before_either_shard_starts(self):
        result = self.run_server()
        self.assertEqual(result.returncode, 64)
        self.assertIn("Klei token required", result.stderr)
        self.assertNotIn("started", result.stdout)

    def test_normal_console_stop_saves_both_shards(self):
        result = self.run_server(offline=True, commands="c_shutdown()\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("saved Master", result.stdout)
        self.assertIn("saved Caves", result.stdout)

    def test_failed_caves_stops_and_saves_master(self):
        result = self.run_server(offline=True, fail_shard="Caves")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertIn("saved Master", result.stdout)

    def test_failed_master_stops_and_saves_caves(self):
        result = self.run_server(offline=True, fail_shard="Master")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertIn("saved Caves", result.stdout)

    def test_online_token_is_not_logged(self):
        token = "test-token-never-log-this"
        (self.cluster / "cluster_token.txt").write_text(token)
        result = self.run_server(commands="c_shutdown()\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_install_preserves_world_configuration(self):
        config_script = (
            (SOURCE / "install.sh")
            .read_text()
            .split('cluster="$HOME/DoNotStarveTogether/config/server"', 1)[1]
        )
        command = (
            'set -Eeuo pipefail\numask 077\ncluster="$HOME/DoNotStarveTogether/config/server"'
            + config_script
        )
        for _ in range(2):
            subprocess.run(
                ["bash", "-c", command],
                env={**os.environ, "HOME": str(self.root)},
                check=True,
                capture_output=True,
                timeout=5,
            )
            config = configparser.ConfigParser(interpolation=None)
            config.read(self.cluster / "cluster.ini")
            self.assertEqual(config["NETWORK"]["offline_cluster"], "false")
            self.assertEqual(config["GAMEPLAY"]["max_players"], "2")
            self.assertRegex(config["NETWORK"]["cluster_password"], r"^[a-f0-9]{32}$")
            if _ == 0:
                initial = (self.cluster / "cluster.ini").read_bytes()
                (self.cluster / "cluster_token.txt").write_text(
                    "preserve-existing-token"
                )
            else:
                self.assertEqual((self.cluster / "cluster.ini").read_bytes(), initial)
                self.assertEqual(
                    (self.cluster / "cluster_token.txt").read_text(),
                    "preserve-existing-token",
                )


if __name__ == "__main__":
    unittest.main()

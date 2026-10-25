import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class GitCacheRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifests = json.loads(
            Path(os.environ["FEATURE_FLAGS_RENDERED_MANIFEST"]).read_text()
        )
        deployment = next(
            item
            for item in manifests
            if item.get("kind") == "Deployment"
            and item["metadata"]["name"] == "feature-flags"
        )
        cls.pod_spec = deployment["spec"]["template"]["spec"]
        cls.init = next(
            (
                item
                for item in cls.pod_spec.get("initContainers", [])
                if item["name"] == "repair-git-cache"
            ),
            None,
        )
        cls.script = ""
        if cls.init:
            volume = next(
                item
                for item in cls.pod_spec["volumes"]
                if item["name"] == "flipt-cache-repair"
            )
            configmap = next(
                item
                for item in manifests
                if item.get("kind") == "ConfigMap"
                and item["metadata"]["name"] == volume["configMap"]["name"]
            )
            cls.script = configmap["data"]["repair-git-cache.sh"]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.cache = self.root / "cache"
        self.run_git("init", "--initial-branch=feature-flags-state", str(self.source))
        (self.source / "features.yaml").write_text("flags: []\n")
        self.run_git("-C", str(self.source), "add", "features.yaml")
        self.run_git("-C", str(self.source), "commit", "-m", "initial flags")
        self.run_git("clone", "--bare", str(self.source), str(self.cache))
        self.fetch()
        self.remote_ref = self.cache / "refs/remotes/origin/feature-flags-state"
        self.local_ref = self.cache / "refs/heads/feature-flags-state"

    def run_git(self, *arguments, **kwargs):
        return subprocess.run(
            [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                *arguments,
            ],
            check=True,
            capture_output=True,
            text=True,
            **kwargs,
        )

    def fetch(self):
        return self.run_git(
            "--git-dir",
            str(self.cache),
            "fetch",
            "origin",
            "+refs/heads/feature-flags-state:refs/remotes/origin/feature-flags-state",
        )

    def repair(self, cache=None):
        return subprocess.run(
            ["sh", "-eu", "-s", "--", str(cache or self.cache)],
            input=self.script,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_empty_remote_ref_allows_fetch_without_losing_local_commits(self):
        commit = self.run_git(
            "--git-dir",
            str(self.cache),
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            input="unpushed flag change\n",
        ).stdout.strip()
        self.run_git(
            "--git-dir",
            str(self.cache),
            "update-ref",
            "refs/heads/feature-flags-state",
            commit,
        )
        self.remote_ref.write_bytes(b"")
        result = self.repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.fetch()
        self.assertEqual(self.local_ref.read_text().strip(), commit)
        self.run_git("--git-dir", str(self.cache), "cat-file", "-e", commit)
        backups = list(
            self.root.glob(
                "cache.ref-backups/*/refs/remotes/origin/feature-flags-state"
            )
        )
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b"")
        self.assertNotEqual(self.remote_ref.read_bytes(), b"")

    def test_healthy_cache_is_unchanged(self):
        before = {
            str(path.relative_to(self.cache)): path.read_bytes()
            for path in self.cache.rglob("*")
            if path.is_file()
        }
        result = self.repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {
            str(path.relative_to(self.cache)): path.read_bytes()
            for path in self.cache.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)
        self.assertFalse((self.root / "cache.ref-backups").exists())

    def test_repeated_recovery_preserves_existing_backups(self):
        self.remote_ref.write_bytes(b"")
        self.assertEqual(self.repair().returncode, 0)
        self.fetch()
        before = sorted(
            self.root.glob(
                "cache.ref-backups/*/refs/remotes/origin/feature-flags-state"
            )
        )
        self.assertEqual(self.repair().returncode, 0)
        self.assertEqual(
            sorted(
                self.root.glob(
                    "cache.ref-backups/*/refs/remotes/origin/feature-flags-state"
                )
            ),
            before,
        )
        self.remote_ref.write_bytes(b"")
        self.assertEqual(self.repair().returncode, 0)
        self.assertEqual(
            len(
                list(
                    self.root.glob(
                        "cache.ref-backups/*/refs/remotes/origin/feature-flags-state"
                    )
                )
            ),
            2,
        )

    def test_empty_local_refs_and_lock_files_are_preserved(self):
        self.local_ref.write_bytes(b"")
        lock = self.remote_ref.with_suffix(".lock")
        lock.write_bytes(b"")
        self.assertEqual(self.repair().returncode, 0)
        self.assertEqual(self.local_ref.read_bytes(), b"")
        self.assertEqual(lock.read_bytes(), b"")

    def test_backup_failure_keeps_the_ref_and_blocks_startup(self):
        self.remote_ref.write_bytes(b"")
        (self.root / "cache.ref-backups").write_text("cannot create a backup directory")
        result = self.repair()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_ref.read_bytes(), b"")

    def test_new_cache_needs_no_repair(self):
        cache = self.root / "new-cache"
        result = self.repair(cache)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(cache.exists())

    def test_recovery_runs_with_the_flipt_image_and_pvc(self):
        self.assertIsNotNone(self.init)
        self.assertEqual(self.init["image"], self.pod_spec["containers"][0]["image"])
        self.assertEqual(
            self.init["command"],
            [
                "/bin/sh",
                "/opt/flipt-cache-repair/repair-git-cache.sh",
                "/var/opt/flipt/repositories/default",
            ],
        )
        self.assertIn(
            {"name": "flipt-data", "mountPath": "/var/opt/flipt"},
            self.init["volumeMounts"],
        )
        self.assertTrue(self.init["securityContext"]["runAsNonRoot"])


if __name__ == "__main__":
    unittest.main()

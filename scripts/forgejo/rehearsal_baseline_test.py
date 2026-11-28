"""Exercise snapshot reference capture with actual bare Git repositories."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "argocd/applications/forgejo/upgrade-repository-refs.sh"
)


class SnapshotReferencesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="forgejo-snapshot-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(
            os.environ,
            GIT_AUTHOR_NAME="Test",
            GIT_AUTHOR_EMAIL="test@example.invalid",
            GIT_COMMITTER_NAME="Test",
            GIT_COMMITTER_EMAIL="test@example.invalid",
        )

    def repository(self, name, commit=True):
        repo = self.root / "owner" / (name + ".git")
        repo.parent.mkdir(exist_ok=True)
        subprocess.run(
            ["git", "init", "--bare", str(repo)], check=True, capture_output=True
        )
        if commit:
            tree = (
                subprocess.check_output(
                    ["git", "--git-dir=" + str(repo), "mktree"], input=b""
                )
                .decode()
                .strip()
            )
            oid = (
                subprocess.check_output(
                    ["git", "--git-dir=" + str(repo), "commit-tree", tree],
                    input=b"fixture\n",
                    env=self.env,
                )
                .decode()
                .strip()
            )
            subprocess.run(
                ["git", "--git-dir=" + str(repo), "update-ref", "refs/heads/main", oid],
                check=True,
            )
        return repo

    def capture(self):
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.root)],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_captures_current_snapshot_with_any_repository_count(self):
        for name in ["first", "second", "third"]:
            self.repository(name)
        self.repository("empty", commit=False)
        before = self.capture()
        self.assertEqual(before.returncode, 0, before.stderr)
        self.assertEqual(before.stdout.count("refs/heads/main"), 3)
        self.assertIn("empty.git", before.stdout)
        self.assertEqual(before.stdout, self.capture().stdout)

    def test_detects_changed_refs_after_capture(self):
        repo = self.repository("first")
        before = self.capture()
        self.assertEqual(before.returncode, 0, before.stderr)
        oid = (
            subprocess.check_output(
                ["git", "--git-dir=" + str(repo), "rev-parse", "refs/heads/main"]
            )
            .decode()
            .strip()
        )
        subprocess.run(
            ["git", "--git-dir=" + str(repo), "update-ref", "refs/heads/new", oid],
            check=True,
        )
        after = self.capture()
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertNotEqual(before.stdout, after.stdout)

    def test_rejects_corrupt_reference(self):
        repo = self.repository("broken")
        (repo / "refs/heads/main").write_text("not-a-valid-object\n")
        self.assertNotEqual(self.capture().returncode, 0)

    def test_rejects_non_repository_and_missing_root(self):
        (self.root / "owner/broken.git").mkdir(parents=True)
        self.assertNotEqual(self.capture().returncode, 0)
        result = subprocess.run(
            ["bash", str(SCRIPT), str(self.root / "absent")],
            capture_output=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()

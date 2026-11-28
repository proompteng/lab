import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


class PersistentNixTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.image = self.root / "image"
        self.store = self.root / "persistent"
        self.binaries = self.root / "bin"
        self.toolchain = self.image / "store/toolchain"
        self.calls = self.root / "calls"
        self.registration = self.root / "registration"
        self.registration.write_text("closure one\n")
        self.toolchain.mkdir(parents=True)
        self.image.chmod(0o755)
        (self.image / "var/nix/db").mkdir(parents=True)
        (self.image / "var/nix/db/db.sqlite").write_text("database")
        self.binaries.mkdir()
        self.script = pathlib.Path(__file__).resolve().parents[1] / "seed-nix.sh"
        rsync = shutil.which("rsync")
        self.assertIsNotNone(rsync)
        self.executable(
            "rsync",
            'if test "${1:-}" != --server; then\n'
            f'  echo copy >> "{self.calls}"\n'
            f'  test ! -e "{self.root / "fail-copy"}" || exit 7\n'
            "fi\n"
            f'exec "{rsync}" "$@"\n',
        )
        self.executable("mount", f'echo mount >> "{self.calls}"\n')
        (self.toolchain / "bin").mkdir()
        self.executable(
            "nix-store",
            f'echo register >> "{self.calls}"\n'
            f'test ! -e "{self.root / "fail-register"}" || exit 8\n'
            "cat > /dev/null\n",
            self.toolchain / "bin",
        )

    def executable(self, name, body, directory=None):
        path = (directory or self.binaries) / name
        path.write_text("#!/bin/sh\nset -eu\n" + body)
        path.chmod(0o755)

    def run_seed(self):
        return subprocess.run(
            [
                "bash",
                str(self.script),
                str(self.image),
                str(self.store),
                str(self.registration),
                str(self.toolchain),
            ],
            env={
                **os.environ,
                "PATH": str(self.binaries) + os.pathsep + os.environ["PATH"],
            },
            capture_output=True,
            text=True,
            check=False,
        )

    def test_same_closure_restart_mounts_without_copy_or_database_import(self):
        for _ in range(2):
            if self.store.exists():
                self.store.chmod(0o700)
            result = self.run_seed()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.store.stat().st_mode & 0o777, 0o755)
        self.assertEqual(
            self.calls.read_text().splitlines(),
            ["copy", "mount", "register", "mount"],
        )

    def test_new_closure_seeds_new_paths_and_preserves_installed_packages(self):
        self.assertEqual(self.run_seed().returncode, 0)
        personal = self.store / "store/personal-package"
        personal.write_text("installed by the user")
        (self.image / "store/new-package").write_text("new image package")
        self.registration.write_text("closure two\n")
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertEqual(personal.read_text(), "installed by the user")
        self.assertEqual(
            (self.store / "store/new-package").read_text(), "new image package"
        )
        self.assertEqual(self.calls.read_text().splitlines().count("register"), 2)

    def test_failed_copy_retries_before_registering(self):
        failure = self.root / "fail-copy"
        failure.touch()
        self.assertEqual(self.run_seed().returncode, 7)
        self.assertEqual(self.calls.read_text().splitlines(), ["copy"])
        failure.unlink()
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertEqual(self.calls.read_text().splitlines().count("register"), 1)

    def test_failed_database_import_retries_and_does_not_mark_closure_complete(self):
        failure = self.root / "fail-register"
        failure.touch()
        self.assertEqual(self.run_seed().returncode, 8)
        failure.unlink()
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertEqual(self.calls.read_text().splitlines().count("register"), 2)

    def test_missing_persistent_database_invalidates_the_completed_seed(self):
        self.assertEqual(self.run_seed().returncode, 0)
        (self.store / "var/nix/db/db.sqlite").unlink()
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertTrue((self.store / "var/nix/db/db.sqlite").exists())
        self.assertEqual(self.calls.read_text().splitlines().count("register"), 2)

    def test_missing_toolchain_invalidates_the_completed_seed(self):
        self.assertEqual(self.run_seed().returncode, 0)
        shutil.rmtree(self.store / "store/toolchain")
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertTrue((self.store / "store/toolchain/bin/nix-store").exists())
        self.assertEqual(self.calls.read_text().splitlines().count("register"), 2)

    def test_failed_upgrade_keeps_old_receipt_and_retries_new_closure(self):
        self.assertEqual(self.run_seed().returncode, 0)
        receipt = self.store / "var/nix/devbox-registration.sha256"
        original = receipt.read_text()
        self.registration.write_text("closure two\n")
        failure = self.root / "fail-register"
        failure.touch()
        self.assertEqual(self.run_seed().returncode, 8)
        self.assertEqual(receipt.read_text(), original)
        failure.unlink()
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertNotEqual(receipt.read_text(), original)
        self.assertEqual(self.run_seed().returncode, 0)
        self.assertEqual(self.calls.read_text().splitlines().count("register"), 3)


if __name__ == "__main__":
    unittest.main()

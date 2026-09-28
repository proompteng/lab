import pathlib
import subprocess
import tempfile
import unittest


class PersistentHomeTests(unittest.TestCase):
    def test_image_upgrade_refreshes_managed_codex_and_preserves_personal_state(self):
        script = pathlib.Path(__file__).resolve().parents[1] / "seed-home.sh"
        with tempfile.TemporaryDirectory() as directory:
            image = pathlib.Path(directory) / "image"
            home = pathlib.Path(directory) / "home"
            for root, version in [(image, "2"), (home, "1")]:
                package = root / ".codex/packages/standalone"
                release = package / "releases" / version
                release.mkdir(parents=True)
                (release / "codex").write_text("version " + version)
                (package / "current").symlink_to("releases/" + version)
                (root / ".local/bin").mkdir(parents=True)
                (root / ".local/bin/codex").symlink_to(
                    "../../.codex/packages/standalone/current/codex"
                )
                (root / ".codex/config.toml").write_text("settings " + version)
            (home / ".local/bin/custom-tool").write_text("personal tool")
            (home / "workspace").mkdir()
            (home / "workspace/uncommitted.txt").write_text("work in progress")

            for _ in range(2):
                subprocess.run(["bash", str(script), str(image), str(home)], check=True)
                self.assertEqual((home / ".local/bin/codex").read_text(), "version 2")
                self.assertEqual(
                    (home / ".codex/config.toml").read_text(), "settings 1"
                )
                self.assertEqual(
                    (home / ".local/bin/custom-tool").read_text(), "personal tool"
                )
                self.assertEqual(
                    (home / "workspace/uncommitted.txt").read_text(), "work in progress"
                )


if __name__ == "__main__":
    unittest.main()

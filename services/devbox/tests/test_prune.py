import pathlib
import subprocess
import tempfile
import unittest

PRUNE = pathlib.Path(__file__).resolve().parents[1] / "prune-roots.sh"


class RootRetentionTests(unittest.TestCase):
    def test_keeps_selected_and_last_ready_roots_with_shared_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory)
            selected, ready, obsolete = "a" * 64, "b" * 64, "c" * 64
            for name in [selected, ready, obsolete, ".extract.interrupted", "notes"]:
                root = state / "roots" / name
                root.mkdir(parents=True)
                (root / ".image-complete").touch()
            for name in ["home", "nix", "docker", "metadata"]:
                (state / name).mkdir()
            (state / "metadata/last-ready").write_text(ready)
            for _ in range(2):
                subprocess.run(["bash", str(PRUNE), str(state), selected], check=True)
                self.assertEqual(
                    {p.name for p in (state / "roots").iterdir()},
                    {selected, ready, "notes"},
                )
                for name in ["home", "nix", "docker"]:
                    self.assertTrue((state / name).is_dir())

    def test_does_not_prune_before_selected_image_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory)
            retained = state / "roots" / ("b" * 64)
            retained.mkdir(parents=True)
            result = subprocess.run(
                ["bash", str(PRUNE), str(state), "a" * 64], check=False
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(retained.is_dir())

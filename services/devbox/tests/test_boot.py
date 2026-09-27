import os
import pathlib
import subprocess
import tempfile
import unittest


class BootBoundaryTests(unittest.TestCase):
    def test_rejects_mutable_and_foreign_images_before_downloading(self):
        boot = pathlib.Path(__file__).resolve().parents[1] / "boot.sh"
        for image in [
            "registry.ide-newton.ts.net/lab/codex-devbox-rootfs:latest",
            "example.com/devbox@sha256:" + "a" * 64,
            "registry.ide-newton.ts.net/lab/codex-devbox-rootfs@sha256:short",
            "registry.ide-newton.ts.net/lab/codex-devbox-rootfs@sha256:"
            + "a" * 64
            + ";id",
        ]:
            with self.subTest(image=image), tempfile.TemporaryDirectory() as directory:
                marker = pathlib.Path(directory) / "downloaded"
                client = pathlib.Path(directory) / "crane"
                client.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 99\n")
                client.chmod(0o755)
                result = subprocess.run(
                    ["bash", str(boot)],
                    env={
                        **os.environ,
                        "DEVBOX_ROOTFS_IMAGE": image,
                        "PATH": directory + os.pathsep + os.environ["PATH"],
                    },
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("immutable", result.stderr)
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()

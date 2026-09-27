import os
import pathlib
import shlex
import stat
import subprocess
import tarfile
import tempfile
import unittest


class BootBoundaryTests(unittest.TestCase):
    def test_extracted_and_cached_roots_allow_non_root_traversal(self):
        boot = pathlib.Path(__file__).resolve().parents[1] / "boot.sh"
        source = boot.read_text()
        self.assertEqual(source.count("state=/persist\n"), 1)
        image = "registry.ide-newton.ts.net/lab/codex-devbox-rootfs@sha256:" + "a" * 64
        for cached in [False, True]:
            with (
                self.subTest(cached=cached),
                tempfile.TemporaryDirectory() as directory,
            ):
                work = pathlib.Path(directory)
                state = work / "persist"
                root = state / "roots" / ("a" * 64)
                binaries = work / "bin"
                binaries.mkdir()
                archive = work / "rootfs.tar"
                with tarfile.open(archive, "w") as output:
                    for name in [
                        "sbin/init",
                        "usr/local/sbin/devbox-prepare",
                        "opt/devbox/nix-registration",
                    ]:
                        item = tarfile.TarInfo(name)
                        item.mode = 0o755
                        output.addfile(item)
                if cached:
                    root.mkdir(parents=True, mode=0o700)
                    (root / ".image-complete").write_text(image + "\n")
                for name, command in {
                    "mountpoint": "exit 0",
                    "crane": f"cat {shlex.quote(str(archive))}",
                    "rsync": "exit 71",
                }.items():
                    executable = binaries / name
                    executable.write_text("#!/bin/sh\n" + command + "\n")
                    executable.chmod(0o755)
                executable = work / "boot.sh"
                executable.write_text(
                    source.replace(
                        "state=/persist\n", f"state={shlex.quote(str(state))}\n"
                    )
                )
                result = subprocess.run(
                    ["bash", str(executable)],
                    env={
                        **os.environ,
                        "DEVBOX_ROOTFS_IMAGE": image,
                        "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                    },
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 71, result.stderr)
                self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o755)

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

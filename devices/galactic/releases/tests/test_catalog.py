import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "catalog.sh"
OLD = "sha256:" + "1" * 64
NEW = "sha256:" + "2" * 64


class CatalogPublicationTests(unittest.TestCase):
    def publish(self, current, previous=OLD):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "devices/galactic/releases/catalog.sh"
            script.parent.mkdir(parents=True)
            shutil.copyfile(SCRIPT, script)
            lock = root / "devices/nuc/image-factory/release.json"
            lock.parent.mkdir(parents=True)
            release = {
                "talos": "v1.14.0",
                "kataSource": "registry.test/kata@" + OLD,
                "kataCatalogEntry": "registry.test/kata:r6@" + OLD,
                "upstreamCatalog": "registry.test/extensions@" + OLD,
                "catalogRepository": "registry.test/catalog",
                "catalogDigest": NEW,
            }
            if previous is not None:
                release["previousCatalogDigest"] = previous
            lock.write_text(json.dumps(release))
            output = root / "output"
            output.mkdir()
            shutil.copyfile(lock, output / "release.json")
            (output / "catalog.tar").write_text("fixture")
            state = root / "state.json"
            state.write_text(json.dumps({"current": current, "tags": 0}))
            bin_dir = root / "bin"
            bin_dir.mkdir()
            crane = bin_dir / "crane"
            crane.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "p = pathlib.Path(os.environ['CATALOG_TEST_STATE'])\n"
                "s = json.loads(p.read_text())\n"
                "op = sys.argv[1]\n"
                "if op == 'ls' and s['current']: print('v1.14.0')\n"
                "elif op == 'digest':\n"
                "    ref = sys.argv[2]\n"
                "    print(s['current'] if ref == 'registry.test/catalog:v1.14.0' "
                "else os.environ['CATALOG_TEST_OLD'] if ref == 'registry.test/kata:r6' "
                "else os.environ['CATALOG_TEST_NEW'])\n"
                "elif op == 'tag':\n"
                "    s.update(current=os.environ['CATALOG_TEST_NEW'], tags=s['tags'] + 1)\n"
                "    p.write_text(json.dumps(s))\n"
                "elif op not in ('copy', 'append', 'ls'): raise SystemExit(2)\n"
            )
            cosign = bin_dir / "cosign"
            cosign.write_text("#!/bin/sh\nexit 0\n")
            crane.chmod(0o755)
            cosign.chmod(0o755)
            result = subprocess.run(
                ["bash", str(script), "publish", str(output)],
                env={
                    **os.environ,
                    "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_REPOSITORY": "proompteng/lab",
                    "GITHUB_SHA": "a" * 40,
                    "CATALOG_TEST_STATE": str(state),
                    "CATALOG_TEST_OLD": OLD,
                    "CATALOG_TEST_NEW": NEW,
                },
                capture_output=True,
                text=True,
            )
            return result, json.loads(state.read_text())

    def test_replaces_only_the_reviewed_previous_digest(self):
        result, state = self.publish(OLD)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state, {"current": NEW, "tags": 1})

    def test_repeated_publication_does_not_retag(self):
        result, state = self.publish(NEW)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state, {"current": NEW, "tags": 0})

    def test_unexpected_current_digest_is_preserved(self):
        unexpected = "sha256:" + "3" * 64
        result, state = self.publish(unexpected)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"current": unexpected, "tags": 0})

    def test_replacement_requires_an_explicit_previous_digest(self):
        result, state = self.publish(OLD, previous=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"current": OLD, "tags": 0})

    def test_invalid_previous_digest_is_rejected(self):
        result, state = self.publish(OLD, previous="invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"current": OLD, "tags": 0})

    def test_first_publication_creates_the_tag(self):
        result, state = self.publish(None, previous=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state, {"current": NEW, "tags": 1})


if __name__ == "__main__":
    unittest.main()

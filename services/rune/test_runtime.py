import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock

from runtime import prepare, read_lock


class ModelCacheTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cache = Path(self.temporary.name)
        self.content = b"checkpoint fixture"
        self.lock = {
            "repository": "owner/model",
            "revision": "a" * 40,
            "servedModel": "fixture",
            "files": [
                {
                    "name": "config.json",
                    "bytes": len(self.content),
                    "sha256": hashlib.sha256(self.content).hexdigest(),
                }
            ],
        }

    def prepare(self, fetch):
        with redirect_stdout(io.StringIO()):
            return prepare(self.lock, self.cache, fetch)

    def test_download_checks_revision_and_reuses_verified_bytes(self):
        fetch = Mock(return_value=io.BytesIO(self.content))
        model = self.prepare(fetch)
        fetch.assert_called_once_with(
            f"https://huggingface.co/owner/model/resolve/{'a' * 40}/config.json",
            timeout=60,
        )
        self.assertEqual((model / "config.json").read_bytes(), self.content)
        second_fetch = Mock(side_effect=AssertionError("Cache hit must not fetch"))
        self.assertEqual(self.prepare(second_fetch), model)
        second_fetch.assert_not_called()

    def test_same_size_corruption_prevents_reuse_without_overwriting_evidence(self):
        model = self.prepare(Mock(return_value=io.BytesIO(self.content)))
        corrupt = b"x" * len(self.content)
        (model / "config.json").write_bytes(corrupt)
        fetch = Mock()
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.prepare(fetch)
        fetch.assert_not_called()
        self.assertEqual((model / "config.json").read_bytes(), corrupt)

    def test_invalid_downloads_never_publish_a_cache_entry(self):
        for payload in [
            b"",
            b"short",
            b"x" * len(self.content),
            self.content + b"extra",
        ]:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, "failed verification"):
                    self.prepare(Mock(return_value=io.BytesIO(payload)))
                self.assertEqual(
                    list((self.cache / self.lock["revision"]).iterdir()), []
                )

    def test_network_errors_do_not_log_redirect_credentials(self):
        fetch = Mock(side_effect=OSError("signed redirect URL with secret-token"))
        with self.assertRaises(ValueError) as failure:
            self.prepare(fetch)
        self.assertNotIn("secret-token", str(failure.exception))
        self.assertTrue(failure.exception.__suppress_context__)

    def test_manifest_rejects_moving_revision_and_paths(self):
        path = self.cache / "lock.json"
        for revision, name in [("main", "config.json"), ("a" * 40, "../config.json")]:
            with self.subTest(revision=revision, name=name):
                manifest = {**self.lock, "revision": revision}
                manifest["files"] = [{**self.lock["files"][0], "name": name}]
                path.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    read_lock(path)

    def test_manifest_rejects_duplicated_files(self):
        path = self.cache / "lock.json"
        path.write_text(json.dumps({**self.lock, "files": self.lock["files"] * 2}))
        with self.assertRaisesRegex(ValueError, "duplicated"):
            read_lock(path)


if __name__ == "__main__":
    unittest.main()

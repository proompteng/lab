import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "verify_image_config", Path(__file__).with_name("verify-image-config.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseConfigTest(unittest.TestCase):
    def setUp(self):
        self.upstream = {
            "architecture": "arm64",
            "os": "linux",
            "created": "2026-09-01T00:00:00Z",
            "rootfs": {"type": "layers", "diff_ids": ["sha256:original"]},
            "config": {
                "User": "1000",
                "Entrypoint": ["/usr/bin/dumb-init", "--", "/entrypoint"],
                "Labels": {"org.opencontainers.image.version": "16.0.3"},
            },
        }
        self.revision = "a" * 40
        self.digest = "sha256:" + "b" * 64
        self.created = "2026-09-09T00:00:00Z"
        self.release = copy.deepcopy(self.upstream)
        self.release["config"]["Labels"].update(
            {
                "org.opencontainers.image.created": self.created,
                "org.opencontainers.image.revision": self.revision,
                "org.opencontainers.image.source": "https://github.com/proompteng/lab",
                "org.opencontainers.image.base.name": "code.forgejo.org/forgejo/forgejo",
                "org.opencontainers.image.base.digest": self.digest,
            }
        )

    def check(self):
        module.verify(
            self.upstream, self.release, self.revision, self.created, self.digest
        )

    def test_metadata_only_release(self):
        self.check()
        self.assertNotIn(
            "org.opencontainers.image.revision", self.upstream["config"]["Labels"]
        )

    def test_rejects_runtime_changes(self):
        for field, changed in [
            ("User", "0"),
            ("Entrypoint", ["/other"]),
            ("Env", ["INJECTED=1"]),
        ]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.release)
                self.release["config"][field] = changed
                with self.assertRaises(ValueError):
                    self.check()
                self.release = original

    def test_rejects_changed_layers(self):
        self.release["rootfs"]["diff_ids"] = ["sha256:changed"]
        with self.assertRaises(ValueError):
            self.check()

    def test_rejects_wrong_identity(self):
        for key in [
            "org.opencontainers.image.revision",
            "org.opencontainers.image.base.digest",
            "org.opencontainers.image.version",
        ]:
            with self.subTest(key=key):
                original = self.release["config"]["Labels"][key]
                self.release["config"]["Labels"][key] = "incorrect"
                with self.assertRaises(ValueError):
                    self.check()
                self.release["config"]["Labels"][key] = original


if __name__ == "__main__":
    unittest.main()

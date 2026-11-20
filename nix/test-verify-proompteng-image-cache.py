#!/usr/bin/env python3
"""Regression fixtures for the effective cache path in layered runtime images."""

import contextlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "proompteng_image_cache", Path(__file__).with_name("verify-proompteng-image-cache.py")
)
assert spec and spec.loader
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)

RUNTIME = "nix/store/fixture-proompteng-runtime-root-0/app/apps/landing"
SERVER = RUNTIME + "/server.js"
CACHE = RUNTIME + "/.next/cache"
VALID = [(SERVER, "file", ""), (CACHE, "link", "/var/cache/proompteng")]


class ImageCacheTest(unittest.TestCase):
    def check_image(self, layers: list[list[tuple[str, str, str]]], valid: bool) -> None:
        with tempfile.TemporaryDirectory(prefix="proompteng-image-cache-") as directory:
            image_path = Path(directory) / "image.tar"
            with tarfile.open(image_path, "w") as image:
                layer_names = []
                for index, entries in enumerate(layers):
                    layer_data = io.BytesIO()
                    with tarfile.open(fileobj=layer_data, mode="w") as layer:
                        for path, kind, target in entries:
                            entry = tarfile.TarInfo(path)
                            if kind == "link":
                                entry.type = tarfile.SYMTYPE
                                entry.linkname = target
                            elif kind == "directory":
                                entry.type = tarfile.DIRTYPE
                            layer.addfile(entry)
                    name = f"layer-{index}.tar"
                    layer_names.append(name)
                    self.add_file(image, name, layer_data.getvalue())
                self.add_file(image, "manifest.json", json.dumps([{"Layers": layer_names}]).encode())
            with contextlib.redirect_stdout(io.StringIO()):
                if valid:
                    verifier.verify(str(image_path))
                else:
                    with self.assertRaises(ValueError):
                        verifier.verify(str(image_path))

    @staticmethod
    def add_file(archive: tarfile.TarFile, name: str, data: bytes) -> None:
        entry = tarfile.TarInfo(name)
        entry.size = len(data)
        archive.addfile(entry, io.BytesIO(data))

    def test_valid_cache(self) -> None:
        self.check_image([VALID], True)

    def test_upper_layer_whiteouts_remove_lower_evidence(self) -> None:
        for whiteout in [RUNTIME + "/.next/.wh.cache", RUNTIME + "/.next/.wh..wh..opq", RUNTIME + "/.wh.server.js"]:
            with self.subTest(whiteout=whiteout):
                self.check_image([VALID, [(whiteout, "file", "")]], False)

    def test_same_layer_can_recreate_whiteouted_cache_in_either_archive_order(self) -> None:
        entries = [(CACHE, "link", "/var/cache/proompteng"), (RUNTIME + "/.next/.wh.cache", "file", "")]
        self.check_image([VALID, entries], True)
        self.check_image([VALID, list(reversed(entries))], True)

    def test_replaced_and_missing_cache_are_rejected(self) -> None:
        self.check_image([[VALID[0]]], False)
        self.check_image([VALID, [(CACHE, "directory", "")]], False)
        self.check_image([VALID, [(CACHE, "link", "/tmp/cache")]], False)


if __name__ == "__main__":
    unittest.main()

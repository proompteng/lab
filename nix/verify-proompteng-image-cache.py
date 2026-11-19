#!/usr/bin/env python3
"""Check the cache path used by the real standalone server in a built Docker archive."""

import json
import sys
import tarfile
from pathlib import PurePosixPath


def verify(image_path: str) -> None:
    servers: set[str] = set()
    caches: dict[str, str | None] = {}
    with tarfile.open(image_path, "r:*") as image:
        manifest_file = image.extractfile("manifest.json")
        if manifest_file is None:
            raise ValueError("image is missing manifest.json")
        manifest = json.load(manifest_file)
        if len(manifest) != 1 or not manifest[0].get("Layers"):
            raise ValueError("expected one image with filesystem layers")
        for layer_name in manifest[0]["Layers"]:
            layer_file = image.extractfile(layer_name)
            if layer_file is None:
                raise ValueError(f"image layer is missing: {layer_name}")
            layer_servers: dict[str, bool] = {}
            layer_caches: dict[str, str | None] = {}
            removed: set[str] = set()
            with tarfile.open(fileobj=layer_file, mode="r|*") as layer:
                for entry in layer:
                    name = str(PurePosixPath("/", entry.name.lstrip("/")))
                    path = PurePosixPath(name)
                    if path.name == ".wh..wh..opq":
                        removed.add(str(path.parent))
                    elif path.name.startswith(".wh."):
                        removed.add(str(path.parent / path.name.removeprefix(".wh.")))
                    if name.endswith("/app/apps/landing/server.js"):
                        layer_servers[name] = entry.isfile()
                    if name.endswith("/app/apps/landing/.next/cache"):
                        layer_caches[name] = entry.linkname if entry.issym() else None
            # Whiteouts apply to lower layers, irrespective of their order alongside this layer's new entries.
            def retained(path: str) -> bool:
                return not any(path == root or path.startswith(root.rstrip("/") + "/") for root in removed)

            servers = {path for path in servers if retained(path)}
            caches = {path: target for path, target in caches.items() if retained(path)}
            for path, regular in layer_servers.items():
                if regular:
                    servers.add(path)
                else:
                    servers.discard(path)
            caches.update(layer_caches)
    if not servers:
        raise ValueError("standalone landing server is missing from the runtime image")
    for server in servers:
        cache = str(PurePosixPath(server).parent / ".next/cache")
        if caches.get(cache) != "/var/cache/proompteng":
            raise ValueError(f"{cache} must link to the writable /var/cache/proompteng volume")
    print("Verified standalone server cache links to /var/cache/proompteng.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: verify-proompteng-image-cache.py <nix-image-tar>")
    try:
        verify(sys.argv[1])
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        sys.exit(f"Proompteng image cache verification failed: {error}")

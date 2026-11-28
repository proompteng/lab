"""Require an OCI release wrapper to preserve every runtime configuration field."""

import copy
import json
import re
import sys


def verify(upstream, release, revision, created, platform_digest):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("invalid source revision")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", platform_digest):
        raise ValueError("invalid upstream platform digest")
    expected = copy.deepcopy(upstream)
    expected["config"].setdefault("Labels", {}).update(
        {
            "org.opencontainers.image.created": created,
            "org.opencontainers.image.revision": revision,
            "org.opencontainers.image.source": "https://github.com/proompteng/lab",
            "org.opencontainers.image.base.name": "code.forgejo.org/forgejo/forgejo",
            "org.opencontainers.image.base.digest": platform_digest,
        }
    )
    if expected != release:
        raise ValueError("release changed upstream runtime configuration or metadata")


if __name__ == "__main__":
    upstream_path, release_path, revision, created, digest = sys.argv[1:]
    with open(upstream_path) as source, open(release_path) as candidate:
        verify(json.load(source), json.load(candidate), revision, created, digest)
    print(
        "Verified unchanged upstream runtime configuration and exact release metadata"
    )

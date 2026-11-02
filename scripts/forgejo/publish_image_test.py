"""Exercise immutable publication failures with an isolated registry CLI double."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("publish-image.sh").resolve()
REVISION = "a" * 40
DIGEST = "sha256:" + "b" * 64


class ImmutablePublicationTest(unittest.TestCase):
    def run_publication(self, registry_state, ref="refs/heads/main"):
        with tempfile.TemporaryDirectory(prefix="forgejo-publication-") as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "bin/git").write_text(
                '#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%s\\n" "$GITHUB_SHA"; '
                "else echo 2026-09-09T00:00:00Z; fi\n"
            )
            (root / "bin/crane").write_text(
                """#!/bin/bash
set -eu
printf '%s\n' "$*" >> calls
if [[ "$1" == tag ]]; then touch published; exit 0; fi
reference=${!#}
if [[ "$reference" == *:prepared-* || -e published || "$REGISTRY_STATE" == matching ]]; then
  printf '%s\n' "$EXPECTED_DIGEST"
elif [[ "$REGISTRY_STATE" == absent ]]; then
  echo 'MANIFEST_UNKNOWN: manifest unknown' >&2; exit 1
elif [[ "$REGISTRY_STATE" == conflicting ]]; then
  echo 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
elif [[ "$REGISTRY_STATE" == unauthorized ]]; then
  echo 'UNAUTHORIZED: authentication required' >&2; exit 1
else
  echo 'registry request timed out' >&2; exit 1
fi
"""
            )
            for executable in (root / "bin").iterdir():
                executable.chmod(0o755)
            release = root / "argocd/applications/forgejo/upstream-image.json"
            release.parent.mkdir(parents=True)
            release.write_text(
                json.dumps(
                    {
                        "repository": "code.forgejo.org/forgejo/forgejo",
                        "version": "16.0.3",
                        "indexDigest": DIGEST,
                    }
                )
            )
            evidence = root / "forgejo-image-evidence"
            evidence.mkdir()
            (evidence / "receipt.json").write_text(
                json.dumps({"revision": REVISION, "digest": DIGEST})
            )
            result = subprocess.run(
                ["bash", str(SCRIPT), "publish"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=10,
                env=dict(
                    os.environ,
                    PATH=str(root / "bin") + os.pathsep + os.environ["PATH"],
                    GITHUB_REF=ref,
                    GITHUB_SHA=REVISION,
                    REGISTRY_STATE=registry_state,
                    EXPECTED_DIGEST=DIGEST,
                ),
            )
            return result.returncode, (root / "published").exists(), result.stderr

    def test_publishes_absent_tag_after_matching_prepared_digest(self):
        status, published, error = self.run_publication("absent")
        self.assertEqual(status, 0, error)
        self.assertTrue(published)

    def test_matching_tag_is_idempotent(self):
        status, published, error = self.run_publication("matching")
        self.assertEqual(status, 0, error)
        self.assertTrue(published)

    def test_registry_failures_and_conflicts_never_publish(self):
        for state in ["conflicting", "unauthorized", "timeout"]:
            with self.subTest(state=state):
                status, published, _ = self.run_publication(state)
                self.assertNotEqual(status, 0)
                self.assertFalse(published)

    def test_non_main_execution_never_publishes(self):
        status, published, _ = self.run_publication("absent", "refs/pull/123/merge")
        self.assertNotEqual(status, 0)
        self.assertFalse(published)


if __name__ == "__main__":
    unittest.main()

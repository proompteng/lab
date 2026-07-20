from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


def test_singleuser_runs_the_digest_pinned_image_entrypoint() -> None:
    values = yaml.safe_load(
        (REPO_ROOT / "argocd/applications/torghut/notebooks/values.yaml").read_text()
    )

    assert "cmd" in values["singleuser"]
    assert values["singleuser"]["cmd"] is None

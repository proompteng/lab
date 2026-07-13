from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
REMOVED_CRONJOBS = (
    "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml",
    "argocd/applications/torghut/execution-tca-refresh-cronjob.yaml",
    "argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml",
    "argocd/applications/torghut/tigerbeetle-journal-order-events-cronjob.yaml",
    "argocd/applications/torghut/zero-notional-drift-repair-cronjob.yaml",
    "argocd/applications/torghut-hyperliquid-runtime/proof-verifier-cronjob.yaml",
)
TIGERBEETLE_SMOKE_JOB = "argocd/applications/torghut/tigerbeetle-smoke-job.yaml"


def test_release_workflow_tracks_only_active_torghut_job_manifests() -> None:
    workflow = (REPO_ROOT / ".github/workflows/torghut-release.yml").read_text(
        encoding="utf-8"
    )

    for removed_cronjob in REMOVED_CRONJOBS:
        assert removed_cronjob not in workflow
    assert workflow.count(TIGERBEETLE_SMOKE_JOB) == 3


def test_deploy_automerge_allows_only_active_torghut_job_manifests() -> None:
    workflow = (REPO_ROOT / ".github/workflows/torghut-deploy-automerge.yml").read_text(
        encoding="utf-8"
    )

    for removed_cronjob in REMOVED_CRONJOBS:
        assert removed_cronjob not in workflow
    assert TIGERBEETLE_SMOKE_JOB in workflow

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
RENEWAL_CRONJOB = "argocd/applications/torghut/empirical-promotion-renewal-cronjob.yaml"
SOURCE_WINDOW_REPAIR_CRONJOB = (
    "argocd/applications/torghut/order-feed-source-window-repair-cronjob.yaml"
)
TIGERBEETLE_SMOKE_JOB = "argocd/applications/torghut/tigerbeetle-smoke-job.yaml"
TIGERBEETLE_JOURNAL_CRONJOB = (
    "argocd/applications/torghut/tigerbeetle-journal-order-events-cronjob.yaml"
)


def test_release_workflow_tracks_empirical_promotion_renewal_cronjob() -> None:
    workflow = (REPO_ROOT / ".github/workflows/torghut-release.yml").read_text(
        encoding="utf-8"
    )

    assert workflow.count(RENEWAL_CRONJOB) == 3
    assert workflow.count(SOURCE_WINDOW_REPAIR_CRONJOB) == 3
    assert workflow.count(TIGERBEETLE_SMOKE_JOB) == 3
    assert workflow.count(TIGERBEETLE_JOURNAL_CRONJOB) == 3


def test_deploy_automerge_allows_empirical_promotion_renewal_cronjob() -> None:
    workflow = (REPO_ROOT / ".github/workflows/torghut-deploy-automerge.yml").read_text(
        encoding="utf-8"
    )

    assert RENEWAL_CRONJOB in workflow
    assert SOURCE_WINDOW_REPAIR_CRONJOB in workflow
    assert TIGERBEETLE_SMOKE_JOB in workflow
    assert TIGERBEETLE_JOURNAL_CRONJOB in workflow

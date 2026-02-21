"""Evidence continuity checks for autonomous research ledger records."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ...models import (
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
)


@dataclass(frozen=True)
class EvidenceContinuityCheckReport:
    checked_at: datetime
    run_ids: list[str]
    checked_runs: int
    failed_runs: int
    missing_runs: list[dict[str, Any]]

    def to_payload(self) -> dict[str, Any]:
        return {
            "checked_at": self.checked_at.isoformat(),
            "run_ids": list(self.run_ids),
            "checked_runs": self.checked_runs,
            "failed_runs": self.failed_runs,
            "missing_runs": list(self.missing_runs),
            "ok": self.failed_runs == 0,
        }


def evaluate_evidence_continuity(
    session: Session,
    *,
    run_limit: int,
) -> EvidenceContinuityCheckReport:
    """Validate evidence chain continuity for latest non-skipped autonomous runs."""

    checked_at = datetime.now(timezone.utc)
    resolved_limit = max(1, int(run_limit))
    runs = list(
        session.execute(
            select(ResearchRun)
            .where(ResearchRun.status != "skipped")
            .order_by(ResearchRun.created_at.desc())
            .limit(resolved_limit)
        )
        .scalars()
        .all()
    )
    run_ids = [row.run_id for row in runs]
    if not run_ids:
        return EvidenceContinuityCheckReport(
            checked_at=checked_at,
            run_ids=[],
            checked_runs=0,
            failed_runs=0,
            missing_runs=[],
        )

    candidate_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchCandidate.id),
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )

    fold_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchFoldMetrics.id),
                )
                .join(
                    ResearchFoldMetrics,
                    ResearchFoldMetrics.candidate_id == ResearchCandidate.candidate_id,
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )

    stress_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchStressMetrics.id),
                )
                .join(
                    ResearchStressMetrics,
                    ResearchStressMetrics.candidate_id
                    == ResearchCandidate.candidate_id,
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )

    promotion_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchPromotion.id),
                )
                .join(
                    ResearchPromotion,
                    ResearchPromotion.candidate_id == ResearchCandidate.candidate_id,
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )
    promotion_audit_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchPromotion.id),
                )
                .join(
                    ResearchPromotion,
                    ResearchPromotion.candidate_id == ResearchCandidate.candidate_id,
                )
                .where(
                    ResearchCandidate.run_id.in_(run_ids),
                    or_(
                        and_(
                            ResearchPromotion.decision_rationale.is_not(None),
                            ResearchPromotion.decision_rationale != "",
                            ResearchPromotion.evidence_bundle.is_not(None),
                        ),
                        ResearchPromotion.approve_reason.is_not(None),
                        ResearchPromotion.deny_reason.is_not(None),
                    ),
                )
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )

    missing_runs: list[dict[str, Any]] = []
    for run_id in run_ids:
        candidate_count = int(candidate_counts.get(run_id, 0) or 0)
        fold_count = int(fold_counts.get(run_id, 0) or 0)
        stress_count = int(stress_counts.get(run_id, 0) or 0)
        promotion_count = int(promotion_counts.get(run_id, 0) or 0)
        promotion_audit_count = int(promotion_audit_counts.get(run_id, 0) or 0)
        missing: list[str] = []
        if candidate_count <= 0:
            missing.append("research_candidates")
        if fold_count <= 0:
            missing.append("research_fold_metrics")
        if stress_count <= 0:
            missing.append("research_stress_metrics")
        if promotion_count <= 0:
            missing.append("research_promotions")
        elif promotion_audit_count <= 0:
            missing.append("promotion_decision_audit")
        if missing:
            missing_runs.append(
                {
                    "run_id": run_id,
                    "missing_tables": missing,
                    "counts": {
                        "research_candidates": candidate_count,
                        "research_fold_metrics": fold_count,
                        "research_stress_metrics": stress_count,
                        "research_promotions": promotion_count,
                        "promotion_decision_audit": promotion_audit_count,
                    },
                }
            )

    return EvidenceContinuityCheckReport(
        checked_at=checked_at,
        run_ids=run_ids,
        checked_runs=len(run_ids),
        failed_runs=len(missing_runs),
        missing_runs=missing_runs,
    )


__all__ = ["EvidenceContinuityCheckReport", "evaluate_evidence_continuity"]

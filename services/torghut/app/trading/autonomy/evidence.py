"""Evidence continuity checks for autonomous research ledger records."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, cast

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ...models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchStressMetrics,
    ResearchValidationTest,
)
from ..discovery.profit_target_oracle import evaluate_profit_target_oracle


_AUTORESEARCH_PORTFOLIO_READY_STATUSES = {
    "paper_candidate",
    "promotion_ready",
    "ready_for_promotion",
    "ready_for_promotion_review",
    "target_met",
    "accepted",
    "promoted",
}


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


def _autoresearch_portfolio_current_oracle_passed(
    row: AutoresearchPortfolioCandidate,
) -> bool:
    scorecard = row.objective_scorecard_json
    if not isinstance(scorecard, Mapping):
        return False
    oracle = evaluate_profit_target_oracle(
        cast(Mapping[str, Any], scorecard),
        target_net_pnl_per_day=Decimal(row.target_net_pnl_per_day),
    )
    return bool(oracle.get("passed"))


def _autoresearch_continuity_counts(session: Session) -> dict[str, int] | None:
    portfolio_rows = list(
        session.execute(select(AutoresearchPortfolioCandidate)).scalars()
    )
    counts = {
        "autoresearch_epochs": int(
            session.execute(select(func.count(AutoresearchEpoch.id))).scalar_one()
        ),
        "autoresearch_candidate_specs": int(
            session.execute(
                select(func.count(AutoresearchCandidateSpec.id))
            ).scalar_one()
        ),
        "autoresearch_proposal_scores": int(
            session.execute(
                select(func.count(AutoresearchProposalScore.id))
            ).scalar_one()
        ),
        "autoresearch_portfolio_candidates": len(portfolio_rows),
        "autoresearch_portfolio_ready": 0,
        "autoresearch_portfolio_blocked": 0,
    }
    if not any(counts.values()):
        return None

    for row in portfolio_rows:
        oracle_ready = (
            row.status in _AUTORESEARCH_PORTFOLIO_READY_STATUSES
            and _autoresearch_portfolio_current_oracle_passed(row)
        )
        if oracle_ready:
            counts["autoresearch_portfolio_ready"] += 1
        else:
            counts["autoresearch_portfolio_blocked"] += 1
    return counts


def _autoresearch_missing_tables(counts: Mapping[str, int]) -> list[str]:
    missing: list[str] = []
    if counts["autoresearch_epochs"] <= 0:
        missing.append("autoresearch_epochs")
    if counts["autoresearch_candidate_specs"] <= 0:
        missing.append("autoresearch_candidate_specs")
    if counts["autoresearch_proposal_scores"] <= 0:
        missing.append("autoresearch_proposal_scores")
    if counts["autoresearch_portfolio_candidates"] <= 0:
        missing.append("autoresearch_portfolio_candidates")
    if counts["autoresearch_portfolio_ready"] <= 0:
        missing.append("autoresearch_portfolio_ready")
    if (
        counts["autoresearch_portfolio_ready"] <= 0
        and counts["autoresearch_portfolio_blocked"] > 0
    ):
        missing.append("autoresearch_portfolio_candidates_blocked")
    return missing


def _autoresearch_continuity_report(
    session: Session,
    *,
    checked_at: datetime,
    run_limit: int,
) -> EvidenceContinuityCheckReport | None:
    counts = _autoresearch_continuity_counts(session)
    if counts is None:
        return None

    latest_epoch_ids = [
        str(epoch_id)
        for (epoch_id,) in session.execute(
            select(AutoresearchEpoch.epoch_id)
            .order_by(
                AutoresearchEpoch.completed_at.desc().nullslast(),
                AutoresearchEpoch.created_at.desc(),
            )
            .limit(max(1, int(run_limit)))
        ).all()
    ]
    run_ids = latest_epoch_ids or ["autoresearch_ledgers"]
    missing = _autoresearch_missing_tables(counts)

    missing_runs = (
        [
            {
                "run_id": run_ids[0],
                "missing_tables": missing,
                "counts": counts,
                "discovery_mode": "whitepaper_autoresearch",
                "source_ref": "postgres:autoresearch_ledgers",
            }
        ]
        if missing
        else []
    )
    return EvidenceContinuityCheckReport(
        checked_at=checked_at,
        run_ids=run_ids,
        checked_runs=1,
        failed_runs=len(missing_runs),
        missing_runs=missing_runs,
    )


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
        autoresearch_report = _autoresearch_continuity_report(
            session,
            checked_at=checked_at,
            run_limit=resolved_limit,
        )
        if autoresearch_report is not None:
            return autoresearch_report
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
    attempt_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchAttempt.run_id,
                    func.count(ResearchAttempt.id),
                )
                .where(ResearchAttempt.run_id.in_(run_ids))
                .group_by(ResearchAttempt.run_id)
            ).all()
        )
    )
    validation_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchValidationTest.id),
                )
                .join(
                    ResearchValidationTest,
                    ResearchValidationTest.candidate_id
                    == ResearchCandidate.candidate_id,
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )
    sequential_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchSequentialTrial.id),
                )
                .join(
                    ResearchSequentialTrial,
                    ResearchSequentialTrial.candidate_id
                    == ResearchCandidate.candidate_id,
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )
    cost_calibration_counts = dict(
        (
            (str(run_id), int(count or 0))
            for run_id, count in session.execute(
                select(
                    ResearchCandidate.run_id,
                    func.count(ResearchCostCalibration.id),
                )
                .join(
                    ResearchCostCalibration,
                    (ResearchCostCalibration.scope_type == "candidate_family")
                    & (
                        ResearchCostCalibration.scope_id
                        == ResearchCandidate.candidate_family
                    ),
                )
                .where(ResearchCandidate.run_id.in_(run_ids))
                .group_by(ResearchCandidate.run_id)
            ).all()
        )
    )
    candidate_economic_validity_counts: dict[str, int] = {}
    for candidate in session.execute(
        select(ResearchCandidate).where(ResearchCandidate.run_id.in_(run_ids))
    ).scalars():
        payload = candidate.economic_validity_card
        if not isinstance(payload, dict) or not payload:
            continue
        candidate_economic_validity_counts[candidate.run_id] = (
            candidate_economic_validity_counts.get(candidate.run_id, 0) + 1
        )

    missing_runs: list[dict[str, Any]] = []
    run_lookup = {row.run_id: row for row in runs}
    autoresearch_counts = _autoresearch_continuity_counts(session)
    autoresearch_missing = (
        _autoresearch_missing_tables(autoresearch_counts)
        if autoresearch_counts is not None
        else []
    )
    for run_id in run_ids:
        run = run_lookup[run_id]
        candidate_count = int(candidate_counts.get(run_id, 0) or 0)
        fold_count = int(fold_counts.get(run_id, 0) or 0)
        stress_count = int(stress_counts.get(run_id, 0) or 0)
        promotion_count = int(promotion_counts.get(run_id, 0) or 0)
        promotion_audit_count = int(promotion_audit_counts.get(run_id, 0) or 0)
        attempt_count = int(attempt_counts.get(run_id, 0) or 0)
        validation_count = int(validation_counts.get(run_id, 0) or 0)
        sequential_count = int(sequential_counts.get(run_id, 0) or 0)
        cost_calibration_count = int(cost_calibration_counts.get(run_id, 0) or 0)
        economic_validity_count = int(
            candidate_economic_validity_counts.get(run_id, 0) or 0
        )
        discovery_mode = str(run.discovery_mode or "").strip()
        require_strategy_factory_chain = discovery_mode.startswith("strategy_factory")
        missing: list[str] = []
        use_autoresearch_continuity = (
            autoresearch_counts is not None
            and candidate_count <= 0
            and promotion_count <= 0
            and (
                discovery_mode.startswith("whitepaper_autoresearch")
                or discovery_mode.startswith("portfolio_profit_autoresearch")
                or bool(autoresearch_counts)
            )
        )
        if use_autoresearch_continuity:
            missing.extend(autoresearch_missing)
        else:
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
        if require_strategy_factory_chain:
            if attempt_count <= 0:
                missing.append("research_attempts")
            if validation_count <= 0:
                missing.append("research_validation_tests")
            if sequential_count <= 0:
                missing.append("research_sequential_trials")
            if cost_calibration_count <= 0:
                missing.append("research_cost_calibrations")
            if economic_validity_count <= 0:
                missing.append("candidate_economic_validity_card")
        if missing:
            missing_runs.append(
                {
                    "run_id": run_id,
                    "missing_tables": missing,
                    "counts": {
                        **(autoresearch_counts or {}),
                        "candidate_economic_validity_card": economic_validity_count,
                        "research_attempts": attempt_count,
                        "research_candidates": candidate_count,
                        "research_cost_calibrations": cost_calibration_count,
                        "research_fold_metrics": fold_count,
                        "research_stress_metrics": stress_count,
                        "research_promotions": promotion_count,
                        "research_sequential_trials": sequential_count,
                        "research_validation_tests": validation_count,
                        "promotion_decision_audit": promotion_audit_count,
                    },
                    "discovery_mode": discovery_mode or None,
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

"""FastAPI routes for persisted whitepaper autoresearch epochs."""

from __future__ import annotations

from typing import Any, Mapping, cast

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
)


router = APIRouter(prefix="/trading/autoresearch", tags=["trading-autoresearch"])


def _json_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _json_list(value: Any) -> list[Any]:
    return list(cast(list[Any], value)) if isinstance(value, list) else []


def _best_portfolio_dashboard_fields(
    portfolio: AutoresearchPortfolioCandidate | None,
) -> dict[str, Any]:
    if portfolio is None:
        return {
            "best_portfolio_net_pnl_per_day": None,
            "best_portfolio_active_day_ratio": None,
            "best_portfolio_positive_day_ratio": None,
            "blocked_promotion_reasons": [],
            "best_portfolio_sleeves": [],
        }
    scorecard = _json_object(portfolio.objective_scorecard_json)
    payload = _json_object(portfolio.payload_json)
    readiness = payload.get("promotion_readiness")
    readiness_payload = _json_object(readiness)
    blockers = readiness_payload.get("blockers")
    sleeve_payload = payload.get("sleeves")
    return {
        "best_portfolio_net_pnl_per_day": scorecard.get("net_pnl_per_day"),
        "best_portfolio_active_day_ratio": scorecard.get("active_day_ratio"),
        "best_portfolio_positive_day_ratio": scorecard.get("positive_day_ratio"),
        "blocked_promotion_reasons": _json_list(blockers),
        "best_portfolio_sleeves": _json_list(sleeve_payload),
    }


def _summary_dashboard_fields(summary: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "claim_count": summary.get("claim_count"),
        "hypothesis_count": summary.get("hypothesis_count"),
        "candidate_spec_count": summary.get("candidate_spec_count"),
        "replayed_candidate_count": summary.get("evidence_bundle_count"),
        "portfolio_candidate_count": summary.get("portfolio_candidate_count"),
        "mlx_rank_bucket_lift": summary.get("mlx_rank_bucket_lift"),
        "false_positive_table": summary.get("false_positive_table", []),
        "best_false_negative_table": summary.get("best_false_negative_table", []),
    }


@router.get("/epochs")
def trading_autoresearch_epochs(
    status: str | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=100),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return persisted whitepaper autoresearch epochs with dashboard fields."""

    stmt = select(AutoresearchEpoch)
    if status:
        stmt = stmt.where(AutoresearchEpoch.status == status)
    rows = list(
        session.execute(
            stmt.order_by(AutoresearchEpoch.created_at.desc()).limit(limit)
        ).scalars()
    )
    items: list[dict[str, object]] = []
    for row in rows:
        portfolio = (
            session.execute(
                select(AutoresearchPortfolioCandidate)
                .where(AutoresearchPortfolioCandidate.epoch_id == row.epoch_id)
                .order_by(AutoresearchPortfolioCandidate.created_at.asc())
            )
            .scalars()
            .first()
        )
        summary = _json_object(row.summary_json)
        snapshot = _json_object(row.snapshot_manifest_json)
        items.append(
            {
                "epoch_id": row.epoch_id,
                "status": row.status,
                "target_net_pnl_per_day": str(row.target_net_pnl_per_day),
                "paper_run_ids": row.paper_run_ids_json or [],
                "paper_count": len(row.paper_run_ids_json or []),
                "started_at": row.started_at.isoformat() if row.started_at else None,
                "completed_at": row.completed_at.isoformat()
                if row.completed_at
                else None,
                "failure_reason": row.failure_reason,
                "source_count": snapshot.get("source_count"),
                "summary": summary,
                **_summary_dashboard_fields(summary),
                **_best_portfolio_dashboard_fields(portfolio),
            }
        )
    return {"count": len(items), "epochs": items}


@router.get("/epochs/{epoch_id}")
def trading_autoresearch_epoch(
    epoch_id: str,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return one persisted whitepaper autoresearch epoch with child ledgers."""

    epoch = session.execute(
        select(AutoresearchEpoch).where(AutoresearchEpoch.epoch_id == epoch_id)
    ).scalar_one_or_none()
    if epoch is None:
        raise HTTPException(
            status_code=404, detail=f"autoresearch_epoch_not_found:{epoch_id}"
        )
    specs = list(
        session.execute(
            select(AutoresearchCandidateSpec)
            .where(AutoresearchCandidateSpec.epoch_id == epoch_id)
            .order_by(AutoresearchCandidateSpec.created_at.asc())
        ).scalars()
    )
    proposals = list(
        session.execute(
            select(AutoresearchProposalScore)
            .where(AutoresearchProposalScore.epoch_id == epoch_id)
            .order_by(AutoresearchProposalScore.rank.asc())
        ).scalars()
    )
    portfolios = list(
        session.execute(
            select(AutoresearchPortfolioCandidate)
            .where(AutoresearchPortfolioCandidate.epoch_id == epoch_id)
            .order_by(AutoresearchPortfolioCandidate.created_at.asc())
        ).scalars()
    )
    summary = _json_object(epoch.summary_json)
    dashboard = {
        **_summary_dashboard_fields(summary),
        **_best_portfolio_dashboard_fields(portfolios[0] if portfolios else None),
    }
    return {
        "epoch": {
            "epoch_id": epoch.epoch_id,
            "status": epoch.status,
            "target_net_pnl_per_day": str(epoch.target_net_pnl_per_day),
            "paper_run_ids": epoch.paper_run_ids_json or [],
            "snapshot_manifest": epoch.snapshot_manifest_json or {},
            "runner_config": epoch.runner_config_json or {},
            "summary": summary,
            "started_at": epoch.started_at.isoformat() if epoch.started_at else None,
            "completed_at": epoch.completed_at.isoformat()
            if epoch.completed_at
            else None,
            "failure_reason": epoch.failure_reason,
        },
        "dashboard": dashboard,
        "candidate_specs": [
            {
                "candidate_spec_id": row.candidate_spec_id,
                "hypothesis_id": row.hypothesis_id,
                "candidate_kind": row.candidate_kind,
                "family_template_id": row.family_template_id,
                "status": row.status,
                "blockers": row.blockers_json or [],
                "payload": row.payload_json,
            }
            for row in specs
        ],
        "proposal_scores": [
            {
                "candidate_spec_id": row.candidate_spec_id,
                "model_id": row.model_id,
                "backend": row.backend,
                "proposal_score": str(row.proposal_score),
                "rank": row.rank,
                "selection_reason": row.selection_reason,
                "feature_hash": row.feature_hash,
            }
            for row in proposals
        ],
        "portfolio_candidates": [
            {
                "portfolio_candidate_id": row.portfolio_candidate_id,
                "status": row.status,
                "target_net_pnl_per_day": str(row.target_net_pnl_per_day),
                "source_candidate_ids": row.source_candidate_ids_json,
                "objective_scorecard": row.objective_scorecard_json,
                "optimizer_report": row.optimizer_report_json,
                "payload": row.payload_json,
            }
            for row in portfolios
        ],
    }

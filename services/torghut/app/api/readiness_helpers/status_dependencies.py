"""Readiness status helper dependencies owned by explicit API modules."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from app.config import settings
from app.db import SessionLocal
from app.trading.empirical_jobs import build_empirical_jobs_status
from app.trading.scheduler import TradingScheduler

from ..health_checks import (
    build_api_live_submission_gate_payload,
    build_hypothesis_runtime_payload,
    forecast_service_status,
    load_clickhouse_ta_status,
    load_options_catalog_freshness_summary,
    load_tca_summary,
    route_claim_symbols,
)
from ..proof_floor_payloads import (
    build_capital_reentry_cohort_ledger_payload,
    build_capital_replay_projection_payload,
    build_clock_settlement_payload,
    build_evidence_clock_payloads,
    build_freshness_carry_ledger_payload,
    build_profit_freshness_frontier_payload,
    build_profit_repair_settlement_ledger_payload,
    build_profit_signal_quorum_payload,
    build_profitability_proof_floor_payload,
    build_quality_adjusted_profit_frontier_payload,
    build_renewal_bond_profit_escrow_payload,
    build_repair_bid_settlement_payload,
    build_repair_outcome_dividend_ledger_payload,
    build_repair_receipt_frontier_payload,
    build_route_evidence_clearinghouse_payload,
    build_route_image_proof_summary,
    build_route_reacquisition_board_payload,
    build_route_warrant_exchange_payload,
    build_routeability_repair_acceptance_ledger_payload,
    build_source_serving_repair_receipt_payload,
)

__all__ = (
    "active_runtime_revision",
    "build_api_live_submission_gate_payload",
    "build_capital_reentry_cohort_ledger_payload",
    "build_capital_replay_projection_payload",
    "build_clock_settlement_payload",
    "build_consumer_evidence_receipt_projection",
    "build_evidence_clock_payloads",
    "build_freshness_carry_ledger_payload",
    "build_hypothesis_runtime_payload",
    "build_profit_freshness_frontier_payload",
    "build_profit_repair_settlement_ledger_payload",
    "build_profit_signal_quorum_payload",
    "build_profitability_proof_floor_payload",
    "build_quality_adjusted_profit_frontier_payload",
    "build_renewal_bond_profit_escrow_payload",
    "build_repair_bid_settlement_payload",
    "build_repair_outcome_dividend_ledger_payload",
    "build_repair_receipt_frontier_payload",
    "build_route_evidence_clearinghouse_payload",
    "build_route_image_proof_summary",
    "build_route_reacquisition_board_payload",
    "build_route_warrant_exchange_payload",
    "build_routeability_repair_acceptance_ledger_payload",
    "build_source_serving_repair_receipt_payload",
    "empirical_jobs_status",
    "forecast_service_status",
    "load_clickhouse_ta_status",
    "load_options_catalog_freshness_summary",
    "load_tca_summary",
    "refresh_universe_state_for_readiness",
    "revenue_repair_topline_fields",
    "route_claim_symbols",
)


def build_consumer_evidence_receipt_projection(
    *,
    forecast_service_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    serving_revision: str | None,
) -> tuple[dict[str, object], dict[str, object]]:
    from ..trading_misc import (
        build_consumer_evidence_receipt_projection as build_projection,
    )

    return build_projection(
        forecast_service_status=forecast_service_status,
        empirical_jobs_status=empirical_jobs_status,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
        serving_revision=serving_revision,
    )


def revenue_repair_topline_fields(
    revenue_repair_payload: Mapping[str, Any],
) -> dict[str, object]:
    from ..trading_misc import revenue_repair_topline_fields as topline_fields

    return topline_fields(revenue_repair_payload)


def active_runtime_revision() -> str | None:
    revision = os.getenv("K_REVISION", "").strip()
    return revision or None


def refresh_universe_state_for_readiness(
    *,
    scheduler: TradingScheduler,
    state: object,
) -> None:
    from .refresh_universe_state_for_readiness import (
        refresh_universe_state_for_readiness as refresh_universe_state,
    )

    refresh_universe_state(scheduler=scheduler, state=state)


def empirical_jobs_status() -> dict[str, object]:
    try:
        with SessionLocal() as session:
            return build_empirical_jobs_status(
                session=session,
                stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
            )
    except Exception as exc:
        return {
            "status": "degraded",
            "authority": "blocked",
            "stale_after_seconds": settings.trading_empirical_job_stale_after_seconds,
            "jobs": {},
            "message": f"empirical job status unavailable: {type(exc).__name__}",
        }

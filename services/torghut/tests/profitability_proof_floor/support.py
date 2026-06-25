from __future__ import annotations


from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from app.trading.proof_floor import (
    _route_universe_adverse_slippage_clear,
    build_profitability_proof_floor_receipt,
)


NOW = datetime(2026, 5, 6, 21, 27, tzinfo=timezone.utc)


def _healthy_hypothesis_payload() -> dict[str, object]:
    return {
        "summary": {
            "hypotheses_total": 1,
            "promotion_eligible_total": 1,
            "rollback_required_total": 0,
            "state_totals": {"promotion_eligible": 1},
        },
        "items": [
            {
                "hypothesis_id": "chip-paper-microbar-composite",
                "reasons": [],
                "promotion_contract": {
                    "max_avg_abs_slippage_bps": "20",
                    "observed_post_cost_expectancy_bps": "8",
                    "capacity_daily_notional": "1000000",
                    "drawdown_budget": "1200",
                    "allocated_sleeve_equity": "100000",
                },
            }
        ],
    }


def _healthy_empirical_jobs() -> dict[str, object]:
    return {
        "ready": True,
        "status": "healthy",
        "candidate_ids": ["chip-paper-microbar-composite@execution-proof"],
        "dataset_snapshot_refs": ["torghut-chip-full-day-20260505-5e447b6d-r1"],
    }


def _healthy_quant_evidence() -> dict[str, object]:
    return {
        "ok": True,
        "status": "healthy",
        "reason": "ready",
        "account": "paper",
        "window": "15m",
        "latest_metrics_updated_at": NOW.isoformat(),
        "max_stage_lag_seconds": 5,
    }


def _healthy_market_context() -> dict[str, object]:
    return {
        "alert_active": False,
        "last_reason": "ok",
        "last_freshness_seconds": 30,
        "last_quality_score": 0.99,
        "last_domain_states": {"macro": "fresh"},
    }


def _fresh_tca_summary(*, avg_abs_slippage_bps: str = "5") -> dict[str, object]:
    return {
        "order_count": 12,
        "last_computed_at": (NOW - timedelta(minutes=5)).isoformat(),
        "avg_abs_slippage_bps": avg_abs_slippage_bps,
    }


def _simple_lane_status() -> dict[str, object]:
    return {
        "enabled": True,
        "submit_enabled": True,
        "order_feed_telemetry_enabled": True,
        "order_feed_ingestion_enabled": True,
        "order_feed_bootstrap_configured": True,
        "order_feed_topic_count": 1,
        "order_feed_assignment_mode": "manual",
        "order_feed_auto_offset_reset": "latest",
        "order_feed_lifecycle_required": True,
        "order_feed_lifecycle_status": "enabled",
        "route_symbol_filter_enabled": True,
        "max_notional_per_order": "250",
        "max_notional_per_symbol": "750",
        "capacity_daily_notional": "1000000",
        "drawdown_budget": "1200",
        "allocated_sleeve_equity": "100000",
    }


__all__: tuple[str, ...] = (
    "Any",
    "Mapping",
    "NOW",
    "_fresh_tca_summary",
    "_healthy_empirical_jobs",
    "_healthy_hypothesis_payload",
    "_healthy_market_context",
    "_healthy_quant_evidence",
    "_route_universe_adverse_slippage_clear",
    "_simple_lane_status",
    "build_profitability_proof_floor_receipt",
    "cast",
    "datetime",
    "timedelta",
    "timezone",
)

from __future__ import annotations


from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.profit_freshness_frontier import (
    PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION,
    build_profit_freshness_frontier,
)


NOW = datetime(2026, 5, 12, 15, 10, tzinfo=timezone.utc)


def _base_inputs() -> dict[str, object]:
    return {
        "account_label": "PA3SX7FYNUTF",
        "trading_mode": "live",
        "proof_window": "15m",
        "torghut_revision": "torghut-00320",
        "proof_floor_receipt": {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "stale",
                    "reason": "execution_tca_stale",
                    "freshness_seconds": 330_000,
                    "source_ref": {
                        "last_computed_at": "2026-05-08T20:22:17+00:00",
                    },
                }
            ],
        },
        "routeability_repair_acceptance_ledger": {
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:test",
            "aggregate_state": "blocked",
            "accepted_routeable_candidate_count": 0,
            "aggregate_blocking_reason_codes": [
                "proof_floor_repair_only",
                "market_context_technicals_stale",
            ],
            "lots": [
                {
                    "lot_id": "routeability-repair-lot:tca",
                    "lot_type": "route_universe_tca_repair",
                    "current_state": "stale",
                    "blocking_reason_codes": ["execution_tca_stale"],
                    "hypothesis_ids": ["H-NVDA"],
                }
            ],
        },
        "quality_adjusted_profit_frontier": {
            "frontier_id": "quality-frontier:test",
            "packets": [{"packet_id": "packet-a"}],
        },
        "route_reacquisition_board": {
            "summary": {"capital_eligible_symbol_count": 0},
            "rows": [
                {
                    "symbol": "NVDA",
                    "state": "blocked",
                    "current_blocker": "execution_tca_stale",
                    "hypothesis_ids": ["H-NVDA"],
                }
            ],
        },
        "live_submission_gate": {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
        },
        "quant_evidence": {
            "ok": True,
            "status": "degraded",
            "reason": "quant_pipeline_degraded",
            "latest_metrics_count": 144,
            "stage_count": 0,
            "max_stage_lag_seconds": 956_000,
            "source_url": "http://jangar/quant/health",
        },
        "market_context_status": {
            "status": "healthy",
            "last_symbol": "AMZN",
            "last_checked_at": "2026-05-08T20:22:17+00:00",
            "last_freshness_seconds": 330_000,
            "max_staleness_seconds": 86_400,
            "last_domain_states": {
                "technicals": {"status": "stale"},
                "fundamentals": {"status": "stale"},
                "news": {"status": "stale"},
                "regime": {"status": "stale"},
            },
        },
        "empirical_jobs_status": {
            "ready": False,
            "status": "degraded",
            "missing_jobs": [],
            "stale_jobs": ["benchmark_parity", "janus_event_car"],
            "ineligible_jobs": ["janus_hgrm_reward"],
            "candidate_ids": ["candidate-nvda"],
            "dataset_snapshot_refs": ["dataset-nvda"],
        },
        "hypothesis_payload": {
            "summary": {
                "promotion_eligible_total": 0,
                "reason_totals": {
                    "signal_lag_exceeded": 1,
                    "feature_rows_missing": 1,
                    "drift_checks_missing": 1,
                },
            },
            "items": [
                {
                    "hypothesis_id": "H-NVDA",
                    "reasons": [
                        "signal_lag_exceeded",
                        "feature_rows_missing",
                        "drift_checks_missing",
                    ],
                }
            ],
        },
        "jangar_reliability_settlement_ref": {
            "settlement_ref": "jangar-reliability-settlement:test",
            "decision": "hold",
            "state": "degraded",
            "reason_codes": ["torghut_empirical_jobs_stale"],
        },
        "now": NOW,
    }


def _frontier(**overrides: object) -> dict[str, object]:
    payload = _base_inputs()
    payload.update(overrides)
    return build_profit_freshness_frontier(**payload)


def _dimension(frontier: Mapping[str, object], name: str) -> Mapping[str, Any]:
    for raw_dimension in cast(
        list[Mapping[str, Any]], frontier["freshness_dimensions"]
    ):
        if raw_dimension["dimension"] == name:
            return raw_dimension
    raise AssertionError(f"missing dimension {name}")


__all__: tuple[str, ...] = (
    "Any",
    "Mapping",
    "NOW",
    "PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION",
    "_base_inputs",
    "_dimension",
    "_frontier",
    "build_profit_freshness_frontier",
    "cast",
    "datetime",
    "timezone",
)

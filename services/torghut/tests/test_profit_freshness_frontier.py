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
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
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


def test_profit_freshness_frontier_ranks_stale_proof_as_zero_notional_repairs() -> None:
    frontier = _frontier()

    assert frontier["schema_version"] == PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION
    assert frontier["frontier_state"] == "held"
    assert (
        frontier["next_zero_notional_action"] == "refresh_stale_market_context_domains"
    )
    assert frontier["capital_posture"]["capital_state"] == "zero_notional"
    assert frontier["capital_posture"]["paper_notional_limit"] == "0"
    assert frontier["capital_posture"]["live_notional_limit"] == "0"
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 0
    assert frontier["summary"]["dimension_count"] == 9
    assert frontier["summary"]["active_repair_lot_count"] >= 6

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])
    assert len(selected) == 1
    assert selected[0]["state"] == "selected_zero_notional_repair"
    assert selected[0]["paper_notional_limit"] == "0"
    assert selected[0]["live_notional_limit"] == "0"


def test_stale_market_context_and_empirical_jobs_are_explicit_dimensions() -> None:
    frontier = _frontier()
    market = _dimension(frontier, "market_context")
    empirical = _dimension(frontier, "empirical_proof")

    assert market["state"] == "stale"
    assert "market_context_technicals_stale" in market["reason_codes"]
    assert "market_context:news" in market["evidence_refs"]
    assert empirical["state"] == "stale"
    assert "empirical_job_stale:benchmark_parity" in empirical["reason_codes"]
    assert "dataset-nvda" in empirical["evidence_refs"]


def test_positive_partial_signal_does_not_create_paper_candidate_when_jangar_holds() -> (
    None
):
    frontier = _frontier(
        quant_evidence={
            "ok": True,
            "status": "healthy",
            "latest_metrics_count": 144,
            "stage_count": 4,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        empirical_jobs_status={
            "ready": True,
            "status": "healthy",
            "eligible_jobs": [
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ],
            "candidate_ids": ["candidate-nvda"],
            "dataset_snapshot_refs": ["dataset-nvda"],
        },
    )

    assert _dimension(frontier, "signal_ingestion")["state"] == "current"
    assert _dimension(frontier, "market_context")["state"] == "current"
    assert _dimension(frontier, "empirical_proof")["state"] == "current"
    assert _dimension(frontier, "jangar_settlement")["state"] == "blocked"
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 0
    assert frontier["capital_posture"]["capital_behavior_changed"] is False


def test_closed_frontier_still_does_not_widen_capital_limits() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "max_notional": "25",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "source_ref": {"last_computed_at": "2026-05-12T15:00:00+00:00"},
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:ready",
            "aggregate_state": "accepted",
            "accepted_routeable_candidate_count": 1,
            "aggregate_blocking_reason_codes": [],
            "lots": [],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 1},
            "rows": [
                {
                    "symbol": "NVDA",
                    "state": "routeable",
                    "current_blocker": "route_tca_passed",
                }
            ],
        },
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
        },
        quant_evidence={
            "ok": True,
            "status": "healthy",
            "latest_metrics_count": 144,
            "stage_count": 4,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        empirical_jobs_status={
            "ready": True,
            "status": "healthy",
            "eligible_jobs": [
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ],
            "candidate_ids": ["candidate-nvda"],
            "dataset_snapshot_refs": ["dataset-nvda"],
        },
        hypothesis_payload={
            "summary": {"promotion_eligible_total": 1, "reason_totals": {}},
            "items": [
                {"hypothesis_id": "H-NVDA", "reasons": [], "promotion_eligible": True}
            ],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    assert frontier["frontier_state"] == "ready"
    assert frontier["repair_lots"] == []
    assert frontier["selected_zero_notional_repairs"] == []
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 1
    assert frontier["capital_posture"]["paper_notional_limit"] == "0"
    assert frontier["capital_posture"]["live_notional_limit"] == "0"

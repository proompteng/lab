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
    assert frontier["next_zero_notional_action"] == "rebuild_required_feature_rows"
    assert frontier["capital_posture"]["capital_state"] == "zero_notional"
    assert frontier["capital_posture"]["paper_notional_limit"] == "0"
    assert frontier["capital_posture"]["live_notional_limit"] == "0"
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 0
    assert frontier["summary"]["dimension_count"] == 9
    assert frontier["summary"]["active_repair_lot_count"] >= 6

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])
    assert len(selected) == 1
    assert selected[0]["blocked_dimension"] == "feature_coverage"
    assert selected[0]["state"] == "selected_zero_notional_repair"
    assert selected[0]["paper_notional_limit"] == "0"
    assert selected[0]["live_notional_limit"] == "0"
    assert "market_context" not in {
        repair["blocked_dimension"]
        for repair in cast(list[Mapping[str, Any]], frontier["repair_lots"])
    }


def test_daily_net_pnl_unlock_outranks_bps_proxy_when_profit_packets_are_available() -> (
    None
):
    frontier = _frontier(
        quality_adjusted_profit_frontier={
            "frontier_id": "quality-frontier:pnl-unlock",
            "packets": [
                {
                    "packet_id": "qapf:retired-market-context-small-unlock",
                    "repair_class": "market_context",
                    "hypothesis_ref": "H-NVDA",
                    "expected_daily_net_pnl_unlock": "1.25",
                },
                {
                    "packet_id": "qapf:empirical-large-unlock",
                    "blocked_dimension": "empirical_proof",
                    "candidate_id": "candidate-nvda",
                    "post_cost_daily_net_pnl_unlock": "250.50",
                },
            ],
        }
    )

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])

    assert selected[0]["blocked_dimension"] == "empirical_proof"
    assert selected[0]["expected_daily_net_pnl_unlock"] == "250.5"
    assert selected[0]["repair_priority_basis"] == "expected_daily_net_pnl_unlock"
    assert selected[0]["profit_unlock_refs"] == ["qapf:empirical-large-unlock"]
    assert frontier["next_zero_notional_action"] == "renew_empirical_proof_jobs"
    assert frontier["summary"]["ranked_daily_net_pnl_repair_count"] == 1
    assert frontier["summary"]["selected_expected_daily_net_pnl_unlock"] == "250.5"
    assert frontier["capital_posture"]["capital_state"] == "zero_notional"


def test_feature_replay_closure_outranks_drift_for_micro_alpha_blocker() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "route_tca_passed",
                    "freshness_seconds": 71,
                    "source_ref": {
                        "last_computed_at": "2026-05-12T15:08:49+00:00",
                    },
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:alpha-feature",
            "aggregate_state": "accepted",
            "accepted_routeable_candidate_count": 1,
            "aggregate_blocking_reason_codes": [],
            "lots": [],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 1},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "routeable",
                    "current_blocker": "",
                    "hypothesis_ids": ["H-MICRO-01"],
                }
            ],
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
            "candidate_ids": ["chip-paper-microbar-composite@execution-proof"],
            "dataset_snapshot_refs": ["dataset-micro"],
        },
        hypothesis_payload={
            "summary": {
                "promotion_eligible_total": 0,
                "reason_totals": {
                    "feature_rows_missing": 1,
                    "required_feature_set_unavailable": 1,
                    "drift_checks_missing": 1,
                },
            },
            "items": [
                {
                    "hypothesis_id": "H-MICRO-01",
                    "reasons": [
                        "feature_rows_missing",
                        "required_feature_set_unavailable",
                        "drift_checks_missing",
                    ],
                }
            ],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])

    assert frontier["next_zero_notional_action"] == "rebuild_required_feature_rows"
    assert selected[0]["blocked_dimension"] == "feature_coverage"
    assert selected[0]["hypothesis_id"] == "H-MICRO-01"
    assert selected[0]["priority_adjustments"] == ["alpha_feature_replay_closure"]
    assert selected[0]["paper_notional_limit"] == "0"
    assert selected[0]["live_notional_limit"] == "0"


def test_feature_replay_closure_outranks_stale_empirical_when_alpha_readiness_blocks_routeability() -> (
    None
):
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "route_tca_passed",
                    "freshness_seconds": 71,
                    "source_ref": {
                        "last_computed_at": "2026-05-12T15:08:49+00:00",
                    },
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:alpha-readiness-blocked",
            "aggregate_state": "blocked",
            "accepted_routeable_candidate_count": 0,
            "aggregate_blocking_reason_codes": [
                "alpha_readiness_not_promotion_eligible",
                "alpha_readiness_fail",
                "empirical_jobs_not_ready",
            ],
            "lots": [],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 0},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "blocked",
                    "current_blocker": "alpha_readiness_not_promotion_eligible",
                    "hypothesis_ids": ["H-MICRO-01"],
                }
            ],
        },
        quant_evidence={
            "required": False,
            "ok": True,
            "status": "not_required",
            "reason": "quant_health_not_configured",
            "informational_reasons": ["quant_health_not_configured"],
            "source_url": None,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        empirical_jobs_status={
            "ready": False,
            "status": "degraded",
            "stale_jobs": [
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ],
            "ineligible_jobs": [
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ],
            "candidate_ids": ["chip-paper-microbar-composite@execution-proof"],
            "dataset_snapshot_refs": ["torghut-chip-full-day-20260505-4c330ce9-r1"],
        },
        hypothesis_payload={
            "summary": {
                "promotion_eligible_total": 0,
                "reason_totals": {
                    "feature_rows_missing": 1,
                    "required_feature_set_unavailable": 1,
                    "drift_checks_missing": 1,
                },
            },
            "items": [
                {
                    "hypothesis_id": "H-MICRO-01",
                    "reasons": [
                        "feature_rows_missing",
                        "required_feature_set_unavailable",
                        "drift_checks_missing",
                    ],
                }
            ],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": (
                "jangar-reliability-settlement:"
                "dependency-quorum:allow:torghut_dependency_quorum_not_required"
            ),
            "decision": "allow",
            "state": "current",
            "reason_codes": ["torghut_dependency_quorum_not_required"],
            "source": "dependency_quorum_proxy",
        },
    )

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])
    repair_lots = cast(list[Mapping[str, Any]], frontier["repair_lots"])

    assert frontier["next_zero_notional_action"] == "rebuild_required_feature_rows"
    assert selected[0]["blocked_dimension"] == "feature_coverage"
    assert selected[0]["hypothesis_id"] == "H-MICRO-01"
    assert selected[0]["priority_adjustments"] == [
        "alpha_feature_replay_closure",
        "alpha_readiness_routeability_closure",
    ]
    assert selected[0]["paper_notional_limit"] == "0"
    assert selected[0]["live_notional_limit"] == "0"
    assert repair_lots[1]["blocked_dimension"] == "empirical_proof"


def test_stale_market_context_and_empirical_jobs_are_explicit_dimensions() -> None:
    frontier = _frontier()
    market = _dimension(frontier, "market_context")
    empirical = _dimension(frontier, "empirical_proof")

    assert market["state"] == "stale"
    assert "market_context_technicals_stale" in market["reason_codes"]
    assert "market_context:regime" in market["evidence_refs"]
    assert "market_context:news" not in market["evidence_refs"]
    assert "market_context" not in {
        repair["blocked_dimension"]
        for repair in cast(list[Mapping[str, Any]], frontier["repair_lots"])
    }
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


def test_jangar_not_required_allow_reason_does_not_hold_frontier() -> None:
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
        jangar_reliability_settlement_ref={
            "settlement_ref": (
                "jangar-reliability-settlement:"
                "dependency-quorum:allow:torghut_dependency_quorum_not_required"
            ),
            "decision": "allow",
            "state": "current",
            "reason_codes": ["torghut_dependency_quorum_not_required"],
            "source": "dependency_quorum_proxy",
        },
    )

    jangar = _dimension(frontier, "jangar_settlement")

    assert jangar["state"] == "current"
    assert jangar["reason_codes"] == []
    assert jangar["details"]["informational_reason_codes"] == [
        "torghut_dependency_quorum_not_required"
    ]
    assert all(
        repair["blocked_dimension"] != "jangar_settlement"
        for repair in cast(
            list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"]
        )
    )
    assert frontier["frontier_state"] != "held"
    assert (
        frontier["next_zero_notional_action"] != "refresh_jangar_reliability_settlement"
    )


def test_jangar_allow_with_real_blocking_reason_still_holds_frontier() -> None:
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
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:blocking",
            "decision": "allow",
            "state": "current",
            "reason_codes": [
                "torghut_dependency_quorum_not_required",
                "jangar_controller_unavailable",
            ],
            "source": "dependency_quorum_proxy",
        },
    )

    jangar = _dimension(frontier, "jangar_settlement")

    assert jangar["state"] == "blocked"
    assert jangar["reason_codes"] == ["jangar_controller_unavailable"]
    assert jangar["details"]["informational_reason_codes"] == [
        "torghut_dependency_quorum_not_required"
    ]
    assert frontier["frontier_state"] == "held"


def test_optional_unconfigured_quant_health_does_not_select_signal_repair() -> None:
    frontier = _frontier(
        quant_evidence={
            "required": False,
            "ok": True,
            "status": "not_required",
            "reason": "quant_health_not_configured",
            "blocking_reasons": [],
            "informational_reasons": ["quant_health_not_configured"],
            "source_url": None,
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
        jangar_reliability_settlement_ref={
            "settlement_ref": (
                "jangar-reliability-settlement:"
                "dependency-quorum:allow:torghut_dependency_quorum_not_required"
            ),
            "decision": "allow",
            "state": "current",
            "reason_codes": ["torghut_dependency_quorum_not_required"],
            "source": "dependency_quorum_proxy",
        },
    )

    signal = _dimension(frontier, "signal_ingestion")

    assert signal["state"] == "current"
    assert signal["reason_codes"] == []
    assert signal["details"]["informational_reason_codes"] == [
        "quant_health_not_configured"
    ]
    assert all(
        repair["blocked_dimension"] != "signal_ingestion"
        for repair in cast(
            list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"]
        )
    )


def test_required_unconfigured_quant_health_still_selects_signal_repair() -> None:
    frontier = _frontier(
        quant_evidence={
            "required": True,
            "ok": False,
            "status": "unknown",
            "reason": "quant_health_not_configured",
            "blocking_reasons": ["quant_health_not_configured"],
            "informational_reasons": [],
            "source_url": None,
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
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    signal = _dimension(frontier, "signal_ingestion")

    assert signal["state"] == "missing"
    assert "quant_health_not_configured" in signal["reason_codes"]
    assert any(
        lot["blocked_dimension"] == "signal_ingestion"
        for lot in cast(list[Mapping[str, Any]], frontier["repair_lots"])
    )


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
    tca_dimension = _dimension(frontier, "tca_fill_quality")
    assert tca_dimension["state"] == "current"
    assert "route_tca_passed" not in tca_dimension["reason_codes"]
    assert frontier["repair_lots"] == []
    assert frontier["selected_zero_notional_repairs"] == []
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 1
    assert frontier["capital_posture"]["paper_notional_limit"] == "0"
    assert frontier["capital_posture"]["live_notional_limit"] == "0"


def test_tca_dimension_reports_missing_when_proof_dimension_is_absent() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [],
        }
    )

    tca_dimension = _dimension(frontier, "tca_fill_quality")

    assert tca_dimension["state"] == "missing"
    assert tca_dimension["reason_codes"] == ["execution_tca_missing"]


def test_tca_dimension_keeps_non_routeability_proof_blockers() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "blocking_reason_codes": [
                        "capital_state_zero_notional",
                        "fill_quality_guardrail_failed",
                    ],
                }
            ],
        }
    )

    tca_dimension = _dimension(frontier, "tca_fill_quality")

    assert tca_dimension["state"] == "degraded"
    assert tca_dimension["reason_codes"] == ["fill_quality_guardrail_failed"]


def test_tca_dimension_derives_stale_and_failed_reasons_without_explicit_reason() -> (
    None
):
    stale_frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "stale",
                    "freshness_seconds": 330_000,
                }
            ],
        }
    )
    failed_frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "fail",
                }
            ],
        }
    )

    stale_dimension = _dimension(stale_frontier, "tca_fill_quality")
    failed_dimension = _dimension(failed_frontier, "tca_fill_quality")

    assert stale_dimension["state"] == "stale"
    assert stale_dimension["reason_codes"] == ["execution_tca_stale"]
    assert failed_dimension["state"] == "blocked"
    assert failed_dimension["reason_codes"] == ["execution_tca_fail"]


def test_fresh_execution_tca_does_not_inherit_routeability_blockers() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "execution_tca_route_universe_exclusions_applied",
                    "freshness_seconds": 71,
                    "source_ref": {
                        "last_computed_at": "2026-05-12T15:08:49+00:00",
                    },
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:route-blocked",
            "aggregate_state": "blocked",
            "accepted_routeable_candidate_count": 0,
            "aggregate_blocking_reason_codes": [
                "proof_floor_repair_only",
                "capital_state_zero_notional",
                "route_tca_passed_but_dependency_receipts_block_capital",
                "execution_tca_route_universe_exclusions_applied",
                "execution_tca_symbol_missing",
            ],
            "lots": [
                {
                    "lot_id": "routeability-repair-lot:alpha",
                    "lot_type": "alpha_readiness_repair",
                    "current_state": "blocked",
                    "blocking_reason_codes": ["alpha_readiness_fail"],
                    "hypothesis_ids": ["H-AAPL"],
                },
                {
                    "lot_id": "routeability-repair-lot:tca",
                    "lot_type": "route_universe_tca_repair",
                    "current_state": "blocked",
                    "blocking_reason_codes": [
                        "execution_tca_route_universe_exclusions_applied",
                        "execution_tca_symbol_missing",
                    ],
                    "hypothesis_ids": ["H-AAPL", "H-AMD", "H-AMZN"],
                },
            ],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 0},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "probing",
                    "current_blocker": (
                        "route_tca_passed_but_dependency_receipts_block_capital"
                    ),
                    "hypothesis_ids": ["H-AAPL"],
                },
                {
                    "symbol": "AMD",
                    "state": "blocked",
                    "current_blocker": "execution_tca_route_universe_exclusions_applied",
                    "hypothesis_ids": ["H-AMD"],
                },
                {
                    "symbol": "AMZN",
                    "state": "missing",
                    "current_blocker": "execution_tca_symbol_missing",
                    "hypothesis_ids": ["H-AMZN"],
                },
            ],
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
            "candidate_ids": ["candidate-aapl"],
            "dataset_snapshot_refs": ["dataset-aapl"],
        },
        hypothesis_payload={
            "summary": {"promotion_eligible_total": 0, "reason_totals": {}},
            "items": [{"hypothesis_id": "H-AAPL", "reasons": []}],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    tca_dimension = _dimension(frontier, "tca_fill_quality")
    route_dimension = _dimension(frontier, "route_readiness")

    assert tca_dimension["state"] == "current"
    assert tca_dimension["reason_codes"] == []
    assert tca_dimension["blocking_hypotheses"] == []
    assert tca_dimension["details"]["routeability_blocked_symbols"] == [
        "AAPL",
        "AMD",
        "AMZN",
    ]
    assert route_dimension["state"] == "blocked"
    assert "capital_state_zero_notional" in route_dimension["reason_codes"]
    assert (
        "route_tca_passed_but_dependency_receipts_block_capital"
        in route_dimension["reason_codes"]
    )
    assert (
        frontier["next_zero_notional_action"] == "recompute_route_tca_and_fill_quality"
    )
    assert (
        frontier["selected_zero_notional_repairs"][0]["zero_notional_action"]
        == "recompute_route_tca_and_fill_quality"
    )
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 0


def test_route_readiness_uses_settlement_action_without_unsettled_tca_lot() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "route_tca_passed",
                    "freshness_seconds": 71,
                    "source_ref": {
                        "last_computed_at": "2026-05-12T15:08:49+00:00",
                    },
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:route-alpha-blocked",
            "aggregate_state": "blocked",
            "accepted_routeable_candidate_count": 0,
            "aggregate_blocking_reason_codes": ["alpha_readiness_fail"],
            "lots": [
                {
                    "lot_id": "routeability-repair-lot:tca",
                    "lot_type": "route_universe_tca_repair",
                    "current_state": "accepted",
                    "blocking_reason_codes": [],
                },
                {
                    "lot_id": "routeability-repair-lot:alpha",
                    "lot_type": "alpha_readiness_repair",
                    "current_state": "blocked",
                    "blocking_reason_codes": ["alpha_readiness_fail"],
                    "hypothesis_ids": ["H-AAPL"],
                },
            ],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 0},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "routeable",
                    "current_blocker": "",
                    "hypothesis_ids": ["H-AAPL"],
                }
            ],
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
            "candidate_ids": ["candidate-aapl"],
            "dataset_snapshot_refs": ["dataset-aapl"],
        },
        hypothesis_payload={
            "summary": {"promotion_eligible_total": 0, "reason_totals": {}},
            "items": [{"hypothesis_id": "H-AAPL", "reasons": []}],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    route_dimension = _dimension(frontier, "route_readiness")

    assert route_dimension["state"] == "blocked"
    assert "alpha_readiness_fail" in route_dimension["reason_codes"]
    assert (
        frontier["next_zero_notional_action"] == "settle_routeability_acceptance_lots"
    )


def test_profit_freshness_lots_carry_non_authoritative_target_notional_rankings() -> (
    None
):
    frontier = _frontier(
        quality_adjusted_profit_frontier={
            "frontier_id": "quality-frontier:target-notional",
            "packets": [
                {
                    "packet_id": "qapf:empirical-target",
                    "blocked_dimension": "empirical_proof",
                    "candidate_id": "candidate-nvda",
                    "post_cost_daily_net_pnl_unlock": "250.50",
                    "target_notional_ranking": {
                        "status": "feasible",
                        "target_daily_net_pnl": "500",
                        "observed_post_cost_expectancy_bps": "8",
                        "required_daily_notional": "625000",
                        "capacity_daily_notional": "900000",
                        "drawdown_budget": "1000",
                        "blocking_reasons": [],
                    },
                }
            ],
        }
    )

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])

    assert selected[0]["target_notional_ranking_basis"] == (
        "non_authoritative_candidate_comparison"
    )
    assert selected[0]["target_notional_rankings"] == [
        {
            "packet_ref": "qapf:empirical-target",
            "status": "feasible",
            "target_daily_net_pnl": "500",
            "observed_post_cost_expectancy_bps": "8",
            "required_daily_notional": "625000",
            "capacity_daily_notional": "900000",
            "drawdown_budget": "1000",
            "blocking_reasons": [],
            "authority": "ranking_metadata_only",
        }
    ]
    assert frontier["summary"]["target_notional_ranked_repair_count"] >= 1

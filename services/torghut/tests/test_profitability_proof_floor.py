from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from app.trading.proof_floor import build_profitability_proof_floor_receipt


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
                "promotion_contract": {"max_avg_abs_slippage_bps": "20"},
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
        "route_symbol_filter_enabled": True,
        "max_notional_per_order": "250",
        "max_notional_per_symbol": "750",
    }


def test_live_degraded_evidence_routes_to_repair_only() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00245",
        trading_mode="live",
        market_session_open=False,
        live_submission_gate={
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 3,
                "promotion_eligible_total": 0,
                "rollback_required_total": 3,
                "state_totals": {"blocked": 1, "shadow": 2},
                "reason_totals": {"slippage_budget_exceeded": 2},
                "informational_reason_totals": {"closed_session_signal_hold": 2},
            },
            "items": [
                {
                    "hypothesis_id": "H-CONT-01",
                    "state": "shadow",
                    "promotion_eligible": False,
                    "reasons": [
                        "tca_evidence_stale",
                        "signal_lag_exceeded",
                        "feature_rows_missing",
                    ],
                    "informational_reasons": ["closed_session_signal_hold"],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "20"},
                    "lineage_ref": {
                        "candidate_id": "chip-paper-microbar-composite@execution-proof",
                        "strategy_id": "intraday_tsmom_v1@paper",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                    },
                }
            ],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence={
            "ok": False,
            "status": "degraded",
            "reason": "quant_pipeline_degraded",
            "max_stage_lag_seconds": 13354,
        },
        market_context_status=_healthy_market_context(),
        tca_summary={
            "order_count": 13775,
            "last_computed_at": "2026-04-02T20:59:45.136640+00:00",
            "avg_abs_slippage_bps": "568.6138848199565249",
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["max_notional"] == "0"
    assert set(receipt["blocking_reasons"]) >= {
        "simple_submit_disabled",
        "alpha_readiness_not_promotion_eligible",
        "quant_pipeline_degraded",
        "execution_tca_stale",
    }

    repair_codes = [repair["code"] for repair in receipt["repair_ladder"]]
    assert repair_codes[:4] == [
        "live_submit_gate_closed",
        "repair_alpha_readiness",
        "repair_execution_tca",
        "repair_quant_ingestion",
    ]
    assert repair_codes[-1] == "closed_session_signal_hold"
    alpha_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "alpha_readiness"
    )
    assert alpha_dimension["source_ref"]["reason_totals"] == {
        "slippage_budget_exceeded": 2
    }
    assert alpha_dimension["source_ref"]["informational_reason_totals"] == {
        "closed_session_signal_hold": 2
    }
    assert alpha_dimension["source_ref"]["hypothesis_ids"] == ["H-CONT-01"]
    assert alpha_dimension["source_ref"]["blocked_hypothesis_ids"] == ["H-CONT-01"]
    assert alpha_dimension["source_ref"]["repair_target_count"] == 1
    assert alpha_dimension["source_ref"]["blocked_repair_target_count"] == 1
    repair_targets = cast(
        list[Mapping[str, Any]], alpha_dimension["source_ref"]["repair_targets"]
    )
    assert repair_targets == [
        {
            "hypothesis_id": "H-CONT-01",
            "state": "shadow",
            "promotion_eligible": False,
            "reasons": [
                "feature_rows_missing",
                "signal_lag_exceeded",
                "tca_evidence_stale",
            ],
            "informational_reasons": ["closed_session_signal_hold"],
            "candidate_id": "chip-paper-microbar-composite@execution-proof",
            "strategy_id": "intraday_tsmom_v1@paper",
            "lane_id": "continuation",
            "strategy_family": "intraday_continuation",
        }
    ]


def test_alpha_repair_targets_flow_to_route_reacquisition_records() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00364",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 1,
                "promotion_eligible_total": 0,
                "rollback_required_total": 0,
                "state_totals": {"shadow": 1},
                "reason_totals": {"post_cost_expectancy_non_positive": 1},
            },
            "items": [
                {
                    "hypothesis_id": "H-CONT-01",
                    "state": "shadow",
                    "promotion_eligible": False,
                    "reasons": ["post_cost_expectancy_non_positive"],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "12"},
                    "lineage_ref": {
                        "candidate_id": "chip-paper-microbar-composite@execution-proof",
                        "strategy_id": "intraday_tsmom_v1@paper",
                    },
                }
            ],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            "order_count": 2033,
            "filled_execution_count": 2033,
            "unsettled_execution_count": 0,
            "last_computed_at": NOW.isoformat(),
            "latest_execution_created_at": NOW.isoformat(),
            "avg_abs_slippage_bps": "9.25",
            "scope_symbols": ["AAPL"],
            "scope_symbol_count": 1,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 2033,
                    "avg_abs_slippage_bps": "9.25",
                    "max_abs_slippage_bps": "112.77",
                    "last_computed_at": NOW.isoformat(),
                }
            ],
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    route_book = cast(dict[str, Any], receipt["route_reacquisition_book"])
    records = cast(list[Mapping[str, Any]], route_book["records"])
    assert len(records) == 1
    assert records[0]["symbol"] == "AAPL"
    assert records[0]["state"] == "probing"
    assert records[0]["hypothesis_ids"] == ["H-CONT-01"]


def test_live_all_clear_routes_to_micro_candidate_with_configured_notional() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00245",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "live_micro_candidate"
    assert receipt["floor_state"] == "live_micro_ready"
    assert receipt["capital_state"] == "live_allowed"
    assert receipt["max_notional"] == "250"
    assert receipt["blocking_reasons"] == []
    assert receipt["repair_ladder"] == []


def test_paper_all_clear_routes_to_paper_candidate() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00345",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "paper_candidate"
    assert receipt["floor_state"] == "paper_ready"
    assert receipt["capital_state"] == "paper_allowed"
    assert receipt["max_notional"] == "250"


def test_optional_degraded_quant_evidence_is_informational() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00345",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence={
            "required": False,
            "ok": True,
            "status": "degraded",
            "reason": "quant_latest_metrics_empty",
            "blocking_reasons": [],
            "informational_reasons": [
                "quant_latest_metrics_empty",
                "quant_pipeline_stages_missing",
            ],
            "account": "paper",
            "window": "15m",
        },
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    quant_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "quant_ingestion"
    )
    repair_codes = [repair["code"] for repair in receipt["repair_ladder"]]

    assert receipt["route_state"] == "paper_candidate"
    assert receipt["capital_state"] == "paper_allowed"
    assert receipt["blocking_reasons"] == []
    assert quant_dimension["state"] == "informational"
    assert quant_dimension["capital_effect"] == "none"
    assert "repair_quant_ingestion" not in repair_codes


def test_required_degraded_quant_evidence_keeps_capital_at_zero() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00345",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence={
            "required": True,
            "ok": False,
            "status": "degraded",
            "reason": "quant_latest_metrics_empty",
            "blocking_reasons": ["quant_latest_metrics_empty"],
            "informational_reasons": [],
            "account": "paper",
            "window": "15m",
        },
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["quant_latest_metrics_empty"]
    assert [repair["code"] for repair in receipt["repair_ladder"]] == [
        "repair_quant_ingestion"
    ]


def test_hypothesis_market_context_stale_blocks_even_without_route_alert() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00245",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 1,
                "promotion_eligible_total": 0,
                "rollback_required_total": 1,
                "state_totals": {"shadow": 1},
            },
            "items": [
                {
                    "hypothesis_id": "H-REV-01",
                    "reasons": ["market_context_stale"],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "20"},
                }
            ],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status={
            "alert_active": False,
            "last_reason": "ok",
            "last_freshness_seconds": None,
            "last_quality_score": None,
            "last_domain_states": {},
        },
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    market_context_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "market_context"
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert "market_context_stale" in receipt["blocking_reasons"]
    assert market_context_dimension["state"] == "stale"
    assert market_context_dimension["reason"] == "market_context_stale"
    assert market_context_dimension["source_ref"]["hypothesis_reason_count"] == 1
    assert [repair["code"] for repair in receipt["repair_ladder"]] == [
        "repair_alpha_readiness",
        "repair_market_context",
    ]


def test_closed_session_market_context_stale_is_next_open_hold() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00289",
        trading_mode="live",
        market_session_open=False,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status={
            "alert_active": True,
            "alert_reason": "market_context_stale",
            "last_reason": "market_context_stale",
            "last_freshness_seconds": 9600,
            "last_quality_score": 0.68,
            "last_domain_states": {
                "technicals": "stale",
                "fundamentals": "stale",
                "news": "stale",
                "regime": "stale",
            },
        },
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    market_context_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "market_context"
    )

    assert receipt["route_state"] == "observe_only"
    assert receipt["capital_state"] == "closed_session_hold"
    assert receipt["blocking_reasons"] == []
    assert market_context_dimension["state"] == "informational"
    assert market_context_dimension["reason"] == "expected_market_closed_staleness"
    assert market_context_dimension["capital_effect"] == "none"
    assert [repair["code"] for repair in receipt["repair_ladder"]] == [
        "closed_session_market_context_hold"
    ]


def test_live_submit_disabled_fails_closed_even_when_other_dimensions_pass() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00245",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["simple_submit_disabled"]


def test_tca_slippage_guardrail_failure_keeps_capital_at_zero() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00245",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(avg_abs_slippage_bps="25"),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["execution_tca_slippage_guardrail_exceeded"]


def test_execution_tca_source_ref_exposes_symbol_route_blockers() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00267",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="25"),
            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
            "scope_symbol_count": 3,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 3,
                    "avg_abs_slippage_bps": "6",
                    "max_abs_slippage_bps": "9",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "NVDA",
                    "order_count": 4,
                    "avg_abs_slippage_bps": "25",
                    "max_abs_slippage_bps": "31",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "ORCL",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
            ],
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    tca_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "execution_tca"
    )
    source_ref = cast(Mapping[str, Any], tca_dimension["source_ref"])
    symbol_routes = cast(Mapping[str, Any], source_ref["symbol_routes"])

    assert symbol_routes["scope_symbols"] == ["AAPL", "NVDA", "ORCL"]
    assert symbol_routes["routeable_symbol_count"] == 1
    assert symbol_routes["blocked_symbol_count"] == 1
    assert symbol_routes["missing_symbol_count"] == 1
    assert symbol_routes["routeable_symbols"][0]["symbol"] == "AAPL"
    assert symbol_routes["blocked_symbols"][0]["symbol"] == "NVDA"
    assert symbol_routes["missing_symbols"] == ["ORCL"]
    assert source_ref["aggregate_reason"] == "execution_tca_slippage_guardrail_exceeded"
    exclusions = cast(Mapping[str, Any], source_ref["route_universe_exclusions"])
    assert exclusions["state"] == "enforced"
    assert exclusions["candidate_symbol_count"] == 1
    assert exclusions["excluded_symbol_count"] == 2
    assert exclusions["max_notional_for_excluded_symbols"] == "0"
    route_book = cast(Mapping[str, Any], receipt["route_reacquisition_book"])
    route_summary = cast(Mapping[str, Any], route_book["summary"])
    route_records = cast(list[Mapping[str, Any]], route_book["records"])
    assert route_summary["routeable_symbol_count"] == 1
    assert route_summary["blocked_symbol_count"] == 1
    assert route_summary["missing_symbol_count"] == 1
    assert route_summary["candidate_symbols"] == ["AAPL"]
    assert route_records[0]["symbol"] == "AAPL"
    assert route_records[0]["state"] == "routeable"
    assert tca_dimension["state"] == "pass"
    assert tca_dimension["reason"] == "execution_tca_route_universe_exclusions_applied"
    assert receipt["route_state"] == "live_micro_candidate"
    assert receipt["capital_state"] == "live_allowed"
    assert receipt["blocking_reasons"] == []
    assert receipt["repair_ladder"][0]["code"] == "repair_route_universe"
    assert (
        receipt["repair_ladder"][0]["reason"]
        == "execution_tca_route_universe_exclusions_applied"
    )


def test_execution_tca_route_universe_uses_widest_hypothesis_guardrail() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00268",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 2,
                "promotion_eligible_total": 2,
                "rollback_required_total": 0,
                "state_totals": {"promotion_eligible": 2},
            },
            "items": [
                {
                    "hypothesis_id": "microstructure-breakout",
                    "reasons": [],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "8"},
                },
                {
                    "hypothesis_id": "event-reversion",
                    "reasons": [],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "12"},
                },
            ],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="13"),
            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
            "scope_symbol_count": 3,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 2033,
                    "avg_abs_slippage_bps": "9.25",
                    "max_abs_slippage_bps": "112.77",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "NVDA",
                    "order_count": 3289,
                    "avg_abs_slippage_bps": "13.47",
                    "max_abs_slippage_bps": "178.40",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "ORCL",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
            ],
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    tca_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "execution_tca"
    )
    source_ref = cast(Mapping[str, Any], tca_dimension["source_ref"])
    symbol_routes = cast(Mapping[str, Any], source_ref["symbol_routes"])

    assert tca_dimension["state"] == "pass"
    assert tca_dimension["reason"] == "execution_tca_route_universe_exclusions_applied"
    assert source_ref["aggregate_reason"] == "execution_tca_slippage_guardrail_exceeded"
    exclusions = cast(Mapping[str, Any], source_ref["route_universe_exclusions"])
    assert exclusions["state"] == "enforced"
    assert exclusions["excluded_symbol_count"] == 2
    assert symbol_routes["slippage_guardrail_bps"] == "8"
    assert symbol_routes["route_slippage_guardrail_bps"] == "12"
    assert symbol_routes["routeable_symbol_count"] == 1
    assert symbol_routes["routeable_symbols"][0]["symbol"] == "AAPL"
    assert symbol_routes["blocked_symbol_count"] == 1
    assert symbol_routes["blocked_symbols"][0]["symbol"] == "NVDA"
    assert symbol_routes["missing_symbol_count"] == 1
    assert symbol_routes["missing_symbols"] == ["ORCL"]
    assert receipt["blocking_reasons"] == []


def test_execution_tca_route_universe_uses_adverse_signed_shortfall() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00757",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 2,
                "promotion_eligible_total": 2,
                "rollback_required_total": 0,
                "state_totals": {"promotion_eligible": 2},
            },
            "items": [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "reasons": [],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "8"},
                },
                {
                    "hypothesis_id": "H-CONT-01",
                    "reasons": [],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "12"},
                },
            ],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="28"),
            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
            "scope_symbol_count": 3,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 1,
                    "avg_abs_slippage_bps": "28.05213012",
                    "avg_realized_shortfall_bps": "-28.05213012",
                    "max_abs_slippage_bps": "28.05213012",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "NVDA",
                    "order_count": 1,
                    "avg_abs_slippage_bps": "25",
                    "avg_realized_shortfall_bps": "25",
                    "max_abs_slippage_bps": "25",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "ORCL",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "avg_realized_shortfall_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
            ],
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    tca_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "execution_tca"
    )
    source_ref = cast(Mapping[str, Any], tca_dimension["source_ref"])
    symbol_routes = cast(Mapping[str, Any], source_ref["symbol_routes"])

    assert tca_dimension["state"] == "pass"
    assert tca_dimension["reason"] == "execution_tca_route_universe_exclusions_applied"
    assert source_ref["aggregate_reason"] == "execution_tca_slippage_guardrail_exceeded"
    assert symbol_routes["route_slippage_guardrail_bps"] == "12"
    assert symbol_routes["routeable_symbol_count"] == 1
    assert symbol_routes["routeable_symbols"][0]["symbol"] == "AAPL"
    assert (
        symbol_routes["routeable_symbols"][0]["avg_abs_slippage_bps"]
        == "28.05213012"
    )
    assert (
        symbol_routes["routeable_symbols"][0]["avg_realized_shortfall_bps"]
        == "-28.05213012"
    )
    assert symbol_routes["routeable_symbols"][0]["route_adverse_slippage_bps"] == "0"
    assert (
        symbol_routes["routeable_symbols"][0]["route_slippage_basis"]
        == "signed_realized_shortfall_bps"
    )
    assert symbol_routes["blocked_symbol_count"] == 1
    assert symbol_routes["blocked_symbols"][0]["symbol"] == "NVDA"
    assert symbol_routes["blocked_symbols"][0]["route_adverse_slippage_bps"] == "25"

    route_book = cast(Mapping[str, Any], receipt["route_reacquisition_book"])
    route_summary = cast(Mapping[str, Any], route_book["summary"])
    route_records = cast(list[Mapping[str, Any]], route_book["records"])
    assert route_summary["candidate_symbols"] == ["AAPL"]
    aapl_record = next(item for item in route_records if item["symbol"] == "AAPL")
    assert aapl_record["state"] == "routeable"
    assert aapl_record["route_adverse_slippage_bps"] == "0"


def test_execution_tca_route_universe_requires_symbol_filter_before_unblock() -> None:
    simple_lane_status = {
        **_simple_lane_status(),
        "route_symbol_filter_enabled": False,
    }
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00268",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="25"),
            "scope_symbols": ["AAPL", "NVDA"],
            "scope_symbol_count": 2,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 3,
                    "avg_abs_slippage_bps": "6",
                    "max_abs_slippage_bps": "9",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "NVDA",
                    "order_count": 4,
                    "avg_abs_slippage_bps": "25",
                    "max_abs_slippage_bps": "31",
                    "last_computed_at": NOW.isoformat(),
                },
            ],
        },
        simple_lane_status=simple_lane_status,
        now=NOW,
    )

    tca_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "execution_tca"
    )
    source_ref = cast(Mapping[str, Any], tca_dimension["source_ref"])
    exclusions = cast(Mapping[str, Any], source_ref["route_universe_exclusions"])

    assert exclusions["state"] == "missing_enforcement"
    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == [
        "execution_tca_route_universe_incomplete",
    ]


def test_execution_tca_zero_routeable_symbols_blocks_capital() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00268",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="25"),
            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
            "scope_symbol_count": 3,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 2033,
                    "avg_abs_slippage_bps": "21.25",
                    "max_abs_slippage_bps": "112.77",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "NVDA",
                    "order_count": 3289,
                    "avg_abs_slippage_bps": "23.47",
                    "max_abs_slippage_bps": "178.40",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "ORCL",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
            ],
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    tca_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "execution_tca"
    )
    source_ref = cast(Mapping[str, Any], tca_dimension["source_ref"])
    symbol_routes = cast(Mapping[str, Any], source_ref["symbol_routes"])

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["execution_tca_route_universe_empty"]
    assert source_ref["aggregate_reason"] == "execution_tca_slippage_guardrail_exceeded"
    assert symbol_routes["routeable_symbol_count"] == 0
    assert symbol_routes["blocked_symbol_count"] == 2
    assert symbol_routes["missing_symbol_count"] == 1
    route_book = cast(Mapping[str, Any], receipt["route_reacquisition_book"])
    route_summary = cast(Mapping[str, Any], route_book["summary"])
    assert route_summary["routeable_symbol_count"] == 0
    assert route_summary["blocked_symbol_count"] == 2
    assert route_summary["missing_symbol_count"] == 1
    assert route_summary["expected_unblock_value"] == 5
    assert receipt["repair_ladder"][0]["code"] == "repair_route_universe"
    assert receipt["repair_ladder"][0]["reason"] == "execution_tca_route_universe_empty"


def test_sim_routeable_symbol_becomes_repair_probe_without_capital_unlock() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00372",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status={
            "alert_active": True,
            "alert_reason": "market_context_stale",
            "last_freshness_seconds": 86400,
            "last_quality_score": 0.62,
            "last_domain_states": {"news": "stale"},
        },
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="5.5"),
            "scope_symbols": ["AAPL", "AMZN", "NVDA"],
            "scope_symbol_count": 3,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
                {
                    "symbol": "AMZN",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
                {
                    "symbol": "NVDA",
                    "order_count": 5,
                    "avg_abs_slippage_bps": "5.57",
                    "max_abs_slippage_bps": "7.10",
                    "last_computed_at": NOW.isoformat(),
                },
            ],
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    route_book = cast(Mapping[str, Any], receipt["route_reacquisition_book"])
    route_summary = cast(Mapping[str, Any], route_book["summary"])
    route_records = cast(list[Mapping[str, Any]], route_book["records"])
    nvda = next(item for item in route_records if item["symbol"] == "NVDA")

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert "market_context_stale" in receipt["blocking_reasons"]
    assert route_summary["probing_symbol_count"] == 1
    assert route_summary["missing_symbol_count"] == 2
    assert route_summary["candidate_symbols"] == ["NVDA"]
    assert nvda["state"] == "probing"
    assert nvda["paper_probe_notional_limit"] == "0"


def test_paper_route_probe_config_flows_into_proof_floor_route_book() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00670",
        trading_mode="paper",
        market_session_open=False,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 1,
                "promotion_eligible_total": 0,
                "rollback_required_total": 0,
                "state_totals": {"blocked": 1},
            },
            "items": [
                {
                    "hypothesis_id": "H-CONT-01",
                    "reasons": ["runtime_ledger_proof_missing"],
                    "promotion_eligible": False,
                    "promotion_contract": {"max_avg_abs_slippage_bps": "20"},
                }
            ],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="5"),
            "scope_symbols": ["AAPL", "AMZN"],
            "scope_symbol_count": 2,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "last_computed_at": None,
                },
                {
                    "symbol": "AMZN",
                    "order_count": 1,
                    "avg_abs_slippage_bps": "3.07908692",
                    "max_abs_slippage_bps": "3.07908692",
                    "last_computed_at": NOW.isoformat(),
                },
            ],
        },
        simple_lane_status={
            **_simple_lane_status(),
            "paper_route_probe_enabled": True,
            "paper_route_probe_max_notional": "25",
        },
        now=NOW,
    )

    probe = cast(Mapping[str, Any], receipt["paper_route_probe"])
    route_book = cast(Mapping[str, Any], receipt["route_reacquisition_book"])
    route_probe = cast(Mapping[str, Any], route_book["paper_route_probe"])
    summary = cast(Mapping[str, Any], route_book["summary"])

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert probe == route_probe
    assert probe["configured_enabled"] is True
    assert probe["active"] is False
    assert probe["next_session_max_notional"] == "25"
    assert probe["eligible_symbols"] == ["AMZN", "AAPL"]
    assert probe["capital_authority"] == "none"
    assert summary["paper_route_probe_eligible_symbols"] == ["AMZN", "AAPL"]


def test_settled_old_tca_exposes_execution_quality_instead_of_staleness() -> None:
    settled_at = NOW - timedelta(days=34)
    latest_execution_at = settled_at - timedelta(seconds=1)

    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00256",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            "order_count": 13775,
            "filled_execution_count": 13571,
            "unsettled_execution_count": 0,
            "latest_execution_created_at": latest_execution_at.isoformat(),
            "last_computed_at": settled_at.isoformat(),
            "avg_abs_slippage_bps": "568.6138848199565249",
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    tca_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "execution_tca"
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["execution_tca_slippage_guardrail_exceeded"]
    assert "execution_tca_stale" not in receipt["blocking_reasons"]
    assert tca_dimension["state"] == "fail"
    assert tca_dimension["source_ref"]["unsettled_execution_count"] == 0


def test_unsettled_execution_after_old_tca_stays_stale() -> None:
    settled_at = NOW - timedelta(days=3)
    latest_execution_at = NOW - timedelta(hours=1)

    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-00256",
        trading_mode="live",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "0.10x canary",
        },
        hypothesis_payload=_healthy_hypothesis_payload(),
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            "order_count": 12,
            "filled_execution_count": 13,
            "unsettled_execution_count": 1,
            "latest_execution_created_at": latest_execution_at.isoformat(),
            "last_computed_at": settled_at.isoformat(),
            "avg_abs_slippage_bps": "5",
        },
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["execution_tca_stale"]

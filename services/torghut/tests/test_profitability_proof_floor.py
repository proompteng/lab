from __future__ import annotations

from datetime import datetime, timedelta, timezone

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
            },
            "items": [
                {
                    "hypothesis_id": "chip-paper-microbar-composite",
                    "reasons": [
                        "tca_evidence_stale",
                        "signal_lag_exceeded",
                        "feature_rows_missing",
                    ],
                    "promotion_contract": {"max_avg_abs_slippage_bps": "20"},
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

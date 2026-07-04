from __future__ import annotations

from app.trading.route_reacquisition import build_route_reacquisition_book

from tests.profitability_proof_floor.support import (
    Any,
    Mapping,
    NOW,
    _fresh_tca_summary,
    _healthy_empirical_jobs,
    _healthy_hypothesis_payload,
    _healthy_market_context,
    _healthy_quant_evidence,
    _simple_lane_status,
    build_profitability_proof_floor_receipt,
    cast,
)


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
        "hypothesis_not_promotion_eligible",
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


def test_bounded_paper_target_symbols_feed_route_probe_without_promotion() -> None:
    simple_lane_status = {
        **_simple_lane_status(),
        "paper_route_probe_enabled": True,
        "paper_route_probe_allow_live_mode": True,
        "paper_route_probe_max_notional": "100",
    }
    receipt = build_profitability_proof_floor_receipt(
        account_label="PA3SX7FYNUTF",
        torghut_revision="torghut-01274",
        trading_mode="live",
        market_session_open=False,
        live_submission_gate={
            "allowed": False,
            "reason": "live_submit_activation_expired",
            "blocked_reasons": ["live_submit_activation_expired"],
            "capital_stage": "shadow",
        },
        hypothesis_payload={
            "summary": {
                "hypotheses_total": 0,
                "promotion_eligible_total": 0,
                "rollback_required_total": 0,
                "state_totals": {},
            },
            "items": [],
        },
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary={
            "order_count": 0,
            "last_computed_at": None,
            "filled_execution_count": 0,
        },
        simple_lane_status=simple_lane_status,
        paper_route_probe_target_symbols=["aapl", "NVDA", "AAPL"],
        now=NOW,
    )

    route_book = cast(Mapping[str, Any], receipt["route_reacquisition_book"])
    probe = cast(Mapping[str, Any], route_book["paper_route_probe"])
    summary = cast(Mapping[str, Any], route_book["summary"])
    source_refs = cast(Mapping[str, Any], route_book["source_refs"])

    assert receipt["capital_state"] == "zero_notional"
    assert receipt["route_state"] == "repair_only"
    assert probe["promotion_authority"] is False
    assert probe["active"] is False
    assert probe["next_session_max_notional"] == "100"
    assert probe["eligible_symbols"] == ["AAPL", "NVDA"]
    assert probe["blocking_reasons"] == ["session_closed"]
    assert summary["paper_route_probe_eligible_symbols"] == ["AAPL", "NVDA"]
    assert source_refs["paper_route_probe_target_symbols"] == ["AAPL", "NVDA"]
    assert source_refs["paper_route_probe_target_symbol_source"] == (
        "bounded_paper_route_collection_target_plan"
    )


def test_route_probe_accepts_comma_separated_target_symbols() -> None:
    route_book = build_route_reacquisition_book(
        proof_floor_receipt={
            "account_label": "PA3SX7FYNUTF",
            "generated_at": NOW,
            "proof_dimensions": [],
        },
        trading_mode="live",
        market_session_open=True,
        paper_route_probe_enabled=True,
        paper_route_probe_allow_live_mode=True,
        paper_route_probe_max_notional="100",
        paper_route_probe_target_symbols="msft,TSLA,MSFT",
    )

    probe = cast(Mapping[str, Any], route_book["paper_route_probe"])
    assert probe["eligible_symbols"] == ["MSFT", "TSLA"]


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
                    "promotion_contract": {
                        "max_avg_abs_slippage_bps": "12",
                        "observed_post_cost_expectancy_bps": "8",
                        "capacity_daily_notional": "1000000",
                        "drawdown_budget": "1200",
                        "allocated_sleeve_equity": "100000",
                    },
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


def test_required_order_feed_lifecycle_blocks_simple_proof_floor() -> None:
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
        simple_lane_status={
            **_simple_lane_status(),
            "order_feed_telemetry_enabled": False,
            "order_feed_lifecycle_status": "disabled",
        },
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["order_feed_lifecycle_disabled"]
    order_feed_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "order_feed_lifecycle"
    )
    assert order_feed_dimension["state"] == "fail"
    assert order_feed_dimension["capital_effect"] == "paper_hold"
    assert receipt["repair_ladder"][0]["code"] == "enable_order_feed_lifecycle"


def test_required_order_feed_ingestion_config_blocks_simple_proof_floor() -> None:
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
        simple_lane_status={
            **_simple_lane_status(),
            "order_feed_ingestion_enabled": False,
            "order_feed_bootstrap_configured": False,
            "order_feed_topic_count": 0,
        },
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["order_feed_ingestion_disabled"]
    order_feed_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "order_feed_lifecycle"
    )
    assert order_feed_dimension["state"] == "fail"
    assert order_feed_dimension["reason"] == "order_feed_ingestion_disabled"
    assert order_feed_dimension["source_ref"]["order_feed_telemetry_enabled"] is True
    assert order_feed_dimension["source_ref"]["order_feed_ingestion_enabled"] is False
    assert order_feed_dimension["source_ref"]["order_feed_topic_count"] == 0
    assert receipt["repair_ladder"][0]["code"] == "enable_order_feed_lifecycle"


def test_required_order_feed_bootstrap_config_blocks_simple_proof_floor() -> None:
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
        simple_lane_status={
            **_simple_lane_status(),
            "order_feed_bootstrap_configured": False,
        },
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["order_feed_bootstrap_missing"]
    order_feed_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "order_feed_lifecycle"
    )
    assert order_feed_dimension["state"] == "fail"
    assert order_feed_dimension["reason"] == "order_feed_bootstrap_missing"
    assert receipt["repair_ladder"][0]["action"] == (
        "configure_order_feed_bootstrap_before_proof_floor_authority"
    )


def test_required_order_feed_topic_config_blocks_simple_proof_floor() -> None:
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
        simple_lane_status={
            **_simple_lane_status(),
            "order_feed_topic_count": 0,
        },
        now=NOW,
    )

    assert receipt["route_state"] == "repair_only"
    assert receipt["capital_state"] == "zero_notional"
    assert receipt["blocking_reasons"] == ["order_feed_topic_missing"]
    order_feed_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "order_feed_lifecycle"
    )
    assert order_feed_dimension["state"] == "fail"
    assert order_feed_dimension["reason"] == "order_feed_topic_missing"
    assert receipt["repair_ladder"][0]["action"] == (
        "configure_order_feed_topic_before_proof_floor_authority"
    )


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

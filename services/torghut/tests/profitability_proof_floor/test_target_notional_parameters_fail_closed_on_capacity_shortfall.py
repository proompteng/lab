from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.profitability_proof_floor.support import (
    Any,
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


def test_target_notional_parameters_fail_closed_on_capacity_shortfall() -> None:
    hypothesis = _healthy_hypothesis_payload()
    item = cast(list[dict[str, Any]], hypothesis["items"])[0]
    contract = cast(dict[str, object], item["promotion_contract"])
    contract["observed_post_cost_expectancy_bps"] = "5"
    contract["capacity_daily_notional"] = "999999"

    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-target-sizing",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload=hypothesis,
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    sizing_dimension = next(
        item
        for item in receipt["proof_dimensions"]
        if item["dimension"] == "target_notional_sizing"
    )

    assert receipt["capital_state"] == "zero_notional"
    assert "target_notional_capacity_below_required" in receipt["blocking_reasons"]
    assert sizing_dimension["state"] == "fail"
    assert (
        receipt["target_notional_parameters"]["candidates"][0][
            "required_daily_notional"
        ]
        == "1000000"
    )


def test_target_notional_parameters_fail_closed_on_drawdown_budget() -> None:
    hypothesis = _healthy_hypothesis_payload()
    item = cast(list[dict[str, Any]], hypothesis["items"])[0]
    contract = cast(dict[str, object], item["promotion_contract"])
    contract["drawdown_budget"] = "3500"
    contract["allocated_sleeve_equity"] = "100000"

    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-target-sizing",
        trading_mode="paper",
        market_session_open=True,
        live_submission_gate={
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
        },
        hypothesis_payload=hypothesis,
        empirical_jobs_status=_healthy_empirical_jobs(),
        quant_evidence=_healthy_quant_evidence(),
        market_context_status=_healthy_market_context(),
        tca_summary=_fresh_tca_summary(),
        simple_lane_status=_simple_lane_status(),
        now=NOW,
    )

    assert receipt["capital_state"] == "zero_notional"
    assert "target_drawdown_budget_exceeds_cap" in receipt["blocking_reasons"]
    assert (
        receipt["target_notional_parameters"]["candidates"][0]["drawdown_cap"] == "3000"
    )

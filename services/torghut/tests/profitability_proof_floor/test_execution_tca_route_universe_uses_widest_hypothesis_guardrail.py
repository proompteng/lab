from __future__ import annotations

from tests.profitability_proof_floor.support import (
    Any,
    Mapping,
    NOW,
    _fresh_tca_summary,
    _healthy_empirical_jobs,
    _healthy_hypothesis_payload,
    _healthy_market_context,
    _healthy_quant_evidence,
    _route_universe_adverse_slippage_clear,
    _simple_lane_status,
    build_profitability_proof_floor_receipt,
    cast,
    timedelta,
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
                    "promotion_contract": {
                        "max_avg_abs_slippage_bps": "8",
                        "observed_post_cost_expectancy_bps": "8",
                        "capacity_daily_notional": "1000000",
                        "drawdown_budget": "1200",
                        "allocated_sleeve_equity": "100000",
                    },
                },
                {
                    "hypothesis_id": "event-reversion",
                    "reasons": [],
                    "promotion_contract": {
                        "max_avg_abs_slippage_bps": "12",
                        "observed_post_cost_expectancy_bps": "8",
                        "capacity_daily_notional": "1000000",
                        "drawdown_budget": "1200",
                        "allocated_sleeve_equity": "100000",
                    },
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
                    "promotion_contract": {
                        "max_avg_abs_slippage_bps": "8",
                        "observed_post_cost_expectancy_bps": "8",
                        "capacity_daily_notional": "1000000",
                        "drawdown_budget": "1200",
                        "allocated_sleeve_equity": "100000",
                    },
                },
                {
                    "hypothesis_id": "H-CONT-01",
                    "reasons": [],
                    "promotion_contract": {
                        "max_avg_abs_slippage_bps": "12",
                        "observed_post_cost_expectancy_bps": "8",
                        "capacity_daily_notional": "1000000",
                        "drawdown_budget": "1200",
                        "allocated_sleeve_equity": "100000",
                    },
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
        symbol_routes["routeable_symbols"][0]["avg_abs_slippage_bps"] == "28.05213012"
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


def test_execution_tca_signed_adverse_clear_unblocks_aggregate_abs_slippage() -> None:
    receipt = build_profitability_proof_floor_receipt(
        account_label="TORGHUT_SIM",
        torghut_revision="torghut-sim-00979",
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
        tca_summary={
            **_fresh_tca_summary(avg_abs_slippage_bps="29.9205222873469388"),
            "scope_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
            "scope_symbol_count": 4,
            "symbol_breakdown": [
                {
                    "symbol": "AAPL",
                    "order_count": 19,
                    "avg_abs_slippage_bps": "10.0605907784615385",
                    "avg_realized_shortfall_bps": "-3.7676291292307692",
                    "max_abs_slippage_bps": "52.57029761",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "AMZN",
                    "order_count": 24,
                    "avg_abs_slippage_bps": "15.533415621",
                    "avg_realized_shortfall_bps": "-12.782019899",
                    "max_abs_slippage_bps": "109.74841602",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "INTC",
                    "order_count": 9,
                    "avg_abs_slippage_bps": "76.5197505133333333",
                    "avg_realized_shortfall_bps": "-76.21408033",
                    "max_abs_slippage_bps": "437.54186202",
                    "last_computed_at": NOW.isoformat(),
                },
                {
                    "symbol": "NVDA",
                    "order_count": 14,
                    "avg_abs_slippage_bps": "56.553109646",
                    "avg_realized_shortfall_bps": "-56.064048032",
                    "max_abs_slippage_bps": "524.38041507",
                    "last_computed_at": NOW.isoformat(),
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
    adverse_clear = cast(
        Mapping[str, Any], source_ref["route_universe_adverse_slippage"]
    )

    assert tca_dimension["state"] == "pass"
    assert (
        tca_dimension["reason"] == "execution_tca_route_universe_adverse_slippage_clear"
    )
    assert source_ref["aggregate_reason"] == "execution_tca_slippage_guardrail_exceeded"
    assert symbol_routes["routeable_symbol_count"] == 4
    assert symbol_routes["blocked_symbol_count"] == 0
    assert symbol_routes["missing_symbol_count"] == 0
    assert adverse_clear["state"] == "clear"
    assert receipt["blocking_reasons"] == []
    assert [
        item["code"] for item in cast(list[Mapping[str, Any]], receipt["repair_ladder"])
    ] == []


def test_route_universe_adverse_slippage_clear_fails_closed() -> None:
    base_symbol_routes: dict[str, object] = {
        "scope_symbol_count": 1,
        "routeable_symbol_count": 1,
        "blocked_symbol_count": 0,
        "missing_symbol_count": 0,
        "slippage_guardrail_bps": "20",
        "routeable_symbols": [
            {
                "symbol": "AAPL",
                "route_slippage_basis": "signed_realized_shortfall_bps",
                "route_adverse_slippage_bps": "0",
            }
        ],
    }
    cases: list[tuple[str, dict[str, object], bool]] = [
        ("filter_disabled", base_symbol_routes, False),
        (
            "inconsistent_counts",
            {**base_symbol_routes, "scope_symbol_count": 2},
            True,
        ),
        (
            "missing_guardrail",
            {
                key: value
                for key, value in base_symbol_routes.items()
                if key != "slippage_guardrail_bps"
            },
            True,
        ),
        (
            "malformed_routeable_row",
            {**base_symbol_routes, "routeable_symbols": ["AAPL"]},
            True,
        ),
        (
            "wrong_slippage_basis",
            {
                **base_symbol_routes,
                "routeable_symbols": [
                    {
                        "symbol": "AAPL",
                        "route_slippage_basis": "avg_abs_slippage_bps_fallback",
                        "route_adverse_slippage_bps": "0",
                    }
                ],
            },
            True,
        ),
        (
            "adverse_slippage_above_guardrail",
            {
                **base_symbol_routes,
                "routeable_symbols": [
                    {
                        "symbol": "AAPL",
                        "route_slippage_basis": "signed_realized_shortfall_bps",
                        "route_adverse_slippage_bps": "25",
                    }
                ],
            },
            True,
        ),
    ]

    for case_name, symbol_routes, route_filter_enabled in cases:
        assert (
            _route_universe_adverse_slippage_clear(
                symbol_routes,
                route_filter_enabled=route_filter_enabled,
                aggregate_tca_reason="execution_tca_slippage_guardrail_exceeded",
            )
            is False
        ), case_name


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
            "paper_route_probe_allow_live_mode": True,
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
    assert probe["live_mode_collection_allowed"] is True
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

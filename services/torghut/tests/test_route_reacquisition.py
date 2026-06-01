from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from app.trading.route_reacquisition import (
    _dimension,
    _float,
    _hypothesis_ids,
    _int,
    _next_action,
    _receipt_id,
    build_route_reacquisition_book,
)
from app.trading.route_reacquisition_board import build_route_reacquisition_board


def test_empty_proof_floor_builds_zero_value_repair_book() -> None:
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-07T16:00:00+00:00",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "proof_dimensions": [],
        },
        trading_mode="paper",
        market_session_open=True,
    )

    assert book["state"] == "candidate"
    assert book["capital_rule"] == "paper_probe_requires_receipt_chain"
    assert book["records"] == []
    summary = cast(Mapping[str, Any], book["summary"])
    assert summary["expected_unblock_value"] == 0


def test_route_book_helpers_normalize_repair_inputs() -> None:
    assert _int(True) == 1
    assert _int(2.9) == 2
    assert _int("7.8") == 7
    assert _int("not-a-number", default=42) == 42
    assert _float(True) == 1.0
    assert _float(2) == 2.0
    assert _float("9.25") == 9.25
    assert _float("not-a-number") is None
    assert _float("") is None
    assert (
        _dimension(
            {"proof_dimensions": [{"dimension": "market_context"}]}, "execution_tca"
        )
        == {}
    )
    assert (
        _receipt_id({"last_receipt_id": "receipt-1"}, "receipt_id", "last_receipt_id")
        == "receipt-1"
    )
    assert _hypothesis_ids(
        {"hypothesis_ids": ["H-2", ""], "candidate_ids": ["H-1", "H-2"]}
    ) == [
        "H-1",
        "H-2",
    ]
    assert (
        _next_action(state="blocked", reason="slippage_guardrail")
        == "reduce_execution_slippage_before_route_reentry"
    )
    assert (
        _next_action(state="retired", reason="manual_override")
        == "retire_symbol_until_evidence_returns"
    )


def test_route_book_skips_malformed_symbol_rows() -> None:
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-07T16:00:00+00:00",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "fail",
                    "source_ref": {
                        "symbol_routes": {
                            "routeable_symbols": [{"symbol": ""}],
                            "blocked_symbols": [{"symbol": "  "}],
                            "missing_symbols": ["", None],
                        }
                    },
                }
            ],
        },
        trading_mode="live",
        market_session_open=False,
    )

    assert book["records"] == []
    summary = cast(Mapping[str, Any], book["summary"])
    assert summary["routeable_symbol_count"] == 0
    assert summary["blocked_symbol_count"] == 0
    assert summary["missing_symbol_count"] == 0


def test_route_book_normalizes_receipts_ids_and_malformed_symbol_rows() -> None:
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-07T16:00:00+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "fail",
                    "reason": "execution_tca_slippage_guardrail_exceeded",
                    "source_ref": {
                        "unsettled_execution_count": "not-a-number",
                        "symbol_routes": {
                            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
                            "scope_symbol_count": 3,
                            "routeable_symbols": [
                                {"symbol": ""},
                                {
                                    "symbol": "NVDA",
                                    "filled_execution_count": 2.7,
                                    "avg_abs_slippage_bps": "5.57",
                                    "max_abs_slippage_bps": "7.10",
                                    "last_computed_at": "2026-05-07T15:59:00+00:00",
                                },
                            ],
                            "blocked_symbols": [
                                {"symbol": ""},
                                {
                                    "symbol": "AAPL",
                                    "order_count": True,
                                    "avg_abs_slippage_bps": "21.25",
                                    "max_abs_slippage_bps": "112.77",
                                    "last_computed_at": "2026-05-07T15:58:00+00:00",
                                },
                            ],
                            "missing_symbols": ["", "ORCL"],
                        },
                    },
                },
                {
                    "dimension": "market_context",
                    "state": "pass",
                    "source_ref": {"receipt_id": "mctx-receipt-1"},
                },
                {
                    "dimension": "quant_ingestion",
                    "state": "informational",
                    "source_ref": {"last_receipt_id": "quant-receipt-1"},
                },
                {
                    "dimension": "alpha_readiness",
                    "state": "pass",
                    "source_ref": {
                        "hypothesis_ids": ["H-REV-01", ""],
                        "candidate_ids": ["H-REV-01", "H-MICRO-01"],
                    },
                },
            ],
        },
        trading_mode="live",
        market_session_open=True,
    )

    records = cast(list[Mapping[str, Any]], book["records"])
    assert len(records) == 3

    nvda = next(item for item in records if item["symbol"] == "NVDA")
    aapl = next(item for item in records if item["symbol"] == "AAPL")
    orcl = next(item for item in records if item["symbol"] == "ORCL")

    assert nvda["state"] == "routeable"
    assert nvda["filled_execution_count"] == 2
    assert nvda["market_context_receipt_id"] == "mctx-receipt-1"
    assert nvda["quant_pipeline_receipt_id"] == "quant-receipt-1"
    assert nvda["hypothesis_ids"] == ["H-MICRO-01", "H-REV-01"]
    assert aapl["state"] == "blocked"
    assert aapl["filled_execution_count"] == 1
    assert (
        aapl["next_repair_action"] == "reduce_execution_slippage_before_route_reentry"
    )
    assert orcl["state"] == "missing"
    summary = cast(Mapping[str, Any], book["summary"])
    assert summary["expected_unblock_value"] == 7
    assert summary["candidate_symbols"] == ["NVDA"]
    assert summary["repair_candidate_symbols"] == ["AAPL", "ORCL"]


def test_route_book_ranks_zero_notional_repair_candidates_from_live_shape() -> None:
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-07T17:26:11.729605+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "fail",
                    "reason": "execution_tca_route_universe_empty",
                    "source_ref": {
                        "slippage_guardrail_bps": "8",
                        "unsettled_execution_count": 0,
                        "symbol_routes": {
                            "scope_symbols": [
                                "AAPL",
                                "AMD",
                                "AMZN",
                                "AVGO",
                                "GOOGL",
                                "INTC",
                                "NVDA",
                                "ORCL",
                            ],
                            "scope_symbol_count": 8,
                            "routeable_symbols": [],
                            "blocked_symbols": [
                                {
                                    "symbol": "AVGO",
                                    "order_count": 1123,
                                    "avg_abs_slippage_bps": "21.8582812794280608",
                                },
                                {
                                    "symbol": "AAPL",
                                    "order_count": 2033,
                                    "avg_abs_slippage_bps": "9.2512103573044345",
                                },
                                {
                                    "symbol": "NVDA",
                                    "order_count": 3289,
                                    "avg_abs_slippage_bps": "13.4758535356493902",
                                },
                                {
                                    "symbol": "INTC",
                                    "order_count": 66,
                                    "avg_abs_slippage_bps": "20.5710872857575758",
                                },
                                {
                                    "symbol": "AMD",
                                    "order_count": 823,
                                    "avg_abs_slippage_bps": "14.933309365549806",
                                },
                            ],
                            "missing_symbols": ["AMZN", "GOOGL", "ORCL"],
                        },
                    },
                },
                {"dimension": "market_context", "state": "stale"},
                {"dimension": "quant_ingestion", "state": "informational"},
                {"dimension": "alpha_readiness", "state": "fail"},
            ],
        },
        trading_mode="live",
        market_session_open=True,
    )

    summary = cast(Mapping[str, Any], book["summary"])
    assert summary["candidate_symbols"] == []
    assert summary["repair_candidate_count"] == 8
    assert summary["repair_candidate_symbols"] == [
        "AAPL",
        "NVDA",
        "AMD",
        "INTC",
        "AVGO",
        "AMZN",
        "GOOGL",
        "ORCL",
    ]
    candidates = cast(list[Mapping[str, Any]], summary["repair_candidates"])
    assert candidates[0]["rank"] == 1
    assert candidates[0]["symbol"] == "AAPL"
    assert candidates[0]["state"] == "blocked"
    assert candidates[0]["reason"] == "execution_tca_route_universe_empty"
    assert candidates[0]["avg_abs_slippage_bps"] == "9.2512103573044345"
    assert candidates[0]["slippage_guardrail_bps"] == "8"
    assert candidates[0]["filled_execution_count"] == 2033
    assert candidates[0]["paper_probe_notional_limit"] == "0"
    assert candidates[0]["next_repair_action"] == "repair_route_evidence_before_paper_probe"
    assert candidates[0]["promotion_authority"] is False
    assert candidates[-1]["symbol"] == "ORCL"
    assert (
        candidates[-1]["next_repair_action"] == "create_simulation_probe_before_capital"
    )


def test_route_book_surfaces_paper_route_probe_readiness_without_capital_authority() -> (
    None
):
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-24T06:42:27.532861+00:00",
            "account_label": "TORGHUT_SIM",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "execution_tca_route_universe_exclusions_applied",
                    "source_ref": {
                        "slippage_guardrail_bps": "6",
                        "unsettled_execution_count": 0,
                        "symbol_routes": {
                            "scope_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                            "scope_symbol_count": 4,
                            "routeable_symbols": [
                                {
                                    "symbol": "AMZN",
                                    "order_count": 1,
                                    "avg_abs_slippage_bps": "3.07908692",
                                }
                            ],
                            "blocked_symbols": [
                                {
                                    "symbol": "NVDA",
                                    "order_count": 6,
                                    "avg_abs_slippage_bps": "92.210049075",
                                }
                            ],
                            "missing_symbols": ["AAPL", "INTC"],
                        },
                    },
                },
                {"dimension": "market_context", "state": "pass"},
                {"dimension": "quant_ingestion", "state": "pass"},
                {"dimension": "alpha_readiness", "state": "fail"},
            ],
        },
        trading_mode="paper",
        market_session_open=False,
        paper_route_probe_enabled=True,
        paper_route_probe_max_notional=25.0,
    )

    probe = cast(Mapping[str, Any], book["paper_route_probe"])
    assert probe["configured_enabled"] is True
    assert probe["configured_max_notional"] == "25.0"
    assert probe["active"] is False
    assert probe["effective_max_notional"] == "0"
    assert probe["next_session_max_notional"] == "25.0"
    assert probe["eligible_symbols"] == ["AMZN", "NVDA", "AAPL", "INTC"]
    assert probe["active_symbols"] == []
    assert probe["blocking_reasons"] == ["session_closed"]
    assert probe["capital_authority"] == "none"

    summary = cast(Mapping[str, Any], book["summary"])
    assert summary["paper_route_probe_eligible_symbols"] == [
        "AMZN",
        "NVDA",
        "AAPL",
        "INTC",
    ]
    assert summary["paper_route_probe_active_symbols"] == []
    assert summary["repair_candidate_symbols"] == ["NVDA", "AAPL", "INTC"]

    records = cast(list[Mapping[str, Any]], book["records"])
    amzn = next(item for item in records if item["symbol"] == "AMZN")
    amzn_probe = cast(Mapping[str, Any], amzn["paper_route_probe"])
    assert amzn["state"] == "probing"
    assert amzn["reason"] == "route_tca_passed_but_dependency_receipts_block_capital"
    assert (
        amzn["next_repair_action"]
        == "collect_paper_runtime_ledger_receipts_before_capital"
    )
    assert amzn_probe["eligible"] is True
    assert amzn_probe["active"] is False
    assert amzn_probe["notional_limit"] == "0"
    assert amzn_probe["next_session_notional_limit"] == "25.0"

    aapl = next(item for item in records if item["symbol"] == "AAPL")
    aapl_probe = cast(Mapping[str, Any], aapl["paper_route_probe"])
    assert aapl["paper_probe_notional_limit"] == "0"
    assert aapl_probe["eligible"] is True
    assert aapl_probe["active"] is False
    assert aapl_probe["notional_limit"] == "0"
    assert aapl_probe["next_session_notional_limit"] == "25.0"
    assert aapl_probe["capital_authority"] == "none"

    candidates = cast(list[Mapping[str, Any]], summary["repair_candidates"])
    candidate = next(item for item in candidates if item["symbol"] == "AAPL")
    candidate_probe = cast(Mapping[str, Any], candidate["paper_route_probe"])
    assert candidate["paper_probe_notional_limit"] == "0"
    assert candidate_probe["next_session_notional_limit"] == "25.0"


def test_live_route_book_can_advertise_next_session_paper_probe_without_capital_authority() -> (
    None
):
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-24T06:42:27.532861+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "source_ref": {
                        "symbol_routes": {
                            "scope_symbols": ["AAPL"],
                            "scope_symbol_count": 1,
                            "routeable_symbols": [],
                            "blocked_symbols": [],
                            "missing_symbols": ["AAPL"],
                        }
                    },
                },
                {"dimension": "market_context", "state": "pass"},
                {"dimension": "quant_ingestion", "state": "pass"},
                {"dimension": "alpha_readiness", "state": "fail"},
            ],
        },
        trading_mode="live",
        market_session_open=False,
        paper_route_probe_enabled=True,
        paper_route_probe_max_notional="25",
    )

    probe = cast(Mapping[str, Any], book["paper_route_probe"])
    assert probe["configured_enabled"] is True
    assert probe["active"] is False
    assert probe["effective_max_notional"] == "0"
    assert probe["next_session_max_notional"] == "25"
    assert probe["eligible_symbols"] == ["AAPL"]
    assert probe["active_symbols"] == []
    assert probe["blocking_reasons"] == ["not_paper_mode", "session_closed"]
    assert probe["capital_authority"] == "none"
    assert book["capital_rule"] == "live_zero_notional_unchanged"

    records = cast(list[Mapping[str, Any]], book["records"])
    aapl = next(item for item in records if item["symbol"] == "AAPL")
    aapl_probe = cast(Mapping[str, Any], aapl["paper_route_probe"])
    assert aapl["paper_probe_notional_limit"] == "0"
    assert aapl_probe["active"] is False
    assert aapl_probe["notional_limit"] == "0"
    assert aapl_probe["next_session_notional_limit"] == "25"
    assert aapl_probe["capital_authority"] == "none"


def test_route_book_marks_paper_route_probe_active_only_when_market_open() -> None:
    book = build_route_reacquisition_book(
        proof_floor_receipt={
            "generated_at": "2026-05-24T06:42:27.532861+00:00",
            "account_label": "TORGHUT_SIM",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "execution_tca_route_universe_exclusions_applied",
                    "source_ref": {
                        "symbol_routes": {
                            "scope_symbols": ["AAPL"],
                            "scope_symbol_count": 1,
                            "routeable_symbols": [],
                            "blocked_symbols": [],
                            "missing_symbols": ["AAPL"],
                        }
                    },
                },
                {"dimension": "market_context", "state": "pass"},
                {"dimension": "quant_ingestion", "state": "pass"},
                {"dimension": "alpha_readiness", "state": "fail"},
            ],
        },
        trading_mode="paper",
        market_session_open=True,
        paper_route_probe_enabled=True,
        paper_route_probe_max_notional="25",
    )

    probe = cast(Mapping[str, Any], book["paper_route_probe"])
    assert probe["active"] is True
    assert probe["effective_max_notional"] == "25"
    assert probe["active_symbols"] == ["AAPL"]
    assert probe["blocking_reasons"] == []


def test_route_reacquisition_board_keeps_live_repair_zero_notional() -> None:
    proof_floor = {
        "generated_at": "2026-05-07T22:11:12.125118+00:00",
        "account_label": "PA3SX7FYNUTF",
        "torghut_revision": "torghut-00285",
        "route_state": "repair_only",
        "capital_state": "zero_notional",
        "proof_dimensions": [
            {
                "dimension": "execution_tca",
                "state": "fail",
                "reason": "execution_tca_route_universe_incomplete",
                "source_ref": {
                    "slippage_guardrail_bps": "8",
                    "unsettled_execution_count": 0,
                    "symbol_routes": {
                        "scope_symbols": ["AAPL", "NVDA", "AMZN"],
                        "scope_symbol_count": 3,
                        "routeable_symbols": [
                            {
                                "symbol": "AAPL",
                                "order_count": 2033,
                                "avg_abs_slippage_bps": "9.2512103573044345",
                                "last_computed_at": "2026-05-07T14:23:42.805829Z",
                            }
                        ],
                        "blocked_symbols": [
                            {
                                "symbol": "NVDA",
                                "order_count": 3289,
                                "avg_abs_slippage_bps": "13.4758535356493902",
                                "last_computed_at": "2026-05-07T14:23:42.665729Z",
                            }
                        ],
                        "missing_symbols": ["AMZN"],
                    },
                },
            },
            {"dimension": "market_context", "state": "stale"},
            {"dimension": "quant_ingestion", "state": "informational"},
            {"dimension": "alpha_readiness", "state": "fail"},
        ],
    }
    route_book = build_route_reacquisition_book(
        proof_floor_receipt=proof_floor,
        trading_mode="live",
        market_session_open=False,
    )
    proof_floor["route_reacquisition_book"] = route_book

    board = build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        active_revision="torghut-00285",
    )

    assert board["schema_version"] == "torghut.route-reacquisition-board.v1"
    assert board["state"] == "repair_only"
    assert board["capital_rule"] == "zero_notional_until_receipts_close"
    assert board["capital_state"] == "zero_notional"
    rows = cast(list[Mapping[str, Any]], board["rows"])
    assert [row["symbol"] for row in rows] == ["AAPL", "NVDA", "AMZN"]
    assert {row["max_notional"] for row in rows} == {"0"}
    assert rows[0]["state"] == "probing"
    assert rows[0]["expected_unblock_value"] == 3
    required_receipts = cast(Mapping[str, Any], rows[0]["required_receipts"])
    assert required_receipts["market_context_receipt"]["state"] == "stale"
    assert required_receipts["jangar_proof_packet"]["state"] == "missing"
    summary = cast(Mapping[str, Any], board["summary"])
    assert summary["state_counts"] == {"blocked": 1, "missing": 1, "probing": 1}
    assert summary["zero_notional_row_count"] == 3
    assert summary["expected_unblock_value"] == 6
    assert summary["capital_eligible_symbol_count"] == 0
    assert summary["top_repair_symbols"] == ["AAPL", "NVDA", "AMZN"]


def test_route_reacquisition_board_preserves_candidate_notional_and_receipts() -> None:
    proof_floor = {
        "generated_at": "2026-05-07T22:11:12.125118+00:00",
        "account_label": "PA3SX7FYNUTF",
        "torghut_revision": "torghut-00285",
        "route_state": "paper_candidate",
        "capital_state": "paper_allowed",
        "proof_dimensions": [
            {"dimension": "execution_tca", "state": "pass", "reason": "fresh"},
            {"dimension": "market_context", "state": "pass"},
            {"dimension": "quant_ingestion", "state": "pass"},
            {"dimension": "alpha_readiness", "state": "pass"},
        ],
        "route_reacquisition_book": {
            "generated_at": "2026-05-07T22:11:12.125118+00:00",
            "account_label": "PA3SX7FYNUTF",
            "trading_mode": "paper",
            "market_session_open": True,
            "records": [
                {
                    "symbol": "NVDA",
                    "state": "routeable",
                    "reason": "fresh",
                    "filled_execution_count": 2.7,
                    "paper_probe_notional_limit": "125",
                    "market_context_receipt_id": "mctx-1",
                    "quant_pipeline_receipt_id": "quant-1",
                    "hypothesis_ids": ["H-2", "H-1", "H-2"],
                },
                {
                    "symbol": "AMD",
                    "state": "blocked",
                    "reason": "slippage_guardrail",
                    "filled_execution_count": True,
                    "next_repair_action": "reduce_execution_slippage_before_route_reentry",
                    "paper_probe_notional_limit": "25",
                },
                {
                    "symbol": "UNKNOWN",
                    "state": "retired",
                    "reason": "manual_override",
                    "filled_execution_count": "not-a-number",
                    "paper_probe_notional_limit": "",
                },
            ],
        },
    }

    board = build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        active_revision="torghut-00285",
        jangar_broker_ref="jangar-proof-1",
    )

    assert board["state"] == "candidate"
    assert board["capital_rule"] == "paper_probe_requires_receipt_chain"
    rows = cast(list[Mapping[str, Any]], board["rows"])
    assert [row["symbol"] for row in rows] == ["AMD", "NVDA", "UNKNOWN"]
    amd, nvda, unknown = rows
    assert amd["expected_cost_class"] == "high_route_quality_repair"
    assert amd["expected_profit_effect"] == "repairs_route_quality"
    assert amd["max_notional"] == "25"
    assert nvda["expected_unblock_value"] == 4
    assert nvda["expected_cost_class"] == "low_maintenance"
    assert nvda["expected_profit_effect"] == "maintains_capital_candidate"
    assert nvda["max_notional"] == "125"
    nvda_receipts = cast(Mapping[str, Any], nvda["required_receipts"])
    assert nvda_receipts["market_context_receipt"]["state"] == "present"
    assert nvda_receipts["quant_pipeline_receipt"]["state"] == "present"
    assert nvda_receipts["alpha_readiness_receipt"]["hypothesis_ids"] == ["H-1", "H-2"]
    assert nvda_receipts["jangar_proof_packet"]["state"] == "present"
    assert unknown["expected_unblock_value"] == 0
    assert unknown["expected_cost_class"] == "unknown"
    assert unknown["expected_profit_effect"] == "none"
    assert unknown["max_notional"] == "0"
    summary = cast(Mapping[str, Any], board["summary"])
    assert summary["capital_eligible_symbol_count"] == 1
    assert summary["zero_notional_row_count"] == 1


def test_route_reacquisition_board_holds_candidate_without_jangar_continuity() -> None:
    proof_floor = {
        "generated_at": "2026-05-07T22:11:12.125118+00:00",
        "account_label": "PA3SX7FYNUTF",
        "torghut_revision": "torghut-00285",
        "route_state": "paper_candidate",
        "capital_state": "paper_allowed",
        "proof_dimensions": [
            {"dimension": "execution_tca", "state": "pass", "reason": "fresh"},
            {"dimension": "market_context", "state": "pass"},
            {"dimension": "quant_ingestion", "state": "pass"},
            {"dimension": "alpha_readiness", "state": "pass"},
        ],
        "route_reacquisition_book": {
            "generated_at": "2026-05-07T22:11:12.125118+00:00",
            "account_label": "PA3SX7FYNUTF",
            "trading_mode": "paper",
            "market_session_open": True,
            "records": [
                {
                    "symbol": "NVDA",
                    "state": "routeable",
                    "reason": "fresh",
                    "filled_execution_count": 25,
                    "paper_probe_notional_limit": "125",
                    "market_context_receipt_id": "mctx-1",
                    "quant_pipeline_receipt_id": "quant-1",
                    "hypothesis_ids": ["H-1"],
                }
            ],
        },
    }

    board = build_route_reacquisition_board(
        proof_floor_receipt=proof_floor,
        active_revision="torghut-00285",
    )

    assert board["state"] == "candidate"
    assert board["capital_rule"] == "zero_notional_until_jangar_continuity"
    assert board["blocking_reasons"] == ["jangar_continuity_epoch_missing"]
    continuity = cast(Mapping[str, Any], board["jangar_continuity"])
    assert continuity["decision"] == "missing"
    assert continuity["state"] == "missing"
    rows = cast(list[Mapping[str, Any]], board["rows"])
    assert rows[0]["symbol"] == "NVDA"
    assert rows[0]["max_notional"] == "0"
    receipts = cast(Mapping[str, Any], rows[0]["required_receipts"])
    continuity_receipt = cast(Mapping[str, Any], receipts["jangar_continuity_epoch"])
    assert continuity_receipt["state"] == "missing"
    assert continuity_receipt["blocking_reasons"] == ["jangar_continuity_epoch_missing"]
    summary = cast(Mapping[str, Any], board["summary"])
    assert summary["capital_eligible_symbol_count"] == 0
    assert summary["zero_notional_row_count"] == 1


def test_hpairs_route_repair_receipts_keep_pair_legs_separate_and_audit_only() -> None:
    proof_floor = {
        "generated_at": "2026-06-01T14:30:00+00:00",
        "account_label": "TORGHUT_SIM",
        "runtime_strategy_id": "microbar-cross-sectional-pairs-v1",
        "runtime_strategy_name": "H-PAIRS microbar cross-sectional pairs",
        "source_manifest_ref": "runtime-manifest:H-PAIRS-01",
        "route_state": "repair_only",
        "capital_state": "zero_notional",
        "proof_dimensions": [
            {
                "dimension": "execution_tca",
                "state": "fail",
                "reason": "pair_imbalance",
                "source_ref": {
                    "source_manifest_ref": "runtime-manifest:H-PAIRS-01",
                    "symbol_routes": {
                        "scope_symbols": ["AAPL", "AMZN"],
                        "scope_symbol_count": 2,
                        "routeable_symbols": [],
                        "blocked_symbols": [
                            {
                                "symbol": "AAPL",
                                "reason": "missing_bid_ask",
                                "pair_id": "H-PAIRS:AAPL-AMZN",
                                "pair_side": "long",
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                                "runtime_strategy_id": "microbar-cross-sectional-pairs-v1",
                                "runtime_strategy_name": "H-PAIRS microbar cross-sectional pairs",
                            },
                            {
                                "symbol": "AMZN",
                                "reason": "stale_quote",
                                "pair_id": "H-PAIRS:AAPL-AMZN",
                                "pair_side": "short",
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                            },
                        ],
                        "missing_symbols": [
                            {
                                "symbol": "MSFT",
                                "reason": "runtime_import_pending",
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                            }
                        ],
                    },
                },
            },
            {"dimension": "market_context", "state": "pass"},
            {"dimension": "quant_ingestion", "state": "pass"},
            {
                "dimension": "alpha_readiness",
                "state": "pass",
                "source_ref": {
                    "hypothesis_ids": ["H-PAIRS-01"],
                    "candidate_ids": ["candidate-hpairs"],
                },
            },
        ],
    }

    book = build_route_reacquisition_book(
        proof_floor_receipt=proof_floor,
        trading_mode="paper",
        market_session_open=False,
        paper_route_probe_enabled=True,
        paper_route_probe_max_notional="25",
    )
    records = cast(list[Mapping[str, Any]], book["records"])
    by_symbol = {record["symbol"]: record for record in records}
    probe = cast(Mapping[str, Any], book["paper_route_probe"])

    assert list(by_symbol) == ["AAPL", "AMZN", "MSFT"]
    assert probe["eligible_symbols"] == ["AAPL", "AMZN", "MSFT"]
    assert probe["active"] is False
    assert probe["blocking_reasons"] == ["session_closed"]
    assert by_symbol["AAPL"]["reason"] == "missing_bid_ask"
    assert by_symbol["AMZN"]["reason"] == "stale_quote"
    assert by_symbol["AAPL"]["repair_recommendation"] == (
        "collect_bid_ask_quote_before_routeability_claim"
    )
    assert by_symbol["AMZN"]["repair_recommendation"] == (
        "refresh_quote_snapshot_and_recompute_route_fillability"
    )
    assert by_symbol["MSFT"]["repair_recommendation"] == (
        "complete_runtime_import_reconciliation_before_authority"
    )
    for symbol in ("AAPL", "AMZN"):
        metadata = cast(Mapping[str, Any], by_symbol[symbol]["source_metadata"])
        receipt = cast(Mapping[str, Any], by_symbol[symbol]["audit_receipt"])
        assert metadata["hypothesis_id"] == "H-PAIRS-01"
        assert metadata["candidate_id"] == "candidate-hpairs"
        assert metadata["runtime_strategy_id"] == "microbar-cross-sectional-pairs-v1"
        assert metadata["account_label"] == "TORGHUT_SIM"
        assert metadata["symbol"] == symbol
        assert metadata["source_manifest_ref"] == "runtime-manifest:H-PAIRS-01"
        assert metadata["pair_side"] in {"long", "short"}
        assert receipt["state"] == "audit_only"
        assert receipt["promotion_authority"] is False
        assert receipt["capital_authority"] == "none"

    board = build_route_reacquisition_board(
        proof_floor_receipt={**proof_floor, "route_reacquisition_book": book},
        active_revision="torghut-hpairs",
    )
    rows = cast(list[Mapping[str, Any]], board["rows"])
    assert [row["symbol"] for row in rows] == ["AAPL", "AMZN", "MSFT"]
    assert {row["promotion_authority"] for row in rows} == {False}
    assert board["promotion_authority"] is False

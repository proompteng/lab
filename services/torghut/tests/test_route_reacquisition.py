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
    assert candidates[0] == {
        "rank": 1,
        "symbol": "AAPL",
        "state": "blocked",
        "reason": "execution_tca_route_universe_empty",
        "avg_abs_slippage_bps": "9.2512103573044345",
        "slippage_guardrail_bps": "8",
        "filled_execution_count": 2033,
        "paper_probe_notional_limit": "0",
        "next_repair_action": "repair_route_evidence_before_paper_probe",
    }
    assert candidates[-1]["symbol"] == "ORCL"
    assert (
        candidates[-1]["next_repair_action"] == "create_simulation_probe_before_capital"
    )

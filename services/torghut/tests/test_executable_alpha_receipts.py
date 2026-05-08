from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.executable_alpha_receipts import (
    build_capital_replay_projection,
)
from app.trading.route_reacquisition import build_route_reacquisition_book
from app.trading.route_reacquisition_board import build_route_reacquisition_board


def _proof_floor(**overrides: object) -> dict[str, object]:
    proof_floor: dict[str, object] = {
        "schema_version": "torghut.profitability-proof-floor.v1",
        "generated_at": "2026-05-07T22:11:12.125118+00:00",
        "account_label": "PA3SX7FYNUTF",
        "torghut_revision": "torghut-00285",
        "route_state": "repair_only",
        "capital_state": "zero_notional",
        "blocking_reasons": [
            "alpha_readiness_not_promotion_eligible",
            "market_context_stale",
        ],
        "proof_dimensions": [
            {
                "dimension": "execution_tca",
                "state": "fail",
                "reason": "execution_tca_route_universe_incomplete",
                "source_ref": {
                    "slippage_guardrail_bps": "8",
                    "unsettled_execution_count": 1,
                    "symbol_routes": {
                        "scope_symbols": ["AAPL", "NVDA", "AMZN", "GOOGL", "ORCL"],
                        "scope_symbol_count": 5,
                        "routeable_symbols": [
                            {
                                "symbol": "AAPL",
                                "order_count": 2033,
                                "avg_abs_slippage_bps": "9.25",
                                "last_computed_at": "2026-05-07T14:23:42.805829Z",
                            }
                        ],
                        "blocked_symbols": [
                            {
                                "symbol": "NVDA",
                                "order_count": 3289,
                                "avg_abs_slippage_bps": "13.47",
                                "last_computed_at": "2026-05-07T14:23:42.665729Z",
                            }
                        ],
                        "missing_symbols": ["AMZN", "GOOGL", "ORCL"],
                    },
                },
            },
            {"dimension": "market_context", "state": "stale"},
            {
                "dimension": "quant_ingestion",
                "state": "fail",
                "source_ref": {"latest_metrics_count": 0},
            },
            {
                "dimension": "alpha_readiness",
                "state": "fail",
                "source_ref": {
                    "promotion_eligible_total": 0,
                    "hypothesis_ids": ["chip-paper-microbar-composite"],
                },
            },
        ],
    }
    proof_floor.update(overrides)
    route_book = build_route_reacquisition_book(
        proof_floor_receipt=proof_floor,
        trading_mode="live",
        market_session_open=False,
    )
    proof_floor["route_reacquisition_book"] = route_book
    return proof_floor


def _projection(
    *,
    proof_floor: dict[str, object] | None = None,
    empirical_ready: bool = False,
    quant_latest_count: int = 0,
    market_alert: bool = True,
    jangar_current: bool = False,
) -> dict[str, object]:
    proof = proof_floor or _proof_floor()
    board = build_route_reacquisition_board(
        proof_floor_receipt=proof,
        active_revision="torghut-00285",
    )
    return build_capital_replay_projection(
        account_label="PA3SX7FYNUTF",
        trading_mode="live",
        torghut_revision="torghut-00285",
        proof_floor_receipt=proof,
        route_reacquisition_board=board,
        live_submission_gate={
            "allowed": False,
            "blocked_reasons": ["simple_submit_disabled"],
        },
        empirical_jobs_status={
            "ready": empirical_ready,
            "status": "ready" if empirical_ready else "stale",
            "dataset_snapshot_refs": ["torghut-chip-full-day"],
        },
        quant_evidence={
            "status": "healthy" if quant_latest_count > 0 else "degraded",
            "latest_metrics_count": quant_latest_count,
            "stage_count": 0 if quant_latest_count == 0 else 3,
            "source_url": "https://jangar.example/api/torghut/trading/control-plane/quant/health",
        },
        market_context_status={
            "status": "healthy" if not market_alert else "degraded",
            "alert_active": market_alert,
            "alert_reason": "market_context_stale",
        },
        jangar_contract_graduation_ref={
            "contract_ref": "docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md",
            "state": "current" if jangar_current else "missing",
            "decision": "allow" if jangar_current else "delay",
            "reasons": [] if jangar_current else ["contract_graduation_missing"],
        },
        now=datetime(2026, 5, 7, 22, 15, tzinfo=timezone.utc),
    )


def test_capital_replay_board_seeds_live_aapl_nvda_and_breadth_probe() -> None:
    projection = _projection()
    board = cast(Mapping[str, Any], projection["capital_replay_board"])

    assert board["schema_version"] == "torghut.capital-replay-board.v1"
    assert board["trading_mode"] == "live"
    assert board["selected_replays"] == [
        item["replay_id"] for item in board["replay_items"]
    ]

    replay_items = cast(list[Mapping[str, Any]], board["replay_items"])
    assert [item["hypothesis_id"] for item in replay_items] == [
        "H-AAPL-ROUTE-REHAB",
        "H-NVDA-SIM-PROOF-REFILL",
        "H-MEGACAP-BREADTH-PROBE",
    ]
    assert {item["max_notional"] for item in replay_items} == {"0"}
    assert replay_items[0]["target_symbols"] == ["AAPL"]
    assert replay_items[1]["target_symbols"] == ["NVDA"]
    assert replay_items[2]["target_symbols"] == ["AMZN", "GOOGL", "ORCL"]
    assert replay_items[2]["replay_class"] == "missing_symbol_breadth_probe"

    summary = cast(Mapping[str, Any], board["summary"])
    assert summary["paper_replay_candidate_count"] == 0
    assert summary["capital_ready"] is False


def test_receipts_keep_superficially_good_route_out_of_paper_candidate() -> None:
    proof_floor = _proof_floor(blocking_reasons=[])
    projection = _projection(
        proof_floor=proof_floor,
        empirical_ready=True,
        quant_latest_count=144,
        market_alert=False,
        jangar_current=False,
    )
    receipts_payload = cast(Mapping[str, Any], projection["executable_alpha_receipts"])
    receipts = cast(list[Mapping[str, Any]], receipts_payload["receipts"])

    assert receipts_payload["schema_version"] == "torghut.executable-alpha-receipts.v1"
    assert {receipt["graduation_state"] for receipt in receipts} == {"candidate"}
    assert all(receipt["capital_effect"]["max_notional"] == "0" for receipt in receipts)
    assert all(
        "contract_graduation_missing" in receipt["remaining_blockers"]
        or "jangar_contract_graduation_missing" in receipt["remaining_blockers"]
        for receipt in receipts
    )
    assert all(
        receipt["graduation_state"] != "paper_replay_candidate" for receipt in receipts
    )


def test_replay_items_record_stale_empirical_market_quant_and_tca_blockers() -> None:
    projection = _projection()
    board = cast(Mapping[str, Any], projection["capital_replay_board"])
    replay_items = cast(list[Mapping[str, Any]], board["replay_items"])
    aapl = replay_items[0]

    blockers = cast(list[str], aapl["remaining_blockers"])
    assert "empirical_jobs_stale" in blockers
    assert "market_context_stale" in blockers
    assert "quant_latest_metrics_empty" in blockers
    assert "execution_tca_above_guardrail" in blockers
    guardrails = cast(list[Mapping[str, Any]], aapl["guardrails"])
    assert guardrails[0]["code"] == "zero_notional_required"
    assert guardrails[0]["status"] == "pass"
    assert guardrails[1]["code"] == "tca_slippage_guardrail"
    assert guardrails[1]["status"] == "blocked"


def test_receipts_include_before_refs_required_after_refs_and_rollback_target() -> None:
    projection = _projection()
    board = cast(Mapping[str, Any], projection["capital_replay_board"])
    replay_items = cast(list[Mapping[str, Any]], board["replay_items"])
    receipts = cast(
        list[Mapping[str, Any]],
        cast(Mapping[str, Any], projection["executable_alpha_receipts"])["receipts"],
    )

    assert all(item["before_refs"] for item in replay_items)
    assert all(item["required_after_refs"] for item in replay_items)
    assert all(
        item["rollback_target"]["capital_state"] == "zero_notional"
        for item in replay_items
    )
    assert all(receipt["before_refs"] for receipt in receipts)
    assert all(receipt["after_refs"] == {} for receipt in receipts)
    assert all(receipt["guardrail_result"]["passed"] is False for receipt in receipts)

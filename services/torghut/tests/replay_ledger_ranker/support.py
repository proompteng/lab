from __future__ import annotations


import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

import app.trading.discovery.replay_ledger_ranker as ranker
import scripts.rank_replay_ledgers as rank_replay_ledgers_cli
from app.trading.discovery.replay_ledger_ranker import (
    ReplayLedgerRankingPolicy,
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
    rank_replay_ledger_files,
    rank_replay_ledger_payload,
)


def _ts(day: int, minute: int = 0) -> str:
    return datetime(2026, 5, day, 14, 30 + minute, tzinfo=timezone.utc).isoformat()


def _round_trip(
    *,
    day: int,
    symbol: str,
    qty: str,
    buy_price: str,
    sell_price: str,
    prefix: str,
) -> list[dict[str, object]]:
    return [
        {
            "event_type": "decision",
            "executed_at": _ts(day, 0),
            "decision_id": f"{prefix}-buy-decision",
            "symbol": symbol,
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(day, 1),
            "decision_id": f"{prefix}-buy-decision",
            "order_id": f"{prefix}-buy-order",
            "symbol": symbol,
        },
        {
            "event_type": "fill",
            "executed_at": _ts(day, 2),
            "decision_id": f"{prefix}-buy-decision",
            "order_id": f"{prefix}-buy-order",
            "symbol": symbol,
            "side": "buy",
            "filled_qty": qty,
            "avg_fill_price": buy_price,
            "cost_amount": "1",
        },
        {
            "event_type": "decision",
            "executed_at": _ts(day, 10),
            "decision_id": f"{prefix}-sell-decision",
            "symbol": symbol,
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(day, 11),
            "decision_id": f"{prefix}-sell-decision",
            "order_id": f"{prefix}-sell-order",
            "symbol": symbol,
        },
        {
            "event_type": "fill",
            "executed_at": _ts(day, 12),
            "decision_id": f"{prefix}-sell-decision",
            "order_id": f"{prefix}-sell-order",
            "symbol": symbol,
            "side": "sell",
            "filled_qty": qty,
            "avg_fill_price": sell_price,
            "cost_amount": "1",
        },
    ]


def _with_execution_quality(
    rows: list[dict[str, object]],
    *,
    order_type: str,
    shortfall_bps: str,
    limit_fill_probability: str | None = None,
    queue_position: str | None = None,
    opportunity_cost_bps: str | None = None,
    price_improvement_bps: str | None = None,
    include_closing_auction_evidence: bool = True,
) -> list[dict[str, object]]:
    for row in rows:
        if row.get("event_type") in {"order_submitted", "fill"}:
            row["order_type"] = order_type
            row["execution_shortfall_bps"] = shortfall_bps
            row["fill_status"] = "filled"
            if include_closing_auction_evidence:
                row["closing_window"] = "late_session_close"
                row["closing_auction"] = True
                row["closing_auction_projection"] = {
                    "projected_imbalance_shares": "12500",
                    "projected_clearing_price": "100.42",
                }
                row["closing_auction_clearing_price"] = "100.44"
                row["terminal_inventory_path"] = [
                    {"minutes_to_close": 10, "qty": "1000"},
                    {"minutes_to_close": 0, "qty": "0"},
                ]
            if limit_fill_probability is not None:
                row["limit_fill_probability"] = limit_fill_probability
            if queue_position is not None:
                row["queue_position"] = queue_position
            if opportunity_cost_bps is not None:
                row["nonfill_opportunity_cost_bps"] = opportunity_cost_bps
            if price_improvement_bps is not None:
                row["price_improvement_bps"] = price_improvement_bps
    return rows


def _with_lob_reality_gap_evidence(
    rows: list[dict[str, object]],
    *,
    fragile: bool = False,
) -> list[dict[str, object]]:
    event_cycle = ("add", "trade", "cancel")
    for index, row in enumerate(rows):
        if fragile:
            row["bid"] = str(100 + Decimal(index) * Decimal("0.12"))
            row["ask"] = str(Decimal(str(row["bid"])) + Decimal("0.02"))
            row["bid_size"] = "950"
            row["ask_size"] = "50"
            row["round_trip_latency_ms"] = "2"
            row["trade_direction"] = "buy"
            row["trade_size"] = "900"
            row["odd_lot_bid_size"] = "4" if index else "80"
            row["odd_lot_ask_size"] = "3" if index else "82"
            row["off_exchange_trade"] = index > 0
            row["lob_event_type"] = "cancel_replace" if index > 0 else "trade"
        else:
            row["bid"] = "99.99"
            row["ask"] = "100.01"
            row["bid_size"] = "510" if index % 2 == 0 else "500"
            row["ask_size"] = "500" if index % 2 == 0 else "510"
            row["round_trip_latency_ms"] = str(Decimal("1.0") + Decimal(index) / 10)
            row["trade_direction"] = "buy" if index % 2 == 0 else "sell"
            row["trade_size"] = "8"
            row["odd_lot_bid_size"] = "40"
            row["odd_lot_ask_size"] = "42"
            row["off_exchange_trade"] = False
            row["lob_event_type"] = event_cycle[index % len(event_cycle)]
    return rows


def _with_microstructure_stress_evidence(
    rows: list[dict[str, object]],
    *,
    fragile: bool = False,
) -> list[dict[str, object]]:
    for index, row in enumerate(rows):
        if fragile:
            row["order_type"] = "market"
            row["fill_status"] = "filled"
            row["order_qty"] = "1000"
            row["fill_qty"] = "1000"
            row["spread_bps"] = "24"
            row["order_book_imbalance"] = "-0.70"
            row["event_type"] = "trade"
            row["bid_size"] = "20"
            row["ask_size"] = "980"
            row.pop("bid", None)
            row.pop("ask", None)
        else:
            row["order_type"] = "limit"
            row["fill_status"] = "filled"
            row["order_qty"] = "1000"
            row["fill_qty"] = "1000"
            row["spread_bps"] = "2"
            row["order_book_imbalance"] = "0.25"
            row["event_type"] = ("add", "trade", "cancel")[index % 3]
            row["bid"] = "99.99"
            row["ask"] = "100.01"
            row["bid_size"] = "600"
            row["ask_size"] = "500"
    return rows


def _payload(
    candidate_id: str,
    rows: list[dict[str, object]],
    *,
    promotion_authority: str = "replay_artifact_only_not_live",
    include_lineage: bool = True,
) -> dict[str, object]:
    if include_lineage:
        for row in rows:
            if row.get("event_type") == "fill":
                row["adv_source"] = "observed_microbar_notional_by_symbol_day"
                row["adv_notional"] = "10000000"
                row["participation_rate"] = "0.0001"
                row["capacity_warning_codes"] = []
    payload: dict[str, object] = {
        "schema_version": "torghut.exact_replay_ledger.rows.v1",
        "candidate_id": candidate_id,
        "candidate_identity": {
            "candidate_id": candidate_id,
            "candidate_identity_hash": f"identity-{candidate_id}",
            "source_manifest_ref": f"manifests/{candidate_id}.json",
        },
        "candidate_identity_hash": f"identity-{candidate_id}",
        "window_start": "2026-05-18",
        "window_end": "2026-05-22",
        "account_label": "TORGHUT_REPLAY",
        "cost_basis": "local_replay_transaction_cost_model",
        "execution_policy_hash": "policy-sha",
        "cost_model_hash": "cost-sha",
        "cost_lineage": {
            "cost_lineage_hash": f"cost-lineage-{candidate_id}",
            "adv_source": "observed_microbar_notional_by_symbol_day",
            "warning_contract": ["missing_adv", "participation_exceeds_max"],
        },
        "cost_lineage_hash": f"cost-lineage-{candidate_id}",
        "lineage_hash": "lineage-sha",
        "promotion_authority": promotion_authority,
        "stage": "replay",
        "source": "local_intraday_tsmom_replay",
        "runtime_ledger_rows": rows,
    }
    if not include_lineage:
        for key in (
            "candidate_id",
            "candidate_identity",
            "candidate_identity_hash",
            "cost_lineage",
            "cost_lineage_hash",
        ):
            payload.pop(key, None)
    return payload


def _policy() -> ReplayLedgerRankingPolicy:
    return ReplayLedgerRankingPolicy(
        target_net_pnl_per_day=Decimal("500"),
        min_window_weekday_count=20,
        min_avg_filled_notional_per_day=Decimal("300000"),
        max_best_day_share=Decimal("0.25"),
        max_gross_exposure_pct_equity=Decimal("1.0"),
        start_equity=Decimal("1000"),
    )


__all__: tuple[str, ...] = (
    "Decimal",
    "Path",
    "ReplayLedgerRankingPolicy",
    "_payload",
    "_policy",
    "_round_trip",
    "_ts",
    "_with_execution_quality",
    "_with_lob_reality_gap_evidence",
    "_with_microstructure_stress_evidence",
    "build_replay_ledger_ranking_report",
    "datetime",
    "default_replay_ledger_ranking_policy",
    "json",
    "pytest",
    "rank_replay_ledger_files",
    "rank_replay_ledger_payload",
    "rank_replay_ledgers_cli",
    "ranker",
    "sys",
    "timezone",
)

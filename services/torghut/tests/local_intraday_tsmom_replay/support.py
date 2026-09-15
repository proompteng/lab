from __future__ import annotations


import json
import os
import subprocess
import sys
from argparse import Namespace
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.trading.costs import CostModelConfig, TransactionCostModel
from app.trading.evaluation_trace import (
    GateTrace,
    NearMissRecord,
    StrategyTrace,
    ThresholdTrace,
)
from app.models import Strategy
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.runtime_ledger import build_runtime_ledger_buckets
from scripts.local_intraday_tsmom_replay import (
    ClosedTrade,
    FetchChunkRequest,
    FillAccountingState,
    FillExecution,
    FlattenPositionsRequest,
    PendingOrder,
    PositionState,
    ReplayConfig,
    ReplayLedgerContext,
    TraceBlockContext,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision as _apply_filled_decision_request,
    _apply_order_preferences,
    _append_decimal_sample,
    _build_near_miss,
    _decision_exit_reason,
    _decision_market_order_spread_bps_max,
    _decision_position_owner,
    _decision_spread_bps,
    _estimate_trade_cost,
    _estimate_trade_cost_lineage,
    _fetch_chunk,
    _flatten_positions,
    _http_query,
    _init_funnel_stats,
    _insert_near_miss,
    _latency_bucket,
    _load_strategies,
    _parse_signal_row,
    _pending_censor_time,
    _positions_payload,
    _record_capital_snapshot,
    _record_trace_for_funnel,
    _resolve_repo_root,
    _reconcile_pending_order_before_immediate_fill,
    _resolve_passed_trace_block_reason,
    _resolve_pending_fill_price,
    _should_replace_pending_order,
    _signal_mid_jump_bps,
    _signal_spread_bps,
    _kubectl_clickhouse_query,
    main as replay_main,
    run_replay,
)


class _TestLocalIntradayTsmomReplayBase(TestCase):
    def _signal(self, *, bid: str, ask: str, price: str) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": Decimal(price),
                "imbalance_bid_px": Decimal(bid),
                "imbalance_ask_px": Decimal(ask),
                "spread": Decimal(ask) - Decimal(bid),
            },
        )

    def _decision(
        self,
        *,
        action: str,
        order_type: str,
        limit_price: str | None = None,
    ) -> StrategyDecision:
        return StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action=action,
            qty=Decimal("10"),
            order_type=order_type,
            time_in_force="day",
            limit_price=Decimal(limit_price) if limit_price is not None else None,
            rationale="test",
            params={},
        )


def _apply_filled_decision(
    *,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    fill_price: Decimal,
    filled_at: datetime,
    created_at: datetime,
    positions: dict[tuple[str, str], PositionState],
    day_bucket: dict[str, Any],
    cost_model: TransactionCostModel,
    cash: Decimal,
    all_closed_trades: list[ClosedTrade],
    symbol_bucket: dict[str, Any] | None = None,
    force_position_isolation: bool = False,
    exact_ledger_rows: list[dict[str, Any]] | None = None,
    ledger_context: ReplayLedgerContext | None = None,
    ledger_strategy_id: str | None = None,
) -> Decimal:
    return _apply_filled_decision_request(
        FillExecution(
            decision=decision,
            signal=signal,
            fill_price=fill_price,
            filled_at=filled_at,
            created_at=created_at,
            cash=cash,
            force_position_isolation=force_position_isolation,
            ledger_strategy_id=ledger_strategy_id,
        ),
        FillAccountingState(
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=cost_model,
            all_closed_trades=all_closed_trades,
            exact_ledger_rows=exact_ledger_rows,
            ledger_context=ledger_context,
        ),
    )


__all__ = (
    "json",
    "os",
    "subprocess",
    "sys",
    "Namespace",
    "date",
    "datetime",
    "timezone",
    "Decimal",
    "Path",
    "TemporaryDirectory",
    "Any",
    "TestCase",
    "patch",
    "CostModelConfig",
    "TransactionCostModel",
    "GateTrace",
    "NearMissRecord",
    "StrategyTrace",
    "ThresholdTrace",
    "Strategy",
    "SignalEnvelope",
    "StrategyDecision",
    "build_runtime_ledger_buckets",
    "ClosedTrade",
    "FetchChunkRequest",
    "FillAccountingState",
    "FillExecution",
    "FlattenPositionsRequest",
    "PendingOrder",
    "PositionState",
    "ReplayConfig",
    "ReplayLedgerContext",
    "TraceBlockContext",
    "_SHARED_POSITION_OWNER",
    "_apply_filled_decision",
    "_apply_order_preferences",
    "_append_decimal_sample",
    "_build_near_miss",
    "_decision_exit_reason",
    "_decision_market_order_spread_bps_max",
    "_decision_position_owner",
    "_decision_spread_bps",
    "_estimate_trade_cost",
    "_estimate_trade_cost_lineage",
    "_fetch_chunk",
    "_flatten_positions",
    "_http_query",
    "_init_funnel_stats",
    "_insert_near_miss",
    "_latency_bucket",
    "_load_strategies",
    "_parse_signal_row",
    "_pending_censor_time",
    "_positions_payload",
    "_record_capital_snapshot",
    "_record_trace_for_funnel",
    "_resolve_repo_root",
    "_reconcile_pending_order_before_immediate_fill",
    "_resolve_passed_trace_block_reason",
    "_resolve_pending_fill_price",
    "_should_replace_pending_order",
    "_signal_mid_jump_bps",
    "_signal_spread_bps",
    "_kubectl_clickhouse_query",
    "replay_main",
    "run_replay",
    "_TestLocalIntradayTsmomReplayBase",
)

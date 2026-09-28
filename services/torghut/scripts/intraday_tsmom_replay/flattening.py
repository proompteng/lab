from __future__ import annotations

from app.trading.costs import TransactionCostModel

from app.trading.models import (
    SignalEnvelope,
    StrategyDecision,
)

from app.trading.session_context import regular_session_close_utc_for

from dataclasses import dataclass

from datetime import date, datetime

from decimal import Decimal

from typing import Any

from .costing import _estimate_trade_cost_lineage

from .ledger import (
    LedgerFill,
    _append_ledger_fill,
    _append_ledger_submission,
)

from .fill_stats import (
    _ensure_replay_stats_bucket,
    _log_trade_closed,
    _record_fill_order_type,
)
from .replay_stats import _init_funnel_stats

from .replay_types import (
    ClosedTrade,
    PositionState,
    ReplayLedgerContext,
)


@dataclass
class FlattenPositionsRequest:
    day: date
    stats: dict[str, Any]
    funnel_stats: dict[tuple[str, str], dict[str, Any]]
    positions: dict[tuple[str, str], PositionState]
    last_signals: dict[str, SignalEnvelope]
    last_prices: dict[str, Decimal]
    cost_model: TransactionCostModel
    all_closed_trades: list[ClosedTrade]
    cash: Decimal
    exact_ledger_rows: list[dict[str, Any]] | None = None
    ledger_context: ReplayLedgerContext | None = None


@dataclass
class _FlattenedPosition:
    symbol_bucket: dict[str, Any]
    trade: ClosedTrade
    exit_cost: Decimal
    exit_notional: Decimal
    cash: Decimal


@dataclass(frozen=True)
class _FlattenedTradeRequest:
    symbol: str
    position: PositionState
    closed_at: datetime
    exit_qty: Decimal
    fill_price: Decimal
    exit_cost: Decimal


def _flatten_positions(request: FlattenPositionsRequest) -> Decimal:
    if not request.positions:
        return request.cash
    request.stats = _ensure_replay_stats_bucket(request.stats)
    current_cash = request.cash
    for position_key in sorted(list(request.positions)):
        position = request.positions.pop(position_key)
        flattened = _flatten_position(
            request=request,
            position_key=position_key,
            position=position,
            cash=current_cash,
        )
        if flattened is None:
            continue
        current_cash = flattened.cash
        _record_flattened_position(request, flattened)
    return current_cash


def _flatten_position(
    *,
    request: FlattenPositionsRequest,
    position_key: tuple[str, str],
    position: PositionState,
    cash: Decimal,
) -> _FlattenedPosition | None:
    symbol, _owner_strategy_id = position_key
    last_signal = request.last_signals.get(symbol)
    if last_signal is None:
        return None
    symbol_bucket = request.funnel_stats.setdefault(
        (request.day.isoformat(), symbol), _init_funnel_stats()
    )
    fill_price = request.last_prices.get(symbol, position.avg_entry_price)
    exit_qty = abs(position.qty)
    closed_at = regular_session_close_utc_for(request.day)
    synthetic_decision = StrategyDecision(
        strategy_id=position.strategy_id,
        symbol=symbol,
        event_ts=closed_at,
        timeframe="1Sec",
        action="buy" if position.qty < 0 else "sell",
        qty=exit_qty,
        order_type="market",
        time_in_force="day",
        params={},
    )
    exit_cost_lineage = _estimate_trade_cost_lineage(
        model=request.cost_model,
        decision=synthetic_decision,
        signal=last_signal,
        day_bucket=request.stats,
        symbol_bucket=symbol_bucket,
    )
    exit_notional = fill_price * exit_qty
    if position.qty < 0:
        cash -= exit_notional + exit_cost_lineage.total_cost
    else:
        cash += exit_notional - exit_cost_lineage.total_cost
    _append_ledger_submission(
        rows=request.exact_ledger_rows,
        context=request.ledger_context,
        decision=synthetic_decision,
        created_at=closed_at,
        strategy_id=position.strategy_id,
    )
    _append_ledger_fill(
        request.exact_ledger_rows,
        LedgerFill(
            context=request.ledger_context,
            decision=synthetic_decision,
            created_at=closed_at,
            filled_at=closed_at,
            strategy_id=position.strategy_id,
            filled_qty=exit_qty,
            avg_fill_price=fill_price,
            cost_amount=exit_cost_lineage.total_cost,
            cost_lineage=exit_cost_lineage,
        ),
    )
    return _FlattenedPosition(
        symbol_bucket=symbol_bucket,
        trade=_flattened_trade(
            _FlattenedTradeRequest(
                symbol=symbol,
                position=position,
                closed_at=closed_at,
                exit_qty=exit_qty,
                fill_price=fill_price,
                exit_cost=exit_cost_lineage.total_cost,
            )
        ),
        exit_cost=exit_cost_lineage.total_cost,
        exit_notional=exit_notional,
        cash=cash,
    )


def _flattened_trade(request: _FlattenedTradeRequest) -> ClosedTrade:
    gross_pnl = (
        (request.position.avg_entry_price - request.fill_price) * request.exit_qty
        if request.position.qty < 0
        else (request.fill_price - request.position.avg_entry_price) * request.exit_qty
    )
    return ClosedTrade(
        symbol=request.symbol,
        strategy_id=request.position.strategy_id,
        decision_at=request.position.decision_at,
        opened_at=request.position.opened_at,
        closed_at=request.closed_at,
        qty=request.exit_qty,
        entry_price=request.position.avg_entry_price,
        exit_price=request.fill_price,
        gross_pnl=gross_pnl,
        net_pnl=gross_pnl - request.position.entry_cost_total - request.exit_cost,
        exit_reason="eod_flatten",
    )


def _record_flattened_position(
    request: FlattenPositionsRequest,
    flattened: _FlattenedPosition,
) -> None:
    stats = request.stats
    symbol_bucket = flattened.symbol_bucket
    trade = flattened.trade
    exit_cost = flattened.exit_cost
    exit_notional = flattened.exit_notional

    stats["gross_pnl"] += trade.gross_pnl
    stats["net_pnl"] += trade.net_pnl
    stats["cost_total"] += exit_cost
    stats["filled_count"] += 1
    _record_fill_order_type(stats, "market")
    stats["filled_notional"] += exit_notional
    symbol_bucket["gross_pnl"] += trade.gross_pnl
    symbol_bucket["net_pnl"] += trade.net_pnl
    symbol_bucket["cost_total"] += exit_cost
    symbol_bucket["filled_count"] += 1
    _record_fill_order_type(symbol_bucket, "market")
    symbol_bucket["filled_notional"] += exit_notional
    symbol_bucket["closed_trade_count"] += 1
    if trade.net_pnl > 0:
        stats["wins"] += 1
    elif trade.net_pnl < 0:
        stats["losses"] += 1
    stats["closed_trades"].append(trade)
    request.all_closed_trades.append(trade)
    _log_trade_closed(trade)

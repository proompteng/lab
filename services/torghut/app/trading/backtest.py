"""Minimal backtest evaluation utilities."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Literal

from .costs import CostModelInputs, OrderIntent, TransactionCostModel


@dataclass(frozen=True)
class BacktestTrade:
    symbol: str
    side: Literal["long", "short"]
    qty: Decimal
    entry: CostModelInputs
    exit: CostModelInputs
    entry_order_type: Literal["market", "limit", "stop", "stop_limit"] = "market"
    exit_order_type: Literal["market", "limit", "stop", "stop_limit"] = "market"


@dataclass(frozen=True)
class BacktestResult:
    gross_pnl: Decimal
    net_pnl: Decimal
    total_cost: Decimal
    trade_count: int


def evaluate_trades(
    trades: Iterable[BacktestTrade],
    cost_model: TransactionCostModel,
) -> BacktestResult:
    gross_total = Decimal("0")
    cost_total = Decimal("0")
    count = 0
    for trade in trades:
        count += 1
        gross_total += _gross_trade_pnl(trade)
        cost_total += _trade_cost(trade, cost_model)

    return BacktestResult(
        gross_pnl=gross_total,
        net_pnl=gross_total - cost_total,
        total_cost=cost_total,
        trade_count=count,
    )


def _gross_trade_pnl(trade: BacktestTrade) -> Decimal:
    price_delta = trade.exit.price - trade.entry.price
    if trade.side == "short":
        price_delta = -price_delta
    return price_delta * trade.qty


def _trade_cost(trade: BacktestTrade, cost_model: TransactionCostModel) -> Decimal:
    entry_side = "buy" if trade.side == "long" else "sell"
    exit_side = "sell" if trade.side == "long" else "buy"
    entry_order = OrderIntent(
        symbol=trade.symbol,
        side=entry_side,
        qty=trade.qty,
        price=trade.entry.price,
        order_type=trade.entry_order_type,
    )
    exit_order = OrderIntent(
        symbol=trade.symbol,
        side=exit_side,
        qty=trade.qty,
        price=trade.exit.price,
        order_type=trade.exit_order_type,
    )
    entry_cost = cost_model.estimate_costs(entry_order, trade.entry)
    exit_cost = cost_model.estimate_costs(exit_order, trade.exit)
    return entry_cost.total_cost + exit_cost.total_cost


__all__ = ["BacktestTrade", "BacktestResult", "evaluate_trades"]

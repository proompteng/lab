from __future__ import annotations

from app.trading.costs import TransactionCostModel

from app.trading.models import (
    SignalEnvelope,
    StrategyDecision,
)

from dataclasses import dataclass

from datetime import datetime

from decimal import Decimal

from typing import Any

from .costing import _estimate_trade_cost_lineage

from .ledger import (
    LedgerFill,
    _append_ledger_fill,
)

from .fill_stats import (
    _ensure_replay_stats_bucket,
    _log_trade_closed,
    _record_fill_order_type,
)

from .replay_types import (
    ClosedTrade,
    PendingOrder,
    PositionState,
    ReplayLedgerContext,
    _SHARED_POSITION_OWNER,
    _position_key,
)

from .signal_rows import _extract_price


@dataclass(frozen=True)
class ClosePositionRequest:
    symbol: str
    position: PositionState
    close_qty: Decimal
    fill_price: Decimal
    closed_at: datetime
    exit_reason: str
    entry_cost_allocated: Decimal
    exit_cost_total: Decimal


@dataclass(frozen=True)
class FillExecution:
    decision: StrategyDecision
    signal: SignalEnvelope
    fill_price: Decimal
    filled_at: datetime
    created_at: datetime
    cash: Decimal
    force_position_isolation: bool = False
    ledger_strategy_id: str | None = None


@dataclass
class FillAccountingState:
    positions: dict[tuple[str, str], PositionState]
    day_bucket: dict[str, Any]
    symbol_bucket: dict[str, Any] | None
    cost_model: TransactionCostModel
    all_closed_trades: list[ClosedTrade]
    exact_ledger_rows: list[dict[str, Any]] | None = None
    ledger_context: ReplayLedgerContext | None = None


def _positions_payload(
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
    pending_orders: dict[tuple[str, str], PendingOrder] | None = None,
    *,
    force_position_isolation: bool = False,
) -> list[dict[str, Any]]:
    projection = _PositionProjection(
        positions=positions,
        last_prices=last_prices,
        force_position_isolation=force_position_isolation,
    )
    projection.apply_pending_orders(pending_orders or {})
    return projection.payload()


class _PositionProjection:
    def __init__(
        self,
        *,
        positions: dict[tuple[str, str], PositionState],
        last_prices: dict[str, Decimal],
        force_position_isolation: bool,
    ) -> None:
        self.positions = {
            key: PositionState(
                strategy_id=position.strategy_id,
                qty=position.qty,
                avg_entry_price=position.avg_entry_price,
                opened_at=position.opened_at,
                entry_cost_total=position.entry_cost_total,
                decision_at=position.decision_at,
                pending_entry=position.pending_entry,
            )
            for key, position in positions.items()
        }
        self.market_prices = dict(last_prices)
        self.reference_prices = dict(last_prices)
        self.force_position_isolation = force_position_isolation

    def apply_pending_orders(
        self,
        pending_orders: dict[tuple[str, str], PendingOrder],
    ) -> None:
        for pending in pending_orders.values():
            self._apply_pending_order(pending)

    def payload(self) -> list[dict[str, Any]]:
        return [
            self._payload_item(symbol=symbol, position=position)
            for (symbol, _owner_strategy_id), position in self.positions.items()
        ]

    def _apply_pending_order(self, pending: PendingOrder) -> None:
        decision = pending.decision
        owner_strategy_id = _decision_position_owner(
            decision,
            force_position_isolation=self.force_position_isolation,
        )
        position_key = _position_key(decision.symbol, owner_strategy_id)
        reference_price = (
            decision.limit_price
            or self.reference_prices.get(decision.symbol)
            or _extract_price(pending.signal)
        )
        self.reference_prices[decision.symbol] = reference_price
        existing = self.positions.get(position_key)
        if decision.action == "buy":
            self._project_buy(pending, position_key, owner_strategy_id, existing)
            return
        self._project_sell(pending, position_key, owner_strategy_id, existing)

    def _project_buy(
        self,
        pending: PendingOrder,
        position_key: tuple[str, str],
        owner_strategy_id: str,
        existing: PositionState | None,
    ) -> None:
        reference_price = self.reference_prices[pending.decision.symbol]
        if existing is None:
            self.positions[position_key] = self._pending_entry_position(
                pending=pending,
                strategy_id=owner_strategy_id,
                qty=pending.decision.qty,
                reference_price=reference_price,
            )
            return
        if existing.qty < 0:
            self._project_buy_cover(pending, position_key, existing)
            return
        new_qty = existing.qty + pending.decision.qty
        self.positions[position_key] = self._copy_existing_position(
            existing=existing,
            qty=new_qty,
            avg_entry=(
                (existing.avg_entry_price * existing.qty)
                + (reference_price * pending.decision.qty)
            )
            / new_qty,
        )

    def _project_buy_cover(
        self,
        pending: PendingOrder,
        position_key: tuple[str, str],
        existing: PositionState,
    ) -> None:
        remaining_abs_qty = abs(existing.qty) - min(
            pending.decision.qty,
            abs(existing.qty),
        )
        if remaining_abs_qty <= 0:
            self.positions.pop(position_key, None)
            return
        self.positions[position_key] = self._copy_existing_position(
            existing=existing,
            qty=-remaining_abs_qty,
            avg_entry=existing.avg_entry_price,
        )

    def _project_sell(
        self,
        pending: PendingOrder,
        position_key: tuple[str, str],
        owner_strategy_id: str,
        existing: PositionState | None,
    ) -> None:
        reference_price = self.reference_prices[pending.decision.symbol]
        if existing is None:
            self.positions[position_key] = self._pending_entry_position(
                pending=pending,
                strategy_id=owner_strategy_id,
                qty=-pending.decision.qty,
                reference_price=reference_price,
            )
            return
        if existing.qty < 0:
            new_abs_qty = abs(existing.qty) + pending.decision.qty
            self.positions[position_key] = self._copy_existing_position(
                existing=existing,
                qty=-new_abs_qty,
                avg_entry=(
                    (existing.avg_entry_price * abs(existing.qty))
                    + (reference_price * pending.decision.qty)
                )
                / new_abs_qty,
            )
            return
        remaining_qty = existing.qty - min(pending.decision.qty, existing.qty)
        if remaining_qty <= 0:
            self.positions.pop(position_key, None)
            return
        self.positions[position_key] = self._copy_existing_position(
            existing=existing,
            qty=remaining_qty,
            avg_entry=existing.avg_entry_price,
        )

    def _pending_entry_position(
        self,
        *,
        pending: PendingOrder,
        strategy_id: str,
        qty: Decimal,
        reference_price: Decimal,
    ) -> PositionState:
        return PositionState(
            strategy_id=strategy_id,
            qty=qty,
            avg_entry_price=reference_price,
            opened_at=pending.signal.event_ts,
            entry_cost_total=Decimal("0"),
            decision_at=pending.created_at,
            pending_entry=True,
        )

    def _copy_existing_position(
        self,
        *,
        existing: PositionState,
        qty: Decimal,
        avg_entry: Decimal,
    ) -> PositionState:
        return PositionState(
            strategy_id=existing.strategy_id,
            qty=qty,
            avg_entry_price=avg_entry,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total,
            decision_at=existing.decision_at,
            pending_entry=existing.pending_entry,
        )

    def _payload_item(
        self,
        *,
        symbol: str,
        position: PositionState,
    ) -> dict[str, Any]:
        market_price = self.market_prices.get(symbol, position.avg_entry_price)
        signed_qty = position.qty
        return {
            "symbol": symbol,
            "strategy_id": position.strategy_id,
            "qty": str(abs(signed_qty)),
            "side": "short" if signed_qty < 0 else "long",
            "market_value": str(signed_qty * market_price),
            "avg_entry_price": str(position.avg_entry_price),
            "opened_at": position.opened_at.isoformat(),
            "decision_at": position.decision_at.isoformat(),
            "pending_entry": position.pending_entry,
        }


def _position_equity(
    *,
    cash: Decimal,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> Decimal:
    equity = cash
    for (symbol, _owner_strategy_id), position in positions.items():
        equity += position.qty * last_prices.get(symbol, position.avg_entry_price)
    return equity


def _position_exposure(
    *,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> tuple[Decimal, Decimal]:
    gross_exposure = Decimal("0")
    net_exposure = Decimal("0")
    for (symbol, _owner_strategy_id), position in positions.items():
        market_value = position.qty * last_prices.get(symbol, position.avg_entry_price)
        gross_exposure += abs(market_value)
        net_exposure += market_value
    return gross_exposure, net_exposure


def _decision_exit_reason(decision: StrategyDecision) -> str:
    position_exit = decision.params.get("position_exit")
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get("type") or "").strip()
        if exit_type:
            return exit_type
    rationale = str(decision.rationale or "").strip()
    if rationale:
        return rationale.split(",")[0]
    return "signal_exit"


def _decision_position_owner(
    decision: StrategyDecision,
    *,
    force_position_isolation: bool = False,
) -> str:
    if force_position_isolation:
        return decision.strategy_id
    runtime_payload = decision.params.get("strategy_runtime")
    if isinstance(runtime_payload, dict):
        isolation_mode = (
            str(runtime_payload.get("position_isolation_mode") or "").strip().lower()
        )
        if isolation_mode == "per_strategy":
            return decision.strategy_id
    return _SHARED_POSITION_OWNER


def _close_position(
    request: ClosePositionRequest,
) -> tuple[PositionState | None, ClosedTrade]:
    if request.position.qty < 0:
        remaining_qty = request.position.qty + request.close_qty
        gross_pnl = (
            request.position.avg_entry_price - request.fill_price
        ) * request.close_qty
    else:
        remaining_qty = request.position.qty - request.close_qty
        gross_pnl = (
            request.fill_price - request.position.avg_entry_price
        ) * request.close_qty
    net_pnl = gross_pnl - request.entry_cost_allocated - request.exit_cost_total
    remaining_position: PositionState | None = None
    if remaining_qty != 0:
        remaining_position = PositionState(
            strategy_id=request.position.strategy_id,
            qty=remaining_qty,
            avg_entry_price=request.position.avg_entry_price,
            opened_at=request.position.opened_at,
            entry_cost_total=request.position.entry_cost_total
            - request.entry_cost_allocated,
            decision_at=request.position.decision_at,
            pending_entry=False,
        )
    return remaining_position, ClosedTrade(
        symbol=request.symbol,
        strategy_id=request.position.strategy_id,
        decision_at=request.position.decision_at,
        opened_at=request.position.opened_at,
        closed_at=request.closed_at,
        qty=request.close_qty,
        entry_price=request.position.avg_entry_price,
        exit_price=request.fill_price,
        gross_pnl=gross_pnl,
        net_pnl=net_pnl,
        exit_reason=request.exit_reason,
    )


def _apply_filled_decision(
    execution: FillExecution,
    state: FillAccountingState,
) -> Decimal:
    state.day_bucket = _ensure_replay_stats_bucket(state.day_bucket)
    if state.symbol_bucket is not None:
        state.symbol_bucket = _ensure_replay_stats_bucket(state.symbol_bucket)
    return _FilledDecisionApplier(execution=execution, state=state).apply()


class _FilledDecisionApplier:
    def __init__(
        self,
        *,
        execution: FillExecution,
        state: FillAccountingState,
    ) -> None:
        self.execution = execution
        self.state = state
        self.decision = execution.decision
        self.owner_strategy_id = _decision_position_owner(
            self.decision,
            force_position_isolation=execution.force_position_isolation,
        )
        self.position_key = _position_key(self.decision.symbol, self.owner_strategy_id)
        self.cost_lineage = _estimate_trade_cost_lineage(
            model=state.cost_model,
            decision=self.decision,
            signal=execution.signal,
            day_bucket=state.day_bucket,
            symbol_bucket=state.symbol_bucket,
        )
        self.fill_cost = self.cost_lineage.total_cost

    def apply(self) -> Decimal:
        existing = self.state.positions.get(self.position_key)
        if self.decision.action == "buy":
            return self._apply_buy(existing)
        return self._apply_sell(existing)

    def _record_fill(self, *, fill_qty: Decimal, fill_notional: Decimal) -> None:
        self.state.day_bucket["cost_total"] += self.fill_cost
        self.state.day_bucket["filled_count"] += 1
        _record_fill_order_type(self.state.day_bucket, self.decision.order_type)
        self.state.day_bucket["filled_notional"] += fill_notional
        if self.state.symbol_bucket is not None:
            self.state.symbol_bucket["cost_total"] += self.fill_cost
            self.state.symbol_bucket["filled_count"] += 1
            _record_fill_order_type(self.state.symbol_bucket, self.decision.order_type)
            self.state.symbol_bucket["filled_notional"] += fill_notional
        _append_ledger_fill(
            self.state.exact_ledger_rows,
            LedgerFill(
                context=self.state.ledger_context,
                decision=self.decision,
                created_at=self.execution.created_at,
                filled_at=self.execution.filled_at,
                strategy_id=self.execution.ledger_strategy_id or self.owner_strategy_id,
                filled_qty=fill_qty,
                avg_fill_price=self.execution.fill_price,
                cost_amount=self.fill_cost,
                cost_lineage=self.cost_lineage,
            ),
        )

    def _record_closed_trade(self, trade: ClosedTrade) -> None:
        self.state.day_bucket["gross_pnl"] += trade.gross_pnl
        self.state.day_bucket["net_pnl"] += trade.net_pnl
        if self.state.symbol_bucket is not None:
            self.state.symbol_bucket["gross_pnl"] += trade.gross_pnl
            self.state.symbol_bucket["net_pnl"] += trade.net_pnl
            self.state.symbol_bucket["closed_trade_count"] += 1
        if trade.net_pnl > 0:
            self.state.day_bucket["wins"] += 1
        elif trade.net_pnl < 0:
            self.state.day_bucket["losses"] += 1
        self.state.day_bucket["closed_trades"].append(trade)
        self.state.all_closed_trades.append(trade)
        _log_trade_closed(trade)

    def _apply_buy(self, existing: PositionState | None) -> Decimal:
        if existing is not None and existing.qty < 0:
            return self._cover_short(existing)
        return self._open_or_add_long(existing)

    def _cover_short(self, existing: PositionState) -> Decimal:
        cover_qty = min(self.decision.qty, abs(existing.qty))
        fill_notional = self.execution.fill_price * cover_qty
        self._record_fill(fill_qty=cover_qty, fill_notional=fill_notional)
        cash = self.execution.cash - fill_notional - self.fill_cost
        remaining, trade = _close_position(
            ClosePositionRequest(
                symbol=self.decision.symbol,
                position=existing,
                close_qty=cover_qty,
                fill_price=self.execution.fill_price,
                closed_at=self.execution.filled_at,
                exit_reason=_decision_exit_reason(self.decision),
                entry_cost_allocated=existing.entry_cost_total
                * (cover_qty / abs(existing.qty)),
                exit_cost_total=self.fill_cost,
            )
        )
        self._replace_or_clear_position(remaining)
        self._record_closed_trade(trade)
        return cash

    def _open_or_add_long(self, existing: PositionState | None) -> Decimal:
        fill_notional = self.execution.fill_price * self.decision.qty
        self._record_fill(fill_qty=self.decision.qty, fill_notional=fill_notional)
        cash = self.execution.cash - fill_notional - self.fill_cost
        if existing is None:
            self.state.positions[self.position_key] = self._new_position(
                qty=self.decision.qty,
            )
            return cash
        new_qty = existing.qty + self.decision.qty
        self.state.positions[self.position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=new_qty,
            avg_entry_price=(
                (existing.avg_entry_price * existing.qty)
                + (self.execution.fill_price * self.decision.qty)
            )
            / new_qty,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total + self.fill_cost,
            decision_at=existing.decision_at,
            pending_entry=False,
        )
        return cash

    def _apply_sell(self, existing: PositionState | None) -> Decimal:
        if existing is None:
            return self._open_short()
        if existing.qty < 0:
            return self._add_short(existing)
        return self._sell_long(existing)

    def _open_short(self) -> Decimal:
        fill_notional = self.execution.fill_price * self.decision.qty
        self._record_fill(fill_qty=self.decision.qty, fill_notional=fill_notional)
        self.state.positions[self.position_key] = self._new_position(
            qty=-self.decision.qty,
        )
        return self.execution.cash + fill_notional - self.fill_cost

    def _add_short(self, existing: PositionState) -> Decimal:
        fill_notional = self.execution.fill_price * self.decision.qty
        self._record_fill(fill_qty=self.decision.qty, fill_notional=fill_notional)
        new_abs_qty = abs(existing.qty) + self.decision.qty
        self.state.positions[self.position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=-new_abs_qty,
            avg_entry_price=(
                (existing.avg_entry_price * abs(existing.qty))
                + (self.execution.fill_price * self.decision.qty)
            )
            / new_abs_qty,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total + self.fill_cost,
            decision_at=existing.decision_at,
            pending_entry=False,
        )
        return self.execution.cash + fill_notional - self.fill_cost

    def _sell_long(self, existing: PositionState) -> Decimal:
        sell_qty = min(self.decision.qty, existing.qty)
        fill_notional = self.execution.fill_price * sell_qty
        self._record_fill(fill_qty=sell_qty, fill_notional=fill_notional)
        cash = self.execution.cash + fill_notional - self.fill_cost
        remaining, trade = _close_position(
            ClosePositionRequest(
                symbol=self.decision.symbol,
                position=existing,
                close_qty=sell_qty,
                fill_price=self.execution.fill_price,
                closed_at=self.execution.filled_at,
                exit_reason=_decision_exit_reason(self.decision),
                entry_cost_allocated=existing.entry_cost_total
                * (sell_qty / existing.qty),
                exit_cost_total=self.fill_cost,
            )
        )
        self._replace_or_clear_position(remaining)
        self._record_closed_trade(trade)
        return cash

    def _new_position(self, *, qty: Decimal) -> PositionState:
        return PositionState(
            strategy_id=self.owner_strategy_id,
            qty=qty,
            avg_entry_price=self.execution.fill_price,
            opened_at=self.execution.filled_at,
            entry_cost_total=self.fill_cost,
            decision_at=self.execution.created_at,
            pending_entry=False,
        )

    def _replace_or_clear_position(self, remaining: PositionState | None) -> None:
        if remaining is None:
            self.state.positions.pop(self.position_key, None)
            return
        self.state.positions[self.position_key] = remaining

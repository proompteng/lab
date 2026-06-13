from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.trading.models import SignalEnvelope, StrategyDecision

from .ledger import (
    LedgerResolution,
    _append_ledger_resolution,
    _ledger_resolution_event_type,
)
from .order_lifecycle import (
    OrderLifecycleBuckets,
    OrderLifecycleEvent,
    _pending_censor_time,
    _record_order_lifecycle,
    _resolve_pending_fill_price,
)
from .positions import (
    FillAccountingState,
    FillExecution,
    _apply_filled_decision,
    _decision_position_owner,
)
from .replay_state import ReplayRunState
from .replay_types import PendingOrder


@dataclass(frozen=True)
class LifecycleResolution:
    pending: PendingOrder | None
    decision: StrategyDecision
    placement_signal: SignalEnvelope
    created_at: datetime
    resolved_at: datetime
    outcome: str
    censor_reason: str | None = None


@dataclass(frozen=True)
class PendingResolutionContext:
    signal: SignalEnvelope
    day_bucket: dict[str, Any]
    symbol_bucket: dict[str, Any]


def _record_lifecycle_outcome(
    state: ReplayRunState,
    resolution: LifecycleResolution,
) -> None:
    ledger_decision = (
        resolution.pending.decision if resolution.pending else resolution.decision
    )
    ledger_created_at = (
        resolution.pending.created_at if resolution.pending else resolution.created_at
    )
    ledger_strategy_id = _decision_position_owner(
        ledger_decision,
        force_position_isolation=state.config.force_position_isolation,
    )
    if (event_type := _ledger_resolution_event_type(resolution.outcome)) is not None:
        _append_ledger_resolution(
            state.exact_ledger_rows,
            LedgerResolution(
                context=state.ledger_context,
                decision=ledger_decision,
                created_at=ledger_created_at,
                resolved_at=resolution.resolved_at,
                strategy_id=ledger_strategy_id,
                event_type=event_type,
                reason=resolution.censor_reason or resolution.outcome,
            ),
        )
    pending = resolution.pending
    _record_order_lifecycle(
        OrderLifecycleBuckets(
            aggregate=state.order_lifecycle_stats,
            by_day=state.order_lifecycle_day_stats,
            by_symbol=state.order_lifecycle_symbol_stats,
        ),
        OrderLifecycleEvent(
            decision=pending.decision if pending else resolution.decision,
            placement_signal=pending.signal if pending else resolution.placement_signal,
            created_at=pending.created_at if pending else resolution.created_at,
            resolved_at=resolution.resolved_at,
            outcome=resolution.outcome,
            censor_reason=resolution.censor_reason,
        ),
    )


def _censor_pending_orders(
    state: ReplayRunState,
    *,
    reason: str,
    fallback: datetime,
) -> None:
    for pending_key in sorted(list(state.pending_orders)):
        pending = state.pending_orders.pop(pending_key, None)
        if pending is None:
            continue
        _record_lifecycle_outcome(
            state,
            LifecycleResolution(
                pending=pending,
                decision=pending.decision,
                placement_signal=pending.signal,
                created_at=pending.created_at,
                resolved_at=_pending_censor_time(pending=pending, fallback=fallback),
                outcome="censored",
                censor_reason=reason,
            ),
        )


def _fill_matching_pending_orders(
    state: ReplayRunState,
    context: PendingResolutionContext,
) -> None:
    matching_keys = [
        pending_key
        for pending_key in sorted(state.pending_orders)
        if pending_key[0] == context.signal.symbol
    ]
    for pending_key in matching_keys:
        pending = state.pending_orders.pop(pending_key, None)
        if pending is not None:
            _resolve_pending_order(state, context, pending_key, pending)


def _resolve_pending_order(
    state: ReplayRunState,
    context: PendingResolutionContext,
    pending_key: tuple[str, str],
    pending: PendingOrder,
) -> None:
    fill_price = _resolve_pending_fill_price(pending.decision, context.signal)
    if fill_price is None:
        state.pending_orders[pending_key] = pending
        return
    _record_lifecycle_outcome(
        state,
        LifecycleResolution(
            pending=pending,
            decision=pending.decision,
            placement_signal=pending.signal,
            created_at=pending.created_at,
            resolved_at=context.signal.event_ts,
            outcome="filled",
        ),
    )
    state.cash = _apply_filled_decision(
        FillExecution(
            decision=pending.decision,
            signal=context.signal,
            fill_price=fill_price,
            filled_at=context.signal.event_ts,
            created_at=pending.created_at,
            cash=state.cash,
            force_position_isolation=state.config.force_position_isolation,
            ledger_strategy_id=_decision_position_owner(
                pending.decision,
                force_position_isolation=state.config.force_position_isolation,
            ),
        ),
        FillAccountingState(
            positions=state.positions,
            day_bucket=context.day_bucket,
            symbol_bucket=context.symbol_bucket,
            cost_model=state.cost_model,
            all_closed_trades=state.all_closed_trades,
            exact_ledger_rows=state.exact_ledger_rows,
            ledger_context=state.ledger_context,
        ),
    )


def _record_replaced_pending(
    state: ReplayRunState,
    signal: SignalEnvelope,
    pending: PendingOrder,
    reason: str,
) -> None:
    _record_lifecycle_outcome(
        state,
        LifecycleResolution(
            pending=pending,
            decision=pending.decision,
            placement_signal=pending.signal,
            created_at=pending.created_at,
            resolved_at=signal.event_ts,
            outcome="replaced",
            censor_reason=reason,
        ),
    )


__all__ = [
    "LifecycleResolution",
    "PendingResolutionContext",
    "_censor_pending_orders",
    "_fill_matching_pending_orders",
    "_record_lifecycle_outcome",
    "_record_replaced_pending",
]

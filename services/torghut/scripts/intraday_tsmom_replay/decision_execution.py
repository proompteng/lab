from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from app.trading.evaluation_trace import ReplayTraceRecord
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.prices import MarketSnapshot
from app.trading.strategy_runtime import StrategyRuntime

from .ledger import _append_ledger_submission
from .order_lifecycle import (
    _apply_order_preferences,
    _log_pending_order_replaced,
    _reconcile_pending_order_before_immediate_fill,
    _resolve_pending_fill_price,
    _should_replace_pending_order,
)
from .order_resolution import (
    LifecycleResolution,
    _record_lifecycle_outcome,
    _record_replaced_pending,
)
from .positions import (
    FillAccountingState,
    FillExecution,
    _apply_filled_decision,
    _decision_position_owner,
    _positions_payload,
)
from .replay_state import ReplayRunState, _active_symbol_funnel
from .replay_types import PendingOrder, _position_key
from .runtime_evaluation import RuntimeEvaluation


@dataclass
class DecisionExecutionContext:
    signal: SignalEnvelope
    signal_day: object
    day_bucket: dict[str, Any]
    fill_status_by_strategy_id: dict[str, str]


def _execute_decisions(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decisions: list[StrategyDecision],
) -> None:
    for decision in decisions:
        _execute_decision(state, context, decision)


def _execute_decision(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    raw_decision: StrategyDecision,
) -> None:
    strategy = state.strategies_by_id.get(raw_decision.strategy_id)
    decision = _apply_order_preferences(
        raw_decision,
        context.signal,
        strategy_params=StrategyRuntime._strategy_params(strategy)
        if strategy
        else None,
    )
    policy_outcome = state.execution_policy.evaluate(
        decision,
        strategy=strategy,
        positions=_positions_payload(
            state.positions,
            state.last_prices,
            state.pending_orders,
            force_position_isolation=state.config.force_position_isolation,
        ),
        market_snapshot=_replay_market_snapshot(context.signal),
        kill_switch_enabled=False,
        adaptive_policy=None,
    )
    if not policy_outcome.approved:
        context.fill_status_by_strategy_id[decision.strategy_id] = (
            policy_outcome.reasons[0]
            if policy_outcome.reasons
            else "execution_policy_rejected"
        )
        return
    decision = policy_outcome.decision.model_copy(
        update={
            "params": {
                **policy_outcome.decision.params,
                **policy_outcome.params_update(),
            }
        }
    )
    _record_decision_or_return(state, context, decision)


def _replay_market_snapshot(signal: SignalEnvelope) -> MarketSnapshot:
    from .signal_rows import _extract_price, _extract_spread

    return MarketSnapshot(
        symbol=signal.symbol,
        as_of=signal.event_ts,
        price=_extract_price(signal),
        spread=_extract_spread(signal),
        source="intraday_tsmom_replay",
        quote_as_of=signal.event_ts,
        quote_source="replay_tape_or_clickhouse",
    )


def _record_decision_or_return(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
) -> None:
    from .replay_stats import _record_decision

    _record_decision(context.day_bucket, decision)
    symbol_bucket = _active_symbol_funnel(state, context.signal_day, decision.symbol)
    symbol_bucket["decision_count"] += 1
    if decision.qty <= 0:
        return
    immediate_fill_price = _resolve_pending_fill_price(decision, context.signal)
    if immediate_fill_price is not None:
        _fill_immediate_decision(
            state, context, decision, immediate_fill_price, symbol_bucket
        )
        return
    _queue_pending_decision(state, context, decision)


def _fill_immediate_decision(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
    fill_price: Decimal,
    symbol_bucket: dict[str, Any],
) -> None:
    _replace_pending_before_immediate_fill(state, context, decision)
    ledger_strategy_id = _decision_position_owner(
        decision,
        force_position_isolation=state.config.force_position_isolation,
    )
    _record_immediate_fill_lifecycle(state, context, decision)
    _append_ledger_submission(
        rows=state.exact_ledger_rows,
        context=state.ledger_context,
        decision=decision,
        created_at=context.signal.event_ts,
        strategy_id=ledger_strategy_id,
    )
    state.cash = _apply_filled_decision(
        FillExecution(
            decision=decision,
            signal=context.signal,
            fill_price=fill_price,
            filled_at=context.signal.event_ts,
            created_at=context.signal.event_ts,
            cash=state.cash,
            force_position_isolation=state.config.force_position_isolation,
            ledger_strategy_id=ledger_strategy_id,
        ),
        FillAccountingState(
            positions=state.positions,
            day_bucket=context.day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=state.cost_model,
            all_closed_trades=state.all_closed_trades,
            exact_ledger_rows=state.exact_ledger_rows,
            ledger_context=state.ledger_context,
        ),
    )
    context.fill_status_by_strategy_id[decision.strategy_id] = "filled"


def _replace_pending_before_immediate_fill(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
) -> None:
    replaced_pending = _reconcile_pending_order_before_immediate_fill(
        decision=decision,
        pending_orders=state.pending_orders,
        created_at=context.signal.event_ts,
        force_position_isolation=state.config.force_position_isolation,
    )
    if replaced_pending is not None:
        _record_replaced_pending(
            state,
            context.signal,
            replaced_pending,
            "immediate_fill_replaced_pending",
        )


def _record_immediate_fill_lifecycle(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
) -> None:
    _record_lifecycle_outcome(
        state,
        LifecycleResolution(
            pending=None,
            decision=decision,
            placement_signal=context.signal,
            created_at=context.signal.event_ts,
            resolved_at=context.signal.event_ts,
            outcome="filled",
        ),
    )


def _queue_pending_decision(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
) -> None:
    ledger_strategy_id = _decision_position_owner(
        decision,
        force_position_isolation=state.config.force_position_isolation,
    )
    pending_key = _position_key(decision.symbol, ledger_strategy_id)
    existing_pending = state.pending_orders.get(pending_key)
    if existing_pending is not None:
        _replace_pending_if_needed(
            state, context, decision, pending_key, existing_pending
        )
        return
    _store_pending_decision(state, context, decision, pending_key, ledger_strategy_id)


def _replace_pending_if_needed(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
    pending_key: tuple[str, str],
    existing_pending: PendingOrder,
) -> None:
    if not _should_replace_pending_order(
        existing=existing_pending.decision, replacement=decision
    ):
        return
    _record_replaced_pending(
        state, context.signal, existing_pending, "pending_replaced"
    )
    _store_pending_decision(
        state,
        context,
        decision,
        pending_key,
        _decision_position_owner(
            decision,
            force_position_isolation=state.config.force_position_isolation,
        ),
    )
    _log_pending_order_replaced(
        created_at=context.signal.event_ts,
        existing=existing_pending.decision,
        replacement=decision,
    )


def _store_pending_decision(
    state: ReplayRunState,
    context: DecisionExecutionContext,
    decision: StrategyDecision,
    pending_key: tuple[str, str],
    ledger_strategy_id: str,
) -> None:
    state.pending_orders[pending_key] = PendingOrder(
        decision=decision,
        created_at=context.signal.event_ts,
        signal=context.signal,
    )
    _append_ledger_submission(
        rows=state.exact_ledger_rows,
        context=state.ledger_context,
        decision=decision,
        created_at=context.signal.event_ts,
        strategy_id=ledger_strategy_id,
    )
    from .replay_stats import _log_decision_queued

    _log_decision_queued(decision, context.signal.event_ts)
    context.fill_status_by_strategy_id[decision.strategy_id] = "pending"


def _record_trace_rows(
    state: ReplayRunState,
    signal_day: object,
    evaluation: RuntimeEvaluation,
    fill_status_by_strategy_id: dict[str, str],
) -> None:
    if not state.config.capture_traces:
        return
    for trace in evaluation.telemetry_traces:
        state.trace_records.append(
            ReplayTraceRecord(
                trading_day=str(signal_day),
                strategy_trace=trace,
                decision_emitted=trace.strategy_id in evaluation.emitted_strategy_ids,
                fill_status=fill_status_by_strategy_id.get(trace.strategy_id, "none"),
                decision_strategy_id=trace.strategy_id
                if trace.strategy_id in evaluation.emitted_strategy_ids
                else None,
                block_reason=evaluation.block_reason_by_strategy_id.get(
                    trace.strategy_id
                ),
            )
        )


__all__ = [
    "DecisionExecutionContext",
    "_execute_decisions",
    "_record_trace_rows",
]

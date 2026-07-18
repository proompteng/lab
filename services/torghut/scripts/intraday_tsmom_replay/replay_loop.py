from __future__ import annotations

import time as time_mod
from datetime import date
from decimal import Decimal
from typing import Any

from app.config import settings
from app.trading.economic_policy import (
    bind_economic_policy_settings,
    load_economic_policy,
)
from app.trading.models import SignalEnvelope
from app.trading.session_context import regular_session_close_utc_for

from .decision_execution import (
    DecisionExecutionContext,
    _execute_decisions,
    _record_trace_rows,
)
from .flattening import FlattenPositionsRequest, _flatten_positions
from .order_resolution import (
    PendingResolutionContext,
    _censor_pending_orders,
    _fill_matching_pending_orders,
)
from .positions import _position_equity, _positions_payload
from .replay_payload import _build_payload
from .replay_state import ReplayRunState, _active_day_stats, _active_symbol_funnel
from .replay_stats import (
    ReplayProgressSnapshot,
    _log_day_summary,
    _log_progress,
    _record_capital_snapshot,
    _record_liquidity_observation,
)
from .replay_types import ReplayConfig, _decimal_text, logger
from .runtime_evaluation import RuntimeEvaluationRequest, _evaluate_runtime
from .signal_rows import _extract_price, _iter_signal_rows, _log_quote_skipped


def run_replay(config: ReplayConfig) -> dict[str, Any]:
    economic_policy = load_economic_policy(config.economic_policy_path)
    with bind_economic_policy_settings(economic_policy, settings):
        state = ReplayRunState.create(config, economic_policy)
        _log_replay_start(state)
        _consume_signals(state)
        _complete_current_day(state, censor_reason="replay_end")
        return _build_payload(state)


def _log_replay_start(state: ReplayRunState) -> None:
    logger.info(
        "replay_start start_date=%s end_date=%s chunk_minutes=%s flatten_eod=%s start_equity=%s symbol_count=%s symbols=%s",
        state.config.start_date.isoformat(),
        state.config.end_date.isoformat(),
        state.config.chunk_minutes,
        state.config.flatten_eod,
        _decimal_text(state.config.start_equity),
        len(state.config.symbols),
        ",".join(state.config.symbols) if state.config.symbols else "*",
    )


def _consume_signals(state: ReplayRunState) -> None:
    for signal in _iter_signal_rows(state.config):
        enriched = signal.model_copy(
            update={"payload": state.session_context.enrich_signal_payload(signal)}
        )
        _process_signal(state, enriched)


def _process_signal(state: ReplayRunState, signal: SignalEnvelope) -> None:
    signal_day = signal.event_ts.date()
    _ensure_current_day(state, signal_day)
    state.signals_seen += 1
    day_bucket = _active_day_stats(state, signal_day)
    symbol_bucket = _active_symbol_funnel(state, signal_day, signal.symbol)
    symbol_bucket["retained_rows"] += 1
    quote_status = state.quote_quality.assess(signal)
    if not quote_status.valid:
        _handle_invalid_quote(state, signal, quote_status)
        return
    _process_valid_signal(state, signal, signal_day, day_bucket, symbol_bucket)


def _ensure_current_day(state: ReplayRunState, signal_day: date) -> None:
    if state.current_day is None:
        _start_day(state, signal_day)
        return
    if state.current_day == signal_day:
        return
    _complete_current_day(state, censor_reason="day_boundary")
    _start_day(state, signal_day)


def _start_day(state: ReplayRunState, signal_day: date) -> None:
    state.current_day = signal_day
    logger.info("replay_day_start day=%s", signal_day.isoformat())
    _record_capital_snapshot(
        bucket=_active_day_stats(state, signal_day),
        cash=state.cash,
        positions=state.positions,
        last_prices=state.last_prices,
    )


def _complete_current_day(state: ReplayRunState, *, censor_reason: str) -> None:
    if state.current_day is None:
        return
    if state.config.flatten_eod:
        state.cash = _flatten_positions(
            FlattenPositionsRequest(
                day=state.current_day,
                stats=_active_day_stats(state, state.current_day),
                funnel_stats=state.funnel_stats,
                positions=state.positions,
                last_signals=state.last_signals,
                last_prices=state.last_prices,
                cost_model=state.cost_model,
                all_closed_trades=state.all_closed_trades,
                cash=state.cash,
                exact_ledger_rows=state.exact_ledger_rows,
                ledger_context=state.ledger_context,
            )
        )
    _censor_pending_orders(
        state,
        reason=censor_reason,
        fallback=regular_session_close_utc_for(state.current_day),
    )
    _log_current_day_summary(state)


def _log_current_day_summary(state: ReplayRunState) -> None:
    if state.current_day is None:
        return
    day_stats = _active_day_stats(state, state.current_day)
    equity = _record_capital_snapshot(
        bucket=day_stats,
        cash=state.cash,
        positions=state.positions,
        last_prices=state.last_prices,
    )
    _log_day_summary(
        day=state.current_day,
        stats=day_stats,
        cash=state.cash,
        equity=equity,
        open_positions=len(state.positions),
    )


def _handle_invalid_quote(
    state: ReplayRunState, signal: SignalEnvelope, quote_status: Any
) -> None:
    state.engine.observe_signal(signal)
    has_open_position = any(symbol == signal.symbol for symbol, _ in state.positions)
    has_pending_order = any(
        symbol == signal.symbol for symbol, _ in state.pending_orders
    )
    if has_open_position or has_pending_order:
        _log_quote_skipped(
            signal=signal,
            status=quote_status,
            has_open_position=has_open_position,
            has_pending_order=has_pending_order,
        )


def _process_valid_signal(
    state: ReplayRunState,
    signal: SignalEnvelope,
    signal_day: date,
    day_bucket: dict[str, Any],
    symbol_bucket: dict[str, Any],
) -> None:
    _record_valid_signal_inputs(state, signal, day_bucket, symbol_bucket)
    _record_capital_snapshot(
        bucket=day_bucket,
        cash=state.cash,
        positions=state.positions,
        last_prices=state.last_prices,
    )
    _fill_matching_pending_orders(
        state,
        PendingResolutionContext(
            signal=signal,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
        ),
    )
    equity = _record_capital_snapshot(
        bucket=day_bucket,
        cash=state.cash,
        positions=state.positions,
        last_prices=state.last_prices,
    )
    live_positions = _positions_payload(
        state.positions,
        state.last_prices,
        state.pending_orders,
        force_position_isolation=state.config.force_position_isolation,
    )
    evaluation = _evaluate_runtime(
        state,
        RuntimeEvaluationRequest(
            signal=signal,
            signal_day=signal_day,
            equity=equity,
            live_positions=live_positions,
            symbol_bucket=symbol_bucket,
        ),
    )
    execution_context = DecisionExecutionContext(
        signal=signal,
        signal_day=signal_day,
        day_bucket=day_bucket,
        fill_status_by_strategy_id={},
    )
    _execute_decisions(state, execution_context, evaluation.executable_decisions)
    _record_trace_rows(
        state,
        signal_day,
        evaluation,
        execution_context.fill_status_by_strategy_id,
    )
    _maybe_log_progress(state, signal, signal_day, day_bucket)


def _record_valid_signal_inputs(
    state: ReplayRunState,
    signal: SignalEnvelope,
    day_bucket: dict[str, Any],
    symbol_bucket: dict[str, Any],
) -> None:
    price = _extract_price(signal)
    symbol_bucket["quote_valid_rows"] += 1
    state.last_prices[signal.symbol] = price
    state.last_signals[signal.symbol] = signal
    _record_liquidity_observation(bucket=day_bucket, signal=signal)
    _record_liquidity_observation(bucket=symbol_bucket, signal=signal)


def _maybe_log_progress(
    state: ReplayRunState,
    signal: SignalEnvelope,
    signal_day: date,
    day_bucket: dict[str, Any],
) -> None:
    equity = _record_capital_snapshot(
        bucket=day_bucket,
        cash=state.cash,
        positions=state.positions,
        last_prices=state.last_prices,
    )
    if (
        time_mod.monotonic() - state.last_progress_at
    ) < state.config.progress_log_interval_seconds:
        return
    state.last_progress_at = time_mod.monotonic()
    _log_progress(
        ReplayProgressSnapshot(
            signal_day=signal_day,
            signal_ts=signal.event_ts,
            signals_seen=state.signals_seen,
            day_bucket=day_bucket,
            open_position_count=len(state.positions),
            pending_order_count=len(state.pending_orders),
            cash=state.cash,
            equity=equity,
        )
    )


def _latest_equity(state: ReplayRunState) -> Decimal:
    return _position_equity(
        cash=state.cash,
        positions=state.positions,
        last_prices=state.last_prices,
    )


__all__ = ["run_replay"]

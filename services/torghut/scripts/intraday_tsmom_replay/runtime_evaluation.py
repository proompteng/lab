from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.portfolio import allocator_from_settings, sizer_from_settings

from .order_lifecycle import (
    TraceBlockContext,
    _first_reject_reason,
    _resolve_passed_trace_block_reason,
)
from .replay_state import ReplayRunState
from .replay_stats import (
    _build_near_miss,
    _insert_near_miss,
    _record_trace_for_funnel,
    _signal_regime_label,
)


@dataclass(frozen=True)
class RuntimeEvaluation:
    telemetry_traces: tuple[Any, ...]
    executable_decisions: list[StrategyDecision]
    emitted_strategy_ids: set[str]
    block_reason_by_strategy_id: dict[str, str]


@dataclass(frozen=True)
class RuntimeEvaluationRequest:
    signal: SignalEnvelope
    signal_day: object
    equity: Decimal
    live_positions: list[dict[str, Any]]
    symbol_bucket: dict[str, Any]


@dataclass
class AllocationFilteringContext:
    account: dict[str, str]
    live_positions: list[dict[str, Any]]
    equity: Decimal
    executable: list[StrategyDecision]
    allocation_rejects: dict[str, str]
    sizing_rejects: dict[str, str]


@dataclass(frozen=True)
class TraceBlockReasonInputs:
    telemetry: Any
    traces: tuple[Any, ...]
    raw_decision_strategy_ids: set[str]
    allocation_rejects: dict[str, str]
    sizing_rejects: dict[str, str]
    emitted_strategy_ids: set[str]


def _evaluate_runtime(
    state: ReplayRunState,
    request: RuntimeEvaluationRequest,
) -> RuntimeEvaluation:
    raw_decisions = state.engine.evaluate(
        request.signal,
        state.strategies,
        equity=request.equity,
        positions=request.live_positions,
    )
    telemetry = state.engine.consume_runtime_telemetry()
    request.symbol_bucket["runtime_evaluable_rows"] += 1
    traces = tuple(telemetry.traces if state.capture_runtime_traces else ())
    _record_runtime_traces(
        state, str(request.signal_day), request.symbol_bucket, traces
    )
    executable, allocation_rejects, sizing_rejects = _filter_executable_decisions(
        state,
        raw_decisions,
        request.equity,
        request.live_positions,
        _signal_regime_label(request.signal),
    )
    block_reasons = _trace_block_reasons(
        state,
        TraceBlockReasonInputs(
            telemetry=telemetry,
            traces=traces,
            raw_decision_strategy_ids={
                decision.strategy_id for decision in raw_decisions
            },
            allocation_rejects=allocation_rejects,
            sizing_rejects=sizing_rejects,
            emitted_strategy_ids={decision.strategy_id for decision in executable},
        ),
    )
    _record_post_gate_block_reasons(request.symbol_bucket, traces, block_reasons)
    return RuntimeEvaluation(
        telemetry_traces=traces,
        executable_decisions=executable,
        emitted_strategy_ids={decision.strategy_id for decision in executable},
        block_reason_by_strategy_id=block_reasons,
    )


def _record_runtime_traces(
    state: ReplayRunState,
    trading_day: str,
    symbol_bucket: dict[str, Any],
    traces: tuple[Any, ...],
) -> None:
    for trace in traces:
        _record_trace_for_funnel(symbol_bucket, trace)
        near_miss = _build_near_miss(trace, trading_day=trading_day)
        if near_miss is not None:
            _insert_near_miss(state.near_misses, near_miss)


def _filter_executable_decisions(
    state: ReplayRunState,
    raw_decisions: list[StrategyDecision],
    equity: Decimal,
    live_positions: list[dict[str, Any]],
    regime_label: str | None,
) -> tuple[list[StrategyDecision], dict[str, str], dict[str, str]]:
    context = AllocationFilteringContext(
        account={"equity": str(equity)},
        live_positions=live_positions,
        equity=equity,
        executable=[],
        allocation_rejects={},
        sizing_rejects={},
    )
    for allocation_result in allocator_from_settings(equity).allocate(
        raw_decisions,
        account=context.account,
        positions=context.live_positions,
        regime_label=regime_label,
    ):
        _handle_allocation_result(state, allocation_result, context)
    return context.executable, context.allocation_rejects, context.sizing_rejects


def _handle_allocation_result(
    state: ReplayRunState,
    allocation_result: Any,
    context: AllocationFilteringContext,
) -> None:
    decision = allocation_result.decision
    if not allocation_result.approved:
        context.allocation_rejects.setdefault(
            decision.strategy_id,
            _first_reject_reason(
                reason_codes=allocation_result.reason_codes,
                default_reason="allocator_rejected",
            ),
        )
        return
    strategy = state.strategies_by_id.get(decision.strategy_id)
    if strategy is None:
        context.executable.append(decision)
        return
    sizing_result = sizer_from_settings(strategy, context.equity).size(
        decision,
        account=context.account,
        positions=context.live_positions,
    )
    if sizing_result.approved:
        context.executable.append(sizing_result.decision)
        return
    context.sizing_rejects.setdefault(
        decision.strategy_id,
        _first_reject_reason(
            reason_codes=sizing_result.reasons,
            default_reason="sizer_rejected",
        ),
    )


def _trace_block_reasons(
    state: ReplayRunState,
    inputs: TraceBlockReasonInputs,
) -> dict[str, str]:
    if not state.capture_runtime_traces:
        return {}
    runtime_intents, suppressions = _runtime_intent_details(
        inputs.telemetry,
        inputs.raw_decision_strategy_ids,
    )
    context = TraceBlockContext(
        runtime_intent_strategy_ids=runtime_intents,
        runtime_suppression_reason_by_strategy_id=suppressions,
        raw_decision_strategy_ids=inputs.raw_decision_strategy_ids,
        allocation_reject_reason_by_strategy_id=inputs.allocation_rejects,
        sizing_reject_reason_by_strategy_id=inputs.sizing_rejects,
        emitted_strategy_ids=inputs.emitted_strategy_ids,
    )
    return _trace_block_reason_map(inputs.traces, context)


def _runtime_intent_details(
    telemetry: Any,
    raw_decision_strategy_ids: set[str],
) -> tuple[set[str], dict[str, str]]:
    observation = getattr(telemetry, "observation", None)
    if observation is None:
        return set(raw_decision_strategy_ids), {}
    suppressions: dict[str, str] = {}
    for raw_key in observation.strategy_intent_suppression_total:
        strategy_id, separator, reason = str(raw_key).partition("|")
        if separator and strategy_id and reason:
            suppressions.setdefault(strategy_id, reason)
    return set(observation.strategy_intents_total), suppressions


def _trace_block_reason_map(
    traces: tuple[Any, ...],
    context: TraceBlockContext,
) -> dict[str, str]:
    block_reasons: dict[str, str] = {}
    for trace in traces:
        if trace.passed:
            reason = _resolve_passed_trace_block_reason(trace.strategy_id, context)
            if reason is not None:
                block_reasons[trace.strategy_id] = reason
            continue
        if trace.first_failed_gate is not None:
            block_reasons[trace.strategy_id] = trace.first_failed_gate
    return block_reasons


def _record_post_gate_block_reasons(
    symbol_bucket: dict[str, Any],
    traces: tuple[Any, ...],
    block_reasons: dict[str, str],
) -> None:
    for trace in traces:
        reason = block_reasons.get(trace.strategy_id)
        if trace.passed and reason is not None:
            symbol_bucket["post_gate_block_reason_counts"][reason] += 1


__all__ = [
    "RuntimeEvaluation",
    "RuntimeEvaluationRequest",
    "_evaluate_runtime",
]

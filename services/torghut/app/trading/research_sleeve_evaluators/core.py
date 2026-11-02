from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, cast
from app.trading.evaluation_trace import (
    GateCategory,
    GateTrace,
    StrategyTrace,
    ThresholdTrace,
)


@dataclass(frozen=True)
class SleeveSignalEvaluation:
    action: Literal["buy", "sell"]
    confidence: Decimal
    rationale: tuple[str, ...]
    notional_multiplier: Decimal = Decimal("1")


@dataclass(frozen=True)
class SleeveSignalResult:
    signal: SleeveSignalEvaluation | None
    trace: StrategyTrace | None = None


@dataclass(frozen=True)
class StrategyTraceRequest:
    strategy_id: str | None
    strategy_type: str | None
    symbol: str
    event_ts: str
    timeframe: str | None
    passed: bool
    action: Literal["buy", "sell"] | None
    rationale: tuple[str, ...]
    gates: tuple[GateTrace, ...]
    trace_enabled: bool
    context: dict[str, Any] | None = None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> StrategyTraceRequest:
        return cls(
            strategy_id=cast(str | None, values.get("strategy_id")),
            strategy_type=cast(str | None, values.get("strategy_type")),
            symbol=cast(str, values["symbol"]),
            event_ts=cast(str, values["event_ts"]),
            timeframe=cast(str | None, values.get("timeframe")),
            passed=cast(bool, values["passed"]),
            action=cast(Literal["buy", "sell"] | None, values.get("action")),
            rationale=cast(tuple[str, ...], values["rationale"]),
            gates=cast(tuple[GateTrace, ...], values["gates"]),
            trace_enabled=cast(bool, values["trace_enabled"]),
            context=cast(dict[str, Any] | None, values.get("context")),
        )


@dataclass(frozen=True)
class SleeveResultRequest:
    strategy_id: str | None
    strategy_type: str | None
    symbol: str
    event_ts: str
    timeframe: str | None
    signal: SleeveSignalEvaluation | None
    gates: tuple[GateTrace, ...]
    trace_enabled: bool
    context: dict[str, Any] | None = None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> SleeveResultRequest:
        return cls(
            strategy_id=cast(str | None, values.get("strategy_id")),
            strategy_type=cast(str | None, values.get("strategy_type")),
            symbol=cast(str, values["symbol"]),
            event_ts=cast(str, values["event_ts"]),
            timeframe=cast(str | None, values.get("timeframe")),
            signal=cast(SleeveSignalEvaluation | None, values.get("signal")),
            gates=cast(tuple[GateTrace, ...], values["gates"]),
            trace_enabled=cast(bool, values["trace_enabled"]),
            context=cast(dict[str, Any] | None, values.get("context")),
        )


def make_strategy_trace(
    request: StrategyTraceRequest | None = None,
    **kwargs: Any,
) -> StrategyTrace | None:
    resolved_request = request or StrategyTraceRequest.from_kwargs(kwargs)
    if not resolved_request.trace_enabled:
        return None
    first_failed_gate = next(
        (gate.gate for gate in resolved_request.gates if not gate.passed),
        None,
    )
    return StrategyTrace(
        strategy_id=(resolved_request.strategy_id or "").strip() or "unknown",
        strategy_type=(resolved_request.strategy_type or "").strip() or "unknown",
        symbol=resolved_request.symbol,
        event_ts=resolved_request.event_ts,
        timeframe=(resolved_request.timeframe or "").strip() or "unknown",
        passed=resolved_request.passed,
        action=resolved_request.action,
        rationale=resolved_request.rationale,
        gates=resolved_request.gates,
        first_failed_gate=first_failed_gate,
        context=resolved_request.context or {},
    )


def threshold_min(
    *, metric: str, value: Decimal | None, floor: Decimal | None, required: bool
) -> ThresholdTrace:
    if floor is None:
        return ThresholdTrace(
            metric=metric,
            comparator="optional_min",
            value=value,
            threshold=floor,
            passed=True,
            missing_policy="fail_open" if not required else "fail_closed",
            distance_to_pass=Decimal("0"),
        )
    if value is None:
        return ThresholdTrace(
            metric=metric,
            comparator="min_gte",
            value=value,
            threshold=floor,
            passed=not required,
            missing_policy="fail_closed" if required else "fail_open",
            distance_to_pass=floor if required else Decimal("0"),
        )
    passed = value >= floor
    return ThresholdTrace(
        metric=metric,
        comparator="min_gte",
        value=value,
        threshold=floor,
        passed=passed,
        missing_policy="fail_closed" if required else "fail_open",
        distance_to_pass=Decimal("0") if passed else floor - value,
    )


def threshold_max(
    *, metric: str, value: Decimal | None, ceil: Decimal | None, required: bool
) -> ThresholdTrace:
    if ceil is None:
        return ThresholdTrace(
            metric=metric,
            comparator="optional_max",
            value=value,
            threshold=ceil,
            passed=True,
            missing_policy="fail_open" if not required else "fail_closed",
            distance_to_pass=Decimal("0"),
        )
    if value is None:
        return ThresholdTrace(
            metric=metric,
            comparator="max_lte",
            value=value,
            threshold=ceil,
            passed=not required,
            missing_policy="fail_closed" if required else "fail_open",
            distance_to_pass=ceil if required else Decimal("0"),
        )
    passed = value <= ceil
    return ThresholdTrace(
        metric=metric,
        comparator="max_lte",
        value=value,
        threshold=ceil,
        passed=passed,
        missing_policy="fail_closed" if required else "fail_open",
        distance_to_pass=Decimal("0") if passed else value - ceil,
    )


def threshold_range(
    *,
    metric: str,
    value: Decimal | None,
    floor: Decimal | None,
    ceil: Decimal | None,
    required: bool,
) -> tuple[ThresholdTrace, ThresholdTrace]:
    return (
        threshold_min(metric=metric, value=value, floor=floor, required=required),
        threshold_max(metric=metric, value=value, ceil=ceil, required=required),
    )


def threshold_bool(
    *, metric: str, passed: bool, threshold: Any, value: Any = True
) -> ThresholdTrace:
    return ThresholdTrace(
        metric=metric,
        comparator="bool",
        value=value,
        threshold=threshold,
        passed=passed,
        missing_policy="fail_closed",
        distance_to_pass=Decimal("0") if passed else Decimal("1"),
    )


def build_gate(
    *,
    name: str,
    category: GateCategory,
    thresholds: tuple[ThresholdTrace, ...],
    context: dict[str, Any] | None = None,
) -> GateTrace:
    return GateTrace(
        gate=name,
        category=category,
        passed=all((item.passed for item in thresholds)),
        thresholds=thresholds,
        context=context or {},
    )


def build_sleeve_result(
    request: SleeveResultRequest | None = None,
    **kwargs: Any,
) -> SleeveSignalResult:
    resolved_request = request or SleeveResultRequest.from_kwargs(kwargs)
    trace = make_strategy_trace(
        StrategyTraceRequest(
            strategy_id=resolved_request.strategy_id,
            strategy_type=resolved_request.strategy_type,
            symbol=resolved_request.symbol,
            event_ts=resolved_request.event_ts,
            timeframe=resolved_request.timeframe,
            passed=resolved_request.signal is not None,
            action=resolved_request.signal.action
            if resolved_request.signal is not None
            else None,
            rationale=resolved_request.signal.rationale
            if resolved_request.signal is not None
            else (),
            gates=resolved_request.gates,
            trace_enabled=resolved_request.trace_enabled,
            context=resolved_request.context,
        )
    )
    return SleeveSignalResult(signal=resolved_request.signal, trace=trace)


def required_inputs_gate(*, fields: Mapping[str, bool]) -> GateTrace:
    return build_gate(
        name="eligibility",
        category="eligibility",
        thresholds=(
            threshold_bool(
                metric="required_inputs_present",
                passed=all(fields.values()),
                threshold=True,
                value=dict(fields),
            ),
        ),
    )


def entry_window_gate(
    *, within_window: bool, start_minute: int, end_minute: int
) -> GateTrace:
    return build_gate(
        name="eligibility",
        category="eligibility",
        thresholds=(
            threshold_bool(
                metric="within_entry_window",
                passed=within_window,
                threshold="entry_window",
            ),
        ),
        context={
            "entry_start_minute_utc": start_minute,
            "entry_end_minute_utc": end_minute,
        },
    )


def exit_trigger_gate(*, reason_flags: Mapping[str, bool]) -> GateTrace:
    return build_gate(
        name="exit",
        category="exit",
        thresholds=(
            threshold_bool(
                metric="exit_triggered",
                passed=any(reason_flags.values()),
                threshold="any_exit_reason",
                value=dict(reason_flags),
            ),
        ),
        context={"reasons": dict(reason_flags)},
    )


def rank_thresholds(*, universe_size: int, top_n: int) -> tuple[Decimal, Decimal]:
    if universe_size <= 1:
        return (Decimal("0"), Decimal("1"))
    resolved_top_n = min(max(1, top_n), universe_size)
    denominator = Decimal(universe_size - 1)
    low_threshold = Decimal(resolved_top_n - 1) / denominator
    high_threshold = Decimal(universe_size - resolved_top_n) / denominator
    return (low_threshold, high_threshold)


__all__ = [
    "SleeveSignalEvaluation",
    "SleeveSignalResult",
    "StrategyTraceRequest",
    "SleeveResultRequest",
    "make_strategy_trace",
    "threshold_min",
    "threshold_max",
    "threshold_range",
    "threshold_bool",
    "build_gate",
    "build_sleeve_result",
    "required_inputs_gate",
    "entry_window_gate",
    "exit_trigger_gate",
    "rank_thresholds",
]

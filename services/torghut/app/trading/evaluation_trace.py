"""Structured evaluation tracing for runtime and replay research flows."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal, Mapping, cast

GateCategory = Literal[
    'eligibility',
    'feed_quality',
    'structure',
    'confirmation',
    'risk',
    'execution',
    'exit',
]
MissingPolicy = Literal['fail_open', 'fail_closed']
FillStatus = Literal['none', 'pending', 'filled']

_TRACE_SCHEMA_VERSION = 'torghut.strategy-trace.v1'
_REPLAY_TRACE_SCHEMA_VERSION = 'torghut.replay-trace.v1'
_REPLAY_FUNNEL_SCHEMA_VERSION = 'torghut.replay-funnel.v1'
_SWEEP_RESULT_SCHEMA_VERSION = 'torghut.sweep-candidate-result.v1'


def _empty_context() -> dict[str, Any]:
    return {}


def _serialize_trace_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, tuple):
        tuple_value = cast(tuple[Any, ...], value)
        return [_serialize_trace_value(item) for item in tuple_value]
    if isinstance(value, list):
        list_value = cast(list[Any], value)
        return [_serialize_trace_value(item) for item in list_value]
    if isinstance(value, dict):
        dict_value = cast(dict[Any, Any], value)
        return {
            str(key): _serialize_trace_value(item)
            for key, item in dict_value.items()
        }
    return value


@dataclass(frozen=True)
class ThresholdTrace:
    metric: str
    comparator: str
    value: Any
    threshold: Any
    passed: bool
    missing_policy: MissingPolicy
    distance_to_pass: Decimal | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            'metric': self.metric,
            'comparator': self.comparator,
            'value': _serialize_trace_value(self.value),
            'threshold': _serialize_trace_value(self.threshold),
            'passed': self.passed,
            'missing_policy': self.missing_policy,
            'distance_to_pass': (
                str(self.distance_to_pass) if self.distance_to_pass is not None else None
            ),
        }


@dataclass(frozen=True)
class GateTrace:
    gate: str
    category: GateCategory
    passed: bool
    thresholds: tuple[ThresholdTrace, ...] = ()
    context: dict[str, Any] = field(default_factory=_empty_context)

    def failing_thresholds(self) -> tuple[ThresholdTrace, ...]:
        return tuple(item for item in self.thresholds if not item.passed)

    def distance_score(self) -> Decimal:
        score = Decimal('0')
        for threshold in self.failing_thresholds():
            if threshold.distance_to_pass is None:
                score += Decimal('1')
            else:
                score += threshold.distance_to_pass
        return score

    def to_payload(self) -> dict[str, Any]:
        return {
            'gate': self.gate,
            'category': self.category,
            'passed': self.passed,
            'thresholds': [item.to_payload() for item in self.thresholds],
            'context': _serialize_trace_value(self.context),
        }


@dataclass(frozen=True)
class StrategyTrace:
    strategy_id: str
    strategy_type: str
    symbol: str
    event_ts: str
    timeframe: str
    passed: bool
    action: Literal['buy', 'sell'] | None
    rationale: tuple[str, ...] = ()
    gates: tuple[GateTrace, ...] = ()
    first_failed_gate: str | None = None
    context: dict[str, Any] = field(default_factory=_empty_context)
    schema_version: str = _TRACE_SCHEMA_VERSION

    def with_updates(self, **updates: Any) -> StrategyTrace:
        return replace(self, **updates)

    def with_context(self, **context: Any) -> StrategyTrace:
        merged = dict(self.context)
        merged.update(context)
        return replace(self, context=merged)

    def failed_gate(self) -> GateTrace | None:
        if not self.first_failed_gate:
            return None
        for gate in self.gates:
            if gate.gate == self.first_failed_gate:
                return gate
        return None

    def distance_score(self) -> Decimal:
        failed_gate = self.failed_gate()
        if failed_gate is None:
            return Decimal('0')
        return failed_gate.distance_score()

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'strategy_id': self.strategy_id,
            'strategy_type': self.strategy_type,
            'symbol': self.symbol,
            'event_ts': self.event_ts,
            'timeframe': self.timeframe,
            'passed': self.passed,
            'action': self.action,
            'rationale': list(self.rationale),
            'first_failed_gate': self.first_failed_gate,
            'gates': [gate.to_payload() for gate in self.gates],
            'context': _serialize_trace_value(self.context),
        }


@dataclass(frozen=True)
class ReplayTraceRecord:
    trading_day: str
    strategy_trace: StrategyTrace
    decision_emitted: bool
    fill_status: FillStatus
    decision_strategy_id: str | None = None
    block_reason: str | None = None
    fill_price: Decimal | None = None
    schema_version: str = _REPLAY_TRACE_SCHEMA_VERSION

    def with_updates(self, **updates: Any) -> ReplayTraceRecord:
        return replace(self, **updates)

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'trading_day': self.trading_day,
            'decision_emitted': self.decision_emitted,
            'fill_status': self.fill_status,
            'decision_strategy_id': self.decision_strategy_id,
            'block_reason': self.block_reason,
            'fill_price': str(self.fill_price) if self.fill_price is not None else None,
            'strategy_trace': self.strategy_trace.to_payload(),
        }


@dataclass(frozen=True)
class ReplayFunnelBucket:
    trading_day: str
    symbol: str
    retained_rows: int
    runtime_evaluable_rows: int
    quote_valid_rows: int
    strategy_evaluations: int
    gate_pass_counts: dict[str, int]
    decision_count: int
    filled_count: int
    filled_notional: Decimal
    closed_trade_count: int
    gross_pnl: Decimal
    net_pnl: Decimal
    cost_total: Decimal

    def to_payload(self) -> dict[str, Any]:
        return {
            'trading_day': self.trading_day,
            'symbol': self.symbol,
            'retained_rows': self.retained_rows,
            'runtime_evaluable_rows': self.runtime_evaluable_rows,
            'quote_valid_rows': self.quote_valid_rows,
            'strategy_evaluations': self.strategy_evaluations,
            'gate_pass_counts': dict(sorted(self.gate_pass_counts.items())),
            'decision_count': self.decision_count,
            'filled_count': self.filled_count,
            'filled_notional': str(self.filled_notional),
            'closed_trade_count': self.closed_trade_count,
            'gross_pnl': str(self.gross_pnl),
            'net_pnl': str(self.net_pnl),
            'cost_total': str(self.cost_total),
        }


@dataclass(frozen=True)
class ReplayFunnelReport:
    start_date: str
    end_date: str
    buckets: tuple[ReplayFunnelBucket, ...]
    schema_version: str = _REPLAY_FUNNEL_SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'start_date': self.start_date,
            'end_date': self.end_date,
            'buckets': [bucket.to_payload() for bucket in self.buckets],
        }


@dataclass(frozen=True)
class NearMissRecord:
    trading_day: str
    symbol: str
    strategy_id: str
    strategy_type: str
    event_ts: str
    action: Literal['buy', 'sell'] | None
    first_failed_gate: str
    distance_score: Decimal
    thresholds: tuple[ThresholdTrace, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            'trading_day': self.trading_day,
            'symbol': self.symbol,
            'strategy_id': self.strategy_id,
            'strategy_type': self.strategy_type,
            'event_ts': self.event_ts,
            'action': self.action,
            'first_failed_gate': self.first_failed_gate,
            'distance_score': str(self.distance_score),
            'thresholds': [item.to_payload() for item in self.thresholds],
        }


@dataclass(frozen=True)
class SweepCandidateResult:
    candidate_id: str
    family: str
    strategy_name: str
    train_net_per_day: Decimal
    holdout_net_per_day: Decimal
    train_total_net: Decimal
    holdout_total_net: Decimal
    active_holdout_days: int
    max_holdout_drawdown_day: Decimal
    profit_factor: Decimal | None
    wins: int
    losses: int
    score: Decimal
    replay_config: Mapping[str, Any]
    schema_version: str = _SWEEP_RESULT_SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'candidate_id': self.candidate_id,
            'family': self.family,
            'strategy_name': self.strategy_name,
            'train_net_per_day': str(self.train_net_per_day),
            'holdout_net_per_day': str(self.holdout_net_per_day),
            'train_total_net': str(self.train_total_net),
            'holdout_total_net': str(self.holdout_total_net),
            'active_holdout_days': self.active_holdout_days,
            'max_holdout_drawdown_day': str(self.max_holdout_drawdown_day),
            'profit_factor': str(self.profit_factor) if self.profit_factor is not None else None,
            'wins': self.wins,
            'losses': self.losses,
            'score': str(self.score),
            'replay_config': _serialize_trace_value(dict(self.replay_config)),
        }


__all__ = [
    'FillStatus',
    'GateCategory',
    'GateTrace',
    'NearMissRecord',
    'ReplayFunnelBucket',
    'ReplayFunnelReport',
    'ReplayTraceRecord',
    'StrategyTrace',
    'SweepCandidateResult',
    'ThresholdTrace',
]

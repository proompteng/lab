"""Source-activity readback for runtime-window proofs."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    RejectedSignalOutcomeEvent,
    TradeDecision,
)
from .schemas import SourceCountsPayload
from .targets import ProofTarget


def load_source_activity_counts(
    session: Session,
    target: ProofTarget,
) -> SourceCountsPayload:
    symbols = list(target.symbols)
    return {
        "decisions": _count_decisions(session, target, symbols),
        "executions": _count_executions(session, target, symbols),
        "order_events": _count_order_events(session, target, symbols),
        "execution_tca_metrics": _count_tca(session, target, symbols),
        "rejected_signal_events": _count_rejected_signals(session, target, symbols),
    }


def source_activity_blockers(
    counts: SourceCountsPayload,
    *,
    window_closed: bool,
) -> list[str]:
    if not window_closed:
        return []
    blockers: list[str] = []
    if counts["decisions"] <= 0 and counts["rejected_signal_events"] <= 0:
        blockers.append("source_decisions_missing")
    if counts["executions"] <= 0 and counts["rejected_signal_events"] <= 0:
        blockers.append("executions_missing")
    if counts["order_events"] <= 0 and counts["rejected_signal_events"] <= 0:
        blockers.append("order_events_missing")
    if counts["execution_tca_metrics"] <= 0 and counts["rejected_signal_events"] <= 0:
        blockers.append("execution_tca_missing")
    return blockers


def source_activity_satisfied(counts: SourceCountsPayload) -> bool:
    has_rejected_feedback = counts["rejected_signal_events"] > 0
    has_execution_feedback = (
        counts["decisions"] > 0
        and counts["executions"] > 0
        and counts["order_events"] > 0
        and counts["execution_tca_metrics"] > 0
    )
    return has_rejected_feedback or has_execution_feedback


def _count_decisions(
    session: Session,
    target: ProofTarget,
    symbols: Iterable[str],
) -> int:
    stmt = (
        select(func.count(TradeDecision.id))
        .where(TradeDecision.alpaca_account_label == target.source_account_label)
        .where(TradeDecision.created_at >= target.window_start)
        .where(TradeDecision.created_at <= target.window_end)
    )
    symbol_values = list(symbols)
    if symbol_values:
        stmt = stmt.where(TradeDecision.symbol.in_(symbol_values))
    return _count(session, stmt)


def _count_executions(
    session: Session,
    target: ProofTarget,
    symbols: Iterable[str],
) -> int:
    stmt = (
        select(func.count(Execution.id))
        .where(Execution.alpaca_account_label == target.source_account_label)
        .where(Execution.created_at >= target.window_start)
        .where(Execution.created_at <= target.window_end)
    )
    symbol_values = list(symbols)
    if symbol_values:
        stmt = stmt.where(Execution.symbol.in_(symbol_values))
    return _count(session, stmt)


def _count_order_events(
    session: Session,
    target: ProofTarget,
    symbols: Iterable[str],
) -> int:
    stmt = (
        select(func.count(ExecutionOrderEvent.id))
        .where(ExecutionOrderEvent.alpaca_account_label == target.source_account_label)
        .where(ExecutionOrderEvent.event_ts >= target.window_start)
        .where(ExecutionOrderEvent.event_ts <= target.window_end)
    )
    symbol_values = list(symbols)
    if symbol_values:
        stmt = stmt.where(ExecutionOrderEvent.symbol.in_(symbol_values))
    return _count(session, stmt)


def _count_tca(
    session: Session,
    target: ProofTarget,
    symbols: Iterable[str],
) -> int:
    stmt = (
        select(func.count(ExecutionTCAMetric.id))
        .where(ExecutionTCAMetric.alpaca_account_label == target.source_account_label)
        .where(ExecutionTCAMetric.computed_at >= target.window_start)
        .where(ExecutionTCAMetric.computed_at <= target.window_end)
    )
    symbol_values = list(symbols)
    if symbol_values:
        stmt = stmt.where(ExecutionTCAMetric.symbol.in_(symbol_values))
    return _count(session, stmt)


def _count_rejected_signals(
    session: Session,
    target: ProofTarget,
    symbols: Iterable[str],
) -> int:
    stmt = (
        select(func.count(RejectedSignalOutcomeEvent.id))
        .where(RejectedSignalOutcomeEvent.account_label == target.source_account_label)
        .where(RejectedSignalOutcomeEvent.event_ts >= target.window_start)
        .where(RejectedSignalOutcomeEvent.event_ts <= target.window_end)
    )
    symbol_values = list(symbols)
    if symbol_values:
        stmt = stmt.where(RejectedSignalOutcomeEvent.symbol.in_(symbol_values))
    return _count(session, stmt)


def _count(session: Session, stmt: Any) -> int:
    value = session.execute(stmt).scalar_one()
    return int(value or 0)

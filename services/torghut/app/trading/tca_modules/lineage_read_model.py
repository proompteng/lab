"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

import logging
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, load_only

from ...config import settings
from ...models import Execution, ExecutionTCAMetric, TradeDecision
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT,
    TigerBeetleLedgerJournal,
)
from .adaptive_policy import decimal_or_none

logger = logging.getLogger("app.trading.tca")

EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION = "torghut.execution-tca-cost-lineage.v1"

POST_COST_PNL_BASIS = "realized_strategy_pnl_after_explicit_costs"

_TCA_STATUS_LINEAGE_SAMPLE_DEFAULT_LIMIT = 200

_TCA_STATUS_LINEAGE_SAMPLE_MAX_LIMIT = 1000

_TCA_STATUS_LINEAGE_SAMPLE_TRUNCATED_BLOCKER = (
    "runtime_tca_cost_lineage_sample_truncated"
)


@dataclass(frozen=True)
class _TcaGateScope:
    strategy_id: str | None
    account_label: str
    symbols: tuple[str, ...]


@dataclass(frozen=True)
class _TcaGateAggregate:
    order_count: int
    avg_slippage_bps: Decimal | None
    avg_abs_slippage_bps: Decimal | None
    avg_shortfall_notional: Decimal | None
    avg_shortfall_notional_abs: Decimal | None
    avg_churn_ratio: Decimal | None
    avg_divergence_bps: Decimal | None
    avg_divergence_bps_abs: Decimal | None
    expected_shortfall_sample_count: int
    avg_expected_shortfall_bps_p50: Decimal | None
    avg_expected_shortfall_bps_p95: Decimal | None
    avg_realized_shortfall_bps: Decimal | None
    avg_realized_shortfall_bps_abs: Decimal | None
    avg_calibration_error_bps: Decimal | None
    last_computed_at: object | None


@dataclass(frozen=True)
class _TcaExecutionCoverage:
    filled_execution_count: int
    unsettled_execution_count: int
    latest_execution_created_at: object | None


@dataclass(frozen=True)
class _TcaGateEvidence:
    symbol_breakdown: list[dict[str, object]]
    runtime_ledger_lineage: dict[str, object]
    reason_codes: list[str]


def _mapping_from_any(value: object | None) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[object, object], value)
    return {str(key): item for key, item in mapping.items()}


def journal_tigerbeetle_execution_cost(
    session: Session,
    execution: Execution,
    metric: ExecutionTCAMetric,
) -> None:
    if not settings.tigerbeetle_enabled or not settings.tigerbeetle_journal_enabled:
        return
    session.flush()
    try:
        with TigerBeetleLedgerJournal() as journal, session.begin_nested():
            journal.journal_execution(session, execution)
            journal.journal_execution_tca_metric(session, metric)
    except Exception as exc:
        if settings.tigerbeetle_required:
            raise
        blocker = (
            TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT
            if TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT in str(exc)
            else TIGERBEETLE_BLOCKER_JOURNAL_ERROR
        )
        logger.warning(
            "TigerBeetle execution/TCA journal failed for execution_id=%s metric_id=%s blocker=%s: %s",
            execution.id,
            metric.id,
            blocker,
            exc,
            extra={
                "tigerbeetle_execution_cost_journal_status": "blocked",
                "tigerbeetle_execution_cost_journal_blocker": blocker,
                "tigerbeetle_execution_id": str(execution.id),
                "tigerbeetle_execution_tca_metric_id": str(metric.id),
            },
        )


def _execution_lineage_summary(executions: Collection[Execution]) -> dict[str, object]:
    blocker_counts: dict[str, int] = {}
    source_backed_count = 0
    filled_notional_count = 0
    explicit_cost_count = 0
    execution_policy_hash_count = 0
    cost_model_hash_count = 0
    post_cost_pnl_basis_count = 0
    sample_blockers: list[dict[str, object]] = []
    for execution in executions:
        audit_payload = _mapping_from_any(execution.execution_audit_json)
        lineage = _mapping_from_any(
            audit_payload.get("runtime_ledger_lineage")
            or audit_payload.get("execution_tca_cost_lineage")
        )
        blockers = [
            str(item).strip()
            for item in cast(Collection[object], lineage.get("blockers") or [])
            if str(item).strip()
        ]
        if not lineage:
            blockers = ["runtime_tca_cost_lineage_readback_missing"]
        if lineage.get("source_backed") is True and not blockers:
            source_backed_count += 1
        if lineage.get("filled_notional") is not None:
            filled_notional_count += 1
        if lineage.get("explicit_cost_amount") is not None:
            explicit_cost_count += 1
        if lineage.get("execution_policy_hash") is not None:
            execution_policy_hash_count += 1
        if lineage.get("cost_model_hash") is not None:
            cost_model_hash_count += 1
        if lineage.get("pnl_basis") == POST_COST_PNL_BASIS:
            post_cost_pnl_basis_count += 1
        for blocker in blockers:
            blocker_counts[blocker] = blocker_counts.get(blocker, 0) + 1
        if blockers and len(sample_blockers) < 10:
            sample_blockers.append(
                {
                    "execution_id": str(execution.id),
                    "alpaca_order_id": execution.alpaca_order_id,
                    "symbol": execution.symbol,
                    "blockers": blockers,
                }
            )

    execution_count = len(executions)
    blockers = sorted(blocker_counts)
    return {
        "schema_version": EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION,
        "status": "source_backed"
        if execution_count > 0
        and source_backed_count == execution_count
        and not blockers
        else "blocked"
        if execution_count > 0
        else "missing",
        "promotion_authority": False,
        "promotion_authority_reason": "lineage_dimension_only_not_promotion_authority",
        "execution_count": execution_count,
        "source_backed_count": source_backed_count,
        "blocked_count": max(0, execution_count - source_backed_count),
        "filled_notional_count": filled_notional_count,
        "explicit_cost_count": explicit_cost_count,
        "execution_policy_hash_count": execution_policy_hash_count,
        "cost_model_hash_count": cost_model_hash_count,
        "post_cost_pnl_basis_count": post_cost_pnl_basis_count,
        "blockers": blockers,
        "blocker_counts": dict(sorted(blocker_counts.items())),
        "sample_blockers": sample_blockers,
    }


def _normalize_tca_symbols(symbols: Collection[str] | None) -> tuple[str, ...]:
    if symbols is None:
        return ()
    return tuple(
        sorted(
            {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
        )
    )


def _unavailable_tca_symbol_breakdown(
    *,
    symbols: tuple[str, ...],
    reason: str,
) -> list[dict[str, object]]:
    return [
        {
            "symbol": symbol,
            "order_count": 0,
            "avg_abs_slippage_bps": None,
            "max_abs_slippage_bps": None,
            "avg_realized_shortfall_bps": None,
            "last_computed_at": None,
            "read_model_unavailable": True,
            "read_model_status": "timeout",
            "reason_codes": [reason],
        }
        for symbol in symbols
    ]


def _build_tca_symbol_breakdown(
    session: Session,
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
) -> list[dict[str, object]]:
    if not symbols:
        return []

    stmt = (
        select(
            ExecutionTCAMetric.symbol,
            func.count(ExecutionTCAMetric.id),
            func.avg(func.abs(ExecutionTCAMetric.slippage_bps)),
            func.max(func.abs(ExecutionTCAMetric.slippage_bps)),
            func.max(ExecutionTCAMetric.computed_at),
            func.avg(ExecutionTCAMetric.realized_shortfall_bps),
        )
        .where(ExecutionTCAMetric.symbol.in_(symbols))
        .group_by(ExecutionTCAMetric.symbol)
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(ExecutionTCAMetric.alpaca_account_label == account_label)

    rows_by_symbol = {str(row[0]).upper(): row for row in session.execute(stmt).all()}
    breakdown: list[dict[str, object]] = []
    for symbol in symbols:
        row = rows_by_symbol.get(symbol)
        if row is None:
            breakdown.append(
                {
                    "symbol": symbol,
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "avg_realized_shortfall_bps": None,
                    "last_computed_at": None,
                }
            )
            continue
        breakdown.append(
            {
                "symbol": symbol,
                "order_count": int(row[1] or 0),
                "avg_abs_slippage_bps": decimal_or_none(row[2]),
                "max_abs_slippage_bps": decimal_or_none(row[3]),
                "last_computed_at": row[4],
                "avg_realized_shortfall_bps": decimal_or_none(row[5]),
            }
        )
    return breakdown


def refresh_execution_tca_metrics(
    session: Session,
    *,
    account_label: str | None = None,
    stale_before: datetime | None = None,
    limit: int = 500,
    dry_run: bool = False,
) -> dict[str, object]:
    """Refresh materialized TCA rows for filled executions.

    This is intentionally bounded. Revenue-readiness gates consume the
    materialized ``execution_tca_metrics`` table, so code-level TCA fixes do not
    affect promotion evidence until stale rows are rematerialized.
    """

    bounded_limit = max(1, min(limit, 5000))
    stmt = (
        select(Execution)
        .outerjoin(ExecutionTCAMetric, ExecutionTCAMetric.execution_id == Execution.id)
        .where(
            Execution.avg_fill_price.is_not(None),
            Execution.filled_qty > 0,
        )
        .order_by(
            ExecutionTCAMetric.computed_at.asc().nullsfirst(),
            Execution.created_at.asc(),
        )
        .limit(bounded_limit)
    )
    normalized_account_label = account_label.strip() if account_label else ""
    if normalized_account_label:
        stmt = stmt.where(Execution.alpaca_account_label == normalized_account_label)
    if stale_before is not None:
        stmt = stmt.where(
            or_(
                ExecutionTCAMetric.id.is_(None),
                ExecutionTCAMetric.computed_at < stale_before,
            )
        )

    executions = session.execute(stmt).scalars().all()
    if dry_run:
        return {
            "selected": len(executions),
            "refreshed": 0,
            "dry_run": True,
            "limit": bounded_limit,
            "account_label": normalized_account_label or None,
            "stale_before": stale_before.isoformat() if stale_before else None,
            "runtime_ledger_lineage": _execution_lineage_summary(executions),
        }

    from .execution_tca_metrics import upsert_execution_tca_metric

    refreshed = 0
    for execution in executions:
        upsert_execution_tca_metric(session, execution)
        refreshed += 1

    lineage_summary = _execution_lineage_summary(executions)
    return {
        "selected": len(executions),
        "refreshed": refreshed,
        "dry_run": False,
        "limit": bounded_limit,
        "account_label": normalized_account_label or None,
        "stale_before": stale_before.isoformat() if stale_before else None,
        "runtime_ledger_lineage": lineage_summary,
    }


def build_tca_gate_inputs(
    session: Session,
    *,
    strategy_id: str | None = None,
    account_label: str | None = None,
    symbols: Collection[str] | None = None,
) -> dict[str, object]:
    """Build aggregate TCA inputs used by autonomy gate thresholds."""

    scope = _tca_gate_scope(
        strategy_id=strategy_id,
        account_label=account_label,
        symbols=symbols,
    )
    aggregate = _load_tca_gate_aggregate(session, scope)
    symbol_breakdown, symbol_reason = _load_tca_symbol_breakdown(session, scope)
    coverage, coverage_reason = _load_tca_execution_coverage(session, scope)
    runtime_ledger_lineage, lineage_reason = _load_tca_runtime_lineage(
        session=session,
        scope=scope,
        coverage=coverage,
        coverage_reason=coverage_reason,
    )
    evidence = _TcaGateEvidence(
        symbol_breakdown=symbol_breakdown,
        runtime_ledger_lineage=runtime_ledger_lineage,
        reason_codes=_tca_gate_reason_codes(
            symbol_reason=symbol_reason,
            coverage_reason=coverage_reason,
            lineage_reason=lineage_reason,
        ),
    )
    return _tca_gate_payload(
        scope=scope,
        aggregate=aggregate,
        coverage=coverage,
        evidence=evidence,
    )


def _tca_gate_scope(
    *,
    strategy_id: str | None,
    account_label: str | None,
    symbols: Collection[str] | None,
) -> _TcaGateScope:
    return _TcaGateScope(
        strategy_id=strategy_id,
        account_label=account_label.strip() if account_label else "",
        symbols=_normalize_tca_symbols(symbols),
    )


def _load_tca_gate_aggregate(
    session: Session,
    scope: _TcaGateScope,
) -> _TcaGateAggregate:
    stmt = _tca_gate_aggregate_stmt(scope)
    return _parse_tca_gate_aggregate(session.execute(stmt).one())


def _tca_gate_aggregate_stmt(scope: _TcaGateScope) -> Any:
    stmt = select(
        func.count(ExecutionTCAMetric.id),
        func.avg(ExecutionTCAMetric.slippage_bps),
        func.avg(func.abs(ExecutionTCAMetric.slippage_bps)),
        func.avg(ExecutionTCAMetric.shortfall_notional),
        func.avg(func.abs(ExecutionTCAMetric.shortfall_notional)),
        func.avg(ExecutionTCAMetric.churn_ratio),
        func.avg(ExecutionTCAMetric.divergence_bps),
        func.avg(func.abs(ExecutionTCAMetric.divergence_bps)),
        func.count(ExecutionTCAMetric.expected_shortfall_bps_p50),
        func.avg(ExecutionTCAMetric.expected_shortfall_bps_p50),
        func.avg(ExecutionTCAMetric.expected_shortfall_bps_p95),
        func.avg(ExecutionTCAMetric.realized_shortfall_bps),
        func.avg(func.abs(ExecutionTCAMetric.realized_shortfall_bps)),
        func.avg(
            func.abs(
                ExecutionTCAMetric.realized_shortfall_bps
                - ExecutionTCAMetric.expected_shortfall_bps_p50
            )
        ),
        func.max(ExecutionTCAMetric.computed_at),
    )
    if scope.strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == scope.strategy_id)
    if scope.account_label:
        stmt = stmt.where(
            ExecutionTCAMetric.alpaca_account_label == scope.account_label
        )
    if scope.symbols:
        stmt = stmt.where(ExecutionTCAMetric.symbol.in_(scope.symbols))
    return stmt


def _parse_tca_gate_aggregate(row: object) -> _TcaGateAggregate:
    values = cast(tuple[object, ...], row)
    return _TcaGateAggregate(
        order_count=int(cast(int | str, values[0] or 0)),
        avg_slippage_bps=decimal_or_none(values[1]),
        avg_abs_slippage_bps=decimal_or_none(values[2]),
        avg_shortfall_notional=decimal_or_none(values[3]),
        avg_shortfall_notional_abs=decimal_or_none(values[4]),
        avg_churn_ratio=decimal_or_none(values[5]),
        avg_divergence_bps=decimal_or_none(values[6]),
        avg_divergence_bps_abs=decimal_or_none(values[7]),
        expected_shortfall_sample_count=int(cast(int | str, values[8] or 0)),
        avg_expected_shortfall_bps_p50=decimal_or_none(values[9]),
        avg_expected_shortfall_bps_p95=decimal_or_none(values[10]),
        avg_realized_shortfall_bps=decimal_or_none(values[11]),
        avg_realized_shortfall_bps_abs=decimal_or_none(values[12]),
        avg_calibration_error_bps=decimal_or_none(values[13]),
        last_computed_at=values[14],
    )


def _load_tca_symbol_breakdown(
    session: Session,
    scope: _TcaGateScope,
) -> tuple[list[dict[str, object]], str | None]:
    symbol_breakdown_reason: str | None = None
    try:
        symbol_breakdown = _build_tca_symbol_breakdown(
            session,
            strategy_id=scope.strategy_id,
            account_label=scope.account_label,
            symbols=scope.symbols,
        )
    except SQLAlchemyError as exc:
        logger.warning("TCA symbol breakdown unavailable: %s", exc)
        session.rollback()
        symbol_breakdown_reason = "execution_tca_symbol_breakdown_query_unavailable"
        symbol_breakdown = _unavailable_tca_symbol_breakdown(
            symbols=scope.symbols,
            reason=symbol_breakdown_reason,
        )
    return symbol_breakdown, symbol_breakdown_reason


def _load_tca_execution_coverage(
    session: Session,
    scope: _TcaGateScope,
) -> tuple[_TcaExecutionCoverage, str | None]:
    try:
        execution_stmt = _tca_execution_coverage_stmt(
            strategy_id=scope.strategy_id,
            account_label=scope.account_label,
            symbols=scope.symbols,
        )
        unsettled_execution_stmt = _tca_execution_coverage_stmt(
            strategy_id=scope.strategy_id,
            account_label=scope.account_label,
            symbols=scope.symbols,
            only_unsettled=True,
        )
        execution_count, latest_execution_created_at = session.execute(
            execution_stmt
        ).one()
        unsettled_execution_count = int(
            session.execute(unsettled_execution_stmt).scalar_one() or 0
        )
    except SQLAlchemyError as exc:
        logger.warning("TCA execution coverage unavailable: %s", exc)
        session.rollback()
        return (
            _TcaExecutionCoverage(
                filled_execution_count=0,
                unsettled_execution_count=0,
                latest_execution_created_at=None,
            ),
            "execution_tca_execution_coverage_query_unavailable",
        )
    return (
        _TcaExecutionCoverage(
            filled_execution_count=int(execution_count or 0),
            unsettled_execution_count=unsettled_execution_count,
            latest_execution_created_at=latest_execution_created_at,
        ),
        None,
    )


def _load_tca_runtime_lineage(
    *,
    session: Session,
    scope: _TcaGateScope,
    coverage: _TcaExecutionCoverage,
    coverage_reason: str | None,
) -> tuple[dict[str, object], str | None]:
    if coverage_reason is not None:
        return (
            _unavailable_tca_runtime_ledger_lineage_summary(
                reason=coverage_reason,
                total_filled_execution_count=None,
            ),
            coverage_reason,
        )
    try:
        return (
            _build_tca_runtime_ledger_lineage_summary(
                session,
                strategy_id=scope.strategy_id,
                account_label=scope.account_label,
                symbols=scope.symbols,
                total_filled_execution_count=coverage.filled_execution_count,
            ),
            None,
        )
    except SQLAlchemyError as exc:
        logger.warning("TCA runtime ledger lineage unavailable: %s", exc)
        session.rollback()
        reason = "runtime_tca_cost_lineage_query_unavailable"
        return (
            _unavailable_tca_runtime_ledger_lineage_summary(
                reason=reason,
                total_filled_execution_count=coverage.filled_execution_count,
            ),
            reason,
        )


def _tca_gate_reason_codes(
    *,
    symbol_reason: str | None,
    coverage_reason: str | None,
    lineage_reason: str | None,
) -> list[str]:
    return [
        reason
        for reason in (
            symbol_reason,
            coverage_reason,
            lineage_reason if lineage_reason != coverage_reason else None,
        )
        if reason is not None
    ]


def _tca_gate_payload(
    *,
    scope: _TcaGateScope,
    aggregate: _TcaGateAggregate,
    coverage: _TcaExecutionCoverage,
    evidence: _TcaGateEvidence,
) -> dict[str, object]:
    expected_count = aggregate.expected_shortfall_sample_count
    order_count = aggregate.order_count
    expected_shortfall_coverage = (
        Decimal(expected_count) / Decimal(order_count) if order_count > 0 else None
    )
    return {
        "account_label": scope.account_label or None,
        "scope_symbols": list(scope.symbols),
        "scope_symbol_count": len(scope.symbols),
        "order_count": order_count,
        "avg_slippage_bps": aggregate.avg_slippage_bps
        if aggregate.avg_slippage_bps is not None
        else Decimal("0"),
        "avg_abs_slippage_bps": aggregate.avg_abs_slippage_bps
        if aggregate.avg_abs_slippage_bps is not None
        else Decimal("0"),
        "avg_shortfall_notional": aggregate.avg_shortfall_notional
        if aggregate.avg_shortfall_notional is not None
        else Decimal("0"),
        "avg_shortfall_notional_abs": aggregate.avg_shortfall_notional_abs
        if aggregate.avg_shortfall_notional_abs is not None
        else Decimal("0"),
        "avg_churn_ratio": aggregate.avg_churn_ratio
        if aggregate.avg_churn_ratio is not None
        else Decimal("0"),
        "avg_divergence_bps": aggregate.avg_divergence_bps
        if aggregate.avg_divergence_bps is not None
        else Decimal("0"),
        "avg_divergence_bps_abs": aggregate.avg_divergence_bps_abs
        if aggregate.avg_divergence_bps_abs is not None
        else Decimal("0"),
        "expected_shortfall_sample_count": expected_count,
        "expected_shortfall_coverage": expected_shortfall_coverage,
        "avg_expected_shortfall_bps_p50": aggregate.avg_expected_shortfall_bps_p50
        if aggregate.avg_expected_shortfall_bps_p50 is not None
        else Decimal("0"),
        "avg_expected_shortfall_bps_p95": aggregate.avg_expected_shortfall_bps_p95
        if aggregate.avg_expected_shortfall_bps_p95 is not None
        else Decimal("0"),
        "avg_realized_shortfall_bps": aggregate.avg_realized_shortfall_bps
        if aggregate.avg_realized_shortfall_bps is not None
        else Decimal("0"),
        "avg_realized_shortfall_bps_abs": aggregate.avg_realized_shortfall_bps_abs
        if aggregate.avg_realized_shortfall_bps_abs is not None
        else Decimal("0"),
        "avg_calibration_error_bps": aggregate.avg_calibration_error_bps,
        "last_computed_at": aggregate.last_computed_at,
        "filled_execution_count": coverage.filled_execution_count,
        "latest_execution_created_at": coverage.latest_execution_created_at,
        "unsettled_execution_count": coverage.unsettled_execution_count,
        "symbol_breakdown": evidence.symbol_breakdown,
        "runtime_ledger_lineage": evidence.runtime_ledger_lineage,
        "read_model_status": "degraded" if evidence.reason_codes else "ok",
        "reason_codes": evidence.reason_codes,
    }


def _tca_execution_coverage_stmt(
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
    only_unsettled: bool = False,
) -> Any:
    if only_unsettled:
        stmt = (
            select(func.count(Execution.id))
            .select_from(Execution)
            .outerjoin(
                ExecutionTCAMetric,
                ExecutionTCAMetric.execution_id == Execution.id,
            )
            .where(ExecutionTCAMetric.id.is_(None))
        )
    else:
        stmt = select(func.count(Execution.id), func.max(Execution.created_at))

    stmt = stmt.where(
        Execution.avg_fill_price.is_not(None),
        Execution.filled_qty > 0,
    )
    if strategy_id:
        stmt = stmt.join(TradeDecision, TradeDecision.id == Execution.trade_decision_id)
        stmt = stmt.where(TradeDecision.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    if symbols:
        stmt = stmt.where(Execution.symbol.in_(symbols))
    return stmt


def _build_tca_runtime_ledger_lineage_summary(
    session: Session,
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
    total_filled_execution_count: int | None = None,
) -> dict[str, object]:
    sample_limit = _tca_status_lineage_sample_limit()
    stmt = (
        select(Execution)
        .options(
            load_only(
                Execution.id,
                Execution.alpaca_order_id,
                Execution.symbol,
                Execution.execution_audit_json,
            )
        )
        .join(ExecutionTCAMetric, ExecutionTCAMetric.execution_id == Execution.id)
        .where(
            Execution.avg_fill_price.is_not(None),
            Execution.filled_qty > 0,
        )
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    if symbols:
        stmt = stmt.where(Execution.symbol.in_(symbols))
    stmt = stmt.order_by(Execution.created_at.desc(), Execution.id.desc()).limit(
        sample_limit + 1
    )
    sampled_executions = list(session.execute(stmt).scalars())
    query_truncated = len(sampled_executions) > sample_limit
    executions = sampled_executions[:sample_limit]
    summary = _execution_lineage_summary(executions)
    sampled_count = len(executions)
    known_total = (
        max(0, int(total_filled_execution_count))
        if total_filled_execution_count is not None
        else None
    )
    known_truncated = known_total is not None and known_total > sampled_count
    truncated = query_truncated or known_truncated
    summary.update(
        {
            "bounded": True,
            "coverage_exact": not truncated,
            "query_limit": sample_limit,
            "sampled_execution_count": sampled_count,
            "truncated": truncated,
        }
    )
    if known_total is not None:
        summary["total_filled_execution_count"] = known_total
    if truncated:
        _mark_tca_lineage_summary_fail_closed(
            summary,
            reason=_TCA_STATUS_LINEAGE_SAMPLE_TRUNCATED_BLOCKER,
            missing_count=max(1, (known_total or sampled_count + 1) - sampled_count),
        )
    return summary


def _tca_status_lineage_sample_limit() -> int:
    configured_limit = getattr(
        settings,
        "trading_tca_status_lineage_sample_limit",
        _TCA_STATUS_LINEAGE_SAMPLE_DEFAULT_LIMIT,
    )
    try:
        parsed_limit = int(configured_limit)
    except (TypeError, ValueError):
        parsed_limit = _TCA_STATUS_LINEAGE_SAMPLE_DEFAULT_LIMIT
    return max(1, min(parsed_limit, _TCA_STATUS_LINEAGE_SAMPLE_MAX_LIMIT))


def _mark_tca_lineage_summary_fail_closed(
    summary: dict[str, object],
    *,
    reason: str,
    missing_count: int,
) -> None:
    blockers = [
        str(blocker)
        for blocker in cast(Collection[object], summary.get("blockers") or [])
    ]
    if reason not in blockers:
        blockers.append(reason)
    blocker_counts: dict[str, int] = {}
    for key, value in cast(
        Mapping[object, object], summary.get("blocker_counts") or {}
    ).items():
        try:
            blocker_counts[str(key)] = int(cast(Any, value))
        except (TypeError, ValueError):
            blocker_counts[str(key)] = 1
    blocker_counts[reason] = max(1, missing_count)
    summary["status"] = "blocked"
    summary["blockers"] = blockers
    summary["blocker_counts"] = dict(sorted(blocker_counts.items()))
    summary["promotion_authority"] = False


def _unavailable_tca_runtime_ledger_lineage_summary(
    *,
    reason: str,
    total_filled_execution_count: int | None,
) -> dict[str, object]:
    summary = _execution_lineage_summary([])
    sample_limit = _tca_status_lineage_sample_limit()
    missing_count = max(
        1,
        int(total_filled_execution_count)
        if total_filled_execution_count is not None
        else 1,
    )
    summary.update(
        {
            "bounded": True,
            "coverage_exact": False,
            "query_limit": sample_limit,
            "sampled_execution_count": 0,
            "truncated": total_filled_execution_count is not None
            and total_filled_execution_count > 0,
            "read_model_unavailable": True,
            "read_model_status": "timeout",
        }
    )
    if total_filled_execution_count is not None:
        summary["total_filled_execution_count"] = max(
            0, int(total_filled_execution_count)
        )
    _mark_tca_lineage_summary_fail_closed(
        summary,
        reason=reason,
        missing_count=missing_count,
    )
    return summary


__all__ = [
    "build_tca_gate_inputs",
    "refresh_execution_tca_metrics",
]

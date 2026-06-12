# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

import logging
import hashlib
import json
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal
from typing import Any, Optional, cast

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, load_only

from ...config import settings
from ...models import Execution, ExecutionTCAMetric, TradeDecision
from ..prices import resolve_execution_reference_price
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT,
    TigerBeetleLedgerJournal,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_27 import *


def _observed_broker_order_policy_hash(*, execution: Execution) -> str | None:
    raw_order = _mapping_from_any(execution.raw_order)
    if not raw_order:
        return None

    side = _text_from_payload(raw_order, "side")
    order_type = _text_from_payload(raw_order, "order_type", "type")
    time_in_force = _text_from_payload(raw_order, "time_in_force")
    broker_order_id = (
        _text_from_payload(raw_order, "id")
        or str(execution.alpaca_order_id or "").strip()
    )
    submitted_qty = _text_from_payload(raw_order, "qty")
    notional = _text_from_payload(raw_order, "notional")
    if not side or not order_type or not time_in_force or not broker_order_id:
        return None
    if not submitted_qty and notional is None:
        return None

    policy_payload = {
        "source": "observed_broker_order_execution_policy",
        "broker": "alpaca",
        "alpaca_account_label": execution.alpaca_account_label,
        "alpaca_order_id": broker_order_id,
        "client_order_id": _text_from_payload(raw_order, "client_order_id")
        or execution.client_order_id,
        "symbol": _text_from_payload(raw_order, "symbol") or execution.symbol,
        "side": side,
        "order_type": order_type,
        "time_in_force": time_in_force,
        "submitted_qty": submitted_qty,
        "notional": notional,
        "limit_price": _text_from_payload(raw_order, "limit_price"),
        "stop_price": _text_from_payload(raw_order, "stop_price"),
        "extended_hours": raw_order.get("extended_hours"),
        "order_class": _text_from_payload(raw_order, "order_class"),
        "position_intent": _text_from_payload(raw_order, "position_intent"),
    }
    return _stable_payload_digest(
        {key: value for key, value in policy_payload.items() if value is not None}
    )


def _execution_policy_hash_candidates(
    *,
    source_payloads: Collection[Mapping[str, object]],
    decision: TradeDecision | None,
    decision_payload: Mapping[str, object],
    execution: Execution,
    source_fields: dict[str, object],
) -> set[str]:
    explicit_hashes = _hash_candidates(
        source_payloads,
        hash_keys=_EXECUTION_POLICY_HASH_KEYS,
        payload_keys=(),
    )
    if explicit_hashes:
        if len(explicit_hashes) == 1:
            source_fields["execution_policy_hash"] = (
                _existing_lineage_source_field(source_payloads, "execution_policy_hash")
                or "execution_policy_hash"
            )
        return explicit_hashes

    payload_hashes = _hash_candidates(
        source_payloads,
        hash_keys=(),
        payload_keys=_EXECUTION_POLICY_PRIMARY_PAYLOAD_KEYS,
    )
    if payload_hashes:
        if len(payload_hashes) == 1:
            source_fields["execution_policy_hash"] = "execution_policy_payload"
        return payload_hashes

    payload_hashes = _hash_candidates(
        source_payloads,
        hash_keys=(),
        payload_keys=_EXECUTION_POLICY_ADVISORY_PAYLOAD_KEYS,
    )
    if payload_hashes:
        if len(payload_hashes) == 1:
            source_fields["execution_policy_hash"] = "execution_policy_advisor_payload"
        return payload_hashes

    decision_policy_hash = _decision_execution_policy_hash(
        decision=decision,
        decision_payload=decision_payload,
        execution=execution,
    )
    if decision_policy_hash is not None:
        source_fields["execution_policy_hash"] = (
            "trade_decisions.decision_json+executions.order_fields"
        )
        return {decision_policy_hash}

    observed_order_policy_hash = _observed_broker_order_policy_hash(execution=execution)
    if observed_order_policy_hash is None:
        return set()
    source_fields["execution_policy_hash"] = "executions.raw_order_observed_policy"
    return {observed_order_policy_hash}


def _existing_lineage_source_field(
    payloads: Collection[Mapping[str, object]], key: str
) -> object | None:
    for payload in payloads:
        source_fields = payload.get("source_fields")
        if not isinstance(source_fields, Mapping):
            continue
        source_field = cast(Mapping[object, object], source_fields).get(key)
        if source_field is not None:
            return source_field
    return None


def _hash_candidates(
    payloads: Collection[Mapping[str, object]],
    *,
    hash_keys: Collection[str],
    payload_keys: Collection[str],
) -> set[str]:
    candidates: set[str] = set()
    for payload in payloads:
        for key in hash_keys:
            text = _text_from_payload(payload, key)
            if text is not None:
                candidates.add(text)
        for key in payload_keys:
            value = payload.get(key)
            if value is not None and (digest := _stable_payload_digest(value)):
                candidates.add(digest)
    return candidates


def _resolve_lineage_hash(
    *,
    source_payloads: Collection[Mapping[str, object]],
    execution: Execution,
    decision: TradeDecision | None,
) -> str:
    explicit_hashes = _hash_candidates(
        source_payloads,
        hash_keys=_LINEAGE_HASH_KEYS,
        payload_keys=("lineage", "candidate_lineage", "source_lineage"),
    )
    if len(explicit_hashes) == 1:
        return next(iter(explicit_hashes))
    return _stable_payload_digest(
        {
            "alpaca_account_label": execution.alpaca_account_label,
            "alpaca_order_id": execution.alpaca_order_id,
            "client_order_id": execution.client_order_id,
            "decision_hash": decision.decision_hash if decision is not None else None,
            "execution_id": str(execution.id),
            "trade_decision_id": str(execution.trade_decision_id)
            if execution.trade_decision_id
            else None,
        }
    )


def _stable_payload_digest(value: object) -> str:
    body = json.dumps(value, default=str, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _text_from_payload(payload: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        text = str(payload.get(key) or "").strip()
        if text:
            return text
    return None


def _non_negative_decimal(value: object | None) -> Decimal | None:
    parsed = _decimal_or_none(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def _dedupe_texts(values: Collection[str]) -> list[str]:
    deduped: list[str] = []
    for value in values:
        text = value.strip()
        if text and text not in deduped:
            deduped.append(text)
    return deduped


def _journal_tigerbeetle_execution_cost(
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

    normalized_symbols = _normalize_tca_symbols(symbols)
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
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    normalized_account_label = account_label.strip() if account_label else ""
    if normalized_account_label:
        stmt = stmt.where(
            ExecutionTCAMetric.alpaca_account_label == normalized_account_label
        )
    if normalized_symbols:
        stmt = stmt.where(ExecutionTCAMetric.symbol.in_(normalized_symbols))

    row = session.execute(stmt).one()
    symbol_breakdown_reason: str | None = None
    try:
        symbol_breakdown = _build_tca_symbol_breakdown(
            session,
            strategy_id=strategy_id,
            account_label=normalized_account_label,
            symbols=normalized_symbols,
        )
    except SQLAlchemyError as exc:
        logger.warning("TCA symbol breakdown unavailable: %s", exc)
        session.rollback()
        symbol_breakdown_reason = "execution_tca_symbol_breakdown_query_unavailable"
        symbol_breakdown = _unavailable_tca_symbol_breakdown(
            symbols=normalized_symbols,
            reason=symbol_breakdown_reason,
        )
    execution_coverage_reason: str | None = None
    try:
        execution_stmt = _tca_execution_coverage_stmt(
            strategy_id=strategy_id,
            account_label=normalized_account_label,
            symbols=normalized_symbols,
        )
        unsettled_execution_stmt = _tca_execution_coverage_stmt(
            strategy_id=strategy_id,
            account_label=normalized_account_label,
            symbols=normalized_symbols,
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
        execution_coverage_reason = "execution_tca_execution_coverage_query_unavailable"
        execution_count = 0
        latest_execution_created_at = None
        unsettled_execution_count = 0
    order_count = int(row[0] or 0)
    avg_slippage = _decimal_or_none(row[1])
    avg_abs_slippage = _decimal_or_none(row[2])
    avg_shortfall = _decimal_or_none(row[3])
    avg_abs_shortfall = _decimal_or_none(row[4])
    avg_churn = _decimal_or_none(row[5])
    avg_divergence = _decimal_or_none(row[6])
    avg_abs_divergence = _decimal_or_none(row[7])
    expected_count = int(row[8] or 0)
    avg_expected_shortfall_p50 = _decimal_or_none(row[9])
    avg_expected_shortfall_p95 = _decimal_or_none(row[10])
    avg_realized_shortfall_bps = _decimal_or_none(row[11])
    avg_abs_realized_shortfall_bps = _decimal_or_none(row[12])
    avg_calibration_error_bps = _decimal_or_none(row[13])
    last_computed_at = row[14]
    expected_shortfall_coverage = (
        Decimal(expected_count) / Decimal(order_count) if order_count > 0 else None
    )
    filled_execution_count = int(execution_count or 0)
    lineage_unavailable_reason = execution_coverage_reason
    if lineage_unavailable_reason is None:
        try:
            runtime_ledger_lineage = _build_tca_runtime_ledger_lineage_summary(
                session,
                strategy_id=strategy_id,
                account_label=normalized_account_label,
                symbols=normalized_symbols,
                total_filled_execution_count=filled_execution_count,
            )
        except SQLAlchemyError as exc:
            logger.warning("TCA runtime ledger lineage unavailable: %s", exc)
            session.rollback()
            lineage_unavailable_reason = "runtime_tca_cost_lineage_query_unavailable"
            runtime_ledger_lineage = _unavailable_tca_runtime_ledger_lineage_summary(
                reason=lineage_unavailable_reason,
                total_filled_execution_count=filled_execution_count,
            )
    else:
        runtime_ledger_lineage = _unavailable_tca_runtime_ledger_lineage_summary(
            reason=lineage_unavailable_reason,
            total_filled_execution_count=None,
        )
    reason_codes = [
        reason
        for reason in (
            symbol_breakdown_reason,
            execution_coverage_reason,
            lineage_unavailable_reason
            if lineage_unavailable_reason != execution_coverage_reason
            else None,
        )
        if reason is not None
    ]
    return {
        "account_label": normalized_account_label or None,
        "scope_symbols": list(normalized_symbols),
        "scope_symbol_count": len(normalized_symbols),
        "order_count": order_count,
        "avg_slippage_bps": avg_slippage if avg_slippage is not None else Decimal("0"),
        "avg_abs_slippage_bps": avg_abs_slippage
        if avg_abs_slippage is not None
        else Decimal("0"),
        "avg_shortfall_notional": avg_shortfall
        if avg_shortfall is not None
        else Decimal("0"),
        "avg_shortfall_notional_abs": avg_abs_shortfall
        if avg_abs_shortfall is not None
        else Decimal("0"),
        "avg_churn_ratio": avg_churn if avg_churn is not None else Decimal("0"),
        "avg_divergence_bps": avg_divergence
        if avg_divergence is not None
        else Decimal("0"),
        "avg_divergence_bps_abs": avg_abs_divergence
        if avg_abs_divergence is not None
        else Decimal("0"),
        "expected_shortfall_sample_count": expected_count,
        "expected_shortfall_coverage": expected_shortfall_coverage,
        "avg_expected_shortfall_bps_p50": avg_expected_shortfall_p50
        if avg_expected_shortfall_p50 is not None
        else Decimal("0"),
        "avg_expected_shortfall_bps_p95": avg_expected_shortfall_p95
        if avg_expected_shortfall_p95 is not None
        else Decimal("0"),
        "avg_realized_shortfall_bps": avg_realized_shortfall_bps
        if avg_realized_shortfall_bps is not None
        else Decimal("0"),
        "avg_realized_shortfall_bps_abs": avg_abs_realized_shortfall_bps
        if avg_abs_realized_shortfall_bps is not None
        else Decimal("0"),
        "avg_calibration_error_bps": avg_calibration_error_bps,
        "last_computed_at": last_computed_at,
        "filled_execution_count": filled_execution_count,
        "latest_execution_created_at": latest_execution_created_at,
        "unsettled_execution_count": unsettled_execution_count,
        "symbol_breakdown": symbol_breakdown,
        "runtime_ledger_lineage": runtime_ledger_lineage,
        "read_model_status": "degraded" if reason_codes else "ok",
        "reason_codes": reason_codes,
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


__all__ = [name for name in globals() if not name.startswith("__")]

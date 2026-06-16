# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Kafka-backed order-feed ingestion and persistence helpers."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Mapping, cast

from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ...config import settings
from ...models import (
    Execution,
    ExecutionOrderEvent,
    OrderFeedConsumerCursor,
    OrderFeedSourceWindow,
    TradeDecision,
    coerce_json_payload,
)
from ..tca import upsert_execution_tca_metric
from ..tigerbeetle_journal import TigerBeetleLedgerJournal
from ..tigerbeetle_reconcile import reconcile_tigerbeetle_transfers

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    EXECUTION_RAW_ORDER_SOURCE_PARTITION,
    EXECUTION_RAW_ORDER_SOURCE_TOPIC,
    EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
    FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING,
    FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA,
    HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
    NormalizationResult,
    NormalizedOrderEvent,
    ORDER_FEED_SOURCE_REVISION,
    OrderFeedIngestor,
    _AccountAliasResolution,
    _ExecutionLinkageResolution,
    _FILL_EVENT_TYPES,
    _IngestRecordContext,
    _IngestRecordOutcome,
    _ManualAssignmentHooks,
    _OrderFeedSourceIdentity,
    _TradeDecisionLinkageResolution,
    _broker_high_watermark_from_record,
    _create_order_feed_source_window,
    _event_out_of_scope_for_default_account,
    _log_manual_assignment_ready,
    _manual_assignment_hooks,
    _manual_topic_partitions,
    _position_manual_topic_partitions,
    _record_source_identity,
    _reset_manual_unpositioned_partitions,
    _source_topic_from_record,
    _upsert_drop_cursor,
    logger,
)
from .classify_source_window_drop import (
    _classify_source_window_drop,
    _classify_source_window_event,
    _classify_source_window_unhandled_failure,
    _dedupe,
    _execution_correlation_identity_from_payload,
    _increment_drop_counter,
    _lifecycle_payload,
    _mark_order_event_account_alias,
    _missing_linkage_blockers,
    _order_event_account_label_alias,
    _order_event_client_identity,
    _order_event_evidence_payload,
    _order_event_execution_correlation_identity,
    _order_event_linkage_blockers,
    _order_identity_payload,
    _raw_event_with_linkage_blockers,
    _raw_record_source_evidence_payload,
    _source_window_event_status_reason,
    _source_window_failure_reason,
    _source_window_source_identity_payload,
    _source_window_source_identity_payload_for_values,
)
from .normalize_order_feed_record import (
    _event_with_default_account_label_if_in_scope,
    _fill_delta_fields,
    _fingerprint_normalized_order_event,
    _is_fill_event,
    _journal_tigerbeetle_order_event,
    _order_identity_matches_account_scope,
    apply_order_event_to_execution,
    latest_order_event_for_execution,
    link_order_events_to_execution,
    merge_execution_raw_order_update,
    normalize_order_feed_record,
    persist_order_event,
)


def repair_order_feed_execution_links(
    session: Session,
    *,
    account_label: str | None = None,
    canonical_account_label: str | None = None,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    limit: int = 1000,
) -> dict[str, int]:
    """Attach unlinked order-feed lifecycle rows to matching executions.

    This is a bounded repair for already-consumed broker events. It preserves
    fail-closed proof semantics: if no matching execution exists, the event stays
    unlinked and remains a runtime-ledger/source-authority blocker.
    """

    bounded_limit = max(1, min(int(limit), 5000))
    canonical_label = (
        canonical_account_label.strip()
        if canonical_account_label is not None and canonical_account_label.strip()
        else None
    )
    if canonical_label is not None:
        event_ordering = (
            ExecutionOrderEvent.raw_event["_torghut_linkage"]
            .as_string()
            .is_(None)
            .desc(),
            ExecutionOrderEvent.event_ts.desc().nullslast(),
            ExecutionOrderEvent.feed_seq.desc().nullslast(),
            ExecutionOrderEvent.created_at.desc(),
        )
    else:
        event_ordering = (
            ExecutionOrderEvent.raw_event["_torghut_linkage"]
            .as_string()
            .is_(None)
            .desc(),
            ExecutionOrderEvent.event_ts.asc().nullsfirst(),
            ExecutionOrderEvent.feed_seq.asc().nullsfirst(),
            ExecutionOrderEvent.created_at.asc(),
        )
    stmt = (
        select(ExecutionOrderEvent)
        .where(
            (
                (ExecutionOrderEvent.execution_id.is_(None))
                | (ExecutionOrderEvent.trade_decision_id.is_(None))
            ),
            (
                (ExecutionOrderEvent.alpaca_order_id.is_not(None))
                | (ExecutionOrderEvent.client_order_id.is_not(None))
            ),
        )
        .order_by(*event_ordering)
        .limit(bounded_limit)
    )
    if account_label:
        stmt = stmt.where(ExecutionOrderEvent.alpaca_account_label == account_label)
    if window_start is not None:
        stmt = stmt.where(
            func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)
            >= _ensure_aware_utc(window_start)
        )
    if window_end is not None:
        stmt = stmt.where(
            func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)
            < _ensure_aware_utc(window_end)
        )

    events = session.execute(stmt).scalars().all()
    processed_execution_ids: set[tuple[object, str]] = set()
    counters = {
        "selected": len(events),
        "executions_matched": 0,
        "executions_linked": 0,
        "decisions_matched": 0,
        "events_linked": 0,
        "decision_events_linked": 0,
        "events_without_execution": 0,
        "events_without_decision": 0,
        "account_alias_events_linked": 0,
    }
    processed_decision_ids: set[tuple[object, str]] = set()
    for event in events:
        if counters["events_linked"] >= bounded_limit:
            break
        event_client_order_id = _order_event_client_identity(event)
        event_correlation_id = _order_event_execution_correlation_identity(event)
        execution_linkage = _resolve_execution_linkage_for_identity(
            session,
            account_label=event.alpaca_account_label,
            alpaca_order_id=event.alpaca_order_id,
            client_order_id=event_client_order_id,
            execution_correlation_id=event_correlation_id,
        )
        source_account_label: str | None = None
        if (
            execution_linkage.execution is None
            and canonical_label is not None
            and canonical_label != event.alpaca_account_label
        ):
            canonical_execution_linkage = _resolve_execution_linkage_for_identity(
                session,
                account_label=canonical_label,
                alpaca_order_id=event.alpaca_order_id,
                client_order_id=event_client_order_id,
                execution_correlation_id=event_correlation_id,
            )
            if canonical_execution_linkage.execution is not None:
                execution_linkage = canonical_execution_linkage
                source_account_label = event.alpaca_account_label
        if execution_linkage.blockers:
            event.raw_event = _raw_event_with_linkage_blockers(
                event.raw_event,
                execution_linkage.blockers,
            )
            _ensure_source_window_for_event(session, event)
            session.add(event)
            _refresh_source_window_linkage_counts(session, event)
            counters["events_without_execution"] += 1
            counters["events_without_decision"] += int(event.trade_decision_id is None)
            continue
        execution = execution_linkage.execution
        if execution is None:
            if event.trade_decision_id is None:
                decision_linkage = _resolve_trade_decision_linkage_for_identity(
                    session,
                    account_label=event.alpaca_account_label,
                    client_order_id=event_client_order_id,
                )
                decision_source_account_label: str | None = None
                if (
                    decision_linkage.trade_decision is None
                    and canonical_label is not None
                    and canonical_label != event.alpaca_account_label
                ):
                    canonical_decision_linkage = (
                        _resolve_trade_decision_linkage_for_identity(
                            session,
                            account_label=canonical_label,
                            client_order_id=event_client_order_id,
                        )
                    )
                    if canonical_decision_linkage.trade_decision is not None:
                        decision_linkage = canonical_decision_linkage
                        decision_source_account_label = event.alpaca_account_label
                if decision_linkage.blockers:
                    event.raw_event = _raw_event_with_linkage_blockers(
                        event.raw_event,
                        decision_linkage.blockers,
                    )
                    _ensure_source_window_for_event(session, event)
                    session.add(event)
                    _refresh_source_window_linkage_counts(session, event)
                    counters["events_without_decision"] += 1
                elif decision_linkage.trade_decision is None:
                    event.raw_event = _raw_event_with_linkage_blockers(
                        event.raw_event,
                        _missing_linkage_blockers(
                            execution_missing=True,
                            decision_missing=True,
                        ),
                    )
                    _ensure_source_window_for_event(session, event)
                    session.add(event)
                    _refresh_source_window_linkage_counts(session, event)
                    counters["events_without_decision"] += 1
                else:
                    decision = decision_linkage.trade_decision
                    event.trade_decision_id = decision.id
                    event.raw_event = _raw_event_with_linkage_blockers(
                        event.raw_event,
                        _missing_linkage_blockers(
                            execution_missing=True,
                            decision_missing=False,
                        ),
                    )
                    decision_key = (decision.id, decision_source_account_label or "")
                    if decision_key not in processed_decision_ids:
                        processed_decision_ids.add(decision_key)
                        counters["decisions_matched"] += 1
                    if decision_source_account_label is not None:
                        _mark_order_event_account_alias(
                            event,
                            source_account_label=decision_source_account_label,
                            canonical_account_label=decision.alpaca_account_label,
                            basis="matched_order_identity",
                        )
                        counters["account_alias_events_linked"] += 1
                    _ensure_source_window_for_event(session, event)
                    session.add(event)
                    _refresh_source_window_linkage_counts(session, event)
                    counters["decision_events_linked"] += 1
            else:
                event.raw_event = _raw_event_with_linkage_blockers(
                    event.raw_event,
                    _missing_linkage_blockers(
                        execution_missing=True,
                        decision_missing=False,
                    ),
                )
                _ensure_source_window_for_event(session, event)
                session.add(event)
                _refresh_source_window_linkage_counts(session, event)
            counters["events_without_execution"] += 1
            continue
        execution_key = (execution.id, source_account_label or "")
        if execution_key in processed_execution_ids:
            continue
        processed_execution_ids.add(execution_key)
        counters["executions_matched"] += 1
        remaining_event_budget = max(1, bounded_limit - counters["events_linked"])
        linked = link_order_events_to_execution(
            session,
            execution,
            limit=remaining_event_budget,
            source_account_label=source_account_label,
        )
        if linked <= 0:
            continue
        counters["executions_linked"] += 1
        counters["events_linked"] += linked
        if source_account_label is not None:
            counters["account_alias_events_linked"] += linked
    return counters


def repair_order_feed_execution_states(
    session: Session,
    *,
    account_label: str | None = None,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    limit: int = 1000,
) -> dict[str, int]:
    """Reapply linked order-feed lifecycle rows to durable executions.

    Link repair can attach historical events after an execution already has
    lifecycle state. This bounded pass lets the stream-authoritative latest
    linked event correct stale partial-fill state without synthesizing fills.
    """

    bounded_limit = max(1, min(int(limit), 5000))
    stmt = (
        select(Execution)
        .where(
            Execution.trade_decision_id.is_not(None),
            exists().where(ExecutionOrderEvent.execution_id == Execution.id),
        )
        .order_by(
            Execution.order_feed_last_seq.desc().nullslast(),
            Execution.order_feed_last_event_ts.desc().nullslast(),
            Execution.updated_at.desc(),
            Execution.created_at.desc(),
            Execution.id.asc(),
        )
        .limit(bounded_limit)
    )
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    activity_ts = _execution_activity_timestamp()
    if window_start is not None:
        stmt = stmt.where(activity_ts >= _ensure_aware_utc(window_start))
    if window_end is not None:
        stmt = stmt.where(activity_ts < _ensure_aware_utc(window_end))

    executions = session.execute(stmt).scalars().all()
    counters = {
        "selected": len(executions),
        "latest_event_found": 0,
        "executions_updated": 0,
        "out_of_order_events_skipped": 0,
    }
    for execution in executions:
        latest_event = latest_order_event_for_execution(session, execution)
        if latest_event is None:
            continue
        counters["latest_event_found"] += 1
        updated, out_of_order = apply_order_event_to_execution(execution, latest_event)
        if out_of_order:
            counters["out_of_order_events_skipped"] += 1
            continue
        if not updated:
            continue
        _update_trade_decision_from_execution(session, execution)
        upsert_execution_tca_metric(session, execution)
        session.add(execution)
        counters["executions_updated"] += 1
    return counters


def repair_order_feed_fill_deltas(
    session: Session,
    *,
    account_label: str | None = None,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    limit: int = 1000,
) -> dict[str, int]:
    """Backfill fill-delta proof fields for already-persisted cumulative fills.

    Alpaca order-feed fill events carry cumulative filled quantity. Runtime-ledger
    source authority needs per-event deltas so a repeated lifecycle event cannot
    be counted as a fresh fill. This repair is bounded and fail-closed: rows that
    cannot prove a positive cumulative increase are marked non-increasing instead
    of receiving a synthetic delta.
    """

    bounded_limit = max(1, min(int(limit), 5000))
    stmt = (
        select(ExecutionOrderEvent)
        .where(
            ExecutionOrderEvent.fill_quantity_basis.is_(None),
            ExecutionOrderEvent.filled_qty.is_not(None),
            or_(
                ExecutionOrderEvent.event_type.in_(tuple(_FILL_EVENT_TYPES)),
                ExecutionOrderEvent.status.in_(tuple(_FILL_EVENT_TYPES)),
            ),
        )
        .order_by(
            ExecutionOrderEvent.alpaca_account_label.asc(),
            ExecutionOrderEvent.alpaca_order_id.asc().nullsfirst(),
            ExecutionOrderEvent.client_order_id.asc().nullsfirst(),
            ExecutionOrderEvent.event_ts.asc().nullsfirst(),
            ExecutionOrderEvent.feed_seq.asc().nullsfirst(),
            ExecutionOrderEvent.source_topic.asc(),
            ExecutionOrderEvent.source_partition.asc().nullsfirst(),
            ExecutionOrderEvent.source_offset.asc().nullsfirst(),
            ExecutionOrderEvent.created_at.asc(),
        )
        .limit(bounded_limit)
    )
    if account_label:
        stmt = stmt.where(ExecutionOrderEvent.alpaca_account_label == account_label)
    if window_start is not None:
        stmt = stmt.where(
            func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)
            >= _ensure_aware_utc(window_start)
        )
    if window_end is not None:
        stmt = stmt.where(
            func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)
            < _ensure_aware_utc(window_end)
        )

    events = session.execute(stmt).scalars().all()
    counters = {
        "selected": len(events),
        "delta_events_repaired": 0,
        "non_increasing_events_marked": 0,
        "missing_identity_events_marked": 0,
    }
    for event in events:
        if event.filled_qty is None:
            continue
        identity_clauses = _order_event_identity_clauses(event)
        if not identity_clauses:
            event.fill_quantity_basis = FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING
            counters["missing_identity_events_marked"] += 1
            session.add(event)
            continue

        previous_filled_qty = session.scalar(
            select(func.max(ExecutionOrderEvent.filled_qty)).where(
                ExecutionOrderEvent.id != event.id,
                ExecutionOrderEvent.alpaca_account_label == event.alpaca_account_label,
                or_(*identity_clauses),
                ExecutionOrderEvent.filled_qty.is_not(None),
                _event_precedes_order_event(event),
            )
        )
        previous_qty = (
            Decimal("0")
            if previous_filled_qty is None
            else Decimal(str(previous_filled_qty))
        )
        filled_qty = Decimal(str(event.filled_qty))
        filled_qty_delta = filled_qty - previous_qty
        if filled_qty_delta <= 0:
            event.fill_quantity_basis = FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING
            counters["non_increasing_events_marked"] += 1
            session.add(event)
            continue

        event.filled_qty_delta = filled_qty_delta
        event.filled_notional_delta = (
            filled_qty_delta * Decimal(str(event.avg_fill_price))
            if event.avg_fill_price is not None
            else None
        )
        event.fill_quantity_basis = FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA
        counters["delta_events_repaired"] += 1
        session.add(event)
    return counters


def backfill_order_feed_source_windows(
    session: Session,
    *,
    account_label: str | None = None,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    limit: int = 1000,
) -> dict[str, int]:
    """Attach source-window rows to persisted order events that already have offsets.

    These windows are audit lineage for old already-consumed events. They are not
    Kafka cursor authority, so manual assignment will not use them to skip offsets.
    """

    bounded_limit = max(1, min(int(limit), 5000))
    stmt = (
        select(ExecutionOrderEvent)
        .where(
            ExecutionOrderEvent.source_window_id.is_(None),
            ExecutionOrderEvent.source_topic.is_not(None),
            ExecutionOrderEvent.source_partition.is_not(None),
            ExecutionOrderEvent.source_offset.is_not(None),
        )
        .order_by(
            ExecutionOrderEvent.source_topic.asc(),
            ExecutionOrderEvent.source_partition.asc().nullsfirst(),
            ExecutionOrderEvent.source_offset.asc().nullsfirst(),
            ExecutionOrderEvent.created_at.asc(),
        )
        .limit(bounded_limit)
    )
    if account_label:
        stmt = stmt.where(ExecutionOrderEvent.alpaca_account_label == account_label)
    if window_start is not None:
        stmt = stmt.where(
            func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)
            >= _ensure_aware_utc(window_start)
        )
    if window_end is not None:
        stmt = stmt.where(
            func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)
            < _ensure_aware_utc(window_end)
        )

    events = session.execute(stmt).scalars().all()
    counters = {
        "selected": len(events),
        "source_windows_created": 0,
        "source_windows_reused": 0,
        "events_linked": 0,
    }
    for event in events:
        source_window, created = _ensure_source_window_for_event(session, event)
        if source_window is None:
            continue
        if created:
            counters["source_windows_created"] += 1
        else:
            counters["source_windows_reused"] += 1
        session.add(event)
        _refresh_source_window_linkage_counts(session, event)
        counters["events_linked"] += 1
    return counters


def backfill_order_feed_events_from_executions(
    session: Session,
    *,
    account_label: str | None = None,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    limit: int = 1000,
) -> dict[str, int]:
    """Materialize bounded order-feed lifecycle rows from durable executions.

    This repair exists for live accounts that submitted orders before the
    order-feed consumer was producing ``execution_order_events`` rows. It is not
    Kafka cursor authority: generated source windows use a dedicated source
    topic/revision and never update the consumer cursor. The rows stay
    account-scoped and execution/trade-decision linked so runtime proof can
    explain exactly which persisted live execution supplied the lifecycle source.
    """

    bounded_limit = max(1, min(int(limit), 5000))
    stmt = (
        select(Execution)
        .where(
            Execution.trade_decision_id.is_not(None),
            Execution.alpaca_order_id != "",
            ~_execution_order_event_exists_for_execution_clause(),
        )
        .order_by(
            _execution_activity_timestamp().asc().nullsfirst(),
            Execution.created_at.asc(),
            Execution.id.asc(),
        )
        .limit(bounded_limit)
    )
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    activity_ts = _execution_activity_timestamp()
    if window_start is not None:
        stmt = stmt.where(activity_ts >= _ensure_aware_utc(window_start))
    if window_end is not None:
        stmt = stmt.where(activity_ts < _ensure_aware_utc(window_end))

    executions = session.execute(stmt).scalars().all()
    counters = {
        "selected": len(executions),
        "events_created": 0,
        "source_windows_created": 0,
        "skipped_existing_event": 0,
        "skipped_missing_trade_decision": 0,
        "skipped_missing_order_identity": 0,
        "skipped_source_offset_collision": 0,
    }
    for execution in executions:
        if latest_order_event_for_execution(session, execution) is not None:
            counters["skipped_existing_event"] += 1
            continue

        source_offset = _stable_execution_source_offset(execution.id)
        if _source_offset_in_use(
            session,
            source_topic=EXECUTION_RAW_ORDER_SOURCE_TOPIC,
            source_partition=EXECUTION_RAW_ORDER_SOURCE_PARTITION,
            source_offset=source_offset,
        ):
            counters["skipped_source_offset_collision"] += 1
            continue

        event_ts = _ensure_aware_utc(
            _execution_activity_at(execution) or datetime.now(timezone.utc)
        )
        source_window = _create_execution_backfill_source_window(
            session,
            execution=execution,
            event_ts=event_ts,
            source_offset=source_offset,
        )
        event = _execution_backfill_order_event(
            execution=execution,
            event_ts=event_ts,
            source_offset=source_offset,
            source_window_id=source_window.id,
        )
        session.add(event)
        session.flush()
        _refresh_source_window_linkage_counts(session, event)
        counters["events_created"] += 1
        counters["source_windows_created"] += 1
    return counters


def _execution_order_event_exists_for_execution_clause() -> ColumnElement[bool]:
    return exists().where(
        ExecutionOrderEvent.alpaca_account_label == Execution.alpaca_account_label,
        or_(
            ExecutionOrderEvent.execution_id == Execution.id,
            (
                (Execution.alpaca_order_id != "")
                & (ExecutionOrderEvent.alpaca_order_id == Execution.alpaca_order_id)
            ),
            (
                Execution.client_order_id.is_not(None)
                & (Execution.client_order_id != "")
                & (ExecutionOrderEvent.client_order_id == Execution.client_order_id)
            ),
            (
                Execution.execution_idempotency_key.is_not(None)
                & (Execution.execution_idempotency_key != "")
                & (
                    ExecutionOrderEvent.client_order_id
                    == Execution.execution_idempotency_key
                )
            ),
        ),
    )


def _execution_activity_timestamp() -> Any:
    return func.coalesce(
        Execution.order_feed_last_event_ts,
        Execution.last_update_at,
        Execution.updated_at,
        Execution.created_at,
    )


def _execution_activity_at(row: Execution) -> datetime | None:
    return (
        row.order_feed_last_event_ts
        or row.last_update_at
        or row.updated_at
        or row.created_at
    )


def _order_event_identity_clauses(
    event: ExecutionOrderEvent,
) -> list[ColumnElement[bool]]:
    clauses: list[ColumnElement[bool]] = []
    if event.alpaca_order_id:
        clauses.append(ExecutionOrderEvent.alpaca_order_id == event.alpaca_order_id)
    if event.client_order_id:
        clauses.append(ExecutionOrderEvent.client_order_id == event.client_order_id)
    return clauses


def _event_precedes_order_event(event: ExecutionOrderEvent) -> ColumnElement[bool]:
    created_at = event.created_at
    clauses: list[ColumnElement[bool]] = []
    if event.event_ts is not None:
        clauses.append(ExecutionOrderEvent.event_ts < event.event_ts)
        same_event_ts = ExecutionOrderEvent.event_ts == event.event_ts
        if event.feed_seq is not None:
            clauses.append(
                same_event_ts
                & ExecutionOrderEvent.feed_seq.is_not(None)
                & (ExecutionOrderEvent.feed_seq < event.feed_seq)
            )
        clauses.append(same_event_ts & (ExecutionOrderEvent.created_at < created_at))
    if (
        event.source_topic
        and event.source_partition is not None
        and event.source_offset is not None
    ):
        clauses.append(
            (ExecutionOrderEvent.source_topic == event.source_topic)
            & (ExecutionOrderEvent.source_partition == event.source_partition)
            & ExecutionOrderEvent.source_offset.is_not(None)
            & (ExecutionOrderEvent.source_offset < event.source_offset)
        )
    else:
        clauses.append(ExecutionOrderEvent.created_at < created_at)
    if not clauses:
        return ExecutionOrderEvent.id != event.id
    return or_(*clauses)


def _ensure_source_window_for_event(
    session: Session,
    event: ExecutionOrderEvent,
) -> tuple[OrderFeedSourceWindow | None, bool]:
    if event.source_window_id is not None:
        source_window = session.get(OrderFeedSourceWindow, event.source_window_id)
        return source_window, False
    if event.source_partition is None or event.source_offset is None:
        return None, False
    source_window = _find_existing_source_window_for_event(session, event)
    created = False
    if source_window is None:
        source_window = _create_historical_source_window_for_event(session, event)
        created = True
    event.source_window_id = source_window.id
    return source_window, created


__all__ = [name for name in globals() if not name.startswith("__")]

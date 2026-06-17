# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821

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
    AccountAliasResolution as _AccountAliasResolution,
    ExecutionLinkageResolution as _ExecutionLinkageResolution,
    FILL_EVENT_TYPES as _FILL_EVENT_TYPES,
    IngestRecordContext as _IngestRecordContext,
    IngestRecordOutcome as _IngestRecordOutcome,
    ManualAssignmentHooks as _ManualAssignmentHooks,
    OrderFeedSourceIdentity as _OrderFeedSourceIdentity,
    TradeDecisionLinkageResolution as _TradeDecisionLinkageResolution,
    broker_high_watermark_from_record as _broker_high_watermark_from_record,
    create_order_feed_source_window as _create_order_feed_source_window,
    event_out_of_scope_for_default_account as _event_out_of_scope_for_default_account,
    log_manual_assignment_ready as _log_manual_assignment_ready,
    manual_assignment_hooks as _manual_assignment_hooks,
    manual_topic_partitions as _manual_topic_partitions,
    position_manual_topic_partitions as _position_manual_topic_partitions,
    record_source_identity as _record_source_identity,
    reset_manual_unpositioned_partitions as _reset_manual_unpositioned_partitions,
    source_topic_from_record as _source_topic_from_record,
    upsert_drop_cursor as _upsert_drop_cursor,
    logger,
)

from .order_feed_ingestor import OrderFeedIngestor
from .classify_source_window_drop import (
    classify_source_window_drop as _classify_source_window_drop,
    classify_source_window_event as _classify_source_window_event,
    classify_source_window_unhandled_failure as _classify_source_window_unhandled_failure,
    dedupe as _dedupe,
    execution_correlation_identity_from_payload as _execution_correlation_identity_from_payload,
    increment_drop_counter as _increment_drop_counter,
    lifecycle_payload as _lifecycle_payload,
    mark_order_event_account_alias as _mark_order_event_account_alias,
    missing_linkage_blockers as _missing_linkage_blockers,
    order_event_account_label_alias as _order_event_account_label_alias,
    order_event_client_identity as _order_event_client_identity,
    order_event_evidence_payload as _order_event_evidence_payload,
    order_event_execution_correlation_identity as _order_event_execution_correlation_identity,
    order_event_linkage_blockers as _order_event_linkage_blockers,
    order_identity_payload as _order_identity_payload,
    raw_event_with_linkage_blockers as _raw_event_with_linkage_blockers,
    raw_record_source_evidence_payload as _raw_record_source_evidence_payload,
    source_window_event_status_reason as _source_window_event_status_reason,
    source_window_failure_reason as _source_window_failure_reason,
    source_window_source_identity_payload as _source_window_source_identity_payload,
    source_window_source_identity_payload_for_values as _source_window_source_identity_payload_for_values,
)
from .normalize_order_feed_record import (
    event_with_default_account_label_if_in_scope as _event_with_default_account_label_if_in_scope,
    fill_delta_fields as _fill_delta_fields,
    fingerprint_normalized_order_event as _fingerprint_normalized_order_event,
    is_fill_event as _is_fill_event,
    journal_tigerbeetle_order_event as _journal_tigerbeetle_order_event,
    order_identity_matches_account_scope as _order_identity_matches_account_scope,
    apply_order_event_to_execution,
    latest_order_event_for_execution,
    link_order_events_to_execution,
    merge_execution_raw_order_update,
    normalize_order_feed_record,
    persist_order_event,
)
from .repair_order_feed_execution_links import (
    ensure_source_window_for_event as _ensure_source_window_for_event,
    event_precedes_order_event as _event_precedes_order_event,
    execution_activity_at as _execution_activity_at,
    execution_activity_timestamp as _execution_activity_timestamp,
    execution_order_event_exists_for_execution_clause as _execution_order_event_exists_for_execution_clause,
    order_event_identity_clauses as _order_event_identity_clauses,
    backfill_order_feed_events_from_executions,
    backfill_order_feed_source_windows,
    repair_order_feed_execution_links,
    repair_order_feed_execution_states,
    repair_order_feed_fill_deltas,
)
from .resolve_execution_linkage_for_identity import (
    create_execution_backfill_source_window as _create_execution_backfill_source_window,
    create_historical_source_window_for_event as _create_historical_source_window_for_event,
    cross_dsn_linkage_counts_for_source_window as _cross_dsn_linkage_counts_for_source_window,
    decode_json_payload as _decode_json_payload,
    decode_json_text_payload as _decode_json_text_payload,
    ensure_aware_utc as _ensure_aware_utc,
    event_timestamp_for_source_window as _event_timestamp_for_source_window,
    execution_backfill_event_type as _execution_backfill_event_type,
    execution_backfill_order_event as _execution_backfill_order_event,
    execution_backfill_raw_event as _execution_backfill_raw_event,
    extract_trade_update_payload as _extract_trade_update_payload,
    find_existing_source_window_for_event as _find_existing_source_window_for_event,
    isoformat_datetime as _isoformat_datetime,
    normalize_decoded_payload as _normalize_decoded_payload,
    order_event_has_failed_unhandled_source_window as _order_event_has_failed_unhandled_source_window,
    refresh_source_window_linkage_counts as _refresh_source_window_linkage_counts,
    resolve_execution_linkage_for_identity as _resolve_execution_linkage_for_identity,
    resolve_trade_decision_linkage_for_identity as _resolve_trade_decision_linkage_for_identity,
    retry_failed_duplicate_order_event_application as _retry_failed_duplicate_order_event_application,
    source_offset_in_use as _source_offset_in_use,
    stable_execution_source_offset as _stable_execution_source_offset,
)


def _flatten_poll_records(polled: Any) -> list[Any]:
    if not polled:
        return []
    if isinstance(polled, Mapping):
        rows: list[Any] = []
        mapping = cast(Mapping[Any, Any], polled)
        for raw_records in mapping.values():
            if isinstance(raw_records, list):
                rows.extend(cast(list[Any], raw_records))
        return rows
    if isinstance(polled, list):
        return cast(list[Any], polled)
    return []


def _order_feed_cursor_consumer_group() -> str:
    group_id = settings.trading_order_feed_group_id.strip()
    if group_id:
        return group_id
    client_id = settings.trading_order_feed_client_id.strip()
    return client_id or "torghut-order-feed"


def _kafka_consumer_group_id() -> str:
    return _order_feed_cursor_consumer_group()


def _consumer_commit_enabled() -> bool:
    return settings.trading_order_feed_assignment_mode == "group"


def _latest_persisted_source_offsets(session: Session) -> dict[tuple[str, int], int]:
    consumer_group = _order_feed_cursor_consumer_group()
    cursor_rows = session.execute(
        select(
            OrderFeedConsumerCursor.source_topic,
            OrderFeedConsumerCursor.source_partition,
            OrderFeedConsumerCursor.high_watermark_offset,
        ).where(OrderFeedConsumerCursor.consumer_group == consumer_group)
    ).all()
    offsets: dict[tuple[str, int], int] = {
        (str(topic), int(partition)): int(offset)
        for topic, partition, offset in cursor_rows
        if topic is not None and partition is not None and offset is not None
    }

    source_window_rows = session.execute(
        select(
            OrderFeedSourceWindow.source_topic,
            OrderFeedSourceWindow.source_partition,
            func.max(OrderFeedSourceWindow.end_offset),
        )
        .where(
            OrderFeedSourceWindow.consumer_group == consumer_group,
            OrderFeedSourceWindow.source_revision == ORDER_FEED_SOURCE_REVISION,
            OrderFeedSourceWindow.status != "failed_unhandled",
            OrderFeedSourceWindow.end_offset.is_not(None),
        )
        .group_by(
            OrderFeedSourceWindow.source_topic,
            OrderFeedSourceWindow.source_partition,
        )
    ).all()
    for topic, partition, offset in source_window_rows:
        if topic is None or partition is None or offset is None:
            continue
        offsets.setdefault((str(topic), int(partition)), int(offset))
    return offsets


def _upsert_order_feed_consumer_cursor(
    session: Session,
    event: NormalizedOrderEvent,
    *,
    duplicate: bool,
    source_window: OrderFeedSourceWindow | None = None,
) -> bool:
    return _upsert_order_feed_consumer_cursor_from_source(
        session,
        source_topic=event.source_topic,
        source_partition=event.source_partition,
        source_offset=event.source_offset,
        event_fingerprint=event.event_fingerprint,
        event_ts=event.event_ts,
        duplicate=duplicate,
        source_window=source_window,
    )


def _upsert_cursor_and_count(
    *,
    session: Session,
    event: NormalizedOrderEvent,
    duplicate: bool,
    source_window: OrderFeedSourceWindow | None,
    counters: dict[str, int],
) -> bool:
    cursor_updated = _upsert_order_feed_consumer_cursor(
        session,
        event,
        duplicate=duplicate,
        source_window=source_window,
    )
    if cursor_updated:
        counters["cursor_updates_total"] += 1
    return cursor_updated


def _upsert_order_feed_consumer_cursor_from_source(
    session: Session,
    *,
    source_topic: str,
    source_partition: int | None,
    source_offset: int | None,
    event_fingerprint: str | None,
    event_ts: datetime | None,
    duplicate: bool,
    source_window: OrderFeedSourceWindow | None = None,
) -> bool:
    if source_partition is None or source_offset is None:
        return False

    consumer_group = _order_feed_cursor_consumer_group()
    cursor = session.execute(
        select(OrderFeedConsumerCursor).where(
            OrderFeedConsumerCursor.consumer_group == consumer_group,
            OrderFeedConsumerCursor.source_topic == source_topic,
            OrderFeedConsumerCursor.source_partition == source_partition,
        )
    ).scalar_one_or_none()

    if cursor is None:
        cursor = OrderFeedConsumerCursor(
            consumer_group=consumer_group,
            source_topic=source_topic,
            source_partition=source_partition,
            high_watermark_offset=source_offset,
            last_event_fingerprint=event_fingerprint,
            last_event_ts=event_ts,
            processed_event_count=1,
            duplicate_event_count=1 if duplicate else 0,
            offset_gap_count=0,
        )
        session.add(cursor)
        return True

    if source_offset > cursor.high_watermark_offset:
        if source_offset > cursor.high_watermark_offset + 1:
            cursor.offset_gap_count = int(cursor.offset_gap_count or 0) + 1
            if source_window is not None:
                source_window.gap_count = 1
                source_window.gap_ranges = [
                    {
                        "start_offset": cursor.high_watermark_offset + 1,
                        "end_offset": source_offset - 1,
                    }
                ]
        cursor.high_watermark_offset = source_offset
        cursor.last_event_fingerprint = event_fingerprint
        cursor.last_event_ts = event_ts

    cursor.processed_event_count = int(cursor.processed_event_count or 0) + 1
    if duplicate:
        cursor.duplicate_event_count = int(cursor.duplicate_event_count or 0) + 1
    session.add(cursor)
    return True


def _coerce_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return None


def _coerce_datetime(value: Any) -> datetime | None:
    text = _coerce_text(value)
    if text is None:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _coerce_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return None


def _is_stale_by_seq(execution: Execution, event: ExecutionOrderEvent) -> bool:
    if execution.order_feed_last_seq is None or event.feed_seq is None:
        return False
    return event.feed_seq < execution.order_feed_last_seq


def _is_stale_by_ts(execution: Execution, event: ExecutionOrderEvent) -> bool:
    if execution.order_feed_last_seq is not None and event.feed_seq is not None:
        return False
    candidate_ts = event.event_ts
    if candidate_ts is None:
        return False
    if candidate_ts.tzinfo is None:
        candidate_ts = candidate_ts.replace(tzinfo=timezone.utc)
    baseline = execution.order_feed_last_event_ts
    if baseline is None:
        return False
    if baseline.tzinfo is None:
        baseline = baseline.replace(tzinfo=timezone.utc)
    return candidate_ts < baseline


def _update_trade_decision_from_execution(
    session: Session, execution: Execution
) -> None:
    if execution.trade_decision_id is None:
        return
    decision = session.get(TradeDecision, execution.trade_decision_id)
    if decision is None:
        return
    decision.status = execution.status
    if execution.status == "filled" and decision.executed_at is None:
        decision.executed_at = execution.last_update_at or datetime.now(timezone.utc)
    session.add(decision)


def _commit_consumer(consumer: Any) -> bool:
    run_commit = cast(Callable[[], Any] | None, getattr(consumer, "commit", None))
    if run_commit is None:
        return False
    try:
        run_commit()
        return True
    except Exception as exc:  # pragma: no cover - external Kafka failure
        logger.warning("Order-feed consumer commit failed: %s", exc)
        return False


__all__ = [
    "NormalizedOrderEvent",
    "NormalizationResult",
    "OrderFeedIngestor",
    "EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION",
    "HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION",
    "ORDER_FEED_SOURCE_REVISION",
    "normalize_order_feed_record",
    "persist_order_event",
    "apply_order_event_to_execution",
    "backfill_order_feed_events_from_executions",
    "backfill_order_feed_source_windows",
    "link_order_events_to_execution",
    "repair_order_feed_execution_links",
    "repair_order_feed_execution_states",
    "repair_order_feed_fill_deltas",
    "latest_order_event_for_execution",
]


# Public aliases used by split-module consumers.
commit_consumer = _commit_consumer
consumer_commit_enabled = _consumer_commit_enabled
flatten_poll_records = _flatten_poll_records
is_stale_by_seq = _is_stale_by_seq
is_stale_by_ts = _is_stale_by_ts
kafka_consumer_group_id = _kafka_consumer_group_id
latest_persisted_source_offsets = _latest_persisted_source_offsets
order_feed_cursor_consumer_group = _order_feed_cursor_consumer_group
update_trade_decision_from_execution = _update_trade_decision_from_execution
upsert_cursor_and_count = _upsert_cursor_and_count
upsert_order_feed_consumer_cursor_from_source = (
    _upsert_order_feed_consumer_cursor_from_source
)

__all__ = (
    "commit_consumer",
    "consumer_commit_enabled",
    "flatten_poll_records",
    "is_stale_by_seq",
    "is_stale_by_ts",
    "kafka_consumer_group_id",
    "latest_persisted_source_offsets",
    "order_feed_cursor_consumer_group",
    "update_trade_decision_from_execution",
    "upsert_cursor_and_count",
    "upsert_order_feed_consumer_cursor_from_source",
)

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
from .repair_order_feed_execution_links import (
    _ensure_source_window_for_event,
    _event_precedes_order_event,
    _execution_activity_at,
    _execution_activity_timestamp,
    _execution_order_event_exists_for_execution_clause,
    _order_event_identity_clauses,
    backfill_order_feed_events_from_executions,
    backfill_order_feed_source_windows,
    repair_order_feed_execution_links,
    repair_order_feed_execution_states,
    repair_order_feed_fill_deltas,
)
from .resolve_execution_linkage_for_identity import (
    _create_execution_backfill_source_window,
    _create_historical_source_window_for_event,
    _cross_dsn_linkage_counts_for_source_window,
    _decode_json_payload,
    _decode_json_text_payload,
    _ensure_aware_utc,
    _event_timestamp_for_source_window,
    _execution_backfill_event_type,
    _execution_backfill_order_event,
    _execution_backfill_raw_event,
    _extract_trade_update_payload,
    _find_existing_source_window_for_event,
    _isoformat_datetime,
    _normalize_decoded_payload,
    _order_event_has_failed_unhandled_source_window,
    _refresh_source_window_linkage_counts,
    _resolve_execution_linkage_for_identity,
    _resolve_trade_decision_linkage_for_identity,
    _retry_failed_duplicate_order_event_application,
    _source_offset_in_use,
    _stable_execution_source_offset,
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


__all__ = [name for name in globals() if not name.startswith("__")]

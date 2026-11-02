"""Kafka-backed order-feed ingestion and persistence helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Mapping, cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Execution,
    ExecutionOrderEvent,
    OrderFeedConsumerCursor,
    OrderFeedSourceWindow,
    TradeDecision,
)


from .shared_context import (
    NormalizedOrderEvent,
    ORDER_FEED_SOURCE_REVISION,
    logger,
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

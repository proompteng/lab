"""Kafka-backed order-feed ingestion and persistence helpers."""

from __future__ import annotations

import hashlib
from importlib import import_module
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


logger = logging.getLogger(__name__)

ORDER_FEED_SOURCE_REVISION = "alpaca_trade_updates_v1"

HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION = (
    "execution_order_events_existing_source_offsets_v1"
)

FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA = "cumulative_to_delta"

FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING = "cumulative_non_increasing"

FILL_QUANTITY_BASIS_DELTA = "delta"

_FILL_EVENT_TYPES = frozenset({"fill", "filled", "partial_fill", "partially_filled"})

EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION = "execution_raw_order_snapshot_backfill_v1"

EXECUTION_RAW_ORDER_SOURCE_TOPIC = "torghut.execution-raw-order.backfill.v1"

EXECUTION_RAW_ORDER_SOURCE_PARTITION = 0


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


def _ensure_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _ensure_aware_utc(value).isoformat()


def _decode_json_payload(raw: Any) -> dict[str, Any] | list[Any] | None:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return _normalize_decoded_payload(raw)
    if isinstance(raw, bytes):
        try:
            return _decode_json_text_payload(raw.decode("utf-8"))
        except UnicodeDecodeError:
            return None
    if isinstance(raw, str):
        return _decode_json_text_payload(raw)
    return None


def _decode_json_text_payload(raw_text: str) -> dict[str, Any] | list[Any] | None:
    try:
        decoded = json.loads(raw_text)
    except json.JSONDecodeError:
        return None
    return _normalize_decoded_payload(decoded)


def _normalize_decoded_payload(raw: Any) -> dict[str, Any] | list[Any] | None:
    if isinstance(raw, dict):
        return cast(dict[str, Any], raw)
    if isinstance(raw, list):
        return cast(list[Any], raw)
    return None


def _extract_trade_update_payload(payload: Any) -> Mapping[str, Any] | None:
    root = _as_mapping(payload)
    if root is None:
        return None
    channel = _coerce_text(root.get("channel"))
    inner_payload = _as_mapping(root.get("payload"))
    if channel == "trade_updates" and inner_payload is not None:
        return inner_payload
    stream = _coerce_text(root.get("stream"))
    data_payload = _as_mapping(root.get("data"))
    if stream == "trade_updates" and data_payload is not None:
        return data_payload
    if _as_mapping(root.get("order")) is not None:
        return root
    return None


def _kafka_consumer_group_id() -> str:
    from .flatten_poll_records import (
        kafka_consumer_group_id,
    )

    return kafka_consumer_group_id()


def _latest_persisted_source_offsets(
    session: Session,
) -> dict[tuple[str, int], int]:
    from .flatten_poll_records import (
        latest_persisted_source_offsets,
    )

    return latest_persisted_source_offsets(session)


def _consumer_commit_enabled() -> bool:
    from .flatten_poll_records import (
        consumer_commit_enabled,
    )

    return consumer_commit_enabled()


def _commit_consumer(consumer: Any) -> bool:
    from .flatten_poll_records import (
        commit_consumer,
    )

    return commit_consumer(consumer)


def _flatten_poll_records(polled: Any) -> list[Any]:
    from .flatten_poll_records import (
        flatten_poll_records,
    )

    return flatten_poll_records(polled)


def normalize_order_feed_record(
    record: Any, *, default_topic: str, default_account_label: str
) -> NormalizationResult:
    from .normalize_order_feed_record import (
        normalize_order_feed_record as normalize_record,
    )

    return normalize_record(
        record,
        default_topic=default_topic,
        default_account_label=default_account_label,
    )


def _event_with_default_account_label_if_in_scope(
    *args: Any, **kwargs: Any
) -> NormalizedOrderEvent | None:
    from .normalize_order_feed_record import (
        event_with_default_account_label_if_in_scope as event_with_default_account,
    )

    return event_with_default_account(*args, **kwargs)


def persist_order_event(*args: Any, **kwargs: Any) -> tuple[ExecutionOrderEvent, bool]:
    from .normalize_order_feed_record import persist_order_event as persist_event

    return persist_event(*args, **kwargs)


def apply_order_event_to_execution(*args: Any, **kwargs: Any) -> tuple[bool, bool]:
    from .normalize_order_feed_record import (
        apply_order_event_to_execution as apply_event,
    )

    return apply_event(*args, **kwargs)


def _classify_source_window_drop(*args: Any, **kwargs: Any) -> None:
    from .classify_source_window_drop import (
        classify_source_window_drop as classify_drop,
    )

    classify_drop(*args, **kwargs)


def _classify_source_window_event(*args: Any, **kwargs: Any) -> None:
    from .classify_source_window_drop import (
        classify_source_window_event as classify_event,
    )

    classify_event(*args, **kwargs)


def _classify_source_window_unhandled_failure(*args: Any, **kwargs: Any) -> None:
    from .classify_source_window_drop import (
        classify_source_window_unhandled_failure as classify_failure,
    )

    classify_failure(*args, **kwargs)


def _increment_drop_counter(*args: Any, **kwargs: Any) -> None:
    from .classify_source_window_drop import (
        increment_drop_counter as increment_drop,
    )

    increment_drop(*args, **kwargs)


def _order_event_has_failed_unhandled_source_window(*args: Any, **kwargs: Any) -> bool:
    from .resolve_execution_linkage_for_identity import (
        order_event_has_failed_unhandled_source_window as has_failed_window,
    )

    return has_failed_window(*args, **kwargs)


def _retry_failed_duplicate_order_event_application(*args: Any, **kwargs: Any) -> None:
    from .resolve_execution_linkage_for_identity import (
        retry_failed_duplicate_order_event_application as retry_duplicate,
    )

    retry_duplicate(*args, **kwargs)


def _upsert_cursor_and_count(*args: Any, **kwargs: Any) -> bool:
    from .flatten_poll_records import (
        upsert_cursor_and_count as upsert_cursor,
    )

    return upsert_cursor(*args, **kwargs)


def _update_trade_decision_from_execution(*args: Any, **kwargs: Any) -> None:
    from .flatten_poll_records import (
        update_trade_decision_from_execution as update_decision,
    )

    update_decision(*args, **kwargs)


def _upsert_order_feed_consumer_cursor_from_source(*args: Any, **kwargs: Any) -> bool:
    from .flatten_poll_records import (
        upsert_order_feed_consumer_cursor_from_source as upsert_cursor_from_source,
    )

    return upsert_cursor_from_source(*args, **kwargs)


def _order_feed_cursor_consumer_group() -> str:
    from .flatten_poll_records import (
        order_feed_cursor_consumer_group,
    )

    return order_feed_cursor_consumer_group()


@dataclass(frozen=True)
class NormalizedOrderEvent:
    """Canonicalized trade update payload used for persistence and reconciliation."""

    event_fingerprint: str
    source_topic: str
    source_partition: int | None
    source_offset: int | None
    alpaca_account_label: str
    feed_seq: int | None
    event_ts: datetime | None
    symbol: str | None
    alpaca_order_id: str | None
    client_order_id: str | None
    execution_correlation_id: str | None
    event_type: str | None
    status: str | None
    qty: Decimal | None
    filled_qty: Decimal | None
    position_qty: Decimal | None
    filled_qty_delta: Decimal | None
    avg_fill_price: Decimal | None
    filled_notional_delta: Decimal | None
    fill_quantity_basis: str | None
    raw_event: dict[str, Any]


@dataclass(frozen=True)
class NormalizationResult:
    """Result of normalizing a single consumed message."""

    event: NormalizedOrderEvent | None
    drop_reason: str | None
    account_label_explicit: bool = False


@dataclass(frozen=True)
class _IngestRecordOutcome:
    """Record-level durability and offset-commit decision."""

    durable: bool
    commit_allowed: bool = True


@dataclass(frozen=True)
class _ExecutionLinkageResolution:
    """Fail-closed execution lookup result for one order-feed identity."""

    execution: Execution | None
    blockers: tuple[str, ...] = ()


@dataclass(frozen=True)
class _TradeDecisionLinkageResolution:
    """Fail-closed trade-decision lookup result for one order-feed identity."""

    trade_decision: TradeDecision | None
    blockers: tuple[str, ...] = ()


@dataclass(frozen=True)
class _OrderFeedSourceIdentity:
    source_topic: str
    source_partition: int | None
    source_offset: int | None


@dataclass(frozen=True)
class _AccountAliasResolution:
    normalized: NormalizationResult
    event: NormalizedOrderEvent | None
    account_alias_payload: dict[str, str] | None


@dataclass(frozen=True)
class _IngestRecordContext:
    normalized: NormalizationResult
    event: NormalizedOrderEvent | None
    source_identity: _OrderFeedSourceIdentity
    source_window: OrderFeedSourceWindow | None
    account_alias_payload: dict[str, str] | None
    out_of_scope_account: bool


@dataclass(frozen=True)
class _ManualAssignmentHooks:
    assign: Callable[[list[Any]], Any]
    partitions_for_topic: Callable[[str], set[int] | list[int] | tuple[int, ...] | None]
    seek: Callable[[Any, int], Any]
    seek_to_beginning: Callable[..., Any] | None
    seek_to_end: Callable[..., Any] | None


def _manual_assignment_hooks(consumer: Any) -> _ManualAssignmentHooks:
    assign = cast(Callable[[list[Any]], Any] | None, getattr(consumer, "assign", None))
    partitions_for_topic = cast(
        Callable[[str], set[int] | list[int] | tuple[int, ...] | None] | None,
        getattr(consumer, "partitions_for_topic", None),
    )
    seek = cast(Callable[[Any, int], Any] | None, getattr(consumer, "seek", None))
    seek_to_beginning = cast(
        Callable[..., Any] | None, getattr(consumer, "seek_to_beginning", None)
    )
    seek_to_end = cast(
        Callable[..., Any] | None, getattr(consumer, "seek_to_end", None)
    )
    if assign is None or partitions_for_topic is None or seek is None:
        raise RuntimeError(
            "manual order-feed assignment requires KafkaConsumer assign/partition/seek support"
        )
    return _ManualAssignmentHooks(
        assign=assign,
        partitions_for_topic=partitions_for_topic,
        seek=seek,
        seek_to_beginning=seek_to_beginning,
        seek_to_end=seek_to_end,
    )


def _manual_topic_partitions(hooks: _ManualAssignmentHooks) -> list[Any]:
    try:
        TopicPartition = import_module("kafka").TopicPartition
    except Exception as exc:  # pragma: no cover - import guarded at runtime
        raise RuntimeError(
            "kafka-python dependency is required for manual order-feed assignment"
        ) from exc

    topic_partitions: list[Any] = []
    for topic in settings.trading_order_feed_topics:
        partitions = hooks.partitions_for_topic(topic)
        if partitions is None:
            logger.warning(
                "Order-feed topic metadata unavailable topic=%s; manual assignment skipped",
                topic,
            )
            continue
        for partition in sorted(partitions):
            topic_partitions.append(TopicPartition(topic, int(partition)))
    if not topic_partitions:
        raise RuntimeError("manual order-feed assignment found no topic partitions")
    return topic_partitions


def _position_manual_topic_partitions(
    session: Session,
    *,
    topic_partitions: list[Any],
    hooks: _ManualAssignmentHooks,
) -> list[Any]:
    persisted_offsets = _latest_persisted_source_offsets(session)
    unpositioned: list[Any] = []
    for topic_partition in topic_partitions:
        cursor = persisted_offsets.get(
            (topic_partition.topic, topic_partition.partition)
        )
        if cursor is None:
            unpositioned.append(topic_partition)
            continue
        hooks.seek(topic_partition, cursor + 1)
    return unpositioned


def _reset_manual_unpositioned_partitions(
    unpositioned: list[Any],
    *,
    hooks: _ManualAssignmentHooks,
) -> None:
    if not unpositioned:
        return
    if settings.trading_order_feed_auto_offset_reset == "earliest":
        if hooks.seek_to_beginning is None:
            raise RuntimeError(
                "manual order-feed earliest reset requires seek_to_beginning support"
            )
        hooks.seek_to_beginning(*unpositioned)
        return
    if hooks.seek_to_end is None:
        raise RuntimeError(
            "manual order-feed latest reset requires seek_to_end support"
        )
    hooks.seek_to_end(*unpositioned)


def _log_manual_assignment_ready(
    topic_partitions: list[Any],
    unpositioned: list[Any],
) -> None:
    logger.info(
        "Order-feed manual assignment ready topics=%s partitions=%s resumed_partitions=%s reset_partitions=%s reset=%s",
        ",".join(settings.trading_order_feed_topics),
        len(topic_partitions),
        len(topic_partitions) - len(unpositioned),
        len(unpositioned),
        settings.trading_order_feed_auto_offset_reset,
    )


def _record_source_identity(
    record: Any,
    normalized: NormalizationResult,
) -> _OrderFeedSourceIdentity:
    event = normalized.event
    return _OrderFeedSourceIdentity(
        source_topic=(
            event.source_topic
            if event is not None
            else _source_topic_from_record(
                record, default_topic=settings.trading_order_feed_topic
            )
        ),
        source_partition=(
            event.source_partition
            if event is not None
            else _coerce_int(getattr(record, "partition", None))
        ),
        source_offset=(
            event.source_offset
            if event is not None
            else _coerce_int(getattr(record, "offset", None))
        ),
    )


def _event_out_of_scope_for_default_account(
    event: NormalizedOrderEvent | None,
    *,
    normalized: NormalizationResult,
    default_account_label: str,
) -> bool:
    return (
        event is not None
        and normalized.account_label_explicit
        and event.alpaca_account_label != default_account_label
    )


def _upsert_drop_cursor(
    session: Session,
    context: _IngestRecordContext,
) -> bool:
    source_identity = context.source_identity
    return _upsert_order_feed_consumer_cursor_from_source(
        session,
        source_topic=source_identity.source_topic,
        source_partition=source_identity.source_partition,
        source_offset=source_identity.source_offset,
        event_fingerprint=None,
        event_ts=None,
        duplicate=False,
        source_window=context.source_window,
    )


def _source_topic_from_record(record: Any, *, default_topic: str) -> str:
    return _coerce_text(getattr(record, "topic", None)) or default_topic


def _create_order_feed_source_window(
    session: Session,
    *,
    source_topic: str,
    source_partition: int | None,
    source_offset: int | None,
    alpaca_account_label: str,
    broker_high_watermark: int | None = None,
) -> OrderFeedSourceWindow | None:
    if source_partition is None or source_offset is None:
        return None
    now = datetime.now(timezone.utc)
    collector_identity = settings.trading_order_feed_client_id.strip() or None
    source_window = OrderFeedSourceWindow(
        consumer_group=_order_feed_cursor_consumer_group(),
        source_topic=source_topic,
        source_partition=source_partition,
        alpaca_account_label=alpaca_account_label,
        assignment_mode=settings.trading_order_feed_assignment_mode,
        collector_identity=collector_identity,
        source_revision=ORDER_FEED_SOURCE_REVISION,
        window_started_at=now,
        window_ended_at=now,
        start_offset=source_offset,
        end_offset=source_offset,
        broker_high_watermark=broker_high_watermark,
        consumed_count=1,
        inserted_count=0,
        duplicate_count=0,
        malformed_count=0,
        missing_payload_count=0,
        missing_identity_count=0,
        out_of_scope_account_count=0,
        unlinked_execution_count=0,
        unlinked_decision_count=0,
        failed_unhandled_count=0,
        dropped_count=0,
        gap_count=0,
        gap_ranges=None,
        first_event_ts=None,
        last_event_ts=None,
        status="classified",
        status_reason=None,
        payload_json=None,
    )
    session.add(source_window)
    session.flush()
    return source_window


def _broker_high_watermark_from_record(record: Any) -> int | None:
    """Return a broker high watermark carried by Kafka-like records when present.

    ``kafka-python`` ``ConsumerRecord`` values do not expose partition end offsets,
    but test harnesses and collector wrappers can attach one. Treat this as optional
    source telemetry: it enriches the window ledger without affecting cursor
    authority or offset-commit decisions.
    """

    for attribute in (
        "broker_high_watermark",
        "high_watermark",
        "highwater",
        "log_end_offset",
    ):
        value = _coerce_int(getattr(record, attribute, None))
        if value is not None:
            return value
    return None


# Public aliases used by split-module consumers.
classify_source_window_drop = _classify_source_window_drop
classify_source_window_event = _classify_source_window_event
classify_source_window_unhandled_failure = _classify_source_window_unhandled_failure
commit_consumer = _commit_consumer
consumer_commit_enabled = _consumer_commit_enabled
event_with_default_account_label_if_in_scope = (
    _event_with_default_account_label_if_in_scope
)
flatten_poll_records = _flatten_poll_records
increment_drop_counter = _increment_drop_counter
kafka_consumer_group_id = _kafka_consumer_group_id
order_event_has_failed_unhandled_source_window = (
    _order_event_has_failed_unhandled_source_window
)
retry_failed_duplicate_order_event_application = (
    _retry_failed_duplicate_order_event_application
)
upsert_cursor_and_count = _upsert_cursor_and_count
AccountAliasResolution = _AccountAliasResolution
ExecutionLinkageResolution = _ExecutionLinkageResolution
FILL_EVENT_TYPES = _FILL_EVENT_TYPES
IngestRecordContext = _IngestRecordContext
IngestRecordOutcome = _IngestRecordOutcome
ManualAssignmentHooks = _ManualAssignmentHooks
OrderFeedSourceIdentity = _OrderFeedSourceIdentity
TradeDecisionLinkageResolution = _TradeDecisionLinkageResolution
as_mapping = _as_mapping
broker_high_watermark_from_record = _broker_high_watermark_from_record
coerce_datetime = _coerce_datetime
coerce_decimal = _coerce_decimal
coerce_int = _coerce_int
coerce_text = _coerce_text
create_order_feed_source_window = _create_order_feed_source_window
decode_json_payload = _decode_json_payload
event_out_of_scope_for_default_account = _event_out_of_scope_for_default_account
extract_trade_update_payload = _extract_trade_update_payload
isoformat_datetime = _isoformat_datetime
log_manual_assignment_ready = _log_manual_assignment_ready
manual_assignment_hooks = _manual_assignment_hooks
manual_topic_partitions = _manual_topic_partitions
order_feed_cursor_consumer_group = _order_feed_cursor_consumer_group
position_manual_topic_partitions = _position_manual_topic_partitions
record_source_identity = _record_source_identity
reset_manual_unpositioned_partitions = _reset_manual_unpositioned_partitions
source_topic_from_record = _source_topic_from_record
update_trade_decision_from_execution = _update_trade_decision_from_execution
upsert_drop_cursor = _upsert_drop_cursor


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "AccountAliasResolution",
    "Any",
    "Callable",
    "ColumnElement",
    "Decimal",
    "EXECUTION_RAW_ORDER_SOURCE_PARTITION",
    "EXECUTION_RAW_ORDER_SOURCE_TOPIC",
    "EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION",
    "Execution",
    "ExecutionLinkageResolution",
    "ExecutionOrderEvent",
    "FILL_EVENT_TYPES",
    "FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING",
    "FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA",
    "FILL_QUANTITY_BASIS_DELTA",
    "HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION",
    "IngestRecordContext",
    "IngestRecordOutcome",
    "IntegrityError",
    "ManualAssignmentHooks",
    "Mapping",
    "NormalizationResult",
    "NormalizedOrderEvent",
    "ORDER_FEED_SOURCE_REVISION",
    "OrderFeedConsumerCursor",
    "OrderFeedSourceIdentity",
    "OrderFeedSourceWindow",
    "Session",
    "TigerBeetleLedgerJournal",
    "TradeDecision",
    "TradeDecisionLinkageResolution",
    "_AccountAliasResolution",
    "_ExecutionLinkageResolution",
    "_FILL_EVENT_TYPES",
    "_IngestRecordContext",
    "_IngestRecordOutcome",
    "_ManualAssignmentHooks",
    "_OrderFeedSourceIdentity",
    "_TradeDecisionLinkageResolution",
    "_as_mapping",
    "_broker_high_watermark_from_record",
    "_classify_source_window_drop",
    "_classify_source_window_event",
    "_classify_source_window_unhandled_failure",
    "_coerce_datetime",
    "_coerce_decimal",
    "_coerce_int",
    "_coerce_text",
    "_commit_consumer",
    "_consumer_commit_enabled",
    "_create_order_feed_source_window",
    "_decode_json_payload",
    "_decode_json_text_payload",
    "_ensure_aware_utc",
    "_event_out_of_scope_for_default_account",
    "_event_with_default_account_label_if_in_scope",
    "_extract_trade_update_payload",
    "_flatten_poll_records",
    "_increment_drop_counter",
    "_isoformat_datetime",
    "_kafka_consumer_group_id",
    "_latest_persisted_source_offsets",
    "_log_manual_assignment_ready",
    "_manual_assignment_hooks",
    "_manual_topic_partitions",
    "_normalize_decoded_payload",
    "_order_event_has_failed_unhandled_source_window",
    "_order_feed_cursor_consumer_group",
    "_position_manual_topic_partitions",
    "_record_source_identity",
    "_reset_manual_unpositioned_partitions",
    "_retry_failed_duplicate_order_event_application",
    "_source_topic_from_record",
    "_update_trade_decision_from_execution",
    "_upsert_cursor_and_count",
    "_upsert_drop_cursor",
    "_upsert_order_feed_consumer_cursor_from_source",
    "annotations",
    "apply_order_event_to_execution",
    "as_mapping",
    "broker_high_watermark_from_record",
    "cast",
    "classify_source_window_drop",
    "classify_source_window_event",
    "classify_source_window_unhandled_failure",
    "coerce_datetime",
    "coerce_decimal",
    "coerce_int",
    "coerce_json_payload",
    "coerce_text",
    "commit_consumer",
    "consumer_commit_enabled",
    "create_order_feed_source_window",
    "dataclass",
    "datetime",
    "decode_json_payload",
    "event_out_of_scope_for_default_account",
    "event_with_default_account_label_if_in_scope",
    "exists",
    "extract_trade_update_payload",
    "flatten_poll_records",
    "func",
    "hashlib",
    "increment_drop_counter",
    "isoformat_datetime",
    "json",
    "kafka_consumer_group_id",
    "log_manual_assignment_ready",
    "logger",
    "logging",
    "manual_assignment_hooks",
    "manual_topic_partitions",
    "normalize_order_feed_record",
    "or_",
    "order_event_has_failed_unhandled_source_window",
    "order_feed_cursor_consumer_group",
    "persist_order_event",
    "position_manual_topic_partitions",
    "reconcile_tigerbeetle_transfers",
    "record_source_identity",
    "replace",
    "reset_manual_unpositioned_partitions",
    "retry_failed_duplicate_order_event_application",
    "select",
    "settings",
    "source_topic_from_record",
    "timedelta",
    "timezone",
    "update_trade_decision_from_execution",
    "upsert_cursor_and_count",
    "upsert_drop_cursor",
    "upsert_execution_tca_metric",
    "uuid",
)

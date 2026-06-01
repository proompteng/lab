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

from ..config import settings
from ..models import (
    Execution,
    ExecutionOrderEvent,
    OrderFeedConsumerCursor,
    OrderFeedSourceWindow,
    TradeDecision,
    coerce_json_payload,
)
from .tca import upsert_execution_tca_metric
from .tigerbeetle_journal import TigerBeetleLedgerJournal
from .tigerbeetle_reconcile import reconcile_tigerbeetle_transfers

logger = logging.getLogger(__name__)

ORDER_FEED_SOURCE_REVISION = "alpaca_trade_updates_v1"
HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION = (
    "execution_order_events_existing_source_offsets_v1"
)
FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA = "cumulative_to_delta"
FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING = "cumulative_non_increasing"
_FILL_EVENT_TYPES = frozenset({"fill", "filled", "partial_fill", "partially_filled"})
EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION = "execution_raw_order_snapshot_backfill_v1"
EXECUTION_RAW_ORDER_SOURCE_TOPIC = "torghut.execution-raw-order.backfill.v1"
EXECUTION_RAW_ORDER_SOURCE_PARTITION = 0


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
    event_type: str | None
    status: str | None
    qty: Decimal | None
    filled_qty: Decimal | None
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


class OrderFeedIngestor:
    """Consumes order updates from Kafka and persists normalized event rows."""

    def __init__(
        self,
        *,
        consumer_factory: Callable[[], Any] | None = None,
        default_account_label: str | None = None,
    ) -> None:
        self._consumer_factory = consumer_factory or self._build_consumer
        provided_label = (
            default_account_label.strip() if default_account_label is not None else ""
        )
        self._default_account_label = provided_label or settings.trading_account_label
        self._consumer: Any | None = None
        self._disabled_logged = False
        self._manual_assignment_ready = False

    def ingest_once(self, session: Session) -> dict[str, int]:
        counters = self._new_counters()
        if not self._preconditions_met():
            return counters

        consumer = self._ensure_consumer(session)
        if consumer is None:
            counters["consumer_errors_total"] += 1
            return counters

        records = self._poll_records(consumer=consumer, counters=counters)
        if not records:
            return counters

        durable_any = False
        commit_allowed = True
        for record in records:
            outcome = self._ingest_record(
                session=session,
                record=record,
                counters=counters,
            )
            durable_any = outcome.durable or durable_any
            commit_allowed = commit_allowed and outcome.commit_allowed
            if not outcome.commit_allowed:
                break

        if durable_any:
            self._reconcile_tigerbeetle_if_enabled(session)
            session.commit()
        if durable_any and commit_allowed:
            if _consumer_commit_enabled():
                if _commit_consumer(consumer):
                    counters["consumer_commits_total"] += 1
            else:
                counters["consumer_commit_skipped_total"] += 1
                logger.info(
                    "Order-feed Kafka commit skipped: assignment_mode=%s db_cursor_authority=true",
                    settings.trading_order_feed_assignment_mode,
                )
        return counters

    def _reconcile_tigerbeetle_if_enabled(self, session: Session) -> None:
        if not settings.tigerbeetle_enabled or not settings.tigerbeetle_journal_enabled:
            return
        try:
            reconcile_tigerbeetle_transfers(session)
        except Exception as exc:
            if settings.tigerbeetle_reconcile_required:
                raise
            logger.warning(
                "TigerBeetle reconciliation failed after order-feed ingest: %s", exc
            )

    @staticmethod
    def _new_counters() -> dict[str, int]:
        return {
            "messages_total": 0,
            "events_persisted_total": 0,
            "duplicates_total": 0,
            "out_of_order_total": 0,
            "missing_fields_total": 0,
            "classified_drops_total": 0,
            "source_windows_total": 0,
            "malformed_total": 0,
            "missing_payload_total": 0,
            "missing_identity_total": 0,
            "out_of_scope_account_total": 0,
            "unlinked_execution_total": 0,
            "unlinked_decision_total": 0,
            "failed_unhandled_total": 0,
            "apply_updates_total": 0,
            "consumer_errors_total": 0,
            "consumer_commits_total": 0,
            "consumer_commit_skipped_total": 0,
            "cursor_updates_total": 0,
        }

    def _preconditions_met(self) -> bool:
        if not settings.trading_order_feed_enabled:
            return False
        if settings.trading_order_feed_bootstrap_server_list:
            return True
        if not self._disabled_logged:
            logger.info(
                "Order-feed ingestion enabled but TRADING_ORDER_FEED_BOOTSTRAP_SERVERS is not set; skipping"
            )
            self._disabled_logged = True
        return False

    def _poll_records(self, *, consumer: Any, counters: dict[str, int]) -> list[Any]:
        try:
            polled = consumer.poll(
                timeout_ms=settings.trading_order_feed_poll_ms,
                max_records=settings.trading_order_feed_batch_size,
            )
        except Exception as exc:  # pragma: no cover - external Kafka failure
            counters["consumer_errors_total"] += 1
            logger.warning("Order-feed poll failed: %s", exc)
            return []
        return _flatten_poll_records(polled)

    def _ingest_record(
        self,
        *,
        session: Session,
        record: Any,
        counters: dict[str, int],
    ) -> _IngestRecordOutcome:
        counters["messages_total"] += 1
        normalized = normalize_order_feed_record(
            record,
            default_topic=settings.trading_order_feed_topic,
            default_account_label=self._default_account_label,
        )
        source_topic = (
            normalized.event.source_topic
            if normalized.event is not None
            else _source_topic_from_record(
                record, default_topic=settings.trading_order_feed_topic
            )
        )
        source_partition = (
            normalized.event.source_partition
            if normalized.event is not None
            else _coerce_int(getattr(record, "partition", None))
        )
        source_offset = (
            normalized.event.source_offset
            if normalized.event is not None
            else _coerce_int(getattr(record, "offset", None))
        )
        event = normalized.event
        account_alias_payload: dict[str, str] | None = None
        if (
            event is not None
            and normalized.account_label_explicit
            and event.alpaca_account_label != self._default_account_label
        ):
            aliased_event = _event_with_default_account_label_if_in_scope(
                session,
                event,
                default_account_label=self._default_account_label,
            )
            if aliased_event is not None:
                account_alias_payload = {
                    "source_account_label": event.alpaca_account_label,
                    "canonical_account_label": self._default_account_label,
                    "basis": "matched_order_identity",
                }
                event = aliased_event
                normalized = NormalizationResult(
                    event=event,
                    drop_reason=None,
                    account_label_explicit=normalized.account_label_explicit,
                )
        out_of_scope_account = (
            event is not None
            and normalized.account_label_explicit
            and event.alpaca_account_label != self._default_account_label
        )
        source_window = _create_order_feed_source_window(
            session,
            source_topic=source_topic,
            source_partition=source_partition,
            source_offset=source_offset,
            broker_high_watermark=_broker_high_watermark_from_record(record),
            alpaca_account_label=(
                self._default_account_label
                if out_of_scope_account
                else event.alpaca_account_label
                if event is not None
                else self._default_account_label
            ),
        )
        if source_window is not None:
            counters["source_windows_total"] += 1
            if account_alias_payload is not None:
                source_window.payload_json = {
                    "account_label_alias": account_alias_payload,
                }

        try:
            if out_of_scope_account:
                counters["missing_fields_total"] += 1
                if source_window is None:
                    return _IngestRecordOutcome(durable=False)
                _classify_source_window_drop(
                    source_window,
                    "out_of_scope_account",
                    record=record,
                    default_account_label=self._default_account_label,
                )
                _increment_drop_counter(counters, "out_of_scope_account")
                cursor_updated = _upsert_order_feed_consumer_cursor_from_source(
                    session,
                    source_topic=source_topic,
                    source_partition=source_partition,
                    source_offset=source_offset,
                    event_fingerprint=None,
                    event_ts=None,
                    duplicate=False,
                    source_window=source_window,
                )
                if cursor_updated:
                    counters["cursor_updates_total"] += 1
                counters["classified_drops_total"] += 1
                return _IngestRecordOutcome(durable=True)

            if normalized.event is None:
                counters["missing_fields_total"] += 1
                if normalized.drop_reason:
                    logger.debug(
                        "Dropped order-feed message reason=%s", normalized.drop_reason
                    )
                if source_window is None:
                    return _IngestRecordOutcome(durable=False)
                _classify_source_window_drop(
                    source_window,
                    normalized.drop_reason,
                    record=record,
                    default_account_label=self._default_account_label,
                )
                _increment_drop_counter(counters, normalized.drop_reason)
                cursor_updated = _upsert_order_feed_consumer_cursor_from_source(
                    session,
                    source_topic=source_topic,
                    source_partition=source_partition,
                    source_offset=source_offset,
                    event_fingerprint=None,
                    event_ts=None,
                    duplicate=False,
                    source_window=source_window,
                )
                if cursor_updated:
                    counters["cursor_updates_total"] += 1
                counters["classified_drops_total"] += 1
                return _IngestRecordOutcome(durable=True)

            event = normalized.event
            persisted, duplicate = persist_order_event(
                session,
                event,
                source_window_id=(
                    source_window.id if source_window is not None else None
                ),
            )
            if source_window is not None:
                _classify_source_window_event(
                    source_window,
                    persisted=persisted,
                    duplicate=duplicate,
                    account_label_alias=account_alias_payload,
                )
            if duplicate:
                if _order_event_has_failed_unhandled_source_window(session, persisted):
                    _retry_failed_duplicate_order_event_application(
                        session=session,
                        event=persisted,
                        counters=counters,
                        source_window=source_window,
                    )
                cursor_updated = _upsert_cursor_and_count(
                    session=session,
                    event=event,
                    duplicate=True,
                    source_window=source_window,
                    counters=counters,
                )
                counters["duplicates_total"] += 1
                return _IngestRecordOutcome(durable=cursor_updated)
            counters["events_persisted_total"] += 1
            if persisted.execution_id is None:
                counters["unlinked_execution_total"] += 1
            if persisted.trade_decision_id is None:
                counters["unlinked_decision_total"] += 1

            if persisted.execution_id is None:
                _upsert_cursor_and_count(
                    session=session,
                    event=event,
                    duplicate=False,
                    source_window=source_window,
                    counters=counters,
                )
                return _IngestRecordOutcome(durable=True)
            execution = session.get(Execution, persisted.execution_id)
            if execution is None:
                _upsert_cursor_and_count(
                    session=session,
                    event=event,
                    duplicate=False,
                    source_window=source_window,
                    counters=counters,
                )
                return _IngestRecordOutcome(durable=True)

            updated, out_of_order = apply_order_event_to_execution(execution, persisted)
            if out_of_order:
                counters["out_of_order_total"] += 1
            if not updated:
                _upsert_cursor_and_count(
                    session=session,
                    event=event,
                    duplicate=False,
                    source_window=source_window,
                    counters=counters,
                )
                return _IngestRecordOutcome(durable=True)

            counters["apply_updates_total"] += 1
            if execution.trade_decision_id is not None:
                _update_trade_decision_from_execution(session, execution)
            upsert_execution_tca_metric(session, execution)
            session.add(execution)
            _upsert_cursor_and_count(
                session=session,
                event=event,
                duplicate=False,
                source_window=source_window,
                counters=counters,
            )
            return _IngestRecordOutcome(durable=True)
        except Exception as exc:
            counters["consumer_errors_total"] += 1
            counters["failed_unhandled_total"] += 1
            if source_window is None:
                logger.warning(
                    "Order-feed record failed before durable source-window classification: %s",
                    exc,
                )
                return _IngestRecordOutcome(durable=False, commit_allowed=False)
            _classify_source_window_unhandled_failure(source_window, exc)
            logger.warning(
                "Order-feed record failed after source-window classification; Kafka offset will not be committed: %s",
                exc,
            )
            return _IngestRecordOutcome(durable=True, commit_allowed=False)

    def close(self) -> None:
        if self._consumer is None:
            return
        run_close = cast(
            Callable[[], Any] | None, getattr(self._consumer, "close", None)
        )
        self._consumer = None
        self._manual_assignment_ready = False
        if run_close is None:
            return
        try:
            run_close()
        except Exception:  # pragma: no cover - defensive close
            logger.debug("Order-feed consumer close failed", exc_info=True)

    def _ensure_consumer(self, session: Session) -> Any | None:
        if self._consumer is not None:
            if self._manual_assignment_required() and not self._manual_assignment_ready:
                self._assign_manual_partitions(session)
            return self._consumer
        try:
            self._consumer = self._consumer_factory()
            self._disabled_logged = False
            if self._manual_assignment_required():
                self._assign_manual_partitions(session)
            return self._consumer
        except Exception as exc:  # pragma: no cover - external Kafka config failure
            logger.warning("Failed to initialize order-feed consumer: %s", exc)
            self._consumer = None
            self._manual_assignment_ready = False
            return None

    def _manual_assignment_required(self) -> bool:
        return settings.trading_order_feed_assignment_mode == "manual"

    def _assign_manual_partitions(self, session: Session) -> None:
        consumer = self._consumer
        if consumer is None:
            return
        assign = cast(
            Callable[[list[Any]], Any] | None, getattr(consumer, "assign", None)
        )
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

        try:
            from kafka import TopicPartition  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - import guarded at runtime
            raise RuntimeError(
                "kafka-python dependency is required for manual order-feed assignment"
            ) from exc

        topic_partitions: list[Any] = []
        for topic in settings.trading_order_feed_topics:
            partitions = partitions_for_topic(topic)
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

        assign(topic_partitions)
        persisted_offsets = _latest_persisted_source_offsets(session)
        unpositioned: list[Any] = []
        for topic_partition in topic_partitions:
            cursor = persisted_offsets.get(
                (topic_partition.topic, topic_partition.partition)
            )
            if cursor is None:
                unpositioned.append(topic_partition)
                continue
            seek(topic_partition, cursor + 1)

        if unpositioned:
            if settings.trading_order_feed_auto_offset_reset == "earliest":
                if seek_to_beginning is None:
                    raise RuntimeError(
                        "manual order-feed earliest reset requires seek_to_beginning support"
                    )
                seek_to_beginning(*unpositioned)
            else:
                if seek_to_end is None:
                    raise RuntimeError(
                        "manual order-feed latest reset requires seek_to_end support"
                    )
                seek_to_end(*unpositioned)

        self._manual_assignment_ready = True
        logger.info(
            "Order-feed manual assignment ready topics=%s partitions=%s resumed_partitions=%s reset_partitions=%s reset=%s",
            ",".join(settings.trading_order_feed_topics),
            len(topic_partitions),
            len(topic_partitions) - len(unpositioned),
            len(unpositioned),
            settings.trading_order_feed_auto_offset_reset,
        )

    @staticmethod
    def _build_consumer() -> Any:
        try:
            from kafka import KafkaConsumer  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - import guarded at runtime
            raise RuntimeError(
                "kafka-python dependency is required for order-feed ingestion"
            ) from exc

        manual_assignment = settings.trading_order_feed_assignment_mode == "manual"
        topics = [] if manual_assignment else settings.trading_order_feed_topics
        group_id = None if manual_assignment else _kafka_consumer_group_id()
        return cast(
            Any,
            KafkaConsumer(
                *topics,
                bootstrap_servers=settings.trading_order_feed_bootstrap_server_list,
                group_id=group_id,
                client_id=settings.trading_order_feed_client_id,
                enable_auto_commit=False,
                auto_offset_reset=settings.trading_order_feed_auto_offset_reset,
                consumer_timeout_ms=max(settings.trading_order_feed_poll_ms, 1000),
                value_deserializer=None,
                key_deserializer=None,
                **settings.trading_order_feed_kafka_security_kwargs,
            ),
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


def _classify_source_window_drop(
    source_window: OrderFeedSourceWindow,
    drop_reason: str | None,
    *,
    record: Any | None = None,
    default_account_label: str | None = None,
) -> None:
    source_window.status = "dropped"
    source_window.status_reason = drop_reason or "unknown_drop"
    source_window.dropped_count = 1
    source_window.payload_json = {
        "classification": drop_reason or "unknown_drop",
        "classification_counts": {drop_reason or "unknown_drop": 1},
        "source_coverage_complete": False,
        "promotion_authority_eligible": False,
        "authority_class": "invalid_order_feed_message",
        **_source_window_source_identity_payload(source_window),
        **_raw_record_source_evidence_payload(
            record,
            source_window=source_window,
            default_account_label=default_account_label,
        ),
    }
    if drop_reason == "malformed_json":
        source_window.malformed_count = 1
    elif drop_reason == "missing_trade_update_payload":
        source_window.missing_payload_count = 1
    elif drop_reason == "missing_order_identity":
        source_window.missing_identity_count = 1
    elif drop_reason == "out_of_scope_account":
        source_window.out_of_scope_account_count = 1


def _classify_source_window_unhandled_failure(
    source_window: OrderFeedSourceWindow, exc: Exception
) -> None:
    source_window.status = "failed_unhandled"
    source_window.status_reason = _source_window_failure_reason(exc)
    source_window.failed_unhandled_count = 1
    source_window.payload_json = {
        "classification": "failed_unhandled",
        "classification_counts": {"failed_unhandled": 1},
        "source_coverage_complete": False,
        "promotion_authority_eligible": False,
        "authority_class": "failed_unhandled_order_feed_message",
        **_source_window_source_identity_payload(source_window),
    }


def _source_window_failure_reason(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}".strip()
    return text[:128] or type(exc).__name__[:128]


def _increment_drop_counter(counters: dict[str, int], drop_reason: str | None) -> None:
    if drop_reason == "malformed_json":
        counters["malformed_total"] += 1
    elif drop_reason == "missing_trade_update_payload":
        counters["missing_payload_total"] += 1
    elif drop_reason == "missing_order_identity":
        counters["missing_identity_total"] += 1
    elif drop_reason == "out_of_scope_account":
        counters["out_of_scope_account_total"] += 1


def _classify_source_window_event(
    source_window: OrderFeedSourceWindow,
    *,
    persisted: ExecutionOrderEvent,
    duplicate: bool,
    account_label_alias: dict[str, str] | None = None,
) -> None:
    source_window.first_event_ts = persisted.event_ts
    source_window.last_event_ts = persisted.event_ts
    if duplicate:
        source_window.status = "duplicate"
        source_window.status_reason = "duplicate_event_fingerprint"
        source_window.duplicate_count = 1
        payload: dict[str, Any] = {
            "classification": "duplicate",
            "classification_counts": {"duplicate": 1},
            **_source_window_source_identity_payload(source_window),
            **_order_event_evidence_payload(persisted),
            "source_coverage_complete": False,
            "promotion_authority_eligible": False,
            "authority_class": "duplicate_order_feed_message",
        }
        if account_label_alias is not None:
            payload["account_label_alias"] = account_label_alias
        source_window.payload_json = payload
        return
    source_window.status = "inserted"
    source_window.status_reason = _source_window_event_status_reason(persisted)
    source_window.inserted_count = 1
    classification_counts = {"inserted": 1}
    if persisted.execution_id is None:
        source_window.unlinked_execution_count = 1
        classification_counts["unlinked_execution"] = 1
    if persisted.trade_decision_id is None:
        source_window.unlinked_decision_count = 1
        classification_counts["unlinked_decision"] = 1
    payload = {
        "classification": "inserted",
        "classification_counts": classification_counts,
        **_source_window_source_identity_payload(source_window),
        **_order_event_evidence_payload(persisted),
    }
    if account_label_alias is not None:
        payload["account_label_alias"] = account_label_alias
    source_window.payload_json = payload


def _source_window_source_identity_payload(
    source_window: OrderFeedSourceWindow,
) -> dict[str, Any]:
    return _source_window_source_identity_payload_for_values(
        source_topic=source_window.source_topic,
        source_partition=source_window.source_partition,
        start_offset=source_window.start_offset,
        end_offset=source_window.end_offset,
        alpaca_account_label=source_window.alpaca_account_label,
        source_revision=source_window.source_revision,
    )


def _source_window_source_identity_payload_for_values(
    *,
    source_topic: str,
    source_partition: int | None,
    start_offset: int | None,
    end_offset: int | None,
    alpaca_account_label: str,
    source_revision: str | None,
) -> dict[str, Any]:
    return {
        "source_ref": {
            "topic": source_topic,
            "partition": source_partition,
            "offset": start_offset,
        },
        "source_offsets": {
            "topic": source_topic,
            "partition": source_partition,
            "start_offset": start_offset,
            "end_offset": end_offset,
        },
        "alpaca_account_label": alpaca_account_label,
        "source_revision": source_revision,
    }


def _raw_record_source_evidence_payload(
    record: Any | None,
    *,
    source_window: OrderFeedSourceWindow,
    default_account_label: str | None,
) -> dict[str, Any]:
    if record is None:
        return {}

    decoded_payload = _decode_json_payload(getattr(record, "value", None))
    if decoded_payload is None:
        return {}

    envelope = _as_mapping(decoded_payload)
    data_payload = _extract_trade_update_payload(decoded_payload)
    order = _as_mapping(data_payload.get("order")) if data_payload is not None else None
    explicit_account_label = (
        _coerce_text(data_payload.get("account_label")) if data_payload else None
    ) or (_coerce_text(data_payload.get("accountLabel")) if data_payload else None)
    if order is not None:
        explicit_account_label = (
            explicit_account_label
            or _coerce_text(order.get("alpaca_account_label"))
            or _coerce_text(order.get("account_label"))
            or _coerce_text(order.get("accountLabel"))
        )
    if envelope is not None:
        explicit_account_label = (
            explicit_account_label
            or _coerce_text(envelope.get("account_label"))
            or _coerce_text(envelope.get("accountLabel"))
        )
    account_label = (
        explicit_account_label
        or default_account_label
        or source_window.alpaca_account_label
    )
    order_identity = _order_identity_payload(
        alpaca_order_id=(_coerce_text(order.get("id")) if order is not None else None)
        or (_coerce_text(order.get("order_id")) if order is not None else None),
        client_order_id=(
            _coerce_text(order.get("client_order_id")) if order is not None else None
        ),
    )
    lifecycle = _lifecycle_payload(
        event_type=(
            _coerce_text(data_payload.get("event"))
            if data_payload is not None
            else None
        )
        or (
            _coerce_text(data_payload.get("event_type"))
            if data_payload is not None
            else None
        ),
        status=(_coerce_text(order.get("status")) if order is not None else None)
        or (
            _coerce_text(data_payload.get("status"))
            if data_payload is not None
            else None
        ),
        event_ts=_coerce_datetime(
            (
                data_payload.get("timestamp")
                or data_payload.get("t")
                or (order or {}).get("updated_at")
                or (order or {}).get("submitted_at")
                or (envelope.get("event_ts") if envelope else None)
            )
            if data_payload is not None
            else None
        ),
        feed_seq=_coerce_int(
            ((envelope.get("seq") if envelope else None) if envelope else None)
            or (data_payload.get("seq") if data_payload is not None else None)
        ),
    )
    payload: dict[str, Any] = {
        "alpaca_account_label": account_label,
        "order_identity": order_identity,
        "lifecycle": lifecycle,
    }
    if explicit_account_label is not None:
        payload["source_account_label"] = explicit_account_label
    return payload


def _order_event_evidence_payload(event: ExecutionOrderEvent) -> dict[str, Any]:
    linked_refs = {
        "execution_order_event_id": str(event.id),
        "execution_id": str(event.execution_id)
        if event.execution_id is not None
        else None,
        "trade_decision_id": (
            str(event.trade_decision_id)
            if event.trade_decision_id is not None
            else None
        ),
    }
    source_coverage_complete = (
        event.execution_id is not None
        and event.trade_decision_id is not None
        and event.source_partition is not None
        and event.source_offset is not None
    )
    return {
        "event_source_ref": {
            "topic": event.source_topic,
            "partition": event.source_partition,
            "offset": event.source_offset,
        },
        "order_identity": _order_identity_payload(
            alpaca_order_id=event.alpaca_order_id,
            client_order_id=event.client_order_id,
        ),
        "execution_order_event_id": linked_refs["execution_order_event_id"],
        "execution_id": linked_refs["execution_id"],
        "trade_decision_id": linked_refs["trade_decision_id"],
        "linked_refs": linked_refs,
        "lifecycle": _lifecycle_payload(
            event_type=event.event_type,
            status=event.status,
            event_ts=event.event_ts,
            feed_seq=event.feed_seq,
        ),
        "source_materialization": "execution_order_events",
        "authority_class": (
            "runtime_order_feed_execution_source"
            if source_coverage_complete
            else "order_feed_lifecycle_unlinked"
        ),
        "source_coverage_complete": source_coverage_complete,
        "promotion_authority_eligible": source_coverage_complete,
    }


def _order_identity_payload(
    *,
    alpaca_order_id: str | None,
    client_order_id: str | None,
) -> dict[str, str | None]:
    return {
        "alpaca_order_id": alpaca_order_id,
        "client_order_id": client_order_id,
    }


def _lifecycle_payload(
    *,
    event_type: str | None,
    status: str | None,
    event_ts: datetime | None,
    feed_seq: int | None,
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "status": status,
        "event_ts": _isoformat_datetime(event_ts),
        "feed_seq": feed_seq,
    }


def _source_window_event_status_reason(event: ExecutionOrderEvent) -> str:
    if event.execution_id is not None and event.trade_decision_id is not None:
        return "linked_execution_and_decision"
    if event.execution_id is None and event.trade_decision_id is None:
        return "missing_execution_and_decision_links"
    if event.execution_id is None:
        return "missing_execution_link"
    return "missing_trade_decision_link"


def normalize_order_feed_record(
    record: Any, *, default_topic: str, default_account_label: str
) -> NormalizationResult:
    """Normalize a Kafka record (or Kafka-like test object) into a canonical event."""

    value = getattr(record, "value", None)
    payload = _decode_json_payload(value)
    if payload is None:
        return NormalizationResult(event=None, drop_reason="malformed_json")

    envelope = _as_mapping(payload)
    data_payload = _extract_trade_update_payload(payload)
    if data_payload is None:
        return NormalizationResult(
            event=None, drop_reason="missing_trade_update_payload"
        )

    order = _as_mapping(data_payload.get("order"))
    symbol = _coerce_text((order or {}).get("symbol"))
    if symbol is None and envelope is not None:
        symbol = _coerce_text(envelope.get("symbol"))

    alpaca_order_id = _coerce_text((order or {}).get("id"))
    client_order_id = _coerce_text((order or {}).get("client_order_id"))
    if alpaca_order_id is None:
        alpaca_order_id = _coerce_text((order or {}).get("order_id"))

    event_type = _coerce_text(data_payload.get("event")) or _coerce_text(
        data_payload.get("event_type")
    )
    status = _coerce_text((order or {}).get("status")) or _coerce_text(
        data_payload.get("status")
    )
    event_ts = _coerce_datetime(
        data_payload.get("timestamp")
        or data_payload.get("t")
        or (order or {}).get("updated_at")
        or (order or {}).get("submitted_at")
        or (envelope.get("event_ts") if envelope else None)
    )
    feed_seq = _coerce_int(
        (envelope.get("seq") if envelope else None) or data_payload.get("seq")
    )

    if alpaca_order_id is None and client_order_id is None:
        return NormalizationResult(event=None, drop_reason="missing_order_identity")

    qty = _coerce_decimal((order or {}).get("qty"))
    filled_qty = _coerce_decimal((order or {}).get("filled_qty"))
    avg_fill_price = _coerce_decimal(
        (order or {}).get("filled_avg_price") or (order or {}).get("avg_fill_price")
    )

    source_topic = _coerce_text(getattr(record, "topic", None)) or _coerce_text(
        envelope.get("topic") if envelope else None
    )
    if source_topic is None:
        source_topic = default_topic
    explicit_account_label = (
        _coerce_text(data_payload.get("account_label"))
        or _coerce_text(data_payload.get("accountLabel"))
        or _coerce_text((order or {}).get("alpaca_account_label"))
        or _coerce_text((order or {}).get("account_label"))
        or _coerce_text((order or {}).get("accountLabel"))
        or _coerce_text(envelope.get("account_label") if envelope else None)
        or _coerce_text(envelope.get("accountLabel") if envelope else None)
    )
    account_label = explicit_account_label or default_account_label

    fingerprint_input = {
        "alpaca_account_label": account_label,
        "alpaca_order_id": alpaca_order_id,
        "client_order_id": client_order_id,
        "event_type": event_type,
        "status": status,
        "event_ts": event_ts.isoformat() if event_ts else None,
        "feed_seq": feed_seq,
        "qty": str(qty) if qty is not None else None,
        "filled_qty": str(filled_qty) if filled_qty is not None else None,
        "avg_fill_price": str(avg_fill_price) if avg_fill_price is not None else None,
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_input, sort_keys=True).encode("utf-8")
    ).hexdigest()

    event = NormalizedOrderEvent(
        event_fingerprint=fingerprint,
        source_topic=source_topic,
        source_partition=_coerce_int(getattr(record, "partition", None)),
        source_offset=_coerce_int(getattr(record, "offset", None)),
        alpaca_account_label=account_label,
        feed_seq=feed_seq,
        event_ts=event_ts,
        symbol=symbol,
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
        event_type=event_type,
        status=status,
        qty=qty,
        filled_qty=filled_qty,
        filled_qty_delta=None,
        avg_fill_price=avg_fill_price,
        filled_notional_delta=None,
        fill_quantity_basis=None,
        raw_event=coerce_json_payload(payload),
    )
    return NormalizationResult(
        event=event,
        drop_reason=None,
        account_label_explicit=explicit_account_label is not None,
    )


def _event_with_default_account_label_if_in_scope(
    session: Session,
    event: NormalizedOrderEvent,
    *,
    default_account_label: str,
) -> NormalizedOrderEvent | None:
    """Canonicalize broker-account labels only when local order identity proves scope.

    Some paper broker streams identify the account by broker account id while
    Torghut's runtime proof labels the same lane as ``TORGHUT_SIM``. Treat the
    broker id as an alias only when a submitted local execution or decision with
    the same order identity already exists under the default account label. This
    keeps true cross-account events fail-closed as out-of-scope.
    """

    if not default_account_label or event.alpaca_account_label == default_account_label:
        return event
    if not _order_identity_matches_account_scope(
        session,
        event,
        account_label=default_account_label,
    ):
        return None

    raw_event = coerce_json_payload(event.raw_event)
    if isinstance(raw_event, Mapping):
        aliased_raw_event: dict[str, Any] = {
            str(key): value
            for key, value in cast(Mapping[object, Any], raw_event).items()
        }
    else:
        aliased_raw_event = {"payload": raw_event}
    aliased_raw_event["_torghut_account_label_alias"] = {
        "source_account_label": event.alpaca_account_label,
        "canonical_account_label": default_account_label,
        "basis": "matched_order_identity",
    }
    return replace(
        event,
        event_fingerprint=_fingerprint_normalized_order_event(
            event,
            account_label=default_account_label,
        ),
        alpaca_account_label=default_account_label,
        raw_event=coerce_json_payload(aliased_raw_event),
    )


def _fingerprint_normalized_order_event(
    event: NormalizedOrderEvent,
    *,
    account_label: str | None = None,
) -> str:
    fingerprint_input = {
        "alpaca_account_label": account_label or event.alpaca_account_label,
        "alpaca_order_id": event.alpaca_order_id,
        "client_order_id": event.client_order_id,
        "event_type": event.event_type,
        "status": event.status,
        "event_ts": event.event_ts.isoformat() if event.event_ts else None,
        "feed_seq": event.feed_seq,
        "qty": str(event.qty) if event.qty is not None else None,
        "filled_qty": str(event.filled_qty) if event.filled_qty is not None else None,
        "avg_fill_price": (
            str(event.avg_fill_price) if event.avg_fill_price is not None else None
        ),
    }
    return hashlib.sha256(
        json.dumps(fingerprint_input, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _order_identity_matches_account_scope(
    session: Session,
    event: NormalizedOrderEvent,
    *,
    account_label: str,
) -> bool:
    clauses: list[ColumnElement[bool]] = []
    if event.alpaca_order_id:
        clauses.append(
            (Execution.alpaca_order_id == event.alpaca_order_id)
            & (Execution.alpaca_account_label == account_label)
        )
    if event.client_order_id:
        clauses.append(
            (Execution.client_order_id == event.client_order_id)
            & (Execution.alpaca_account_label == account_label)
        )
    if clauses and session.scalar(select(exists().where(or_(*clauses)))):
        return True

    if not event.client_order_id:
        return False
    return bool(
        session.scalar(
            select(
                exists().where(
                    TradeDecision.decision_hash == event.client_order_id,
                    TradeDecision.alpaca_account_label == account_label,
                )
            )
        )
    )


def persist_order_event(
    session: Session,
    event: NormalizedOrderEvent,
    *,
    source_window_id: Any | None = None,
) -> tuple[ExecutionOrderEvent, bool]:
    """Persist a normalized event and link it to execution/trade_decision rows."""

    existing = session.execute(
        select(ExecutionOrderEvent).where(
            ExecutionOrderEvent.event_fingerprint == event.event_fingerprint
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.source_window_id is None and source_window_id is not None:
            existing.source_window_id = source_window_id
            session.add(existing)
            _refresh_source_window_linkage_counts(session, existing)
        _journal_tigerbeetle_order_event(session, existing)
        return existing, True

    filled_qty_delta, filled_notional_delta, fill_quantity_basis = _fill_delta_fields(
        session, event
    )
    execution = _resolve_execution(session, event)
    trade_decision_id = None
    if execution is not None:
        trade_decision_id = execution.trade_decision_id
    elif event.client_order_id:
        decision = session.execute(
            select(TradeDecision).where(
                TradeDecision.decision_hash == event.client_order_id,
                TradeDecision.alpaca_account_label == event.alpaca_account_label,
            )
        ).scalar_one_or_none()
        if decision is not None:
            trade_decision_id = decision.id

    row = ExecutionOrderEvent(
        event_fingerprint=event.event_fingerprint,
        source_topic=event.source_topic,
        source_partition=event.source_partition,
        source_offset=event.source_offset,
        alpaca_account_label=event.alpaca_account_label,
        feed_seq=event.feed_seq,
        event_ts=event.event_ts,
        symbol=event.symbol,
        alpaca_order_id=event.alpaca_order_id,
        client_order_id=event.client_order_id,
        event_type=event.event_type,
        status=event.status,
        qty=event.qty,
        filled_qty=event.filled_qty,
        filled_qty_delta=filled_qty_delta,
        avg_fill_price=event.avg_fill_price,
        filled_notional_delta=filled_notional_delta,
        fill_quantity_basis=fill_quantity_basis,
        raw_event=event.raw_event,
        execution_id=execution.id if execution is not None else None,
        trade_decision_id=trade_decision_id,
        source_window_id=source_window_id,
    )
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
            if settings.tigerbeetle_required:
                _journal_tigerbeetle_order_event(session, row)
    except IntegrityError:
        existing = session.execute(
            select(ExecutionOrderEvent).where(
                ExecutionOrderEvent.event_fingerprint == event.event_fingerprint
            )
        ).scalar_one_or_none()
        if existing is None:
            raise
        if existing.source_window_id is None and source_window_id is not None:
            existing.source_window_id = source_window_id
            session.add(existing)
            _refresh_source_window_linkage_counts(session, existing)
        _journal_tigerbeetle_order_event(session, existing)
        return existing, True

    if not settings.tigerbeetle_required:
        _journal_tigerbeetle_order_event(session, row)
    return row, False


def _journal_tigerbeetle_order_event(
    session: Session,
    row: ExecutionOrderEvent,
) -> None:
    if not settings.tigerbeetle_enabled or not settings.tigerbeetle_journal_enabled:
        return
    try:
        with TigerBeetleLedgerJournal() as journal, session.begin_nested():
            journal.journal_order_event(session, row)
    except Exception as exc:
        if settings.tigerbeetle_required:
            raise
        logger.warning(
            "TigerBeetle order-event journal failed for event_fingerprint=%s: %s",
            row.event_fingerprint,
            exc,
        )


def apply_order_event_to_execution(
    execution: Execution, event: ExecutionOrderEvent
) -> tuple[bool, bool]:
    """Apply event evidence to execution if event ordering is not stale/out-of-order."""

    if (
        event.status is None
        and event.filled_qty is None
        and event.avg_fill_price is None
    ):
        return False, False

    stale_by_seq = _is_stale_by_seq(execution, event)
    stale_by_ts = _is_stale_by_ts(execution, event)
    if stale_by_seq or stale_by_ts:
        return False, True

    updated = False
    if event.status is not None and execution.status != event.status:
        execution.status = event.status
        updated = True
    if event.filled_qty is not None and execution.filled_qty != event.filled_qty:
        execution.filled_qty = event.filled_qty
        updated = True
    if (
        event.avg_fill_price is not None
        and execution.avg_fill_price != event.avg_fill_price
    ):
        execution.avg_fill_price = event.avg_fill_price
        updated = True

    if event.event_ts is not None:
        execution.order_feed_last_event_ts = event.event_ts
        execution.last_update_at = event.event_ts
    if event.feed_seq is not None:
        execution.order_feed_last_seq = event.feed_seq

    execution.raw_order = merge_execution_raw_order_update(
        execution.raw_order,
        event.raw_event,
        update_key="_order_feed_last_event",
    )
    return updated, False


def _fill_delta_fields(
    session: Session,
    event: NormalizedOrderEvent,
) -> tuple[Decimal | None, Decimal | None, str | None]:
    if not _is_fill_event(event.event_type, event.status) or event.filled_qty is None:
        return None, None, None

    identity_clauses: list[ColumnElement[bool]] = []
    if event.alpaca_order_id:
        identity_clauses.append(
            ExecutionOrderEvent.alpaca_order_id == event.alpaca_order_id
        )
    if event.client_order_id:
        identity_clauses.append(
            ExecutionOrderEvent.client_order_id == event.client_order_id
        )
    if not identity_clauses:
        return None, None, FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING

    previous_filled_qty = session.scalar(
        select(func.max(ExecutionOrderEvent.filled_qty)).where(
            ExecutionOrderEvent.alpaca_account_label == event.alpaca_account_label,
            or_(*identity_clauses),
            ExecutionOrderEvent.filled_qty.is_not(None),
        )
    )
    previous_qty = (
        Decimal("0")
        if previous_filled_qty is None
        else Decimal(str(previous_filled_qty))
    )
    filled_qty_delta = Decimal(str(event.filled_qty)) - previous_qty
    if filled_qty_delta <= 0:
        return None, None, FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING

    filled_notional_delta = (
        filled_qty_delta * Decimal(str(event.avg_fill_price))
        if event.avg_fill_price is not None
        else None
    )
    return (
        filled_qty_delta,
        filled_notional_delta,
        FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA,
    )


def _is_fill_event(event_type: str | None, status: str | None) -> bool:
    return (event_type or "").strip().lower() in _FILL_EVENT_TYPES or (
        status or ""
    ).strip().lower() in _FILL_EVENT_TYPES


def merge_execution_raw_order_update(
    existing_raw_order: Any,
    update_payload: Any,
    *,
    update_key: str,
) -> dict[str, Any] | None:
    """Preserve submit-time proof metadata while recording the latest update payload."""

    coerced_existing = coerce_json_payload(existing_raw_order)
    coerced_update = coerce_json_payload(update_payload)
    existing: dict[str, Any] = {}
    if isinstance(coerced_existing, Mapping):
        existing = {
            str(key): value
            for key, value in cast(Mapping[object, Any], coerced_existing).items()
        }
    update: dict[str, Any] = {}
    if isinstance(coerced_update, Mapping):
        update = {
            str(key): value
            for key, value in cast(Mapping[object, Any], coerced_update).items()
        }

    if not existing and not update:
        return None

    merged = dict(existing)
    for key, value in update.items():
        merged.setdefault(key, value)
    if update:
        merged[update_key] = update
    return coerce_json_payload(merged)


def latest_order_event_for_execution(
    session: Session, execution: Execution
) -> ExecutionOrderEvent | None:
    """Fetch newest persisted order event linked to an execution."""

    filters: list[ColumnElement[bool]] = [
        (ExecutionOrderEvent.execution_id == execution.id)
        & (ExecutionOrderEvent.alpaca_account_label == execution.alpaca_account_label)
    ]
    if execution.alpaca_order_id:
        filters.append(
            (ExecutionOrderEvent.alpaca_order_id == execution.alpaca_order_id)
            & (
                ExecutionOrderEvent.alpaca_account_label
                == execution.alpaca_account_label
            )
        )
    if execution.client_order_id:
        filters.append(
            (ExecutionOrderEvent.client_order_id == execution.client_order_id)
            & (
                ExecutionOrderEvent.alpaca_account_label
                == execution.alpaca_account_label
            )
        )

    stmt = (
        select(ExecutionOrderEvent)
        .where(or_(*filters))
        .order_by(
            ExecutionOrderEvent.event_ts.desc().nullslast(),
            ExecutionOrderEvent.feed_seq.desc().nullslast(),
            ExecutionOrderEvent.created_at.desc(),
        )
        .limit(1)
    )
    return session.execute(stmt).scalar_one_or_none()


def link_order_events_to_execution(
    session: Session,
    execution: Execution,
    *,
    limit: int | None = None,
) -> int:
    """Attach previously ingested order-feed events once their Execution exists."""

    clauses: list[ColumnElement[bool]] = []
    if execution.alpaca_order_id:
        clauses.append(
            (ExecutionOrderEvent.alpaca_order_id == execution.alpaca_order_id)
            & (
                ExecutionOrderEvent.alpaca_account_label
                == execution.alpaca_account_label
            )
        )
    if execution.client_order_id:
        clauses.append(
            (ExecutionOrderEvent.client_order_id == execution.client_order_id)
            & (
                ExecutionOrderEvent.alpaca_account_label
                == execution.alpaca_account_label
            )
        )
    if not clauses:
        return 0

    stmt = (
        select(ExecutionOrderEvent)
        .where(
            or_(*clauses),
            (
                (ExecutionOrderEvent.execution_id.is_(None))
                | (ExecutionOrderEvent.trade_decision_id.is_(None))
            ),
        )
        .order_by(
            ExecutionOrderEvent.event_ts.asc().nullsfirst(),
            ExecutionOrderEvent.feed_seq.asc().nullsfirst(),
            ExecutionOrderEvent.created_at.asc(),
        )
    )
    if limit is not None:
        stmt = stmt.limit(max(1, min(int(limit), 5000)))
    events = session.execute(stmt).scalars().all()
    if not events:
        return 0

    linked = 0
    latest_event: ExecutionOrderEvent | None = None
    for event in events:
        changed = False
        if event.execution_id is None:
            event.execution_id = execution.id
            changed = True
        if event.trade_decision_id is None:
            trade_decision_id = execution.trade_decision_id
            if trade_decision_id is None:
                decision = _trade_decision_for_order_event(session, event)
                trade_decision_id = decision.id if decision is not None else None
            if trade_decision_id is not None:
                event.trade_decision_id = trade_decision_id
                changed = True
        if not changed:
            continue
        _ensure_source_window_for_event(session, event)
        session.add(event)
        _refresh_source_window_linkage_counts(session, event)
        latest_event = event
        linked += 1

    if linked == 0 or latest_event is None:
        return 0

    updated, _ = apply_order_event_to_execution(execution, latest_event)
    if updated:
        _update_trade_decision_from_execution(session, execution)
        upsert_execution_tca_metric(session, execution)
        session.add(execution)
    return linked


def repair_order_feed_execution_links(
    session: Session,
    *,
    account_label: str | None = None,
    limit: int = 1000,
) -> dict[str, int]:
    """Attach unlinked order-feed lifecycle rows to matching executions.

    This is a bounded repair for already-consumed broker events. It preserves
    fail-closed proof semantics: if no matching execution exists, the event stays
    unlinked and remains a runtime-ledger/source-authority blocker.
    """

    bounded_limit = max(1, min(int(limit), 5000))
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
        .order_by(
            ExecutionOrderEvent.event_ts.asc().nullsfirst(),
            ExecutionOrderEvent.feed_seq.asc().nullsfirst(),
            ExecutionOrderEvent.created_at.asc(),
        )
        .limit(bounded_limit)
    )
    if account_label:
        stmt = stmt.where(ExecutionOrderEvent.alpaca_account_label == account_label)

    events = session.execute(stmt).scalars().all()
    processed_execution_ids: set[object] = set()
    counters = {
        "selected": len(events),
        "executions_matched": 0,
        "executions_linked": 0,
        "decisions_matched": 0,
        "events_linked": 0,
        "decision_events_linked": 0,
        "events_without_execution": 0,
        "events_without_decision": 0,
    }
    processed_decision_ids: set[object] = set()
    for event in events:
        if counters["events_linked"] >= bounded_limit:
            break
        execution = _execution_for_order_event(session, event)
        if execution is None:
            if event.trade_decision_id is None:
                decision = _trade_decision_for_order_event(session, event)
                if decision is None:
                    counters["events_without_decision"] += 1
                else:
                    event.trade_decision_id = decision.id
                    if decision.id not in processed_decision_ids:
                        processed_decision_ids.add(decision.id)
                        counters["decisions_matched"] += 1
                    _ensure_source_window_for_event(session, event)
                    session.add(event)
                    _refresh_source_window_linkage_counts(session, event)
                    counters["decision_events_linked"] += 1
            counters["events_without_execution"] += 1
            continue
        if execution.id in processed_execution_ids:
            continue
        processed_execution_ids.add(execution.id)
        counters["executions_matched"] += 1
        remaining_event_budget = max(1, bounded_limit - counters["events_linked"])
        linked = link_order_events_to_execution(
            session,
            execution,
            limit=remaining_event_budget,
        )
        if linked <= 0:
            continue
        counters["executions_linked"] += 1
        counters["events_linked"] += linked
    return counters


def repair_order_feed_fill_deltas(
    session: Session,
    *,
    account_label: str | None = None,
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


def _execution_for_order_event(
    session: Session,
    event: ExecutionOrderEvent,
) -> Execution | None:
    clauses: list[ColumnElement[bool]] = []
    if event.alpaca_order_id:
        clauses.append(
            (Execution.alpaca_order_id == event.alpaca_order_id)
            & (Execution.alpaca_account_label == event.alpaca_account_label)
        )
    if event.client_order_id:
        clauses.append(
            (Execution.client_order_id == event.client_order_id)
            & (Execution.alpaca_account_label == event.alpaca_account_label)
        )
    if not clauses:
        return None
    return (
        session.execute(
            select(Execution)
            .where(or_(*clauses))
            .order_by(
                Execution.order_feed_last_event_ts.desc().nullslast(),
                Execution.last_update_at.desc().nullslast(),
                Execution.created_at.desc(),
            )
            .limit(1)
        )
        .scalars()
        .first()
    )


def _trade_decision_for_order_event(
    session: Session,
    event: ExecutionOrderEvent,
) -> TradeDecision | None:
    if not event.client_order_id:
        return None
    return session.execute(
        select(TradeDecision)
        .where(
            TradeDecision.decision_hash == event.client_order_id,
            TradeDecision.alpaca_account_label == event.alpaca_account_label,
        )
        .order_by(TradeDecision.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


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


def _resolve_execution(
    session: Session, event: NormalizedOrderEvent
) -> Execution | None:
    clauses: list[ColumnElement[bool]] = []
    if event.alpaca_order_id:
        clauses.append(
            (Execution.alpaca_order_id == event.alpaca_order_id)
            & (Execution.alpaca_account_label == event.alpaca_account_label)
        )
    if event.client_order_id:
        clauses.append(
            (Execution.client_order_id == event.client_order_id)
            & (Execution.alpaca_account_label == event.alpaca_account_label)
        )
    if not clauses:
        return None
    return session.execute(select(Execution).where(or_(*clauses))).scalar_one_or_none()


def _find_existing_source_window_for_event(
    session: Session,
    event: ExecutionOrderEvent,
) -> OrderFeedSourceWindow | None:
    if event.source_partition is None or event.source_offset is None:
        return None
    return (
        session.execute(
            select(OrderFeedSourceWindow)
            .where(
                OrderFeedSourceWindow.source_topic == event.source_topic,
                OrderFeedSourceWindow.source_partition == event.source_partition,
                OrderFeedSourceWindow.alpaca_account_label
                == event.alpaca_account_label,
                OrderFeedSourceWindow.start_offset <= event.source_offset,
                OrderFeedSourceWindow.end_offset >= event.source_offset,
            )
            .order_by(OrderFeedSourceWindow.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )


def _create_historical_source_window_for_event(
    session: Session,
    event: ExecutionOrderEvent,
) -> OrderFeedSourceWindow:
    if event.source_partition is None or event.source_offset is None:
        raise ValueError("historical_source_window_requires_source_offset")
    event_ts = _event_timestamp_for_source_window(event)
    source_window = OrderFeedSourceWindow(
        consumer_group=_order_feed_cursor_consumer_group(),
        source_topic=event.source_topic,
        source_partition=event.source_partition,
        alpaca_account_label=event.alpaca_account_label,
        assignment_mode=settings.trading_order_feed_assignment_mode,
        collector_identity=settings.trading_order_feed_client_id.strip() or None,
        source_revision=HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
        window_started_at=event_ts,
        window_ended_at=event_ts + timedelta(microseconds=1),
        start_offset=event.source_offset,
        end_offset=event.source_offset,
        broker_high_watermark=None,
        consumed_count=1,
        inserted_count=1,
        duplicate_count=0,
        malformed_count=0,
        missing_payload_count=0,
        missing_identity_count=0,
        out_of_scope_account_count=0,
        unlinked_execution_count=0 if event.execution_id is not None else 1,
        unlinked_decision_count=0 if event.trade_decision_id is not None else 1,
        failed_unhandled_count=0,
        dropped_count=0,
        gap_count=0,
        gap_ranges=None,
        first_event_ts=event.event_ts,
        last_event_ts=event.event_ts,
        status="inserted",
        status_reason="historical_execution_order_event_backfill",
        payload_json={
            "cursor_authority": False,
            "source": "execution_order_events",
            **_source_window_source_identity_payload_for_values(
                source_topic=event.source_topic,
                source_partition=event.source_partition,
                start_offset=event.source_offset,
                end_offset=event.source_offset,
                alpaca_account_label=event.alpaca_account_label,
                source_revision=HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
            ),
            **_order_event_evidence_payload(event),
        },
    )
    session.add(source_window)
    session.flush()
    return source_window


def _create_execution_backfill_source_window(
    session: Session,
    *,
    execution: Execution,
    event_ts: datetime,
    source_offset: int,
) -> OrderFeedSourceWindow:
    source_window = OrderFeedSourceWindow(
        consumer_group=_order_feed_cursor_consumer_group(),
        source_topic=EXECUTION_RAW_ORDER_SOURCE_TOPIC,
        source_partition=EXECUTION_RAW_ORDER_SOURCE_PARTITION,
        alpaca_account_label=execution.alpaca_account_label,
        assignment_mode=settings.trading_order_feed_assignment_mode,
        collector_identity=settings.trading_order_feed_client_id.strip() or None,
        source_revision=EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
        window_started_at=event_ts,
        window_ended_at=event_ts,
        start_offset=source_offset,
        end_offset=source_offset,
        broker_high_watermark=None,
        consumed_count=1,
        inserted_count=1,
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
        first_event_ts=event_ts,
        last_event_ts=event_ts,
        status="inserted",
        status_reason="execution_raw_order_snapshot_backfill",
        payload_json={
            "cursor_authority": False,
            "source": "executions.raw_order",
            **_source_window_source_identity_payload_for_values(
                source_topic=EXECUTION_RAW_ORDER_SOURCE_TOPIC,
                source_partition=EXECUTION_RAW_ORDER_SOURCE_PARTITION,
                start_offset=source_offset,
                end_offset=source_offset,
                alpaca_account_label=execution.alpaca_account_label,
                source_revision=EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
            ),
            "order_identity": _order_identity_payload(
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
            ),
            "lifecycle": _lifecycle_payload(
                event_type=_execution_backfill_event_type(execution),
                status=execution.status,
                event_ts=event_ts,
                feed_seq=None,
            ),
            "execution_id": str(execution.id),
            "trade_decision_id": (
                str(execution.trade_decision_id)
                if execution.trade_decision_id is not None
                else None
            ),
        },
    )
    session.add(source_window)
    session.flush()
    return source_window


def _execution_backfill_order_event(
    *,
    execution: Execution,
    event_ts: datetime,
    source_offset: int,
    source_window_id: Any,
) -> ExecutionOrderEvent:
    event_type = _execution_backfill_event_type(execution)
    raw_event = _execution_backfill_raw_event(execution, event_type=event_type)
    fingerprint_input = {
        "source_revision": EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
        "execution_id": str(execution.id),
        "trade_decision_id": (
            str(execution.trade_decision_id)
            if execution.trade_decision_id is not None
            else None
        ),
        "alpaca_account_label": execution.alpaca_account_label,
        "alpaca_order_id": execution.alpaca_order_id,
        "client_order_id": execution.client_order_id,
        "event_type": event_type,
        "status": execution.status,
        "event_ts": event_ts.isoformat(),
        "filled_qty": str(execution.filled_qty),
        "avg_fill_price": (
            str(execution.avg_fill_price)
            if execution.avg_fill_price is not None
            else None
        ),
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_input, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic=EXECUTION_RAW_ORDER_SOURCE_TOPIC,
        source_partition=EXECUTION_RAW_ORDER_SOURCE_PARTITION,
        source_offset=source_offset,
        alpaca_account_label=execution.alpaca_account_label,
        feed_seq=None,
        event_ts=event_ts,
        symbol=execution.symbol,
        alpaca_order_id=execution.alpaca_order_id,
        client_order_id=execution.client_order_id,
        event_type=event_type,
        status=execution.status,
        qty=execution.submitted_qty,
        filled_qty=execution.filled_qty,
        avg_fill_price=execution.avg_fill_price,
        raw_event=raw_event,
        execution_id=execution.id,
        trade_decision_id=execution.trade_decision_id,
        source_window_id=source_window_id,
    )


def _execution_backfill_event_type(execution: Execution) -> str:
    status = (execution.status or "").strip().lower()
    if status == "filled":
        return "fill"
    if status == "partially_filled":
        return "partial_fill"
    return status or "execution_snapshot"


def _execution_backfill_raw_event(
    execution: Execution,
    *,
    event_type: str,
) -> dict[str, Any]:
    raw_order = coerce_json_payload(execution.raw_order)
    return coerce_json_payload(
        {
            "channel": "trade_updates",
            "source": "execution_raw_order_snapshot_backfill",
            "account_label": execution.alpaca_account_label,
            "payload": {
                "event": event_type,
                "timestamp": _isoformat_datetime(_execution_activity_at(execution)),
                "account_label": execution.alpaca_account_label,
                "order": {
                    "id": execution.alpaca_order_id,
                    "client_order_id": execution.client_order_id,
                    "symbol": execution.symbol,
                    "status": execution.status,
                    "side": execution.side,
                    "type": execution.order_type,
                    "time_in_force": execution.time_in_force,
                    "qty": str(execution.submitted_qty),
                    "filled_qty": str(execution.filled_qty),
                    "filled_avg_price": (
                        str(execution.avg_fill_price)
                        if execution.avg_fill_price is not None
                        else None
                    ),
                    "alpaca_account_label": execution.alpaca_account_label,
                },
            },
            "execution_id": str(execution.id),
            "trade_decision_id": (
                str(execution.trade_decision_id)
                if execution.trade_decision_id is not None
                else None
            ),
            "raw_order": raw_order,
        }
    )


def _source_offset_in_use(
    session: Session,
    *,
    source_topic: str,
    source_partition: int,
    source_offset: int,
) -> bool:
    existing = session.scalar(
        select(func.count(ExecutionOrderEvent.id)).where(
            ExecutionOrderEvent.source_topic == source_topic,
            ExecutionOrderEvent.source_partition == source_partition,
            ExecutionOrderEvent.source_offset == source_offset,
        )
    )
    return int(existing or 0) > 0


def _stable_execution_source_offset(value: object) -> int:
    try:
        raw_int = uuid.UUID(str(value)).int
    except (ValueError, TypeError, AttributeError):
        raw_int = int.from_bytes(
            hashlib.sha256(str(value).encode("utf-8")).digest()[:8],
            "big",
        )
    return raw_int % ((2**63) - 1) or 1


def _event_timestamp_for_source_window(event: ExecutionOrderEvent) -> datetime:
    event_ts = event.event_ts or event.created_at or datetime.now(timezone.utc)
    if event_ts.tzinfo is None:
        return event_ts.replace(tzinfo=timezone.utc)
    return event_ts.astimezone(timezone.utc)


def _ensure_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _ensure_aware_utc(value).isoformat()


def _refresh_source_window_linkage_counts(
    session: Session, event: ExecutionOrderEvent
) -> None:
    if event.source_window_id is None:
        return
    source_window = session.get(OrderFeedSourceWindow, event.source_window_id)
    if source_window is None:
        return
    total_events = session.scalar(
        select(func.count(ExecutionOrderEvent.id)).where(
            ExecutionOrderEvent.source_window_id == event.source_window_id
        )
    )
    linked_executions = session.scalar(
        select(func.count(ExecutionOrderEvent.execution_id)).where(
            ExecutionOrderEvent.source_window_id == event.source_window_id
        )
    )
    linked_decisions = session.scalar(
        select(func.count(ExecutionOrderEvent.trade_decision_id)).where(
            ExecutionOrderEvent.source_window_id == event.source_window_id
        )
    )
    event_count = int(total_events or 0)
    source_window.unlinked_execution_count = max(
        event_count - int(linked_executions or 0),
        0,
    )
    source_window.unlinked_decision_count = max(
        event_count - int(linked_decisions or 0),
        0,
    )
    source_window.inserted_count = max(
        int(source_window.inserted_count or 0), event_count
    )
    payload = coerce_json_payload(source_window.payload_json)
    payload_dict: dict[str, Any]
    if isinstance(payload, Mapping):
        payload_dict = {
            str(key): value
            for key, value in cast(Mapping[object, Any], payload).items()
        }
    else:
        payload_dict = {}
    payload_dict.update(_source_window_source_identity_payload(source_window))
    payload_dict.update(_order_event_evidence_payload(event))
    raw_classification_counts = payload_dict.get("classification_counts", {})
    classification_counts = (
        {
            str(key): value
            for key, value in cast(
                Mapping[object, Any],
                raw_classification_counts,
            ).items()
        }
        if isinstance(raw_classification_counts, Mapping)
        else {}
    )
    if source_window.inserted_count:
        classification_counts["inserted"] = int(source_window.inserted_count)
    if source_window.unlinked_execution_count:
        classification_counts["unlinked_execution"] = int(
            source_window.unlinked_execution_count
        )
    else:
        classification_counts.pop("unlinked_execution", None)
    if source_window.unlinked_decision_count:
        classification_counts["unlinked_decision"] = int(
            source_window.unlinked_decision_count
        )
    else:
        classification_counts.pop("unlinked_decision", None)
    payload_dict["classification_counts"] = classification_counts
    source_window_complete = bool(
        event_count
        and source_window.unlinked_execution_count == 0
        and source_window.unlinked_decision_count == 0
        and event.source_partition is not None
        and event.source_offset is not None
    )
    payload_dict["source_coverage_complete"] = source_window_complete
    payload_dict["promotion_authority_eligible"] = source_window_complete
    payload_dict["authority_class"] = (
        "runtime_order_feed_execution_source"
        if source_window_complete
        else "order_feed_lifecycle_unlinked"
    )
    source_window.payload_json = coerce_json_payload(payload_dict)
    session.add(source_window)


def _order_event_has_failed_unhandled_source_window(
    session: Session, event: ExecutionOrderEvent
) -> bool:
    if event.source_window_id is None:
        return False
    source_window = session.get(OrderFeedSourceWindow, event.source_window_id)
    return source_window is not None and source_window.status == "failed_unhandled"


def _retry_failed_duplicate_order_event_application(
    *,
    session: Session,
    event: ExecutionOrderEvent,
    counters: dict[str, int],
    source_window: OrderFeedSourceWindow | None,
) -> None:
    """Replay execution-side effects before advancing a previously failed offset.

    A prior ``failed_unhandled`` ingest may have durably inserted the
    ``ExecutionOrderEvent`` row but intentionally skipped the consumer cursor. On
    Kafka redelivery that row looks like a duplicate. Treating it as an ordinary
    duplicate would advance the source cursor without proving the execution
    lifecycle mutation that failed earlier, so retry the idempotent execution
    application first.
    """

    if event.execution_id is None:
        raise RuntimeError("failed_unhandled_order_event_missing_execution_link")
    execution = session.get(Execution, event.execution_id)
    if execution is None:
        raise RuntimeError("failed_unhandled_order_event_execution_not_found")

    updated, out_of_order = apply_order_event_to_execution(execution, event)
    if out_of_order:
        counters["out_of_order_total"] += 1
    if updated:
        counters["apply_updates_total"] += 1
        if execution.trade_decision_id is not None:
            _update_trade_decision_from_execution(session, execution)
        upsert_execution_tca_metric(session, execution)
        session.add(execution)
    if source_window is not None:
        payload = coerce_json_payload(source_window.payload_json)
        if isinstance(payload, Mapping):
            payload_dict = {
                str(key): value
                for key, value in cast(Mapping[object, Any], payload).items()
            }
        else:
            payload_dict = {}
        payload_dict["reprocessed_failed_unhandled_source_window_id"] = str(
            event.source_window_id
        )
        source_window.status_reason = "duplicate_after_failed_unhandled_reprocessed"
        source_window.payload_json = coerce_json_payload(payload_dict)


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
    "repair_order_feed_fill_deltas",
    "latest_order_event_for_execution",
]

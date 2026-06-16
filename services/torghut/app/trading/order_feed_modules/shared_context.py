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
    execution_correlation_id: str | None
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
        context = self._build_ingest_record_context(
            session=session,
            record=record,
            counters=counters,
        )
        try:
            if context.out_of_scope_account:
                return self._classify_ingest_drop(
                    session,
                    record=record,
                    counters=counters,
                    context=context,
                    drop_reason="out_of_scope_account",
                )
            if context.event is None:
                return self._classify_ingest_drop(
                    session,
                    record=record,
                    counters=counters,
                    context=context,
                    drop_reason=context.normalized.drop_reason,
                    log_drop=True,
                )
            return self._persist_ingest_event(
                session=session,
                context=context,
                counters=counters,
            )
        except Exception as exc:
            return self._handle_ingest_exception(
                source_window=context.source_window,
                counters=counters,
                exc=exc,
            )

    def _build_ingest_record_context(
        self,
        *,
        session: Session,
        record: Any,
        counters: dict[str, int],
    ) -> _IngestRecordContext:
        normalized = normalize_order_feed_record(
            record,
            default_topic=settings.trading_order_feed_topic,
            default_account_label=self._default_account_label,
        )
        source_identity = _record_source_identity(record, normalized)
        alias = self._resolve_event_account_alias(session, normalized)
        out_of_scope_account = _event_out_of_scope_for_default_account(
            alias.event,
            normalized=alias.normalized,
            default_account_label=self._default_account_label,
        )
        source_window = self._create_ingest_source_window(
            session=session,
            record=record,
            source_identity=source_identity,
            event=alias.event,
            out_of_scope_account=out_of_scope_account,
        )
        if source_window is not None:
            counters["source_windows_total"] += 1
            if alias.account_alias_payload is not None:
                source_window.payload_json = {
                    "account_label_alias": alias.account_alias_payload,
                }
        return _IngestRecordContext(
            normalized=alias.normalized,
            event=alias.event,
            source_identity=source_identity,
            source_window=source_window,
            account_alias_payload=alias.account_alias_payload,
            out_of_scope_account=out_of_scope_account,
        )

    def _resolve_event_account_alias(
        self,
        session: Session,
        normalized: NormalizationResult,
    ) -> _AccountAliasResolution:
        event = normalized.event
        if not _event_out_of_scope_for_default_account(
            event,
            normalized=normalized,
            default_account_label=self._default_account_label,
        ):
            return _AccountAliasResolution(
                normalized=normalized,
                event=event,
                account_alias_payload=None,
            )
        aliased_event = _event_with_default_account_label_if_in_scope(
            session,
            event,
            default_account_label=self._default_account_label,
        )
        if aliased_event is None:
            return _AccountAliasResolution(
                normalized=normalized,
                event=event,
                account_alias_payload=None,
            )
        return _AccountAliasResolution(
            normalized=NormalizationResult(
                event=aliased_event,
                drop_reason=None,
                account_label_explicit=normalized.account_label_explicit,
            ),
            event=aliased_event,
            account_alias_payload={
                "source_account_label": event.alpaca_account_label,
                "canonical_account_label": self._default_account_label,
                "basis": "matched_order_identity",
            },
        )

    def _create_ingest_source_window(
        self,
        *,
        session: Session,
        record: Any,
        source_identity: _OrderFeedSourceIdentity,
        event: NormalizedOrderEvent | None,
        out_of_scope_account: bool,
    ) -> OrderFeedSourceWindow | None:
        return _create_order_feed_source_window(
            session,
            source_topic=source_identity.source_topic,
            source_partition=source_identity.source_partition,
            source_offset=source_identity.source_offset,
            broker_high_watermark=_broker_high_watermark_from_record(record),
            alpaca_account_label=self._source_window_account_label(
                event,
                out_of_scope_account=out_of_scope_account,
            ),
        )

    def _source_window_account_label(
        self,
        event: NormalizedOrderEvent | None,
        *,
        out_of_scope_account: bool,
    ) -> str:
        if out_of_scope_account or event is None:
            return self._default_account_label
        return event.alpaca_account_label

    def _classify_ingest_drop(
        self,
        session: Session,
        *,
        record: Any,
        counters: dict[str, int],
        context: _IngestRecordContext,
        drop_reason: str | None,
        log_drop: bool = False,
    ) -> _IngestRecordOutcome:
        counters["missing_fields_total"] += 1
        if log_drop and drop_reason:
            logger.debug("Dropped order-feed message reason=%s", drop_reason)
        if context.source_window is None:
            return _IngestRecordOutcome(durable=False)
        _classify_source_window_drop(
            context.source_window,
            drop_reason,
            record=record,
            default_account_label=self._default_account_label,
        )
        _increment_drop_counter(counters, drop_reason)
        if _upsert_drop_cursor(session, context):
            counters["cursor_updates_total"] += 1
        counters["classified_drops_total"] += 1
        return _IngestRecordOutcome(durable=True)

    def _persist_ingest_event(
        self,
        *,
        session: Session,
        context: _IngestRecordContext,
        counters: dict[str, int],
    ) -> _IngestRecordOutcome:
        event = cast(NormalizedOrderEvent, context.event)
        persisted, duplicate = persist_order_event(
            session,
            event,
            source_window_id=(
                context.source_window.id if context.source_window is not None else None
            ),
        )
        if context.source_window is not None:
            _classify_source_window_event(
                context.source_window,
                persisted=persisted,
                duplicate=duplicate,
                account_label_alias=context.account_alias_payload,
            )
        if duplicate:
            return self._handle_duplicate_order_event(
                session=session,
                persisted=persisted,
                event=event,
                source_window=context.source_window,
                counters=counters,
            )
        return self._handle_new_order_event(
            session=session,
            persisted=persisted,
            event=event,
            source_window=context.source_window,
            counters=counters,
        )

    def _handle_duplicate_order_event(
        self,
        *,
        session: Session,
        persisted: ExecutionOrderEvent,
        event: NormalizedOrderEvent,
        source_window: OrderFeedSourceWindow | None,
        counters: dict[str, int],
    ) -> _IngestRecordOutcome:
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

    def _handle_new_order_event(
        self,
        *,
        session: Session,
        persisted: ExecutionOrderEvent,
        event: NormalizedOrderEvent,
        source_window: OrderFeedSourceWindow | None,
        counters: dict[str, int],
    ) -> _IngestRecordOutcome:
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
        return self._apply_execution_order_event(
            session=session,
            execution=execution,
            persisted=persisted,
            event=event,
            source_window=source_window,
            counters=counters,
        )

    def _apply_execution_order_event(
        self,
        *,
        session: Session,
        execution: Execution,
        persisted: ExecutionOrderEvent,
        event: NormalizedOrderEvent,
        source_window: OrderFeedSourceWindow | None,
        counters: dict[str, int],
    ) -> _IngestRecordOutcome:
        updated, out_of_order = apply_order_event_to_execution(execution, persisted)
        if out_of_order:
            counters["out_of_order_total"] += 1
        if updated:
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

    def _handle_ingest_exception(
        self,
        *,
        source_window: OrderFeedSourceWindow | None,
        counters: dict[str, int],
        exc: Exception,
    ) -> _IngestRecordOutcome:
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
        hooks = _manual_assignment_hooks(consumer)
        topic_partitions = _manual_topic_partitions(hooks)
        hooks.assign(topic_partitions)
        unpositioned = _position_manual_topic_partitions(
            session,
            topic_partitions=topic_partitions,
            hooks=hooks,
        )
        _reset_manual_unpositioned_partitions(unpositioned, hooks=hooks)
        self._manual_assignment_ready = True
        _log_manual_assignment_ready(topic_partitions, unpositioned)

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
        from kafka import TopicPartition  # type: ignore[import-not-found]
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


__all__ = [name for name in globals() if not name.startswith("__")]

"""Order-feed ingestor implementation."""

from __future__ import annotations

from datetime import datetime, timezone
from importlib import import_module
from typing import Any, Callable, cast

from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Execution,
    ExecutionOrderEvent,
    OrderFeedSourceWindow,
)
from ..broker_account_activities import persist_broker_trade_update
from . import shared_context as _shared_context
from .shared_context import (
    AccountAliasResolution as _AccountAliasResolution,
    IngestRecordContext as _IngestRecordContext,
    IngestRecordOutcome as _IngestRecordOutcome,
    OrderFeedSourceIdentity as _OrderFeedSourceIdentity,
    broker_high_watermark_from_record as _broker_high_watermark_from_record,
    classify_source_window_drop as _classify_source_window_drop,
    classify_source_window_event as _classify_source_window_event,
    classify_source_window_unhandled_failure as _classify_source_window_unhandled_failure,
    commit_consumer as _commit_consumer,
    consumer_commit_enabled as _consumer_commit_enabled,
    create_order_feed_source_window as _create_order_feed_source_window,
    event_out_of_scope_for_default_account as _event_out_of_scope_for_default_account,
    event_with_default_account_label_if_in_scope as _event_with_default_account_label_if_in_scope,
    flatten_poll_records as _flatten_poll_records,
    increment_drop_counter as _increment_drop_counter,
    kafka_consumer_group_id as _kafka_consumer_group_id,
    log_manual_assignment_ready as _log_manual_assignment_ready,
    manual_assignment_hooks as _manual_assignment_hooks,
    manual_topic_partitions as _manual_topic_partitions,
    order_event_has_failed_unhandled_source_window as _order_event_has_failed_unhandled_source_window,
    position_manual_topic_partitions as _position_manual_topic_partitions,
    record_source_identity as _record_source_identity,
    reset_manual_unpositioned_partitions as _reset_manual_unpositioned_partitions,
    retry_failed_duplicate_order_event_application as _retry_failed_duplicate_order_event_application,
    update_trade_decision_from_execution as _update_trade_decision_from_execution,
    upsert_cursor_and_count as _upsert_cursor_and_count,
    upsert_drop_cursor as _upsert_drop_cursor,
    NormalizationResult,
    NormalizedOrderEvent,
    logger,
    normalize_order_feed_record,
)


class OrderFeedIngestor:
    """Consumes order updates from Kafka and persists normalized event rows."""

    def __init__(
        self,
        *,
        consumer_factory: Callable[[], Any] | None = None,
        default_account_label: str | None = None,
        broker_environment: str | None = None,
        broker_endpoint_fingerprint: str | None = None,
    ) -> None:
        self._consumer_factory = consumer_factory or self._build_consumer
        provided_label = (
            default_account_label.strip() if default_account_label is not None else ""
        )
        self._default_account_label = provided_label or settings.trading_account_label
        if (broker_environment is None) != (broker_endpoint_fingerprint is None):
            raise ValueError("order_feed_broker_source_identity_incomplete")
        self._broker_environment = broker_environment
        self._broker_endpoint_fingerprint = broker_endpoint_fingerprint
        self._consumer: Any | None = None
        self._disabled_logged = False
        self._manual_assignment_ready = False

    @property
    def default_account_label(self) -> str:
        return self._default_account_label

    @property
    def immutable_broker_source_enabled(self) -> bool:
        return (
            self._broker_environment is not None
            and self._broker_endpoint_fingerprint is not None
        )

    @property
    def broker_environment(self) -> str | None:
        return self._broker_environment

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
            # The broker event is the primary fact. Make it visible before the
            # optional cross-store audit performs network I/O; otherwise a slow
            # TigerBeetle lookup can hide a fill from risk and lifecycle readers.
            session.commit()
            self._reconcile_tigerbeetle_if_enabled(session)
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
            _shared_context.reconcile_tigerbeetle_transfers(session)
            session.commit()
        except Exception as exc:
            # SQLAlchemy requires an explicit rollback after a database error.
            # Leaving the scheduler session failed poisons the rest of the
            # current cycle even when reconciliation is configured as optional.
            session.rollback()
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
            "immutable_source_events_total": 0,
            "immutable_source_duplicates_total": 0,
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
        if event is None:
            return _AccountAliasResolution(
                normalized=normalized,
                event=None,
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
        self._persist_immutable_source_event(
            session=session,
            event=event,
            counters=counters,
        )
        persisted, duplicate = _shared_context.persist_order_event(
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

    def _persist_immutable_source_event(
        self,
        *,
        session: Session,
        event: NormalizedOrderEvent,
        counters: dict[str, int],
    ) -> None:
        if (
            self._broker_environment is None
            or self._broker_endpoint_fingerprint is None
            or event.source_partition is None
            or event.source_offset is None
        ):
            return
        _, duplicate = persist_broker_trade_update(
            session,
            event.raw_event,
            event_fingerprint=event.event_fingerprint,
            environment=self._broker_environment,
            account_label=event.alpaca_account_label,
            endpoint_fingerprint=self._broker_endpoint_fingerprint,
            source_topic=event.source_topic,
            source_partition=event.source_partition,
            source_offset=event.source_offset,
            observed_at=datetime.now(timezone.utc),
        )
        counter = (
            "immutable_source_duplicates_total"
            if duplicate
            else "immutable_source_events_total"
        )
        counters[counter] += 1

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
        updated, out_of_order = _shared_context.apply_order_event_to_execution(
            execution, persisted
        )
        if out_of_order:
            counters["out_of_order_total"] += 1
        if updated:
            counters["apply_updates_total"] += 1
            if execution.trade_decision_id is not None:
                _update_trade_decision_from_execution(session, execution)
            _shared_context.upsert_execution_tca_metric(session, execution)
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
            KafkaConsumer = import_module("kafka").KafkaConsumer
        except Exception as exc:  # pragma: no cover - import guarded at runtime
            raise RuntimeError(
                "kafka-python dependency is required for order-feed ingestion"
            ) from exc

        manual_assignment = settings.trading_order_feed_assignment_mode == "manual"
        topics: list[str] = (
            [] if manual_assignment else list(settings.trading_order_feed_topics)
        )
        group_id = None if manual_assignment else _kafka_consumer_group_id()
        return KafkaConsumer(
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
        )


__all__ = ["OrderFeedIngestor"]

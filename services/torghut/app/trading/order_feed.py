"""Kafka-backed order-feed ingestion and persistence helpers."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Mapping, cast

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ..config import settings
from ..models import Execution, ExecutionOrderEvent, TradeDecision, coerce_json_payload
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NormalizedOrderEvent:
    """Canonicalized trade update payload used for persistence and reconciliation."""

    event_fingerprint: str
    source_topic: str
    source_partition: int | None
    source_offset: int | None
    feed_seq: int | None
    event_ts: datetime | None
    symbol: str | None
    alpaca_order_id: str | None
    client_order_id: str | None
    event_type: str | None
    status: str | None
    qty: Decimal | None
    filled_qty: Decimal | None
    avg_fill_price: Decimal | None
    raw_event: dict[str, Any]


@dataclass(frozen=True)
class NormalizationResult:
    """Result of normalizing a single consumed message."""

    event: NormalizedOrderEvent | None
    drop_reason: str | None


class OrderFeedIngestor:
    """Consumes order updates from Kafka and persists normalized event rows."""

    def __init__(
        self,
        *,
        consumer_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._consumer_factory = consumer_factory or self._build_consumer
        self._consumer: Any | None = None
        self._disabled_logged = False

    def ingest_once(self, session: Session) -> dict[str, int]:
        counters = {
            'messages_total': 0,
            'events_persisted_total': 0,
            'duplicates_total': 0,
            'out_of_order_total': 0,
            'missing_fields_total': 0,
            'apply_updates_total': 0,
            'consumer_errors_total': 0,
        }

        if not settings.trading_order_feed_enabled:
            return counters
        if not settings.trading_order_feed_bootstrap_servers:
            if not self._disabled_logged:
                logger.info('Order-feed ingestion enabled but TRADING_ORDER_FEED_BOOTSTRAP_SERVERS is not set; skipping')
                self._disabled_logged = True
            return counters

        consumer = self._ensure_consumer()
        if consumer is None:
            counters['consumer_errors_total'] += 1
            return counters

        try:
            polled = consumer.poll(
                timeout_ms=settings.trading_order_feed_poll_ms,
                max_records=settings.trading_order_feed_batch_size,
            )
        except Exception as exc:  # pragma: no cover - external Kafka failure
            counters['consumer_errors_total'] += 1
            logger.warning('Order-feed poll failed: %s', exc)
            return counters

        records = _flatten_poll_records(polled)
        if not records:
            return counters

        inserted_any = False
        for record in records:
            counters['messages_total'] += 1
            normalized = normalize_order_feed_record(
                record,
                default_topic=settings.trading_order_feed_topic,
            )
            if normalized.event is None:
                counters['missing_fields_total'] += 1
                if normalized.drop_reason:
                    logger.debug('Dropped order-feed message reason=%s', normalized.drop_reason)
                continue

            event = normalized.event
            persisted, duplicate = persist_order_event(session, event)
            if duplicate:
                counters['duplicates_total'] += 1
                continue
            counters['events_persisted_total'] += 1
            inserted_any = True

            if persisted.execution_id is not None:
                execution = session.get(Execution, persisted.execution_id)
                if execution is not None:
                    updated, out_of_order = apply_order_event_to_execution(execution, persisted)
                    if out_of_order:
                        counters['out_of_order_total'] += 1
                    if updated:
                        counters['apply_updates_total'] += 1
                        if execution.trade_decision_id is not None:
                            _update_trade_decision_from_execution(session, execution)
                        session.add(execution)

        if inserted_any:
            session.commit()
            _commit_consumer(consumer)
        return counters

    def close(self) -> None:
        if self._consumer is None:
            return
        run_close = cast(Callable[[], Any] | None, getattr(self._consumer, 'close', None))
        self._consumer = None
        if run_close is None:
            return
        try:
            run_close()
        except Exception:  # pragma: no cover - defensive close
            logger.debug('Order-feed consumer close failed', exc_info=True)

    def _ensure_consumer(self) -> Any | None:
        if self._consumer is not None:
            return self._consumer
        try:
            self._consumer = self._consumer_factory()
            self._disabled_logged = False
            return self._consumer
        except Exception as exc:  # pragma: no cover - external Kafka config failure
            logger.warning('Failed to initialize order-feed consumer: %s', exc)
            return None

    @staticmethod
    def _build_consumer() -> Any:
        try:
            from kafka import KafkaConsumer  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - import guarded at runtime
            raise RuntimeError('kafka-python dependency is required for order-feed ingestion') from exc

        bootstrap_servers_raw = settings.trading_order_feed_bootstrap_servers or ''
        return KafkaConsumer(
            settings.trading_order_feed_topic,
            bootstrap_servers=[item.strip() for item in bootstrap_servers_raw.split(',') if item.strip()],
            group_id=settings.trading_order_feed_group_id,
            client_id=settings.trading_order_feed_client_id,
            enable_auto_commit=False,
            auto_offset_reset=settings.trading_order_feed_auto_offset_reset,
            consumer_timeout_ms=max(settings.trading_order_feed_poll_ms, 1000),
            value_deserializer=None,
            key_deserializer=None,
        )


def normalize_order_feed_record(record: Any, *, default_topic: str) -> NormalizationResult:
    """Normalize a Kafka record (or Kafka-like test object) into a canonical event."""

    value = getattr(record, 'value', None)
    payload = _decode_json_payload(value)
    if payload is None:
        return NormalizationResult(event=None, drop_reason='invalid_json')

    envelope = _as_mapping(payload)
    data_payload = _extract_trade_update_payload(payload)
    if data_payload is None:
        return NormalizationResult(event=None, drop_reason='missing_trade_update_payload')

    order = _as_mapping(data_payload.get('order'))
    symbol = _coerce_text((order or {}).get('symbol'))
    if symbol is None and envelope is not None:
        symbol = _coerce_text(envelope.get('symbol'))

    alpaca_order_id = _coerce_text((order or {}).get('id'))
    client_order_id = _coerce_text((order or {}).get('client_order_id'))
    if alpaca_order_id is None:
        alpaca_order_id = _coerce_text((order or {}).get('order_id'))

    event_type = _coerce_text(data_payload.get('event')) or _coerce_text(data_payload.get('event_type'))
    status = _coerce_text((order or {}).get('status')) or _coerce_text(data_payload.get('status'))
    event_ts = _coerce_datetime(
        data_payload.get('timestamp')
        or data_payload.get('t')
        or (order or {}).get('updated_at')
        or (order or {}).get('submitted_at')
        or (envelope.get('event_ts') if envelope else None)
    )
    feed_seq = _coerce_int((envelope.get('seq') if envelope else None) or data_payload.get('seq'))

    if alpaca_order_id is None and client_order_id is None:
        return NormalizationResult(event=None, drop_reason='missing_order_identity')

    qty = _coerce_decimal((order or {}).get('qty'))
    filled_qty = _coerce_decimal((order or {}).get('filled_qty'))
    avg_fill_price = _coerce_decimal((order or {}).get('filled_avg_price') or (order or {}).get('avg_fill_price'))

    source_topic = _coerce_text(getattr(record, 'topic', None)) or _coerce_text(envelope.get('topic') if envelope else None)
    if source_topic is None:
        source_topic = default_topic

    fingerprint_input = {
        'alpaca_order_id': alpaca_order_id,
        'client_order_id': client_order_id,
        'event_type': event_type,
        'status': status,
        'event_ts': event_ts.isoformat() if event_ts else None,
        'feed_seq': feed_seq,
        'qty': str(qty) if qty is not None else None,
        'filled_qty': str(filled_qty) if filled_qty is not None else None,
        'avg_fill_price': str(avg_fill_price) if avg_fill_price is not None else None,
    }
    fingerprint = hashlib.sha256(json.dumps(fingerprint_input, sort_keys=True).encode('utf-8')).hexdigest()

    event = NormalizedOrderEvent(
        event_fingerprint=fingerprint,
        source_topic=source_topic,
        source_partition=_coerce_int(getattr(record, 'partition', None)),
        source_offset=_coerce_int(getattr(record, 'offset', None)),
        feed_seq=feed_seq,
        event_ts=event_ts,
        symbol=symbol,
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
        event_type=event_type,
        status=status,
        qty=qty,
        filled_qty=filled_qty,
        avg_fill_price=avg_fill_price,
        raw_event=coerce_json_payload(payload),
    )
    return NormalizationResult(event=event, drop_reason=None)


def persist_order_event(session: Session, event: NormalizedOrderEvent) -> tuple[ExecutionOrderEvent, bool]:
    """Persist a normalized event and link it to execution/trade_decision rows."""

    existing = session.execute(
        select(ExecutionOrderEvent).where(ExecutionOrderEvent.event_fingerprint == event.event_fingerprint)
    ).scalar_one_or_none()
    if existing is not None:
        return existing, True

    execution = _resolve_execution(session, event)
    trade_decision_id = None
    if execution is not None:
        trade_decision_id = execution.trade_decision_id
    elif event.client_order_id:
        decision = session.execute(
            select(TradeDecision).where(TradeDecision.decision_hash == event.client_order_id)
        ).scalar_one_or_none()
        if decision is not None:
            trade_decision_id = decision.id

    row = ExecutionOrderEvent(
        event_fingerprint=event.event_fingerprint,
        source_topic=event.source_topic,
        source_partition=event.source_partition,
        source_offset=event.source_offset,
        feed_seq=event.feed_seq,
        event_ts=event.event_ts,
        symbol=event.symbol,
        alpaca_order_id=event.alpaca_order_id,
        client_order_id=event.client_order_id,
        event_type=event.event_type,
        status=event.status,
        qty=event.qty,
        filled_qty=event.filled_qty,
        avg_fill_price=event.avg_fill_price,
        raw_event=event.raw_event,
        execution_id=execution.id if execution is not None else None,
        trade_decision_id=trade_decision_id,
    )
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = session.execute(
            select(ExecutionOrderEvent).where(ExecutionOrderEvent.event_fingerprint == event.event_fingerprint)
        ).scalar_one_or_none()
        if existing is None:
            raise
        return existing, True

    return row, False


def apply_order_event_to_execution(execution: Execution, event: ExecutionOrderEvent) -> tuple[bool, bool]:
    """Apply event evidence to execution if event ordering is not stale/out-of-order."""

    if event.status is None and event.filled_qty is None and event.avg_fill_price is None:
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
    if event.avg_fill_price is not None and execution.avg_fill_price != event.avg_fill_price:
        execution.avg_fill_price = event.avg_fill_price
        updated = True

    if event.event_ts is not None:
        execution.order_feed_last_event_ts = event.event_ts
        execution.last_update_at = event.event_ts
    if event.feed_seq is not None:
        execution.order_feed_last_seq = event.feed_seq

    if execution.execution_actual_adapter is None and execution.execution_expected_adapter is not None:
        execution.execution_actual_adapter = execution.execution_expected_adapter

    execution.raw_order = coerce_json_payload(event.raw_event)
    return updated, False


def latest_order_event_for_execution(session: Session, execution: Execution) -> ExecutionOrderEvent | None:
    """Fetch newest persisted order event linked to an execution."""

    filters: list[ColumnElement[bool]] = [ExecutionOrderEvent.execution_id == execution.id]
    if execution.alpaca_order_id:
        filters.append(ExecutionOrderEvent.alpaca_order_id == execution.alpaca_order_id)
    if execution.client_order_id:
        filters.append(ExecutionOrderEvent.client_order_id == execution.client_order_id)

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


def _resolve_execution(session: Session, event: NormalizedOrderEvent) -> Execution | None:
    clauses: list[ColumnElement[bool]] = []
    if event.alpaca_order_id:
        clauses.append(Execution.alpaca_order_id == event.alpaca_order_id)
    if event.client_order_id:
        clauses.append(Execution.client_order_id == event.client_order_id)
    if not clauses:
        return None
    return session.execute(select(Execution).where(or_(*clauses))).scalar_one_or_none()


def _extract_trade_update_payload(payload: Any) -> Mapping[str, Any] | None:
    root = _as_mapping(payload)
    if root is None:
        return None

    channel = _coerce_text(root.get('channel'))
    inner_payload = _as_mapping(root.get('payload'))
    if channel == 'trade_updates' and inner_payload is not None:
        return inner_payload

    stream = _coerce_text(root.get('stream'))
    data_payload = _as_mapping(root.get('data'))
    if stream == 'trade_updates' and data_payload is not None:
        return data_payload

    if _as_mapping(root.get('order')) is not None:
        return root

    return None


def _decode_json_payload(raw: Any) -> dict[str, Any] | list[Any] | None:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        if isinstance(raw, dict):
            return cast(dict[str, Any], raw)
        return cast(list[Any], raw)
    if isinstance(raw, bytes):
        try:
            decoded = json.loads(raw.decode('utf-8'))
            if isinstance(decoded, dict):
                return cast(dict[str, Any], decoded)
            if isinstance(decoded, list):
                return cast(list[Any], decoded)
            return None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
            if isinstance(decoded, dict):
                return cast(dict[str, Any], decoded)
            if isinstance(decoded, list):
                return cast(list[Any], decoded)
            return None
        except json.JSONDecodeError:
            return None
    return None


def _flatten_poll_records(polled: Any) -> list[Any]:
    if not polled:
        return []
    if isinstance(polled, Mapping):
        rows: list[Any] = []
        for records in polled.values():
            if isinstance(records, list):
                rows.extend(records)
        return rows
    if isinstance(polled, list):
        return polled
    return []


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
    normalized = text.replace('Z', '+00:00')
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
    baseline = execution.order_feed_last_event_ts or execution.last_update_at
    if baseline is None:
        return False
    if baseline.tzinfo is None:
        baseline = baseline.replace(tzinfo=timezone.utc)
    return candidate_ts < baseline


def _update_trade_decision_from_execution(session: Session, execution: Execution) -> None:
    if execution.trade_decision_id is None:
        return
    decision = session.get(TradeDecision, execution.trade_decision_id)
    if decision is None:
        return
    decision.status = execution.status
    if execution.status == 'filled' and decision.executed_at is None:
        decision.executed_at = execution.last_update_at or datetime.now(timezone.utc)
    session.add(decision)


def _commit_consumer(consumer: Any) -> None:
    run_commit = cast(Callable[[], Any] | None, getattr(consumer, 'commit', None))
    if run_commit is None:
        return
    try:
        run_commit()
    except Exception as exc:  # pragma: no cover - external Kafka failure
        logger.warning('Order-feed consumer commit failed: %s', exc)


__all__ = [
    'NormalizedOrderEvent',
    'NormalizationResult',
    'OrderFeedIngestor',
    'normalize_order_feed_record',
    'persist_order_event',
    'apply_order_event_to_execution',
    'latest_order_event_for_execution',
]

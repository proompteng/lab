"""Kafka-backed order-feed ingestion and persistence helpers."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from decimal import Decimal
from typing import Any, Mapping, cast

from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ...config import settings
from ...models import (
    Execution,
    ExecutionOrderEvent,
    TradeDecision,
    coerce_json_payload,
)
from ..tca import upsert_execution_tca_metric
from ..tigerbeetle_journal import TigerBeetleLedgerJournal
from ..infrastructure_validation_records import (
    defer_pending_infrastructure_validation_descendant,
    load_infrastructure_validation_evidence,
    strip_unproven_infrastructure_validation_evidence,
    tag_infrastructure_validation_event,
)


from .shared_context import (
    FILL_QUANTITY_BASIS_CUMULATIVE_NON_INCREASING,
    FILL_QUANTITY_BASIS_CUMULATIVE_TO_DELTA,
    FILL_QUANTITY_BASIS_DELTA,
    NormalizationResult,
    NormalizedOrderEvent,
    FILL_EVENT_TYPES as _FILL_EVENT_TYPES,
    as_mapping as _as_mapping,
    coerce_datetime as _coerce_datetime,
    coerce_decimal as _coerce_decimal,
    coerce_int as _coerce_int,
    coerce_text as _coerce_text,
    decode_json_payload as _decode_json_payload,
    extract_trade_update_payload as _extract_trade_update_payload,
    logger,
)

from .classify_source_window_drop import (
    execution_correlation_identity_from_payload as _execution_correlation_identity_from_payload,
    mark_order_event_account_alias as _mark_order_event_account_alias,
    missing_linkage_blockers as _missing_linkage_blockers,
    order_event_client_identity as _order_event_client_identity,
    order_event_execution_correlation_identity as _order_event_execution_correlation_identity,
    raw_event_with_linkage_blockers as _raw_event_with_linkage_blockers,
)


def _resolve_execution_linkage_for_identity(*args: Any, **kwargs: Any) -> Any:
    from .resolve_execution_linkage_for_identity import (
        resolve_execution_linkage_for_identity as resolve_execution_linkage,
    )

    return resolve_execution_linkage(*args, **kwargs)


def _is_stale_by_seq(execution: Execution, event: ExecutionOrderEvent) -> bool:
    from .flatten_poll_records import (
        is_stale_by_seq,
    )

    return is_stale_by_seq(execution, event)


def _is_stale_by_ts(execution: Execution, event: ExecutionOrderEvent) -> bool:
    from .flatten_poll_records import (
        is_stale_by_ts,
    )

    return is_stale_by_ts(execution, event)


def _update_trade_decision_from_execution(*args: Any, **kwargs: Any) -> None:
    from .flatten_poll_records import (
        update_trade_decision_from_execution as update_trade_decision,
    )

    update_trade_decision(*args, **kwargs)


def _refresh_source_window_linkage_counts(*args: Any, **kwargs: Any) -> None:
    from .resolve_execution_linkage_for_identity import (
        refresh_source_window_linkage_counts as refresh_linkage_counts,
    )

    refresh_linkage_counts(*args, **kwargs)


def _resolve_trade_decision_linkage_for_identity(*args: Any, **kwargs: Any) -> Any:
    from .resolve_execution_linkage_for_identity import (
        resolve_trade_decision_linkage_for_identity as resolve_trade_decision_linkage,
    )

    return resolve_trade_decision_linkage(*args, **kwargs)


def _ensure_source_window_for_event(*args: Any, **kwargs: Any) -> Any:
    from .repair_order_feed_execution_links import (
        ensure_source_window_for_event as ensure_source_window,
    )

    return ensure_source_window(*args, **kwargs)


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
    client_order_id = _coerce_text(
        (order or {}).get("client_order_id")
        or (order or {}).get("clientOrderId")
        or (order or {}).get("idempotency_key")
        or (order or {}).get("idempotencyKey")
        or (order or {}).get("execution_idempotency_key")
        or (order or {}).get("executionIdempotencyKey")
        or (order or {}).get("_execution_idempotency_key")
    )
    if alpaca_order_id is None:
        alpaca_order_id = _coerce_text(
            (order or {}).get("order_id") or (order or {}).get("orderId")
        )
    execution_correlation_id = _execution_correlation_identity_from_payload(payload)

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

    if (
        alpaca_order_id is None
        and client_order_id is None
        and execution_correlation_id is None
    ):
        return NormalizationResult(event=None, drop_reason="missing_order_identity")

    qty = _coerce_decimal((order or {}).get("qty"))
    filled_qty = _coerce_decimal((order or {}).get("filled_qty"))
    position_qty = _coerce_decimal(data_payload.get("position_qty"))
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
        "execution_correlation_id": execution_correlation_id,
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
        execution_correlation_id=execution_correlation_id,
        event_type=event_type,
        status=status,
        qty=qty,
        filled_qty=filled_qty,
        position_qty=position_qty,
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
        "execution_correlation_id": event.execution_correlation_id,
        "event_type": event.event_type,
        "status": event.status,
        "event_ts": event.event_ts.isoformat() if event.event_ts else None,
        "feed_seq": event.feed_seq,
        "qty": str(event.qty) if event.qty is not None else None,
        "filled_qty": str(event.filled_qty) if event.filled_qty is not None else None,
        "position_qty": (
            str(event.position_qty) if event.position_qty is not None else None
        ),
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
        clauses.append(
            (Execution.execution_idempotency_key == event.client_order_id)
            & (Execution.alpaca_account_label == account_label)
        )
    if event.execution_correlation_id:
        clauses.append(
            (Execution.execution_correlation_id == event.execution_correlation_id)
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

    validation_evidence = load_infrastructure_validation_evidence(
        session,
        account_label=event.alpaca_account_label,
        client_order_id=event.client_order_id,
        alpaca_order_id=event.alpaca_order_id,
    )
    if validation_evidence is None:
        defer_pending_infrastructure_validation_descendant(
            session,
            account_label=event.alpaca_account_label,
            symbol=event.symbol,
        )
    existing = session.execute(
        select(ExecutionOrderEvent).where(
            ExecutionOrderEvent.event_fingerprint == event.event_fingerprint
        )
    ).scalar_one_or_none()
    if existing is not None:
        if validation_evidence is not None:
            existing.raw_event = tag_infrastructure_validation_event(
                existing.raw_event,
                validation_evidence,
            )
            existing.execution_id = None
            existing.trade_decision_id = None
            session.add(existing)
            if existing.source_window_id is not None:
                _refresh_source_window_linkage_counts(session, existing)
        else:
            sanitized_raw_event = strip_unproven_infrastructure_validation_evidence(
                existing.raw_event
            )
            if sanitized_raw_event != coerce_json_payload(existing.raw_event):
                existing.raw_event = sanitized_raw_event
                session.add(existing)
        if existing.source_window_id is None and source_window_id is not None:
            existing.source_window_id = source_window_id
            session.add(existing)
            _refresh_source_window_linkage_counts(session, existing)
        _journal_tigerbeetle_order_event(session, existing)
        return existing, True

    filled_qty_delta, filled_notional_delta, fill_quantity_basis = _fill_delta_fields(
        session, event
    )
    execution = None
    raw_event = strip_unproven_infrastructure_validation_evidence(event.raw_event)
    trade_decision_id = None
    if validation_evidence is not None:
        raw_event = tag_infrastructure_validation_event(
            event.raw_event,
            validation_evidence,
        )
    else:
        execution_linkage = _resolve_execution_linkage_for_identity(
            session,
            account_label=event.alpaca_account_label,
            alpaca_order_id=event.alpaca_order_id,
            client_order_id=event.client_order_id,
            execution_correlation_id=event.execution_correlation_id,
        )
        execution = execution_linkage.execution
        if execution is not None:
            trade_decision_id = execution.trade_decision_id
            raw_event = _raw_event_with_linkage_blockers(raw_event, ())
        elif not execution_linkage.blockers:
            decision_linkage = _resolve_trade_decision_linkage_for_identity(
                session,
                account_label=event.alpaca_account_label,
                client_order_id=event.client_order_id,
            )
            if decision_linkage.trade_decision is not None:
                trade_decision_id = decision_linkage.trade_decision.id
            linkage_blockers = list(
                _missing_linkage_blockers(
                    execution_missing=True,
                    decision_missing=decision_linkage.trade_decision is None
                    and not decision_linkage.blockers,
                )
            )
            linkage_blockers.extend(decision_linkage.blockers)
            raw_event = _raw_event_with_linkage_blockers(
                raw_event,
                linkage_blockers,
            )
        else:
            raw_event = _raw_event_with_linkage_blockers(
                raw_event,
                execution_linkage.blockers,
            )

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
        position_qty=event.position_qty,
        filled_qty_delta=filled_qty_delta,
        avg_fill_price=event.avg_fill_price,
        filled_notional_delta=filled_notional_delta,
        fill_quantity_basis=fill_quantity_basis,
        raw_event=raw_event,
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

    raw_event = _as_mapping(event.raw_event) or {}
    raw_fill = _extract_trade_update_payload(raw_event) or {}
    raw_fill_qty = _coerce_decimal(
        raw_fill.get("fill_qty")
        or raw_fill.get("last_fill_qty")
        or raw_fill.get("filled_qty_delta")
        or raw_fill.get("qty")
        or raw_fill.get("quantity")
    )
    raw_fill_price = _coerce_decimal(
        raw_fill.get("fill_price")
        or raw_fill.get("last_fill_price")
        or raw_fill.get("execution_price")
        or raw_fill.get("price")
    )
    if raw_fill_qty is not None and raw_fill_qty > 0:
        return (
            raw_fill_qty,
            raw_fill_qty * raw_fill_price if raw_fill_price is not None else None,
            FILL_QUANTITY_BASIS_DELTA,
        )

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
        ExecutionOrderEvent.execution_id == execution.id
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
    if execution.execution_idempotency_key:
        filters.append(
            (ExecutionOrderEvent.client_order_id == execution.execution_idempotency_key)
            & (
                ExecutionOrderEvent.alpaca_account_label
                == execution.alpaca_account_label
            )
        )
    stmt = (
        select(ExecutionOrderEvent)
        .where(or_(*filters))
        .order_by(
            ExecutionOrderEvent.feed_seq.desc().nullslast(),
            ExecutionOrderEvent.source_offset.desc().nullslast(),
            ExecutionOrderEvent.event_ts.desc().nullslast(),
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
    source_account_label: str | None = None,
) -> int:
    """Attach previously ingested order-feed events once their Execution exists."""

    event_account_label = (
        source_account_label.strip()
        if source_account_label is not None and source_account_label.strip()
        else execution.alpaca_account_label
    )
    clauses: list[ColumnElement[bool]] = []
    if execution.alpaca_order_id:
        clauses.append(
            (ExecutionOrderEvent.alpaca_order_id == execution.alpaca_order_id)
            & (ExecutionOrderEvent.alpaca_account_label == event_account_label)
        )
    if execution.client_order_id:
        clauses.append(
            (ExecutionOrderEvent.client_order_id == execution.client_order_id)
            & (ExecutionOrderEvent.alpaca_account_label == event_account_label)
        )
    if execution.execution_idempotency_key:
        clauses.append(
            (ExecutionOrderEvent.client_order_id == execution.execution_idempotency_key)
            & (ExecutionOrderEvent.alpaca_account_label == event_account_label)
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
            ExecutionOrderEvent.feed_seq.asc().nullsfirst(),
            ExecutionOrderEvent.source_offset.asc().nullsfirst(),
            ExecutionOrderEvent.event_ts.asc().nullsfirst(),
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
        if (
            load_infrastructure_validation_evidence(
                session,
                account_label=event.alpaca_account_label,
                client_order_id=event.client_order_id,
                alpaca_order_id=event.alpaca_order_id,
            )
            is not None
        ):
            continue
        event_execution_linkage = _resolve_execution_linkage_for_identity(
            session,
            account_label=execution.alpaca_account_label,
            alpaca_order_id=event.alpaca_order_id,
            client_order_id=_order_event_client_identity(event),
            execution_correlation_id=_order_event_execution_correlation_identity(event),
        )
        if event_execution_linkage.blockers:
            event.raw_event = _raw_event_with_linkage_blockers(
                event.raw_event,
                event_execution_linkage.blockers,
            )
            _ensure_source_window_for_event(session, event)
            session.add(event)
            _refresh_source_window_linkage_counts(session, event)
            continue
        if (
            event_execution_linkage.execution is not None
            and event_execution_linkage.execution.id != execution.id
        ):
            continue
        changed = False
        if event.alpaca_account_label != execution.alpaca_account_label:
            _mark_order_event_account_alias(
                event,
                source_account_label=event.alpaca_account_label,
                canonical_account_label=execution.alpaca_account_label,
                basis="matched_order_identity",
            )
            changed = True
        if event.execution_id is None:
            event.execution_id = execution.id
            changed = True
        if event.trade_decision_id is None:
            trade_decision_id = execution.trade_decision_id
            if trade_decision_id is None:
                decision_linkage = _resolve_trade_decision_linkage_for_identity(
                    session,
                    account_label=execution.alpaca_account_label,
                    client_order_id=_order_event_client_identity(event),
                )
                if decision_linkage.blockers:
                    event.raw_event = _raw_event_with_linkage_blockers(
                        event.raw_event,
                        decision_linkage.blockers,
                    )
                decision = decision_linkage.trade_decision
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


# Public aliases used by split-module consumers.
event_with_default_account_label_if_in_scope = (
    _event_with_default_account_label_if_in_scope
)
fill_delta_fields = _fill_delta_fields
fingerprint_normalized_order_event = _fingerprint_normalized_order_event
is_fill_event = _is_fill_event
journal_tigerbeetle_order_event = _journal_tigerbeetle_order_event
order_identity_matches_account_scope = _order_identity_matches_account_scope

__all__ = (
    "normalize_order_feed_record",
    "persist_order_event",
    "apply_order_event_to_execution",
    "merge_execution_raw_order_update",
    "latest_order_event_for_execution",
    "link_order_events_to_execution",
    "event_with_default_account_label_if_in_scope",
    "fill_delta_fields",
    "fingerprint_normalized_order_event",
    "is_fill_event",
    "journal_tigerbeetle_order_event",
    "order_identity_matches_account_scope",
)

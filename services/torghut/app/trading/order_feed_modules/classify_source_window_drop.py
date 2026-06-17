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

# ruff: noqa: F401

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
    as_mapping as _as_mapping,
    coerce_datetime as _coerce_datetime,
    coerce_int as _coerce_int,
    coerce_text as _coerce_text,
    create_order_feed_source_window as _create_order_feed_source_window,
    decode_json_payload as _decode_json_payload,
    event_out_of_scope_for_default_account as _event_out_of_scope_for_default_account,
    extract_trade_update_payload as _extract_trade_update_payload,
    isoformat_datetime as _isoformat_datetime,
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
    classification_counts = {drop_reason or "unknown_drop": 1}
    source_window.classification_counts = classification_counts
    source_window.payload_json = {
        "classification": drop_reason or "unknown_drop",
        "classification_counts": classification_counts,
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
    classification_counts = {"failed_unhandled": 1}
    source_window.classification_counts = classification_counts
    source_window.payload_json = {
        "classification": "failed_unhandled",
        "classification_counts": classification_counts,
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
        classification_counts = {"duplicate": 1}
        source_window.classification_counts = classification_counts
        payload: dict[str, Any] = {
            "classification": "duplicate",
            "classification_counts": classification_counts,
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
    source_window.classification_counts = classification_counts
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
        or (_coerce_text(order.get("order_id")) if order is not None else None)
        or (_coerce_text(order.get("orderId")) if order is not None else None),
        client_order_id=(
            _coerce_text(order.get("client_order_id")) if order is not None else None
        )
        or (_coerce_text(order.get("clientOrderId")) if order is not None else None)
        or (_coerce_text(order.get("idempotency_key")) if order is not None else None)
        or (_coerce_text(order.get("idempotencyKey")) if order is not None else None)
        or (
            _coerce_text(order.get("execution_idempotency_key"))
            if order is not None
            else None
        )
        or (
            _coerce_text(order.get("_execution_idempotency_key"))
            if order is not None
            else None
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
        "execution_correlation_id": _execution_correlation_identity_from_payload(
            decoded_payload
        ),
        "lifecycle": lifecycle,
    }
    if explicit_account_label is not None:
        payload["source_account_label"] = explicit_account_label
    return payload


def _order_event_evidence_payload(event: ExecutionOrderEvent) -> dict[str, Any]:
    linkage_blockers = _order_event_linkage_blockers(event)
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
    payload: dict[str, Any] = {
        "event_source_ref": {
            "topic": event.source_topic,
            "partition": event.source_partition,
            "offset": event.source_offset,
        },
        "order_identity": _order_identity_payload(
            alpaca_order_id=event.alpaca_order_id,
            client_order_id=event.client_order_id,
        ),
        "execution_correlation_id": _order_event_execution_correlation_identity(event),
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
        "promotion_authority_eligible": False,
        "promotion_authority_blocker": "order_feed_source_refs_require_runtime_ledger_import",
    }
    if linkage_blockers:
        payload["linkage_blockers"] = linkage_blockers
        payload["linkage_classification"] = linkage_blockers[0]
    account_alias = _order_event_account_label_alias(event)
    if account_alias is not None:
        payload["account_label_alias"] = account_alias
    return payload


def _raw_event_with_linkage_blockers(
    raw_event: Any,
    blockers: tuple[str, ...] | list[str],
) -> Any:
    unique_blockers = _dedupe([blocker for blocker in blockers if blocker])
    coerced = coerce_json_payload(raw_event)
    if isinstance(coerced, Mapping):
        payload: dict[str, Any] = {
            str(key): value
            for key, value in cast(Mapping[object, Any], coerced).items()
        }
    else:
        payload = {"payload": coerced}

    if not unique_blockers:
        payload.pop("_torghut_linkage", None)
        return coerce_json_payload(payload)

    existing = payload.get("_torghut_linkage")
    linkage_payload: dict[str, Any] = {}
    if isinstance(existing, Mapping):
        linkage_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], existing).items()
        }
    linkage_payload["blockers"] = unique_blockers
    linkage_payload["classification"] = unique_blockers[0]
    payload["_torghut_linkage"] = linkage_payload
    return coerce_json_payload(payload)


def _order_event_linkage_blockers(event: ExecutionOrderEvent) -> list[str]:
    raw_event = coerce_json_payload(event.raw_event)
    if not isinstance(raw_event, Mapping):
        return []
    linkage = cast(Mapping[object, Any], raw_event).get("_torghut_linkage")
    if not isinstance(linkage, Mapping):
        return []
    raw_blockers = cast(Mapping[object, Any], linkage).get("blockers")
    if isinstance(raw_blockers, str):
        return [raw_blockers] if raw_blockers else []
    if not isinstance(raw_blockers, list):
        return []
    blocker_items = cast(list[object], raw_blockers)
    return _dedupe(
        [text for item in blocker_items if (text := str(item or "").strip())]
    )


def _missing_linkage_blockers(
    *,
    execution_missing: bool,
    decision_missing: bool,
) -> tuple[str, ...]:
    blockers: list[str] = []
    if execution_missing:
        blockers.append("missing_execution_link")
    if decision_missing:
        blockers.append("missing_trade_decision_link")
    return tuple(blockers)


def _order_event_account_label_alias(
    event: ExecutionOrderEvent,
) -> dict[str, str] | None:
    raw_event = coerce_json_payload(event.raw_event)
    if not isinstance(raw_event, Mapping):
        return None
    alias = cast(Mapping[object, Any], raw_event).get("_torghut_account_label_alias")
    if not isinstance(alias, Mapping):
        return None
    source_account_label = _coerce_text(
        cast(Mapping[object, Any], alias).get("source_account_label")
    )
    canonical_account_label = _coerce_text(
        cast(Mapping[object, Any], alias).get("canonical_account_label")
    )
    basis = _coerce_text(cast(Mapping[object, Any], alias).get("basis"))
    if source_account_label is None or canonical_account_label is None:
        return None
    return {
        "source_account_label": source_account_label,
        "canonical_account_label": canonical_account_label,
        "basis": basis or "matched_order_identity",
    }


def _mark_order_event_account_alias(
    event: ExecutionOrderEvent,
    *,
    source_account_label: str,
    canonical_account_label: str,
    basis: str,
) -> None:
    raw_event = coerce_json_payload(event.raw_event)
    if isinstance(raw_event, Mapping):
        aliased_raw_event: dict[str, Any] = {
            str(key): value
            for key, value in cast(Mapping[object, Any], raw_event).items()
        }
    else:
        aliased_raw_event = {"payload": raw_event}
    aliased_raw_event["_torghut_account_label_alias"] = {
        "source_account_label": source_account_label,
        "canonical_account_label": canonical_account_label,
        "basis": basis,
    }
    event.raw_event = coerce_json_payload(aliased_raw_event)


def _order_event_client_identity(event: ExecutionOrderEvent) -> str | None:
    if event.client_order_id:
        return event.client_order_id
    raw_event = coerce_json_payload(event.raw_event)
    if not isinstance(raw_event, Mapping):
        return None
    payload = _extract_trade_update_payload(raw_event)
    order = _as_mapping(payload.get("order")) if payload is not None else None
    if order is None:
        order = _as_mapping(cast(Mapping[object, Any], raw_event).get("order"))
    if order is None:
        return None
    return (
        _coerce_text(order.get("client_order_id"))
        or _coerce_text(order.get("clientOrderId"))
        or _coerce_text(order.get("idempotency_key"))
        or _coerce_text(order.get("idempotencyKey"))
        or _coerce_text(order.get("execution_idempotency_key"))
        or _coerce_text(order.get("executionIdempotencyKey"))
        or _coerce_text(order.get("_execution_idempotency_key"))
    )


def _order_event_execution_correlation_identity(
    event: ExecutionOrderEvent,
) -> str | None:
    return _execution_correlation_identity_from_payload(event.raw_event)


def _execution_correlation_identity_from_payload(payload: Any) -> str | None:
    coerced = coerce_json_payload(payload)
    candidates: list[Any] = []
    if isinstance(coerced, Mapping):
        mapping = cast(Mapping[object, Any], coerced)
        candidates.extend(
            [
                mapping.get("execution_correlation_id"),
                mapping.get("executionCorrelationId"),
                mapping.get("_execution_correlation_id"),
            ]
        )
        data_payload = _extract_trade_update_payload(mapping)
        if data_payload is not None:
            candidates.extend(
                [
                    data_payload.get("execution_correlation_id"),
                    data_payload.get("executionCorrelationId"),
                    data_payload.get("_execution_correlation_id"),
                ]
            )
            order = _as_mapping(data_payload.get("order"))
            if order is not None:
                candidates.extend(
                    [
                        order.get("execution_correlation_id"),
                        order.get("executionCorrelationId"),
                        order.get("_execution_correlation_id"),
                    ]
                )
        order = _as_mapping(mapping.get("order"))
        if order is not None:
            candidates.extend(
                [
                    order.get("execution_correlation_id"),
                    order.get("executionCorrelationId"),
                    order.get("_execution_correlation_id"),
                ]
            )
    for candidate in candidates:
        text = _coerce_text(candidate)
        if text is not None:
            return text
    return None


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


def _dedupe(items: list[str] | tuple[str, ...]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        deduped.append(text)
    return deduped


def _source_window_event_status_reason(event: ExecutionOrderEvent) -> str:
    if event.execution_id is not None and event.trade_decision_id is not None:
        return "linked_execution_and_decision"
    linkage_blockers = _order_event_linkage_blockers(event)
    if linkage_blockers:
        if (
            event.execution_id is None
            and event.trade_decision_id is None
            and "missing_execution_link" in linkage_blockers
            and "missing_trade_decision_link" in linkage_blockers
        ):
            return "missing_execution_and_decision_links"
        return linkage_blockers[0]
    if event.execution_id is None and event.trade_decision_id is None:
        return "missing_execution_and_decision_links"
    if event.execution_id is None:
        return "missing_execution_link"
    return "missing_trade_decision_link"


# Public aliases used by split-module consumers.
classify_source_window_drop = _classify_source_window_drop
classify_source_window_event = _classify_source_window_event
classify_source_window_unhandled_failure = _classify_source_window_unhandled_failure
dedupe = _dedupe
execution_correlation_identity_from_payload = (
    _execution_correlation_identity_from_payload
)
increment_drop_counter = _increment_drop_counter
lifecycle_payload = _lifecycle_payload
mark_order_event_account_alias = _mark_order_event_account_alias
missing_linkage_blockers = _missing_linkage_blockers
order_event_account_label_alias = _order_event_account_label_alias
order_event_client_identity = _order_event_client_identity
order_event_evidence_payload = _order_event_evidence_payload
order_event_execution_correlation_identity = _order_event_execution_correlation_identity
order_event_linkage_blockers = _order_event_linkage_blockers
order_identity_payload = _order_identity_payload
raw_event_with_linkage_blockers = _raw_event_with_linkage_blockers
raw_record_source_evidence_payload = _raw_record_source_evidence_payload
source_window_event_status_reason = _source_window_event_status_reason
source_window_failure_reason = _source_window_failure_reason
source_window_source_identity_payload = _source_window_source_identity_payload
source_window_source_identity_payload_for_values = (
    _source_window_source_identity_payload_for_values
)

__all__ = (
    "classify_source_window_drop",
    "classify_source_window_event",
    "classify_source_window_unhandled_failure",
    "dedupe",
    "execution_correlation_identity_from_payload",
    "increment_drop_counter",
    "lifecycle_payload",
    "mark_order_event_account_alias",
    "missing_linkage_blockers",
    "order_event_account_label_alias",
    "order_event_client_identity",
    "order_event_evidence_payload",
    "order_event_execution_correlation_identity",
    "order_event_linkage_blockers",
    "order_identity_payload",
    "raw_event_with_linkage_blockers",
    "raw_record_source_evidence_payload",
    "source_window_event_status_reason",
    "source_window_failure_reason",
    "source_window_source_identity_payload",
    "source_window_source_identity_payload_for_values",
)

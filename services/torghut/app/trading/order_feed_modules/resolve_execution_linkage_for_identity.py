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


def _resolve_execution_linkage_for_identity(
    session: Session,
    *,
    account_label: str,
    alpaca_order_id: str | None,
    client_order_id: str | None,
    execution_correlation_id: str | None = None,
) -> _ExecutionLinkageResolution:
    clauses: list[ColumnElement[bool]] = []
    if alpaca_order_id:
        clauses.append(Execution.alpaca_order_id == alpaca_order_id)
    if client_order_id:
        clauses.append(Execution.client_order_id == client_order_id)
        clauses.append(Execution.execution_idempotency_key == client_order_id)
    if execution_correlation_id:
        clauses.append(Execution.execution_correlation_id == execution_correlation_id)
    if not clauses:
        return _ExecutionLinkageResolution(
            execution=None,
            blockers=("order_feed_execution_identity_missing",),
        )

    matches = (
        session.execute(
            select(Execution)
            .where(
                Execution.alpaca_account_label == account_label,
                or_(*clauses),
            )
            .order_by(
                Execution.order_feed_last_event_ts.desc().nullslast(),
                Execution.last_update_at.desc().nullslast(),
                Execution.created_at.desc(),
                Execution.id.asc(),
            )
            .limit(2)
        )
        .scalars()
        .all()
    )
    unique_matches = list({match.id: match for match in matches}.values())
    if len(unique_matches) == 1:
        return _ExecutionLinkageResolution(execution=unique_matches[0])
    if len(unique_matches) > 1:
        return _ExecutionLinkageResolution(
            execution=None,
            blockers=("ambiguous_execution_identity",),
        )

    other_account_match = session.scalar(
        select(
            exists().where(
                Execution.alpaca_account_label != account_label,
                or_(*clauses),
            )
        )
    )
    if other_account_match:
        return _ExecutionLinkageResolution(
            execution=None,
            blockers=("account_mismatch_execution_identity",),
        )
    return _ExecutionLinkageResolution(execution=None)


def _resolve_trade_decision_linkage_for_identity(
    session: Session,
    *,
    account_label: str,
    client_order_id: str | None,
) -> _TradeDecisionLinkageResolution:
    if not client_order_id:
        return _TradeDecisionLinkageResolution(
            trade_decision=None,
            blockers=("order_feed_trade_decision_identity_missing",),
        )

    matches = (
        session.execute(
            select(TradeDecision)
            .where(
                TradeDecision.decision_hash == client_order_id,
                TradeDecision.alpaca_account_label == account_label,
            )
            .order_by(TradeDecision.created_at.desc(), TradeDecision.id.asc())
            .limit(2)
        )
        .scalars()
        .all()
    )
    unique_matches = list({match.id: match for match in matches}.values())
    if len(unique_matches) == 1:
        return _TradeDecisionLinkageResolution(trade_decision=unique_matches[0])
    if len(unique_matches) > 1:
        return _TradeDecisionLinkageResolution(
            trade_decision=None,
            blockers=("ambiguous_trade_decision_identity",),
        )

    other_account_match = session.scalar(
        select(
            exists().where(
                TradeDecision.alpaca_account_label != account_label,
                TradeDecision.decision_hash == client_order_id,
            )
        )
    )
    if other_account_match:
        return _TradeDecisionLinkageResolution(
            trade_decision=None,
            blockers=("account_mismatch_trade_decision_identity",),
        )
    return _TradeDecisionLinkageResolution(trade_decision=None)


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


def _cross_dsn_linkage_counts_for_source_window(
    session: Session,
    source_window_id: object,
) -> dict[str, int]:
    rows = session.execute(
        select(ExecutionOrderEvent.raw_event).where(
            ExecutionOrderEvent.source_window_id == source_window_id
        )
    ).all()
    execution_refs = 0
    decision_refs = 0
    tca_refs = 0
    for (raw_event,) in rows:
        payload = coerce_json_payload(raw_event)
        if not isinstance(payload, Mapping):
            continue
        payload_mapping = cast(Mapping[object, Any], payload)
        raw_linkage = payload_mapping.get("_torghut_cross_dsn_linkage")
        if not isinstance(raw_linkage, Mapping):
            continue
        linkage = cast(Mapping[object, Any], raw_linkage)
        if linkage.get("canonical_execution_id"):
            execution_refs += 1
        if linkage.get("canonical_trade_decision_id"):
            decision_refs += 1
        if linkage.get("canonical_execution_tca_metric_id"):
            tca_refs += 1
    return {
        "cross_dsn_execution_ref_count": execution_refs,
        "cross_dsn_trade_decision_ref_count": decision_refs,
        "cross_dsn_tca_ref_count": tca_refs,
    }


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
    linkage_blockers = _order_event_linkage_blockers(event)
    for blocker in linkage_blockers:
        classification_counts[blocker] = 1
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
    cross_dsn_counts = _cross_dsn_linkage_counts_for_source_window(
        session,
        event.source_window_id,
    )
    for count_key, count_value in cross_dsn_counts.items():
        payload_dict[count_key] = count_value
        if count_value:
            classification_counts[count_key] = count_value
        else:
            classification_counts.pop(count_key, None)
    payload_dict["classification_counts"] = classification_counts
    source_window.classification_counts = classification_counts
    source_window_complete = bool(
        event_count
        and source_window.unlinked_execution_count == 0
        and source_window.unlinked_decision_count == 0
        and event.source_partition is not None
        and event.source_offset is not None
    )
    payload_dict["source_coverage_complete"] = source_window_complete
    payload_dict["promotion_authority_eligible"] = False
    payload_dict["promotion_authority_blocker"] = (
        "order_feed_source_refs_require_runtime_ledger_import"
    )
    payload_dict["authority_class"] = (
        "runtime_order_feed_execution_source"
        if source_window_complete
        else "order_feed_lifecycle_unlinked"
    )
    if source_window.source_revision != HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION:
        source_window.status_reason = _source_window_event_status_reason(event)
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
        raw_classification_counts = payload_dict.get("classification_counts")
        if isinstance(raw_classification_counts, Mapping):
            source_window.classification_counts = {
                str(key): value
                for key, value in cast(
                    Mapping[object, Any],
                    raw_classification_counts,
                ).items()
            }
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


__all__ = [name for name in globals() if not name.startswith("__")]

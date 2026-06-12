#!/usr/bin/env python3
"""Annotate live order-feed events with canonical SIM execution references."""

from __future__ import annotations

import argparse
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence, cast

from sqlalchemy import create_engine, func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
    TradeDecision,
    coerce_json_payload,
)


_LINKAGE_KEY = "_torghut_cross_dsn_linkage"
_LINKAGE_SCHEMA_VERSION = "torghut.cross-dsn-order-feed-linkage.v1"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Cross-link live order-feed evidence to canonical SIM executions across DSNs "
            "without creating live execution ledger rows."
        ),
    )
    parser.add_argument("--event-dsn-env", default="DB_DSN")
    parser.add_argument("--canonical-dsn-env", default="SIM_DB_DSN")
    parser.add_argument("--source-account-label", required=True)
    parser.add_argument("--canonical-account-label", required=True)
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _parse_dt(value: object) -> datetime:
    text = str(value).strip()
    if not text:
        raise SystemExit("empty_datetime")
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _event_window_expr() -> Any:
    return func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)


def _event_candidates(
    session: Session,
    *,
    source_account_label: str,
    window_start: datetime,
    window_end: datetime,
    limit: int,
) -> Sequence[ExecutionOrderEvent]:
    window_expr = _event_window_expr()
    return list(
        session.scalars(
            select(ExecutionOrderEvent)
            .where(
                ExecutionOrderEvent.alpaca_account_label == source_account_label,
                or_(
                    ExecutionOrderEvent.execution_id.is_(None),
                    ExecutionOrderEvent.trade_decision_id.is_(None),
                ),
                or_(
                    ExecutionOrderEvent.alpaca_order_id.is_not(None),
                    ExecutionOrderEvent.client_order_id.is_not(None),
                ),
                window_expr >= window_start,
                window_expr < window_end,
            )
            .order_by(window_expr.asc(), ExecutionOrderEvent.source_offset.asc())
            .limit(max(1, min(int(limit), 5000)))
        )
    )


def _unique_executions(rows: Sequence[Execution]) -> list[Execution]:
    seen: set[uuid.UUID] = set()
    unique_rows: list[Execution] = []
    for row in rows:
        if row.id in seen:
            continue
        seen.add(row.id)
        unique_rows.append(row)
    return unique_rows


def _canonical_execution_matches(
    session: Session,
    event: ExecutionOrderEvent,
    *,
    canonical_account_label: str,
) -> list[Execution]:
    clauses = []
    if event.alpaca_order_id:
        clauses.append(Execution.alpaca_order_id == event.alpaca_order_id)
    if event.client_order_id:
        clauses.extend(
            [
                Execution.client_order_id == event.client_order_id,
                Execution.execution_idempotency_key == event.client_order_id,
            ]
        )
    if not clauses:
        return []
    rows = list(
        session.scalars(
            select(Execution)
            .where(
                Execution.alpaca_account_label == canonical_account_label,
                or_(*clauses),
            )
            .order_by(Execution.created_at.asc(), Execution.id.asc())
            .limit(2)
        )
    )
    return _unique_executions(rows)


def _canonical_decision_id(
    session: Session,
    event: ExecutionOrderEvent,
    execution: Execution,
    *,
    canonical_account_label: str,
) -> uuid.UUID | None:
    if execution.trade_decision_id is not None:
        return execution.trade_decision_id
    if not event.client_order_id:
        return None
    rows = list(
        session.scalars(
            select(TradeDecision)
            .where(
                TradeDecision.alpaca_account_label == canonical_account_label,
                TradeDecision.decision_hash == event.client_order_id,
            )
            .order_by(TradeDecision.created_at.asc(), TradeDecision.id.asc())
            .limit(2)
        )
    )
    if len(rows) == 1:
        return rows[0].id
    return None


def _canonical_tca_id(session: Session, execution: Execution) -> uuid.UUID | None:
    row = session.scalar(
        select(ExecutionTCAMetric).where(
            ExecutionTCAMetric.execution_id == execution.id
        )
    )
    return row.id if row is not None else None


def _event_raw_payload(event: ExecutionOrderEvent) -> dict[str, Any]:
    raw_event = coerce_json_payload(event.raw_event)
    if isinstance(raw_event, Mapping):
        return {
            str(key): value
            for key, value in cast(Mapping[object, Any], raw_event).items()
        }
    return {"raw_event": raw_event}


def _linkage_payload(
    *,
    event: ExecutionOrderEvent,
    execution: Execution,
    decision_id: uuid.UUID | None,
    tca_id: uuid.UUID | None,
    event_dsn_env: str,
    canonical_dsn_env: str,
    source_account_label: str,
    canonical_account_label: str,
    linked_at: datetime,
) -> dict[str, Any]:
    return {
        "schema_version": _LINKAGE_SCHEMA_VERSION,
        "basis": "matched_order_identity",
        "source_dsn_env": event_dsn_env,
        "canonical_dsn_env": canonical_dsn_env,
        "source_account_label": source_account_label,
        "canonical_account_label": canonical_account_label,
        "alpaca_order_id": event.alpaca_order_id or execution.alpaca_order_id,
        "client_order_id": event.client_order_id or execution.client_order_id,
        "canonical_execution_id": str(execution.id),
        "canonical_trade_decision_id": str(decision_id) if decision_id else None,
        "canonical_execution_tca_metric_id": str(tca_id) if tca_id else None,
        "promotion_authority_eligible": False,
        "linked_at": linked_at.isoformat(),
    }


def _cross_dsn_counts_for_source_window(
    session: Session,
    source_window_id: uuid.UUID,
) -> dict[str, int]:
    execution_refs = 0
    decision_refs = 0
    tca_refs = 0
    for raw_event in session.scalars(
        select(ExecutionOrderEvent.raw_event).where(
            ExecutionOrderEvent.source_window_id == source_window_id
        )
    ):
        payload = coerce_json_payload(raw_event)
        if not isinstance(payload, Mapping):
            continue
        linkage = payload.get(_LINKAGE_KEY)
        if not isinstance(linkage, Mapping):
            continue
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


def _mark_source_windows(
    session: Session,
    *,
    source_window_ids: set[uuid.UUID],
    event_dsn_env: str,
    canonical_dsn_env: str,
    source_account_label: str,
    canonical_account_label: str,
    canonical_execution_ids: set[uuid.UUID],
    canonical_trade_decision_ids: set[uuid.UUID],
    canonical_tca_ids: set[uuid.UUID],
    linked_at: datetime,
) -> int:
    marked = 0
    for source_window_id in source_window_ids:
        source_window = session.get(OrderFeedSourceWindow, source_window_id)
        if source_window is None:
            continue
        payload = coerce_json_payload(source_window.payload_json)
        if isinstance(payload, Mapping):
            payload_dict = {
                str(key): value
                for key, value in cast(Mapping[object, Any], payload).items()
            }
        else:
            payload_dict = {}
        counts = _cross_dsn_counts_for_source_window(session, source_window_id)
        raw_classification_counts = payload_dict.get("classification_counts")
        classification_counts = (
            {
                str(key): int(value)
                for key, value in cast(
                    Mapping[object, Any],
                    raw_classification_counts,
                ).items()
                if isinstance(value, int)
            }
            if isinstance(raw_classification_counts, Mapping)
            else {}
        )
        for count_key, count_value in counts.items():
            payload_dict[count_key] = count_value
            if count_value:
                classification_counts[count_key] = count_value
            else:
                classification_counts.pop(count_key, None)
        payload_dict[_LINKAGE_KEY] = {
            "schema_version": _LINKAGE_SCHEMA_VERSION,
            "source_dsn_env": event_dsn_env,
            "canonical_dsn_env": canonical_dsn_env,
            "source_account_label": source_account_label,
            "canonical_account_label": canonical_account_label,
            "canonical_execution_ids": sorted(
                str(value) for value in canonical_execution_ids
            ),
            "canonical_trade_decision_ids": sorted(
                str(value) for value in canonical_trade_decision_ids
            ),
            "canonical_execution_tca_metric_ids": sorted(
                str(value) for value in canonical_tca_ids
            ),
            "promotion_authority_eligible": False,
            "linked_at": linked_at.isoformat(),
        }
        payload_dict["classification_counts"] = classification_counts
        source_window.classification_counts = coerce_json_payload(classification_counts)
        source_window.payload_json = coerce_json_payload(payload_dict)
        session.add(source_window)
        marked += 1
    return marked


def reconcile_cross_dsn_order_feed_links(
    event_session: Session,
    canonical_session: Session,
    *,
    event_dsn_env: str,
    canonical_dsn_env: str,
    source_account_label: str,
    canonical_account_label: str,
    window_start: datetime,
    window_end: datetime,
    limit: int = 5000,
    apply: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    linked_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    events = _event_candidates(
        event_session,
        source_account_label=source_account_label,
        window_start=window_start,
        window_end=window_end,
        limit=limit,
    )
    canonical_execution_ids: set[uuid.UUID] = set()
    canonical_trade_decision_ids: set[uuid.UUID] = set()
    canonical_tca_ids: set[uuid.UUID] = set()
    source_window_ids: set[uuid.UUID] = set()
    ambiguous_order_identities: list[dict[str, Any]] = []
    unmatched_order_identities: list[dict[str, Any]] = []
    events_matched = 0
    events_ambiguous = 0
    events_unmatched = 0
    events_marked = 0
    canonical_tca_missing = 0

    for event in events:
        matches = _canonical_execution_matches(
            canonical_session,
            event,
            canonical_account_label=canonical_account_label,
        )
        if len(matches) > 1:
            events_ambiguous += 1
            if len(ambiguous_order_identities) < 25:
                ambiguous_order_identities.append(
                    {
                        "event_id": str(event.id),
                        "alpaca_order_id": event.alpaca_order_id,
                        "client_order_id": event.client_order_id,
                        "candidate_execution_ids": [str(row.id) for row in matches],
                    }
                )
            continue
        if not matches:
            events_unmatched += 1
            if len(unmatched_order_identities) < 25:
                unmatched_order_identities.append(
                    {
                        "event_id": str(event.id),
                        "alpaca_order_id": event.alpaca_order_id,
                        "client_order_id": event.client_order_id,
                    }
                )
            continue

        execution = matches[0]
        decision_id = _canonical_decision_id(
            canonical_session,
            event,
            execution,
            canonical_account_label=canonical_account_label,
        )
        tca_id = _canonical_tca_id(canonical_session, execution)
        events_matched += 1
        canonical_execution_ids.add(execution.id)
        if decision_id is not None:
            canonical_trade_decision_ids.add(decision_id)
        if tca_id is not None:
            canonical_tca_ids.add(tca_id)
        else:
            canonical_tca_missing += 1
        if event.source_window_id is not None:
            source_window_ids.add(event.source_window_id)
        if apply:
            payload = _event_raw_payload(event)
            payload[_LINKAGE_KEY] = _linkage_payload(
                event=event,
                execution=execution,
                decision_id=decision_id,
                tca_id=tca_id,
                event_dsn_env=event_dsn_env,
                canonical_dsn_env=canonical_dsn_env,
                source_account_label=source_account_label,
                canonical_account_label=canonical_account_label,
                linked_at=linked_at,
            )
            event.raw_event = coerce_json_payload(payload)
            event_session.add(event)
            events_marked += 1

    source_windows_marked = (
        _mark_source_windows(
            event_session,
            source_window_ids=source_window_ids,
            event_dsn_env=event_dsn_env,
            canonical_dsn_env=canonical_dsn_env,
            source_account_label=source_account_label,
            canonical_account_label=canonical_account_label,
            canonical_execution_ids=canonical_execution_ids,
            canonical_trade_decision_ids=canonical_trade_decision_ids,
            canonical_tca_ids=canonical_tca_ids,
            linked_at=linked_at,
        )
        if apply
        else 0
    )

    return {
        "status": "ok",
        "apply": bool(apply),
        "event_dsn_env": event_dsn_env,
        "canonical_dsn_env": canonical_dsn_env,
        "source_account_label": source_account_label,
        "canonical_account_label": canonical_account_label,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "limit": max(1, min(int(limit), 5000)),
        "selected": len(events),
        "events_matched": events_matched,
        "events_unmatched": events_unmatched,
        "events_ambiguous": events_ambiguous,
        "events_marked": events_marked,
        "source_windows_marked": source_windows_marked,
        "canonical_executions_matched": len(canonical_execution_ids),
        "canonical_trade_decisions_matched": len(canonical_trade_decision_ids),
        "canonical_tca_matched": len(canonical_tca_ids),
        "canonical_tca_missing": canonical_tca_missing,
        "promotion_authority_eligible": False,
        "ambiguous_order_identities": ambiguous_order_identities,
        "unmatched_order_identities": unmatched_order_identities,
        "completed_at": linked_at.isoformat(),
    }


def main() -> int:
    args = _parse_args()
    event_dsn = os.environ.get(str(args.event_dsn_env).strip())
    canonical_dsn = os.environ.get(str(args.canonical_dsn_env).strip())
    if not event_dsn:
        raise SystemExit(f"missing DSN env var: {args.event_dsn_env}")
    if not canonical_dsn:
        raise SystemExit(f"missing DSN env var: {args.canonical_dsn_env}")

    window_start = _parse_dt(args.window_start)
    window_end = _parse_dt(args.window_end)
    if window_end <= window_start:
        raise SystemExit("window_end_must_be_after_window_start")

    event_engine = create_engine(
        _sqlalchemy_dsn(event_dsn), pool_pre_ping=True, future=True
    )
    canonical_engine = create_engine(
        _sqlalchemy_dsn(canonical_dsn),
        pool_pre_ping=True,
        future=True,
    )
    event_session_factory = sessionmaker(
        bind=event_engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    canonical_session_factory = sessionmaker(
        bind=canonical_engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )

    with (
        event_session_factory() as event_session,
        canonical_session_factory() as canonical_session,
    ):
        payload = reconcile_cross_dsn_order_feed_links(
            event_session,
            canonical_session,
            event_dsn_env=args.event_dsn_env,
            canonical_dsn_env=args.canonical_dsn_env,
            source_account_label=args.source_account_label,
            canonical_account_label=args.canonical_account_label,
            window_start=window_start,
            window_end=window_end,
            limit=max(1, min(int(args.limit), 5000)),
            apply=bool(args.apply),
        )
        if args.apply:
            event_session.commit()
        else:
            event_session.rollback()
        canonical_session.rollback()

    print(
        json.dumps(payload, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2, default=str)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Project order-feed lineage coverage without changing the database.

The projection is deliberately diagnostic.  It compares filled execution rows
with canonical fill events persisted in ``execution_order_events`` and reports
the source-window and Kafka-offset evidence needed before those rows can be
used for runtime-ledger or P&L promotion.  It never updates rows, creates
source windows, repairs links, or claims profitability.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import create_engine, exists, func, or_, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.sql.elements import ColumnElement

from app.models import Execution, ExecutionOrderEvent


SCHEMA_VERSION = "torghut.order-feed-coverage-projection.v1"
FILL_EVENT_TYPES = frozenset({"fill", "filled", "partial_fill", "partially_filled"})
FILLED_EXECUTION_STATUSES = frozenset(
    {"fill", "filled", "partial_fill", "partially_filled"}
)

BLOCKER_EXECUTION_FILL_LINEAGE = "execution_fill_event_lineage_missing"
BLOCKER_UNLINKED_FILL_EVENTS = "unlinked_fill_events_present"
BLOCKER_FILL_EVENT_SOURCE_WINDOW = "fill_events_missing_source_window"
BLOCKER_FILL_EVENT_SOURCE_OFFSET = "fill_events_missing_source_offset"
BLOCKER_FILL_EVENT_ORDER_IDENTITY = "fill_events_missing_order_identity"


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _parse_datetime(value: object) -> datetime:
    text = str(value).strip()
    if not text:
        raise argparse.ArgumentTypeError("datetime cannot be empty")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid datetime: {text}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _bounded_limit(value: object, *, default: int = 100) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc
    return max(1, min(parsed, 5000)) if parsed else default


def _event_time_expression() -> Any:
    return func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)


def _execution_time_expression() -> Any:
    return func.coalesce(
        Execution.order_feed_last_event_ts,
        Execution.last_update_at,
        Execution.created_at,
    )


def _scope_predicates(
    column: Any,
    *,
    account_label: str | None,
    window_start: datetime | None,
    window_end: datetime | None,
    time_expression: Any,
) -> list[ColumnElement[bool]]:
    predicates: list[ColumnElement[bool]] = []
    if account_label:
        predicates.append(column == account_label)
    if window_start is not None:
        predicates.append(time_expression >= window_start)
    if window_end is not None:
        predicates.append(time_expression < window_end)
    return predicates


def _fill_event_predicate() -> ColumnElement[bool]:
    """Identify canonical broker fill lifecycle events.

    ``filled_qty_delta`` is included as a fallback for events whose broker
    taxonomy was normalized away but whose positive delta was already proven by
    the order-feed repair path.  A cumulative quantity without a positive
    delta is intentionally not treated as a fill event here.
    """

    return or_(
        func.lower(ExecutionOrderEvent.event_type).in_(FILL_EVENT_TYPES),
        func.lower(ExecutionOrderEvent.status).in_(FILL_EVENT_TYPES),
        ExecutionOrderEvent.filled_qty_delta > 0,
    )


def _filled_execution_predicate() -> ColumnElement[bool]:
    return or_(
        Execution.filled_qty > 0,
        func.lower(Execution.status).in_(FILLED_EXECUTION_STATUSES),
    )


def _count(session: Session, statement: Any) -> int:
    value = session.scalar(statement)
    return int(value or 0)


def _ratio(numerator: int, denominator: int) -> str | None:
    if denominator <= 0:
        return None
    return str(
        (Decimal(numerator) / Decimal(denominator)).quantize(Decimal("0.000001"))
    )


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    normalized = (
        value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    )
    return normalized.astimezone(timezone.utc).isoformat()


def _decimal_text(value: object) -> str | None:
    if value is None:
        return None
    return str(value)


def _execution_sample(row: Execution) -> dict[str, object]:
    return {
        "execution_id": str(row.id),
        "account_label": row.alpaca_account_label,
        "alpaca_order_id": row.alpaca_order_id,
        "client_order_id": row.client_order_id,
        "symbol": row.symbol,
        "status": row.status,
        "filled_qty": _decimal_text(row.filled_qty),
        "activity_at": _iso(
            row.order_feed_last_event_ts or row.last_update_at or row.created_at
        ),
    }


def _event_sample(row: ExecutionOrderEvent) -> dict[str, object]:
    return {
        "event_id": str(row.id),
        "account_label": row.alpaca_account_label,
        "alpaca_order_id": row.alpaca_order_id,
        "client_order_id": row.client_order_id,
        "symbol": row.symbol,
        "event_type": row.event_type,
        "status": row.status,
        "filled_qty": _decimal_text(row.filled_qty),
        "filled_qty_delta": _decimal_text(row.filled_qty_delta),
        "event_ts": _iso(row.event_ts),
        "source_topic": row.source_topic,
        "source_partition": row.source_partition,
        "source_offset": row.source_offset,
        "execution_id": str(row.execution_id) if row.execution_id else None,
        "source_window_id": str(row.source_window_id) if row.source_window_id else None,
    }


def _sample_rows(
    session: Session,
    statement: Any,
    *,
    sample_limit: int,
) -> list[dict[str, object]]:
    rows = session.scalars(statement.limit(sample_limit)).all()
    return [_execution_sample(row) for row in rows]


def _sample_events(
    session: Session,
    statement: Any,
    *,
    sample_limit: int,
) -> list[dict[str, object]]:
    rows = session.scalars(statement.limit(sample_limit)).all()
    return [_event_sample(row) for row in rows]


def _blockers(
    *,
    filled_executions_missing_fill_event: int,
    unlinked_fill_events: int,
    linked_fill_events_missing_source_window: int,
    linked_fill_events_missing_source_offset: int,
    fill_events_missing_order_identity: int,
) -> list[str]:
    blockers: list[str] = []
    if filled_executions_missing_fill_event:
        blockers.append(BLOCKER_EXECUTION_FILL_LINEAGE)
    if unlinked_fill_events:
        blockers.append(BLOCKER_UNLINKED_FILL_EVENTS)
    if linked_fill_events_missing_source_window:
        blockers.append(BLOCKER_FILL_EVENT_SOURCE_WINDOW)
    if linked_fill_events_missing_source_offset:
        blockers.append(BLOCKER_FILL_EVENT_SOURCE_OFFSET)
    if fill_events_missing_order_identity:
        blockers.append(BLOCKER_FILL_EVENT_ORDER_IDENTITY)
    return blockers


def project_order_feed_coverage(
    session: Session,
    *,
    account_label: str | None = None,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    sample_limit: int = 25,
) -> dict[str, object]:
    """Return a read-only execution-to-fill-event coverage projection."""

    if (
        window_start is not None
        and window_end is not None
        and window_end <= window_start
    ):
        raise ValueError("window_end_must_be_after_window_start")
    bounded_sample_limit = _bounded_limit(sample_limit, default=25)
    execution_scope = _scope_predicates(
        Execution.alpaca_account_label,
        account_label=account_label,
        window_start=window_start,
        window_end=window_end,
        time_expression=_execution_time_expression(),
    )
    event_scope = _scope_predicates(
        ExecutionOrderEvent.alpaca_account_label,
        account_label=account_label,
        window_start=window_start,
        window_end=window_end,
        time_expression=_event_time_expression(),
    )
    fill_predicate = _fill_event_predicate()
    filled_execution_predicate = _filled_execution_predicate()
    linked_any_event = exists(
        select(1).where(
            ExecutionOrderEvent.execution_id == Execution.id,
            *event_scope,
        )
    )
    linked_fill_event = exists(
        select(1).where(
            ExecutionOrderEvent.execution_id == Execution.id,
            fill_predicate,
            *event_scope,
        )
    )

    execution_count = _count(
        session,
        select(func.count(Execution.id)).where(*execution_scope),
    )
    filled_execution_count = _count(
        session,
        select(func.count(Execution.id)).where(
            *execution_scope,
            filled_execution_predicate,
        ),
    )
    execution_with_any_event_count = _count(
        session,
        select(func.count(Execution.id)).where(*execution_scope, linked_any_event),
    )
    execution_with_fill_event_count = _count(
        session,
        select(func.count(Execution.id)).where(*execution_scope, linked_fill_event),
    )
    filled_executions_missing_fill_event = _count(
        session,
        select(func.count(Execution.id)).where(
            *execution_scope,
            filled_execution_predicate,
            ~linked_fill_event,
        ),
    )
    fill_event_scope = [*event_scope, fill_predicate]
    fill_event_count = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(*fill_event_scope),
    )
    linked_fill_event_count = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *fill_event_scope,
            ExecutionOrderEvent.execution_id.is_not(None),
        ),
    )
    unlinked_fill_event_count = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *fill_event_scope,
            ExecutionOrderEvent.execution_id.is_(None),
        ),
    )
    linked_fill_events_missing_source_window = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *fill_event_scope,
            ExecutionOrderEvent.execution_id.is_not(None),
            ExecutionOrderEvent.source_window_id.is_(None),
        ),
    )
    linked_fill_events_missing_source_offset = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *fill_event_scope,
            ExecutionOrderEvent.execution_id.is_not(None),
            or_(
                ExecutionOrderEvent.source_partition.is_(None),
                ExecutionOrderEvent.source_offset.is_(None),
            ),
        ),
    )
    fill_events_missing_order_identity = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *fill_event_scope,
            ExecutionOrderEvent.alpaca_order_id.is_(None),
            ExecutionOrderEvent.client_order_id.is_(None),
        ),
    )
    positive_fill_delta_event_count = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *event_scope,
            ExecutionOrderEvent.filled_qty_delta > 0,
        ),
    )
    positive_fill_delta_unlinked_count = _count(
        session,
        select(func.count(ExecutionOrderEvent.id)).where(
            *event_scope,
            ExecutionOrderEvent.filled_qty_delta > 0,
            ExecutionOrderEvent.execution_id.is_(None),
        ),
    )

    missing_execution_sample = _sample_rows(
        session,
        select(Execution)
        .where(*execution_scope, filled_execution_predicate, ~linked_fill_event)
        .order_by(_execution_time_expression().asc().nullslast(), Execution.id.asc()),
        sample_limit=bounded_sample_limit,
    )
    unlinked_fill_event_sample = _sample_events(
        session,
        select(ExecutionOrderEvent)
        .where(*fill_event_scope, ExecutionOrderEvent.execution_id.is_(None))
        .order_by(
            _event_time_expression().asc().nullslast(), ExecutionOrderEvent.id.asc()
        ),
        sample_limit=bounded_sample_limit,
    )

    blockers = _blockers(
        filled_executions_missing_fill_event=filled_executions_missing_fill_event,
        unlinked_fill_events=unlinked_fill_event_count,
        linked_fill_events_missing_source_window=linked_fill_events_missing_source_window,
        linked_fill_events_missing_source_offset=linked_fill_events_missing_source_offset,
        fill_events_missing_order_identity=fill_events_missing_order_identity,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "read_only": True,
        "writes_performed": False,
        "mutates_database": False,
        "submits_orders": False,
        "profitability_claimed": False,
        "promotion_authority_eligible": False,
        "authority_reason": "coverage_projection_is_diagnostic_only",
        "account_label": account_label,
        "window": {
            "start": _iso(window_start),
            "end": _iso(window_end),
        },
        "population": {
            "execution_count": execution_count,
            "filled_execution_count": filled_execution_count,
            "execution_with_any_event_count": execution_with_any_event_count,
            "execution_with_fill_event_count": execution_with_fill_event_count,
            "filled_executions_missing_fill_event_count": filled_executions_missing_fill_event,
        },
        "event_lineage": {
            "fill_event_count": fill_event_count,
            "linked_fill_event_count": linked_fill_event_count,
            "unlinked_fill_event_count": unlinked_fill_event_count,
            "linked_fill_events_missing_source_window_count": linked_fill_events_missing_source_window,
            "linked_fill_events_missing_source_offset_count": linked_fill_events_missing_source_offset,
            "fill_events_missing_order_identity_count": fill_events_missing_order_identity,
            "positive_fill_delta_event_count": positive_fill_delta_event_count,
            "positive_fill_delta_unlinked_count": positive_fill_delta_unlinked_count,
        },
        "coverage": {
            "filled_execution_to_fill_event_ratio": _ratio(
                execution_with_fill_event_count,
                filled_execution_count,
            ),
            "fill_event_to_execution_ratio": _ratio(
                linked_fill_event_count,
                fill_event_count,
            ),
        },
        "blockers": blockers,
        "samples": {
            "filled_executions_missing_fill_event": missing_execution_sample,
            "unlinked_fill_events": unlinked_fill_event_sample,
        },
        "sample_limit": bounded_sample_limit,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn-env", default="DB_DSN")
    parser.add_argument("--account-label", default=None)
    parser.add_argument("--window-start", type=_parse_datetime, default=None)
    parser.add_argument("--window-end", type=_parse_datetime, default=None)
    parser.add_argument("--sample-limit", type=int, default=25)
    parser.add_argument(
        "--fail-on-blockers",
        action="store_true",
        help="return exit code 1 when the projection finds lineage blockers",
    )
    parser.add_argument("--json", action="store_true", help="emit compact JSON")
    return parser.parse_args()


def run_report(args: argparse.Namespace) -> dict[str, object]:
    dsn_env = str(args.dsn_env).strip()
    dsn = os.environ.get(dsn_env)
    if not dsn:
        raise SystemExit(f"missing DSN env var: {dsn_env}")
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    with session_factory() as session:
        report = project_order_feed_coverage(
            session,
            account_label=args.account_label,
            window_start=args.window_start,
            window_end=args.window_end,
            sample_limit=args.sample_limit,
        )
        session.rollback()
    return report


def main() -> int:
    args = _parse_args()
    report = run_report(args)
    print(
        json.dumps(report, separators=(",", ":"))
        if args.json
        else json.dumps(report, indent=2, sort_keys=True)
    )
    return 1 if args.fail_on_blockers and report["blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

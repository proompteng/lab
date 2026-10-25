"""Queries for source rows that are missing TigerBeetle transfer refs."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.config import Settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
)
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    build_order_event_transfer_plan,
    execution_tca_metric_source_id,
)
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)

from .shared_context import (
    BLOCKER_UNLINKED_COST,
    BLOCKER_UNLINKED_EVENT,
    BLOCKER_UNLINKED_EXECUTION,
    BLOCKER_UNLINKED_RUNTIME_LEDGER,
    append_sample,
    order_event_ref_exists,
    source_ref_exists,
)


@dataclass(frozen=True)
class UnlinkedRefContext:
    session: Session
    settings_obj: Settings
    limit: int
    account_label: str | None
    blockers: list[str]
    samples: list[dict[str, object]]


@dataclass(frozen=True)
class UnlinkedRefCounts:
    event_count: int
    execution_count: int
    cost_count: int
    runtime_ledger_count: int


def collect_unlinked_refs(context: UnlinkedRefContext) -> UnlinkedRefCounts:
    return UnlinkedRefCounts(
        event_count=_query_unlinked_events(context),
        execution_count=_query_unlinked_executions(context),
        cost_count=_query_unlinked_costs(context),
        runtime_ledger_count=_query_unlinked_runtime_buckets(context),
    )


def _query_unlinked_events(context: UnlinkedRefContext) -> int:
    recent_events = (
        context.session.execute(
            select(ExecutionOrderEvent)
            .order_by(ExecutionOrderEvent.created_at.desc())
            .limit(context.limit)
        )
        .scalars()
        .all()
    )
    unlinked_event_count = 0
    for event in recent_events:
        if order_event_ref_exists(
            context.session, event, settings_obj=context.settings_obj
        ):
            continue
        if (
            build_order_event_transfer_plan(
                context.session, event, settings_obj=context.settings_obj
            )
            is None
        ):
            continue
        unlinked_event_count += 1
        append_sample(
            context.samples,
            {
                "blocker": BLOCKER_UNLINKED_EVENT,
                "source_type": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                "source_id": str(event.id),
                "event_fingerprint": event.event_fingerprint,
            },
        )
    if unlinked_event_count:
        context.blockers.append(BLOCKER_UNLINKED_EVENT)
    return unlinked_event_count


def _query_unlinked_executions(context: UnlinkedRefContext) -> int:
    recent_executions = (
        context.session.execute(
            select(Execution)
            .where(Execution.avg_fill_price.is_not(None), Execution.filled_qty > 0)
            .order_by(Execution.created_at.desc())
            .limit(context.limit)
        )
        .scalars()
        .all()
    )
    unlinked_execution_count = 0
    for execution in recent_executions:
        if source_ref_exists(
            context.session,
            settings_obj=context.settings_obj,
            source_type=SOURCE_TYPE_EXECUTION,
            source_id=str(execution.id),
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
            source_pk=execution.id,
        ):
            continue
        unlinked_execution_count += 1
        append_sample(
            context.samples,
            {
                "blocker": BLOCKER_UNLINKED_EXECUTION,
                "source_type": SOURCE_TYPE_EXECUTION,
                "source_id": str(execution.id),
                "alpaca_order_id": execution.alpaca_order_id,
            },
        )
    if unlinked_execution_count:
        context.blockers.append(BLOCKER_UNLINKED_EXECUTION)
    return unlinked_execution_count


def _query_unlinked_costs(context: UnlinkedRefContext) -> int:
    recent_cost_metrics = (
        context.session.execute(
            select(ExecutionTCAMetric)
            .where(
                ExecutionTCAMetric.shortfall_notional.is_not(None),
                ExecutionTCAMetric.shortfall_notional != 0,
            )
            .order_by(ExecutionTCAMetric.computed_at.desc())
            .limit(context.limit)
        )
        .scalars()
        .all()
    )
    unlinked_cost_count = 0
    for metric in recent_cost_metrics:
        if source_ref_exists(
            context.session,
            settings_obj=context.settings_obj,
            source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            source_id=execution_tca_metric_source_id(metric),
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            source_pk=metric.id,
        ):
            continue
        unlinked_cost_count += 1
        append_sample(
            context.samples,
            {
                "blocker": BLOCKER_UNLINKED_COST,
                "source_type": SOURCE_TYPE_EXECUTION_TCA_METRIC,
                "source_id": execution_tca_metric_source_id(metric),
                "execution_id": str(metric.execution_id),
            },
        )
    if unlinked_cost_count:
        context.blockers.append(BLOCKER_UNLINKED_COST)
    return unlinked_cost_count


def _query_unlinked_runtime_buckets(context: UnlinkedRefContext) -> int:
    runtime_bucket_filters: list[ColumnElement[bool]] = [
        (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
        | (StrategyRuntimeLedgerBucket.cost_amount != 0)
    ]
    if context.account_label:
        runtime_bucket_filters.append(
            StrategyRuntimeLedgerBucket.account_label == context.account_label
        )
    recent_runtime_buckets = (
        context.session.execute(
            select(StrategyRuntimeLedgerBucket)
            .where(*runtime_bucket_filters)
            .order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.desc())
            .limit(context.limit)
        )
        .scalars()
        .all()
    )
    unlinked_runtime_ledger_count = 0
    for bucket in recent_runtime_buckets:
        if source_ref_exists(
            context.session,
            settings_obj=context.settings_obj,
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id=str(bucket.id),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            source_pk=bucket.id,
        ):
            continue
        unlinked_runtime_ledger_count += 1
        append_sample(
            context.samples,
            {
                "blocker": BLOCKER_UNLINKED_RUNTIME_LEDGER,
                "source_type": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                "source_id": str(bucket.id),
                "run_id": bucket.run_id,
                "candidate_id": bucket.candidate_id,
            },
        )
    if unlinked_runtime_ledger_count:
        context.blockers.append(BLOCKER_UNLINKED_RUNTIME_LEDGER)
    return unlinked_runtime_ledger_count


__all__ = ("UnlinkedRefContext", "UnlinkedRefCounts", "collect_unlinked_refs")

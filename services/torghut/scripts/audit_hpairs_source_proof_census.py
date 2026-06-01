#!/usr/bin/env python
"""Read-only H-PAIRS/TORGHUT_SIM source-proof census/readback CLI.

This command deliberately performs diagnostics only: it reads SQLAlchemy rows or
fixture JSON and emits a deterministic machine-readable census of the gap between
paper-route activity and authority-grade runtime-ledger proof. It never writes
proof artifacts, promotion state, or database rows.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import cast

from sqlalchemy import create_engine, or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
    Strategy,
    TradeDecision,
)
from app.trading.runtime_authority_verifier import (
    AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
    AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
    AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
    AUTHORITY_MEAN_PNL_BLOCKER,
    AUTHORITY_MEDIAN_PNL_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_P10_PNL_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    AUTHORITY_TRADING_DAYS_BLOCKER,
    AUTHORITY_WORST_DAY_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    build_runtime_authority_report,
    load_runtime_authority_rows,
)
from app.trading.runtime_ledger_source_authority import (
    EXECUTION_ECONOMICS_MISSING_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
)

SCHEMA_VERSION = 'torghut.hpairs-source-proof-census.v1'
AUTHORITY_CANDIDATE_READY = 'authority_candidate_ready'
NO_SOURCE_ACTIVITY = 'no_source_activity'
LIFECYCLE_MISSING = 'lifecycle_missing'
ECONOMICS_MISSING = 'economics_missing'
SOURCE_REFS_MISSING = 'source_refs_missing'
OPEN_POSITIONS = 'open_positions'
AUTHORITY_DISTRIBUTION_MISSING = 'authority_distribution_missing'

_SOURCE_REF_BLOCKERS = frozenset(
    {
        RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
        RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
        ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER,
    }
)
_DISTRIBUTION_BLOCKERS = frozenset(
    {
        AUTHORITY_EVIDENCE_MISSING_BLOCKER,
        AUTHORITY_TRADING_DAYS_BLOCKER,
        AUTHORITY_MEAN_PNL_BLOCKER,
        AUTHORITY_MEDIAN_PNL_BLOCKER,
        AUTHORITY_P10_PNL_BLOCKER,
        AUTHORITY_WORST_DAY_BLOCKER,
        AUTHORITY_FILLED_NOTIONAL_BLOCKER,
        AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
    }
)
_LIFECYCLE_BLOCKERS = frozenset(
    {
        AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
        AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
        AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
        ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    }
)
_ECONOMICS_BLOCKERS = frozenset(
    {
        AUTHORITY_EXPLICIT_COSTS_BLOCKER,
        AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
        EXECUTION_ECONOMICS_MISSING_BLOCKER,
    }
)


@dataclass(frozen=True)
class CensusIdentity:
    hypothesis_id: str
    candidate_id: str
    runtime_strategy_name: str
    account_label: str
    observed_stage: str | None


@dataclass
class CensusSourceRows:
    trade_decisions: list[Mapping[str, object]] = field(default_factory=list)
    executions: list[Mapping[str, object]] = field(default_factory=list)
    execution_order_events: list[Mapping[str, object]] = field(default_factory=list)
    execution_tca_metrics: list[Mapping[str, object]] = field(default_factory=list)
    order_feed_source_windows: list[Mapping[str, object]] = field(default_factory=list)
    runtime_ledger_buckets: list[Mapping[str, object]] = field(default_factory=list)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--dsn', help='SQLAlchemy DSN to read with a short read-only session')
    source.add_argument('--fixture-json', type=Path, help='Fixture JSON containing source row arrays')
    parser.add_argument('--hypothesis-id', default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument('--candidate-id', default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument('--runtime-strategy-name', default=DEFAULT_HPAIRS_RUNTIME_STRATEGY)
    parser.add_argument('--account-label', default=DEFAULT_HPAIRS_ACCOUNT_LABEL)
    parser.add_argument('--observed-stage', default='paper')
    parser.add_argument('--start', dest='started_at')
    parser.add_argument('--end', dest='ended_at')
    parser.add_argument(
        '--fail-on-blockers',
        action='store_true',
        help='exit non-zero unless the census verdict is authority_candidate_ready',
    )
    return parser.parse_args(argv)


def build_source_proof_census(
    rows: CensusSourceRows,
    *,
    identity: CensusIdentity,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
    read_error: str | None = None,
    source_kind: str = 'fixture_json',
) -> dict[str, object]:
    """Build a deterministic source-proof census from already-read rows."""

    ledger_report = build_runtime_authority_report(
        rows.runtime_ledger_buckets,
        hypothesis_id=identity.hypothesis_id,
        candidate_id=identity.candidate_id,
        runtime_strategy_name=identity.runtime_strategy_name,
        account_label=identity.account_label,
        observed_stage=identity.observed_stage,
        started_at=started_at,
        ended_at=ended_at,
        evidence_read_error=read_error,
    )
    daily = _daily_census(rows, ledger_report)
    totals = _totals(rows, daily, ledger_report)
    blockers = _census_blockers(rows, totals, ledger_report, read_error=read_error)
    missing_source_ref_categories = _missing_source_ref_categories(blockers)
    missing_requirement_categories = _missing_requirement_categories(blockers)
    classification = _classify_verdict(totals, blockers)
    return {
        'schema_version': SCHEMA_VERSION,
        'identity': {
            'hypothesis_id': identity.hypothesis_id,
            'candidate_id': identity.candidate_id,
            'runtime_strategy_name': identity.runtime_strategy_name,
            'account_label': identity.account_label,
            'observed_stage': identity.observed_stage,
        },
        'window': {
            'started_at': _isoformat(started_at) if started_at is not None else None,
            'ended_at': _isoformat(ended_at) if ended_at is not None else None,
        },
        'source': {
            'kind': source_kind,
            'read_only': True,
            'writes_proof': False,
            'modifies_rows': False,
        },
        'totals': totals,
        'daily': daily,
        'runtime_authority': {
            'final_authority_ok': ledger_report['final_authority_ok'],
            'blockers': ledger_report['blockers'],
            'aggregate': ledger_report['aggregate'],
        },
        'missing_source_ref_categories': missing_source_ref_categories,
        'missing_requirement_categories': missing_requirement_categories,
        'blockers': blockers,
        'verdict': {
            'classification': classification,
            'authority_candidate_ready': classification == AUTHORITY_CANDIDATE_READY,
            'next_action': _next_action(classification),
        },
    }


def census_json(report: Mapping[str, object]) -> str:
    """Serialize a census as stable JSON."""

    return json.dumps(report, indent=2, sort_keys=True) + '\n'


def load_fixture_rows(path: Path) -> CensusSourceRows:
    payload = json.loads(path.read_text())
    data = _mapping(payload)
    return CensusSourceRows(
        trade_decisions=_row_list(data.get('trade_decisions')),
        executions=_row_list(data.get('executions')),
        execution_order_events=_row_list(data.get('execution_order_events')),
        execution_tca_metrics=_row_list(data.get('execution_tca_metrics') or data.get('tca_metrics')),
        order_feed_source_windows=_row_list(data.get('order_feed_source_windows') or data.get('source_windows')),
        runtime_ledger_buckets=_row_list(data.get('runtime_ledger_buckets')),
    )


def load_dsn_rows(
    dsn: str,
    *,
    identity: CensusIdentity,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> CensusSourceRows:
    """Read only the bounded H-PAIRS source rows needed for the census."""

    engine = create_engine(dsn)
    session_factory = sessionmaker(bind=engine)
    with session_factory() as session:
        return _load_session_rows(
            session,
            identity=identity,
            started_at=started_at,
            ended_at=ended_at,
        )


def _load_session_rows(
    session: Session,
    *,
    identity: CensusIdentity,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> CensusSourceRows:
    decision_stmt = (
        select(TradeDecision, Strategy.name)
        .join(Strategy, TradeDecision.strategy_id == Strategy.id)
        .where(TradeDecision.alpaca_account_label == identity.account_label)
        .where(Strategy.name == identity.runtime_strategy_name)
        .order_by(TradeDecision.created_at.asc(), TradeDecision.id.asc())
    )
    if started_at is not None:
        decision_stmt = decision_stmt.where(TradeDecision.created_at >= started_at)
    if ended_at is not None:
        decision_stmt = decision_stmt.where(TradeDecision.created_at < ended_at)
    decision_pairs = list(session.execute(decision_stmt).all())
    decisions = [_decision_row(row, strategy_name) for row, strategy_name in decision_pairs]
    decision_ids = {str(row.id) for row, _strategy_name in decision_pairs}

    execution_stmt = (
        select(Execution)
        .where(Execution.alpaca_account_label == identity.account_label)
        .order_by(Execution.created_at.asc(), Execution.id.asc())
    )
    if started_at is not None:
        execution_stmt = execution_stmt.where(Execution.created_at >= started_at)
    if ended_at is not None:
        execution_stmt = execution_stmt.where(Execution.created_at < ended_at)
    if decision_ids:
        execution_stmt = execution_stmt.where(Execution.trade_decision_id.in_(decision_ids))
    executions = [_execution_row(row) for row in session.scalars(execution_stmt).all()]
    execution_ids = {str(row['id']) for row in executions}

    event_stmt = (
        select(ExecutionOrderEvent)
        .where(ExecutionOrderEvent.alpaca_account_label == identity.account_label)
        .order_by(
            ExecutionOrderEvent.event_ts.asc().nulls_last(),
            ExecutionOrderEvent.created_at.asc(),
            ExecutionOrderEvent.id.asc(),
        )
    )
    if started_at is not None:
        event_stmt = event_stmt.where(
            or_(ExecutionOrderEvent.event_ts >= started_at, ExecutionOrderEvent.created_at >= started_at)
        )
    if ended_at is not None:
        event_stmt = event_stmt.where(
            or_(ExecutionOrderEvent.event_ts < ended_at, ExecutionOrderEvent.created_at < ended_at)
        )
    if decision_ids or execution_ids:
        event_filters = []
        if decision_ids:
            event_filters.append(ExecutionOrderEvent.trade_decision_id.in_(decision_ids))
        if execution_ids:
            event_filters.append(ExecutionOrderEvent.execution_id.in_(execution_ids))
        event_stmt = event_stmt.where(or_(*event_filters))
    order_events = [_order_event_row(row) for row in session.scalars(event_stmt).all()]

    tca_stmt = (
        select(ExecutionTCAMetric)
        .where(ExecutionTCAMetric.alpaca_account_label == identity.account_label)
        .order_by(ExecutionTCAMetric.computed_at.asc(), ExecutionTCAMetric.id.asc())
    )
    if started_at is not None:
        tca_stmt = tca_stmt.where(ExecutionTCAMetric.computed_at >= started_at)
    if ended_at is not None:
        tca_stmt = tca_stmt.where(ExecutionTCAMetric.computed_at < ended_at)
    if decision_ids or execution_ids:
        tca_filters = []
        if decision_ids:
            tca_filters.append(ExecutionTCAMetric.trade_decision_id.in_(decision_ids))
        if execution_ids:
            tca_filters.append(ExecutionTCAMetric.execution_id.in_(execution_ids))
        tca_stmt = tca_stmt.where(or_(*tca_filters))
    tca_metrics = [_tca_row(row) for row in session.scalars(tca_stmt).all()]

    source_window_stmt = (
        select(OrderFeedSourceWindow)
        .where(OrderFeedSourceWindow.alpaca_account_label == identity.account_label)
        .order_by(OrderFeedSourceWindow.window_started_at.asc(), OrderFeedSourceWindow.id.asc())
    )
    if started_at is not None:
        source_window_stmt = source_window_stmt.where(OrderFeedSourceWindow.window_ended_at >= started_at)
    if ended_at is not None:
        source_window_stmt = source_window_stmt.where(OrderFeedSourceWindow.window_started_at < ended_at)
    source_windows = [_source_window_row(row) for row in session.scalars(source_window_stmt).all()]

    ledger_rows = load_runtime_authority_rows(
        session,
        hypothesis_id=identity.hypothesis_id,
        candidate_id=identity.candidate_id,
        runtime_strategy_name=identity.runtime_strategy_name,
        account_label=identity.account_label,
        observed_stage=identity.observed_stage,
        started_at=started_at,
        ended_at=ended_at,
    )
    runtime_ledger_buckets = [
        {
            'id': row.row_id,
            'run_id': row.run_id,
            'candidate_id': row.candidate_id,
            'hypothesis_id': row.hypothesis_id,
            'observed_stage': row.observed_stage,
            'bucket_started_at': row.bucket_started_at,
            'bucket_ended_at': row.bucket_ended_at,
            'account_label': row.account_label,
            'runtime_strategy_name': row.runtime_strategy_name,
            'strategy_family': row.strategy_family,
            'fill_count': row.fill_count,
            'decision_count': row.decision_count,
            'submitted_order_count': row.submitted_order_count,
            'cancelled_order_count': row.cancelled_order_count,
            'rejected_order_count': row.rejected_order_count,
            'unfilled_order_count': row.unfilled_order_count,
            'closed_trade_count': row.closed_trade_count,
            'open_position_count': row.open_position_count,
            'filled_notional': row.filled_notional,
            'gross_strategy_pnl': row.gross_strategy_pnl,
            'cost_amount': row.cost_amount,
            'net_strategy_pnl_after_costs': row.net_strategy_pnl_after_costs,
            'post_cost_expectancy_bps': row.post_cost_expectancy_bps,
            'ledger_schema_version': row.ledger_schema_version,
            'pnl_basis': row.pnl_basis,
            'execution_policy_hash_counts': dict(row.execution_policy_hash_counts),
            'cost_model_hash_counts': dict(row.cost_model_hash_counts),
            'lineage_hash_counts': dict(row.lineage_hash_counts),
            'blockers': list(row.blockers),
            'payload': dict(row.payload),
        }
        for row in ledger_rows
    ]
    return CensusSourceRows(
        trade_decisions=decisions,
        executions=executions,
        execution_order_events=order_events,
        execution_tca_metrics=tca_metrics,
        order_feed_source_windows=source_windows,
        runtime_ledger_buckets=runtime_ledger_buckets,
    )


def _daily_census(rows: CensusSourceRows, ledger_report: Mapping[str, object]) -> list[dict[str, object]]:
    days = sorted(
        {
            *_row_days(rows.trade_decisions, 'created_at'),
            *_row_days(rows.executions, 'created_at'),
            *_row_days(rows.execution_order_events, 'event_ts', fallback_key='created_at'),
            *_row_days(rows.execution_tca_metrics, 'computed_at'),
            *_row_days(rows.order_feed_source_windows, 'window_started_at'),
            *_ledger_days(ledger_report),
        }
    )
    return [_daily_payload(day, rows, ledger_report) for day in days]


def _daily_payload(day: str, rows: CensusSourceRows, ledger_report: Mapping[str, object]) -> dict[str, object]:
    day_ledgers = [_mapping(item) for item in _sequence(ledger_report.get('trading_days'))]
    ledger_by_day = {str(item.get('trading_day')): item for item in day_ledgers}
    ledger = ledger_by_day.get(day, {})
    day_executions = _rows_on_day(rows.executions, day, 'created_at')
    day_events = _rows_on_day(rows.execution_order_events, day, 'event_ts', fallback_key='created_at')
    day_tca_metrics = _rows_on_day(rows.execution_tca_metrics, day, 'computed_at')
    return {
        'trading_day': day,
        'trade_decision_count': len(_rows_on_day(rows.trade_decisions, day, 'created_at')),
        'execution_count': len(day_executions),
        'filled_execution_count': sum(1 for row in day_executions if _filled_execution(row)),
        'execution_order_event_count': len(day_events),
        'fill_lifecycle_event_count': sum(1 for row in day_events if _fill_event(row)),
        'linked_order_event_fill_count': sum(1 for row in day_events if _linked_order_event_fill(row)),
        'execution_order_events_with_execution_ref_count': sum(
            1 for row in day_events if _text(row.get('execution_id')) is not None
        ),
        'execution_order_events_with_trade_decision_ref_count': sum(
            1 for row in day_events if _text(row.get('trade_decision_id')) is not None
        ),
        'execution_order_events_with_filled_notional_delta_count': sum(
            1 for row in day_events if _decimal(row.get('filled_notional_delta')) > 0
        ),
        'execution_order_events_with_quantity_count': sum(1 for row in day_events if _event_quantity_present(row)),
        'execution_order_events_with_avg_price_count': sum(
            1 for row in day_events if _decimal(row.get('avg_fill_price')) > 0
        ),
        'tca_cost_row_count': len(day_tca_metrics),
        'tca_cost_rows_with_execution_ref_count': sum(
            1 for row in day_tca_metrics if _text(row.get('execution_id')) is not None
        ),
        'tca_cost_rows_with_trade_decision_ref_count': sum(
            1 for row in day_tca_metrics if _text(row.get('trade_decision_id')) is not None
        ),
        'source_window_count': len(_rows_on_day(rows.order_feed_source_windows, day, 'window_started_at')),
        'execution_order_events_with_source_window_count': sum(
            1 for row in day_events if _text(row.get('source_window_id')) is not None
        ),
        'execution_order_events_with_source_offset_count': sum(1 for row in day_events if _event_source_offset_present(row)),
        'runtime_ledger_bucket_count': _int(ledger.get('bucket_count')),
        'blocker_free_runtime_ledger_bucket_count': _int(ledger.get('source_authority_bucket_count')),
        'explicit_cost_runtime_ledger_bucket_count': _int(ledger.get('explicit_cost_bucket_count')),
        'closed_trade_count': _int(ledger.get('closed_trade_count')),
        'open_position_count': _int(ledger.get('open_position_count')),
        'filled_notional': _decimal_text(_decimal(ledger.get('filled_notional'))),
        'post_cost_pnl': _decimal_text(_decimal(ledger.get('net_strategy_pnl_after_costs'))),
        'blockers': sorted(str(item) for item in _sequence(ledger.get('blockers'))),
    }


def _totals(
    rows: CensusSourceRows,
    daily: Sequence[Mapping[str, object]],
    ledger_report: Mapping[str, object],
) -> dict[str, object]:
    aggregate = _mapping(ledger_report.get('aggregate'))
    source_authority_bucket_count = _int(aggregate.get('source_authority_bucket_count'))
    return {
        'trade_decision_count': len(rows.trade_decisions),
        'execution_count': len(rows.executions),
        'filled_execution_count': sum(1 for row in rows.executions if _filled_execution(row)),
        'execution_order_event_count': len(rows.execution_order_events),
        'fill_lifecycle_event_count': sum(1 for row in rows.execution_order_events if _fill_event(row)),
        'linked_order_event_fill_count': sum(1 for row in rows.execution_order_events if _linked_order_event_fill(row)),
        'execution_order_events_with_execution_ref_count': sum(
            1 for row in rows.execution_order_events if _text(row.get('execution_id')) is not None
        ),
        'execution_order_events_with_trade_decision_ref_count': sum(
            1 for row in rows.execution_order_events if _text(row.get('trade_decision_id')) is not None
        ),
        'execution_order_events_with_filled_notional_delta_count': sum(
            1 for row in rows.execution_order_events if _decimal(row.get('filled_notional_delta')) > 0
        ),
        'execution_order_events_with_quantity_count': sum(
            1 for row in rows.execution_order_events if _event_quantity_present(row)
        ),
        'execution_order_events_with_avg_price_count': sum(
            1 for row in rows.execution_order_events if _decimal(row.get('avg_fill_price')) > 0
        ),
        'tca_cost_row_count': len(rows.execution_tca_metrics),
        'tca_cost_rows_with_execution_ref_count': sum(
            1 for row in rows.execution_tca_metrics if _text(row.get('execution_id')) is not None
        ),
        'tca_cost_rows_with_trade_decision_ref_count': sum(
            1 for row in rows.execution_tca_metrics if _text(row.get('trade_decision_id')) is not None
        ),
        'source_window_count': len(rows.order_feed_source_windows),
        'execution_order_events_with_source_window_count': sum(
            1 for row in rows.execution_order_events if _text(row.get('source_window_id')) is not None
        ),
        'execution_order_events_with_source_offset_count': sum(
            1 for row in rows.execution_order_events if _event_source_offset_present(row)
        ),
        'runtime_ledger_bucket_count': len(rows.runtime_ledger_buckets),
        'blocker_free_runtime_ledger_bucket_count': source_authority_bucket_count,
        'explicit_cost_runtime_ledger_bucket_count': _int(aggregate.get('explicit_cost_bucket_count')),
        'runtime_ledger_buckets_with_filled_notional_count': sum(
            1 for row in rows.runtime_ledger_buckets if _decimal(row.get('filled_notional')) > 0
        ),
        'closed_trade_count': _int(aggregate.get('closed_round_trips')),
        'open_position_count': _int(aggregate.get('open_position_count')),
        'filled_notional': _text(aggregate.get('total_filled_notional'), default='0'),
        'post_cost_pnl': _text(aggregate.get('total_net_strategy_pnl_after_costs'), default='0'),
        'trading_day_count': len(daily),
    }


def _census_blockers(
    rows: CensusSourceRows,
    totals: Mapping[str, object],
    ledger_report: Mapping[str, object],
    *,
    read_error: str | None,
) -> list[str]:
    blockers: list[str] = []
    if read_error is not None:
        blockers.append('source_proof_census_read_error')
    if _int(totals.get('trade_decision_count')) <= 0:
        blockers.extend(
            [
                AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
                RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
            ]
        )
    if _int(totals.get('execution_count')) <= 0:
        blockers.append(RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER)
    if _int(totals.get('filled_execution_count')) <= 0:
        blockers.append(AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER)
    if _int(totals.get('execution_order_event_count')) <= 0:
        blockers.extend(
            [
                RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
                ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
            ]
        )
    if _int(totals.get('fill_lifecycle_event_count')) <= 0:
        blockers.append(ORDER_FEED_LIFECYCLE_MISSING_BLOCKER)
    if _int(totals.get('execution_order_events_with_execution_ref_count')) < _int(
        totals.get('execution_order_event_count')
    ):
        blockers.append(RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER)
    if _int(totals.get('execution_order_events_with_trade_decision_ref_count')) < _int(
        totals.get('execution_order_event_count')
    ):
        blockers.append(RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER)
    if _int(totals.get('execution_order_events_with_filled_notional_delta_count')) < _int(
        totals.get('fill_lifecycle_event_count')
    ):
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if _int(totals.get('tca_cost_row_count')) <= 0:
        blockers.extend([AUTHORITY_EXPLICIT_COSTS_BLOCKER, EXECUTION_ECONOMICS_MISSING_BLOCKER])
    if _int(totals.get('source_window_count')) <= 0:
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER)
    if _int(totals.get('execution_order_events_with_source_window_count')) < _int(
        totals.get('execution_order_event_count')
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER)
    if _int(totals.get('execution_order_events_with_source_offset_count')) < _int(
        totals.get('execution_order_event_count')
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER)
    if _int(totals.get('open_position_count')) > 0:
        blockers.append(AUTHORITY_OPEN_POSITIONS_BLOCKER)
    if _int(totals.get('closed_trade_count')) <= 0:
        blockers.append(AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER)
    if _decimal(totals.get('filled_notional')) <= 0:
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if rows.runtime_ledger_buckets and _int(totals.get('explicit_cost_runtime_ledger_bucket_count')) < len(
        rows.runtime_ledger_buckets
    ):
        blockers.append(AUTHORITY_EXPLICIT_COSTS_BLOCKER)
    if not rows.runtime_ledger_buckets:
        blockers.append(AUTHORITY_EVIDENCE_MISSING_BLOCKER)
    blockers.extend(str(item) for item in _sequence(ledger_report.get('blockers')))
    return sorted(dict.fromkeys(blockers))


def _missing_source_ref_categories(blockers: Sequence[str]) -> dict[str, bool]:
    return {code: code in blockers for code in sorted(_SOURCE_REF_BLOCKERS)}


def _missing_requirement_categories(blockers: Sequence[str]) -> dict[str, bool]:
    blocker_set = set(blockers)
    return {
        'filled_notional': AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER in blocker_set,
        'explicit_costs': AUTHORITY_EXPLICIT_COSTS_BLOCKER in blocker_set
        or EXECUTION_ECONOMICS_MISSING_BLOCKER in blocker_set,
        'closed_round_trip': AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER in blocker_set,
        'execution_refs': RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER in blocker_set,
        'execution_order_event_refs': RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER in blocker_set,
        'source_window_refs': RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER in blocker_set
        or RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER in blocker_set,
        'source_offsets': RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER in blocker_set,
        'tca_cost_rows': AUTHORITY_EXPLICIT_COSTS_BLOCKER in blocker_set,
    }


def _classify_verdict(totals: Mapping[str, object], blockers: Sequence[str]) -> str:
    blocker_set = set(blockers)
    source_activity = (
        _int(totals.get('trade_decision_count'))
        + _int(totals.get('execution_count'))
        + _int(totals.get('execution_order_event_count'))
        + _int(totals.get('tca_cost_row_count'))
        + _int(totals.get('runtime_ledger_bucket_count'))
    )
    if source_activity <= 0:
        return NO_SOURCE_ACTIVITY
    if blocker_set.intersection(_LIFECYCLE_BLOCKERS):
        return LIFECYCLE_MISSING
    if blocker_set.intersection(_SOURCE_REF_BLOCKERS):
        return SOURCE_REFS_MISSING
    if blocker_set.intersection(_ECONOMICS_BLOCKERS):
        return ECONOMICS_MISSING
    if AUTHORITY_OPEN_POSITIONS_BLOCKER in blocker_set:
        return OPEN_POSITIONS
    if blocker_set.intersection(_DISTRIBUTION_BLOCKERS):
        return AUTHORITY_DISTRIBUTION_MISSING
    if blocker_set:
        return SOURCE_REFS_MISSING
    return AUTHORITY_CANDIDATE_READY


def _next_action(classification: str) -> str:
    return {
        NO_SOURCE_ACTIVITY: 'collect bounded paper-route source rows before treating replay output as authority',
        LIFECYCLE_MISSING: 'materialize linked decisions, executions, order events, fills, and closed round trips',
        ECONOMICS_MISSING: 'materialize execution TCA/cost rows and explicit runtime cost bases',
        SOURCE_REFS_MISSING: 'backfill runtime-ledger source refs, source windows, offsets, materialization, and authority class',
        OPEN_POSITIONS: 'flatten or wait for source-backed closed round trips before authority promotion',
        AUTHORITY_DISTRIBUTION_MISSING: 'continue source-backed paper runtime until authority distribution thresholds are met',
        AUTHORITY_CANDIDATE_READY: 'assemble authority proof packet from the same source-backed runtime rows',
    }[classification]


def _row_days(rows: Sequence[Mapping[str, object]], key: str, *, fallback_key: str | None = None) -> set[str]:
    days: set[str] = set()
    for row in rows:
        timestamp = _parse_timestamp(row.get(key))
        if timestamp is None and fallback_key is not None:
            timestamp = _parse_timestamp(row.get(fallback_key))
        if timestamp is not None:
            days.add(timestamp.date().isoformat())
    return days


def _ledger_days(ledger_report: Mapping[str, object]) -> set[str]:
    return {
        text
        for item in _sequence(ledger_report.get('trading_days'))
        if (text := _text(_mapping(item).get('trading_day'))) is not None
    }


def _rows_on_day(
    rows: Sequence[Mapping[str, object]],
    day: str,
    key: str,
    *,
    fallback_key: str | None = None,
) -> list[Mapping[str, object]]:
    matches: list[Mapping[str, object]] = []
    for row in rows:
        timestamp = _parse_timestamp(row.get(key))
        if timestamp is None and fallback_key is not None:
            timestamp = _parse_timestamp(row.get(fallback_key))
        if timestamp is not None and timestamp.date().isoformat() == day:
            matches.append(row)
    return matches


def _filled_execution(row: Mapping[str, object]) -> bool:
    status = (_text(row.get('status')) or '').lower()
    return status in {'filled', 'partially_filled'} or _decimal(row.get('filled_qty')) > 0


def _fill_event(row: Mapping[str, object]) -> bool:
    event_type = (_text(row.get('event_type')) or '').lower()
    status = (_text(row.get('status')) or '').lower()
    return 'fill' in event_type or status in {'filled', 'partially_filled'} or _decimal(row.get('filled_qty_delta')) > 0


def _event_quantity_present(row: Mapping[str, object]) -> bool:
    return any(_decimal(row.get(key)) > 0 for key in ('filled_qty_delta', 'filled_qty', 'qty', 'quantity'))


def _linked_order_event_fill(row: Mapping[str, object]) -> bool:
    return (
        _fill_event(row)
        and _text(row.get('execution_id')) is not None
        and _text(row.get('trade_decision_id')) is not None
        and _text(row.get('source_window_id')) is not None
        and _event_source_offset_present(row)
        and _event_quantity_present(row)
        and _decimal(row.get('avg_fill_price')) > 0
        and _decimal(row.get('filled_notional_delta')) > 0
    )


def _event_source_offset_present(row: Mapping[str, object]) -> bool:
    return (
        _text(row.get('source_topic')) is not None
        and row.get('source_partition') is not None
        and row.get('source_offset') is not None
    )


def _decision_row(row: TradeDecision, strategy_name: str | None) -> dict[str, object]:
    return {
        'id': str(row.id),
        'strategy_id': str(row.strategy_id),
        'strategy_name': strategy_name,
        'alpaca_account_label': row.alpaca_account_label,
        'symbol': row.symbol,
        'status': row.status,
        'decision_hash': row.decision_hash,
        'created_at': row.created_at,
        'executed_at': row.executed_at,
    }


def _execution_row(row: Execution) -> dict[str, object]:
    return {
        'id': str(row.id),
        'trade_decision_id': str(row.trade_decision_id) if row.trade_decision_id is not None else None,
        'alpaca_account_label': row.alpaca_account_label,
        'alpaca_order_id': row.alpaca_order_id,
        'client_order_id': row.client_order_id,
        'symbol': row.symbol,
        'side': row.side,
        'status': row.status,
        'filled_qty': row.filled_qty,
        'avg_fill_price': row.avg_fill_price,
        'created_at': row.created_at,
        'updated_at': row.updated_at,
        'order_feed_last_event_ts': row.order_feed_last_event_ts,
    }


def _order_event_row(row: ExecutionOrderEvent) -> dict[str, object]:
    return {
        'id': str(row.id),
        'source_topic': row.source_topic,
        'source_partition': row.source_partition,
        'source_offset': row.source_offset,
        'alpaca_account_label': row.alpaca_account_label,
        'event_ts': row.event_ts,
        'created_at': row.created_at,
        'symbol': row.symbol,
        'alpaca_order_id': row.alpaca_order_id,
        'client_order_id': row.client_order_id,
        'event_type': row.event_type,
        'status': row.status,
        'filled_qty': row.filled_qty,
        'filled_qty_delta': row.filled_qty_delta,
        'avg_fill_price': row.avg_fill_price,
        'filled_notional_delta': row.filled_notional_delta,
        'execution_id': str(row.execution_id) if row.execution_id is not None else None,
        'trade_decision_id': str(row.trade_decision_id) if row.trade_decision_id is not None else None,
        'source_window_id': str(row.source_window_id) if row.source_window_id is not None else None,
    }


def _tca_row(row: ExecutionTCAMetric) -> dict[str, object]:
    return {
        'id': str(row.id),
        'execution_id': str(row.execution_id),
        'trade_decision_id': str(row.trade_decision_id) if row.trade_decision_id is not None else None,
        'strategy_id': str(row.strategy_id) if row.strategy_id is not None else None,
        'alpaca_account_label': row.alpaca_account_label,
        'symbol': row.symbol,
        'side': row.side,
        'filled_qty': row.filled_qty,
        'shortfall_notional': row.shortfall_notional,
        'realized_shortfall_bps': row.realized_shortfall_bps,
        'computed_at': row.computed_at,
    }


def _source_window_row(row: OrderFeedSourceWindow) -> dict[str, object]:
    return {
        'id': str(row.id),
        'consumer_group': row.consumer_group,
        'source_topic': row.source_topic,
        'source_partition': row.source_partition,
        'alpaca_account_label': row.alpaca_account_label,
        'window_started_at': row.window_started_at,
        'window_ended_at': row.window_ended_at,
        'start_offset': row.start_offset,
        'end_offset': row.end_offset,
        'consumed_count': row.consumed_count,
        'inserted_count': row.inserted_count,
        'gap_count': row.gap_count,
        'status': row.status,
    }


def _row_list(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    rows: list[Mapping[str, object]] = []
    for item in cast(Sequence[object], value):
        if isinstance(item, Mapping):
            rows.append({str(key): _json_value(raw) for key, raw in cast(Mapping[object, object], item).items()})
    return rows


def _json_value(value: object) -> object:
    if isinstance(value, str):
        parsed = _parse_timestamp(value)
        return parsed if parsed is not None else value
    if isinstance(value, Mapping):
        return {str(key): _json_value(raw) for key, raw in cast(Mapping[object, object], value).items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_value(item) for item in cast(Sequence[object], value)]
    return value


def _parse_cli_timestamp(value: str | None) -> datetime | None:
    if value is None or not value.strip():
        return None
    parsed = _parse_timestamp(value)
    if parsed is None:
        raise ValueError(f'invalid timestamp: {value}')
    return parsed


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace('Z', '+00:00')))
    except ValueError:
        return None


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return {str(key): item for key, item in cast(Mapping[object, object], value).items()}
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, *, default: str | None = None) -> str | None:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _int(value: object) -> int:
    try:
        return int(str(value if value is not None else '0'))
    except (TypeError, ValueError):
        return 0


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value if value is not None else '0'))
    except (InvalidOperation, ValueError):
        return Decimal('0')
    return parsed if parsed.is_finite() else Decimal('0')


def _decimal_text(value: Decimal) -> str:
    text = format(value.normalize(), 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return _utc(value).isoformat().replace('+00:00', 'Z')


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    started_at = _parse_cli_timestamp(args.started_at)
    ended_at = _parse_cli_timestamp(args.ended_at)
    identity = CensusIdentity(
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        runtime_strategy_name=args.runtime_strategy_name,
        account_label=args.account_label,
        observed_stage=args.observed_stage,
    )
    read_error = None
    try:
        if args.fixture_json is not None:
            rows = load_fixture_rows(args.fixture_json)
            source_kind = 'fixture_json'
        else:
            rows = load_dsn_rows(
                args.dsn,
                identity=identity,
                started_at=started_at,
                ended_at=ended_at,
            )
            source_kind = 'sqlalchemy_dsn'
    except Exception as exc:  # noqa: BLE001 - readback must fail closed into JSON diagnostics.
        rows = CensusSourceRows()
        read_error = str(exc)
        source_kind = 'fixture_json' if args.fixture_json is not None else 'sqlalchemy_dsn'
    report = build_source_proof_census(
        rows,
        identity=identity,
        started_at=started_at,
        ended_at=ended_at,
        read_error=read_error,
        source_kind=source_kind,
    )
    sys.stdout.write(census_json(report))
    verdict = _mapping(report.get('verdict'))
    return 1 if args.fail_on_blockers and verdict.get('authority_candidate_ready') is not True else 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())

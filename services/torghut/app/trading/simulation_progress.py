"""Durable simulation progress ledger hooks and snapshot helpers."""
# pyright: reportUnusedFunction=false

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional, cast

from sqlalchemy import Table, event, select, text
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from ..config import settings
from ..models.entities import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    SimulationRunProgress,
    TradeCursor,
    TradeDecision,
)

logger = logging.getLogger(__name__)

COMPONENT_REPLAY = 'replay'
COMPONENT_TA = 'ta'
COMPONENT_TORGHUT = 'torghut'
COMPONENT_ARTIFACTS = 'artifacts'
SIMULATION_PROGRESS_COMPONENTS = (
    COMPONENT_REPLAY,
    COMPONENT_TA,
    COMPONENT_TORGHUT,
    COMPONENT_ARTIFACTS,
)
_PROGRESS_UPSERT = text(
    """
    INSERT INTO simulation_run_progress (
      run_id,
      component,
      dataset_id,
      lane,
      workflow_name,
      status,
      last_source_ts,
      last_signal_ts,
      last_price_ts,
      cursor_at,
      records_dumped,
      records_replayed,
      trade_decisions,
      executions,
      execution_tca_metrics,
      execution_order_events,
      strategy_type,
      legacy_path_count,
      fallback_count,
      terminal_state,
      last_error_code,
      last_error_message,
      payload_json
    ) VALUES (
      :run_id,
      :component,
      :dataset_id,
      :lane,
      :workflow_name,
      :status,
      :last_source_ts,
      :last_signal_ts,
      :last_price_ts,
      :cursor_at,
      :records_dumped,
      :records_replayed,
      :trade_decisions,
      :executions,
      :execution_tca_metrics,
      :execution_order_events,
      :strategy_type,
      :legacy_path_count,
      :fallback_count,
      :terminal_state,
      :last_error_code,
      :last_error_message,
      CAST(:payload_json AS jsonb)
    )
    ON CONFLICT (run_id, component) DO UPDATE SET
      dataset_id = COALESCE(EXCLUDED.dataset_id, simulation_run_progress.dataset_id),
      lane = COALESCE(EXCLUDED.lane, simulation_run_progress.lane),
      workflow_name = COALESCE(EXCLUDED.workflow_name, simulation_run_progress.workflow_name),
      status = COALESCE(EXCLUDED.status, simulation_run_progress.status),
      last_source_ts = COALESCE(EXCLUDED.last_source_ts, simulation_run_progress.last_source_ts),
      last_signal_ts = COALESCE(EXCLUDED.last_signal_ts, simulation_run_progress.last_signal_ts),
      last_price_ts = COALESCE(EXCLUDED.last_price_ts, simulation_run_progress.last_price_ts),
      cursor_at = COALESCE(EXCLUDED.cursor_at, simulation_run_progress.cursor_at),
      records_dumped = simulation_run_progress.records_dumped + EXCLUDED.records_dumped,
      records_replayed = simulation_run_progress.records_replayed + EXCLUDED.records_replayed,
      trade_decisions = simulation_run_progress.trade_decisions + EXCLUDED.trade_decisions,
      executions = simulation_run_progress.executions + EXCLUDED.executions,
      execution_tca_metrics = simulation_run_progress.execution_tca_metrics + EXCLUDED.execution_tca_metrics,
      execution_order_events = simulation_run_progress.execution_order_events + EXCLUDED.execution_order_events,
      strategy_type = COALESCE(EXCLUDED.strategy_type, simulation_run_progress.strategy_type),
      legacy_path_count = simulation_run_progress.legacy_path_count + EXCLUDED.legacy_path_count,
      fallback_count = simulation_run_progress.fallback_count + EXCLUDED.fallback_count,
      terminal_state = COALESCE(EXCLUDED.terminal_state, simulation_run_progress.terminal_state),
      last_error_code = COALESCE(EXCLUDED.last_error_code, simulation_run_progress.last_error_code),
      last_error_message = COALESCE(EXCLUDED.last_error_message, simulation_run_progress.last_error_message),
      payload_json = COALESCE(simulation_run_progress.payload_json, '{}'::jsonb) || COALESCE(EXCLUDED.payload_json, '{}'::jsonb),
      updated_at = NOW()
    """
)


def _resolve_lane() -> str:
    dataset_id = (settings.trading_simulation_dataset_id or '').strip().lower()
    signal_table = (settings.trading_signal_table or '').strip().lower()
    if 'options' in dataset_id or 'sim_options' in signal_table:
        return 'options'
    return 'equity'


def simulation_progress_context() -> dict[str, str] | None:
    if not settings.trading_simulation_enabled:
        return None
    run_id = (settings.trading_simulation_run_id or '').strip()
    if not run_id:
        return None
    dataset_id = (settings.trading_simulation_dataset_id or '').strip() or None
    return {
        'run_id': run_id,
        'dataset_id': dataset_id or '',
        'lane': _resolve_lane(),
    }


def _utc_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned:
            return None
        try:
            parsed = datetime.fromisoformat(cleaned.replace('Z', '+00:00'))
        except ValueError:
            return None
    else:
        parsed = value
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def upsert_simulation_progress(
    connection: Connection,
    *,
    component: str,
    status: str | None = None,
    workflow_name: str | None = None,
    last_source_ts: datetime | str | None = None,
    last_signal_ts: datetime | str | None = None,
    last_price_ts: datetime | str | None = None,
    cursor_at: datetime | str | None = None,
    records_dumped: int = 0,
    records_replayed: int = 0,
    trade_decisions: int = 0,
    executions: int = 0,
    execution_tca_metrics: int = 0,
    execution_order_events: int = 0,
    strategy_type: str | None = None,
    legacy_path_count: int = 0,
    fallback_count: int = 0,
    terminal_state: str | None = None,
    last_error_code: str | None = None,
    last_error_message: str | None = None,
    payload: Mapping[str, Any] | None = None,
) -> None:
    context = simulation_progress_context()
    if context is None:
        return
    payload_json = dict(payload or {})
    values = {
        'run_id': context['run_id'],
        'component': component,
        'dataset_id': context['dataset_id'] or None,
        'lane': context['lane'],
        'workflow_name': workflow_name,
        'status': status or 'running',
        'last_source_ts': _utc_datetime(last_source_ts),
        'last_signal_ts': _utc_datetime(last_signal_ts),
        'last_price_ts': _utc_datetime(last_price_ts),
        'cursor_at': _utc_datetime(cursor_at),
        'records_dumped': max(0, int(records_dumped)),
        'records_replayed': max(0, int(records_replayed)),
        'trade_decisions': max(0, int(trade_decisions)),
        'executions': max(0, int(executions)),
        'execution_tca_metrics': max(0, int(execution_tca_metrics)),
        'execution_order_events': max(0, int(execution_order_events)),
        'strategy_type': strategy_type,
        'legacy_path_count': max(0, int(legacy_path_count)),
        'fallback_count': max(0, int(fallback_count)),
        'terminal_state': terminal_state,
        'last_error_code': last_error_code,
        'last_error_message': last_error_message,
        'payload_json': json.dumps(payload_json, sort_keys=True),
    }
    try:
        if connection.dialect.name != 'postgresql':
            _upsert_simulation_progress_fallback(
                connection,
                values={
                    **values,
                    'payload_json': payload_json,
                },
            )
            return
        connection.execute(
            _PROGRESS_UPSERT,
            values,
        )
    except Exception:
        logger.exception('Failed to upsert simulation progress ledger')


def _coerce_payload_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def _upsert_simulation_progress_fallback(
    connection: Connection,
    *,
    values: dict[str, Any],
) -> None:
    table = cast(Table, SimulationRunProgress.__table__)
    existing = connection.execute(
        select(table).where(
            table.c.run_id == values['run_id'],
            table.c.component == values['component'],
        )
    ).mappings().first()
    if existing is None:
        connection.execute(table.insert().values(**values))
        return

    existing_payload = _coerce_payload_mapping(existing.get('payload_json'))
    existing_payload.update(_coerce_payload_mapping(values.get('payload_json')))
    now = datetime.now(timezone.utc)
    connection.execute(
        table.update()
        .where(
            table.c.run_id == values['run_id'],
            table.c.component == values['component'],
        )
        .values(
            dataset_id=values['dataset_id'] or existing.get('dataset_id'),
            lane=values['lane'] or existing.get('lane'),
            workflow_name=values['workflow_name'] or existing.get('workflow_name'),
            status=values['status'] or existing.get('status'),
            last_source_ts=values['last_source_ts'] or existing.get('last_source_ts'),
            last_signal_ts=values['last_signal_ts'] or existing.get('last_signal_ts'),
            last_price_ts=values['last_price_ts'] or existing.get('last_price_ts'),
            cursor_at=values['cursor_at'] or existing.get('cursor_at'),
            records_dumped=int(existing.get('records_dumped') or 0) + int(values['records_dumped']),
            records_replayed=int(existing.get('records_replayed') or 0) + int(values['records_replayed']),
            trade_decisions=int(existing.get('trade_decisions') or 0) + int(values['trade_decisions']),
            executions=int(existing.get('executions') or 0) + int(values['executions']),
            execution_tca_metrics=int(existing.get('execution_tca_metrics') or 0)
            + int(values['execution_tca_metrics']),
            execution_order_events=int(existing.get('execution_order_events') or 0)
            + int(values['execution_order_events']),
            strategy_type=values['strategy_type'] or existing.get('strategy_type'),
            legacy_path_count=int(existing.get('legacy_path_count') or 0) + int(values['legacy_path_count']),
            fallback_count=int(existing.get('fallback_count') or 0) + int(values['fallback_count']),
            terminal_state=values['terminal_state'] or existing.get('terminal_state'),
            last_error_code=values['last_error_code'] or existing.get('last_error_code'),
            last_error_message=values['last_error_message'] or existing.get('last_error_message'),
            payload_json=existing_payload,
            updated_at=now,
        )
    )


def simulation_progress_snapshot(
    session: Session,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    context = simulation_progress_context()
    resolved_run_id = (run_id or '').strip() or (context['run_id'] if context is not None else '')
    if not resolved_run_id:
        return {
            'enabled': False,
            'run_id': None,
            'components': {},
        }

    rows = (
        session.execute(
            select(SimulationRunProgress).where(
                SimulationRunProgress.run_id == resolved_run_id,
            )
        )
        .scalars()
        .all()
    )
    components: dict[str, dict[str, Any]] = {}
    for row in rows:
        components[row.component] = {
            'component': row.component,
            'dataset_id': row.dataset_id,
            'lane': row.lane,
            'workflow_name': row.workflow_name,
            'status': row.status,
            'updated_at': row.updated_at.isoformat(),
            'last_source_ts': row.last_source_ts.isoformat() if row.last_source_ts is not None else None,
            'last_signal_ts': row.last_signal_ts.isoformat() if row.last_signal_ts is not None else None,
            'last_price_ts': row.last_price_ts.isoformat() if row.last_price_ts is not None else None,
            'cursor_at': row.cursor_at.isoformat() if row.cursor_at is not None else None,
            'records_dumped': int(row.records_dumped or 0),
            'records_replayed': int(row.records_replayed or 0),
            'trade_decisions': int(row.trade_decisions or 0),
            'executions': int(row.executions or 0),
            'execution_tca_metrics': int(row.execution_tca_metrics or 0),
            'execution_order_events': int(row.execution_order_events or 0),
            'strategy_type': row.strategy_type,
            'legacy_path_count': int(row.legacy_path_count or 0),
            'fallback_count': int(row.fallback_count or 0),
            'terminal_state': row.terminal_state,
            'last_error_code': row.last_error_code,
            'last_error_message': row.last_error_message,
            'payload': cast(dict[str, Any], row.payload_json or {}),
        }

    torghut = components.get(COMPONENT_TORGHUT, {})
    replay = components.get(COMPONENT_REPLAY, {})
    ta = components.get(COMPONENT_TA, {})
    artifacts = components.get(COMPONENT_ARTIFACTS, {})
    artifacts_payload = cast(dict[str, Any], artifacts.get('payload') or {})
    strategy_type = cast(Optional[str], torghut.get('strategy_type') or replay.get('strategy_type'))
    statuses = {component: payload.get('status') for component, payload in components.items()}
    return {
        'enabled': True,
        'run_id': resolved_run_id,
        'dataset_id': replay.get('dataset_id') or torghut.get('dataset_id'),
        'lane': replay.get('lane') or torghut.get('lane'),
        'components': components,
        'summary': {
            'statuses': statuses,
            'records_dumped': int(replay.get('records_dumped') or 0),
            'records_replayed': int(replay.get('records_replayed') or 0),
            'trade_decisions': int(torghut.get('trade_decisions') or 0),
            'executions': int(torghut.get('executions') or 0),
            'execution_tca_metrics': int(torghut.get('execution_tca_metrics') or 0),
            'execution_order_events': int(torghut.get('execution_order_events') or 0),
            'cursor_at': torghut.get('cursor_at'),
            'last_signal_ts': torghut.get('last_signal_ts') or replay.get('last_signal_ts') or ta.get('last_signal_ts'),
            'last_price_ts': torghut.get('last_price_ts') or replay.get('last_price_ts') or ta.get('last_price_ts'),
            'last_source_ts': replay.get('last_source_ts') or ta.get('last_source_ts'),
            'strategy_type': strategy_type,
            'legacy_path_count': int(torghut.get('legacy_path_count') or 0),
            'fallback_count': int(torghut.get('fallback_count') or 0),
            'activity_classification': (
                cast(dict[str, Any], artifacts_payload.get('analysis_run') or {}).get('activity_classification')
                if isinstance(artifacts_payload.get('analysis_run'), Mapping)
                else artifacts_payload.get('activity_classification')
            ),
            'final_artifacts_ready': bool(artifacts.get('terminal_state') == 'complete'),
        },
    }


def _decision_strategy_type(target: TradeDecision) -> str | None:
    raw = _coerce_payload_mapping(target.decision_json)
    for key in ('strategy_type', 'strategyType', 'strategy_id', 'strategyId'):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


@event.listens_for(TradeDecision, 'after_insert')
def _trade_decision_after_insert(_mapper: Any, connection: Connection, target: TradeDecision) -> None:
    strategy_type = _decision_strategy_type(target)
    legacy_count = 1 if (strategy_type or '').strip().lower() == 'legacy_macd_rsi' else 0
    upsert_simulation_progress(
        connection,
        component=COMPONENT_TORGHUT,
        status='running',
        trade_decisions=1,
        strategy_type=strategy_type,
        legacy_path_count=legacy_count,
        payload={
            'symbol': target.symbol,
            'timeframe': target.timeframe,
            'decision_status': target.status,
        },
    )


@event.listens_for(Execution, 'after_insert')
def _execution_after_insert(_mapper: Any, connection: Connection, target: Execution) -> None:
    upsert_simulation_progress(
        connection,
        component=COMPONENT_TORGHUT,
        status='running',
        executions=1,
        fallback_count=int(target.execution_fallback_count or 0),
        payload={
            'symbol': target.symbol,
            'side': target.side,
            'execution_actual_adapter': target.execution_actual_adapter,
            'execution_expected_adapter': target.execution_expected_adapter,
        },
    )


@event.listens_for(ExecutionOrderEvent, 'after_insert')
def _execution_order_event_after_insert(
    _mapper: Any,
    connection: Connection,
    target: ExecutionOrderEvent,
) -> None:
    upsert_simulation_progress(
        connection,
        component=COMPONENT_TORGHUT,
        status='running',
        execution_order_events=1,
        payload={
            'event_type': target.event_type,
            'alpaca_order_id': target.alpaca_order_id,
        },
    )


@event.listens_for(ExecutionTCAMetric, 'after_insert')
def _execution_tca_after_insert(_mapper: Any, connection: Connection, target: ExecutionTCAMetric) -> None:
    upsert_simulation_progress(
        connection,
        component=COMPONENT_TORGHUT,
        status='running',
        execution_tca_metrics=1,
        payload={
            'symbol': target.symbol,
            'side': target.side,
        },
    )


def _record_trade_cursor_progress(connection: Connection, target: TradeCursor) -> None:
    if target.source != 'clickhouse':
        return
    upsert_simulation_progress(
        connection,
        component=COMPONENT_TORGHUT,
        status='running',
        cursor_at=target.cursor_at,
        last_signal_ts=target.cursor_at,
        payload={
            'cursor_source': target.source,
            'cursor_seq': target.cursor_seq,
            'cursor_symbol': target.cursor_symbol,
            'account_label': target.account_label,
        },
    )


@event.listens_for(TradeCursor, 'after_insert')
def _trade_cursor_after_insert(_mapper: Any, connection: Connection, target: TradeCursor) -> None:
    _record_trade_cursor_progress(connection, target)


@event.listens_for(TradeCursor, 'after_update')
def _trade_cursor_after_update(_mapper: Any, connection: Connection, target: TradeCursor) -> None:
    _record_trade_cursor_progress(connection, target)


__all__ = [
    'COMPONENT_ARTIFACTS',
    'COMPONENT_REPLAY',
    'COMPONENT_TA',
    'COMPONENT_TORGHUT',
    'SIMULATION_PROGRESS_COMPONENTS',
    'simulation_progress_context',
    'simulation_progress_snapshot',
    'upsert_simulation_progress',
]

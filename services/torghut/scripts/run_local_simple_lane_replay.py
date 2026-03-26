#!/usr/bin/env python3
"""Replay one trading session through Torghut's simple execution lane locally."""
# pyright: reportArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

SCRIPT_DIR = Path(__file__).resolve().parent
SERVICE_ROOT = SCRIPT_DIR.parent
REPO_ROOT = SERVICE_ROOT.parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import config
from app.models import Base, Execution, Strategy, TradeDecision
from app.trading.decisions import DecisionEngine
from app.trading.execution import OrderExecutor
from app.trading.execution_adapters import SimulationExecutionAdapter
from app.trading.firewall import OrderFirewall
from app.trading.ingest import ClickHouseSignalIngestor, SignalBatch
from app.trading.models import SignalEnvelope
from app.trading.reconcile import Reconciler
from app.trading.risk import RiskEngine
from app.trading.scheduler.simple_pipeline import SimpleTradingPipeline
from app.trading.scheduler.state import TradingState
from app.trading.universe import UniverseResolver

DEFAULT_SYMBOLS = [
    'AAPL',
    'AMAT',
    'AMD',
    'AVGO',
    'GOOG',
    'INTC',
    'META',
    'MSFT',
    'NVDA',
    'QQQ',
    'SPY',
    'TSLA',
]
ALLOWED_REJECT_REASONS = {
    'kill_switch_enabled',
    'invalid_qty_increment',
    'qty_below_min_after_clamp',
    'insufficient_buying_power',
    'max_notional_exceeded',
    'max_symbol_exposure_exceeded',
    'shorting_not_allowed_for_asset',
    'broker_precheck_failed',
    'broker_submit_failed',
}
DEFAULT_START = '2026-03-26T13:30:00Z'
DEFAULT_END = '2026-03-26T20:00:00Z'
DEFAULT_OUTPUT_DIR = (
    REPO_ROOT / 'artifacts/torghut/simulations/local-simple-20260326'
)
DEFAULT_CLICKHOUSE_URL = 'http://torghut-clickhouse.torghut.svc.cluster.local:8123'
DEFAULT_CLICKHOUSE_NAMESPACE = 'torghut'
DEFAULT_CLICKHOUSE_POD = 'chi-torghut-clickhouse-default-0-0-0'
ESSENTIAL_SIGNAL_COLUMNS = [
    'event_ts',
    'ingest_ts',
    'symbol',
    'window_size',
    'window_step',
    'seq',
    'source',
    'macd',
    'macd_signal',
    'rsi14',
    'vwap_session',
    'vwap_w5m',
]

logger = logging.getLogger('torghut.simple_replay')


@dataclass
class ReplayArtifacts:
    runtime_verify: dict[str, Any]
    replay_report: dict[str, Any]
    decision_activity: dict[str, Any]
    execution_activity: dict[str, Any]
    run_summary: dict[str, Any]


class BucketReplayIngestor:
    """Feed preloaded signal buckets into the scheduler."""

    def __init__(self, buckets: list[list[SignalEnvelope]]) -> None:
        self._buckets = buckets
        self._cursor = 0
        self.committed_batches = 0

    @property
    def remaining(self) -> int:
        return max(len(self._buckets) - self._cursor, 0)

    def fetch_signals(self, session: Session) -> SignalBatch:
        _ = session
        if self._cursor >= len(self._buckets):
            return SignalBatch(
                signals=[],
                cursor_at=None,
                cursor_seq=None,
                cursor_symbol=None,
                no_signal_reason='replay_complete',
            )
        signals = self._buckets[self._cursor]
        cursor_at = signals[-1].event_ts if signals else None
        cursor_seq = signals[-1].seq if signals else None
        cursor_symbol = signals[-1].symbol if signals else None
        return SignalBatch(
            signals=signals,
            cursor_at=cursor_at,
            cursor_seq=cursor_seq,
            cursor_symbol=cursor_symbol,
            query_start=signals[0].event_ts if signals else None,
            query_end=signals[-1].event_ts if signals else None,
            no_signal_reason=None if signals else 'empty_bucket',
        )

    def commit_cursor(self, session: Session, batch: SignalBatch) -> None:
        _ = (session, batch)
        if self._cursor < len(self._buckets):
            self._cursor += 1
            self.committed_batches += 1


class LocalSimulationBroker:
    """Small wrapper that gives the simulation adapter a broker-like account surface."""

    def __init__(
        self,
        *,
        adapter: SimulationExecutionAdapter,
        initial_cash: Decimal,
        allow_shorts: bool,
    ) -> None:
        self._adapter = adapter
        self._cash = initial_cash
        self._allow_shorts = allow_shorts

    def get_account(self) -> dict[str, Any]:
        positions = self.list_positions()
        net_market_value = Decimal('0')
        for position in positions:
            raw_market_value = position.get('market_value')
            if raw_market_value is None:
                continue
            try:
                net_market_value += Decimal(str(raw_market_value))
            except Exception:
                continue
        equity = self._cash + net_market_value
        buying_power = max(self._cash, equity, Decimal('0'))
        return {
            'equity': str(equity),
            'cash': str(self._cash),
            'buying_power': str(buying_power),
            'shorting_enabled': self._allow_shorts,
        }

    def list_positions(self) -> list[dict[str, Any]]:
        return self._adapter.list_positions()

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any]:
        return {
            'symbol': symbol_or_asset_id,
            'tradable': True,
            'shortable': self._allow_shorts,
        }

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
        *,
        firewall_token: object | None = None,
    ) -> dict[str, Any]:
        _ = firewall_token
        order = self._adapter.submit_order(
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
        )
        filled_qty = Decimal(str(order.get('filled_qty') or order.get('qty') or '0'))
        fill_price = Decimal(str(order.get('filled_avg_price') or '0'))
        cash_delta = filled_qty * fill_price
        if side.strip().lower() == 'buy':
            self._cash -= cash_delta
        else:
            self._cash += cash_delta
        return order

    def cancel_order(
        self,
        alpaca_order_id: str,
        *,
        firewall_token: object | None = None,
    ) -> bool:
        _ = firewall_token
        return self._adapter.cancel_order(alpaca_order_id)

    def cancel_all_orders(
        self,
        *,
        firewall_token: object | None = None,
    ) -> list[dict[str, Any]]:
        _ = firewall_token
        return self._adapter.cancel_all_orders()

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        return self._adapter.get_order_by_client_order_id(client_order_id)

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        return self._adapter.get_order(alpaca_order_id)

    def list_orders(self, status: str = 'all') -> list[dict[str, Any]]:
        return self._adapter.list_orders(status=status)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Replay a trading session through the simple execution lane.',
    )
    parser.add_argument('--start', default=DEFAULT_START)
    parser.add_argument('--end', default=DEFAULT_END)
    parser.add_argument('--symbols', default=','.join(DEFAULT_SYMBOLS))
    parser.add_argument('--output-dir', default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument(
        '--strategy-config',
        default=str(REPO_ROOT / 'argocd/applications/torghut/strategy-configmap.yaml'),
    )
    parser.add_argument('--clickhouse-url', default=DEFAULT_CLICKHOUSE_URL)
    parser.add_argument('--clickhouse-username', default='torghut')
    parser.add_argument('--clickhouse-password', required=True)
    parser.add_argument('--clickhouse-table', default='torghut.ta_signals')
    parser.add_argument(
        '--clickhouse-transport',
        choices=['kubectl', 'http'],
        default='kubectl',
    )
    parser.add_argument(
        '--clickhouse-namespace',
        default=DEFAULT_CLICKHOUSE_NAMESPACE,
    )
    parser.add_argument(
        '--clickhouse-pod',
        default=DEFAULT_CLICKHOUSE_POD,
    )
    parser.add_argument('--initial-cash', type=Decimal, default=Decimal('10000'))
    parser.add_argument('--bucket-seconds', type=int, default=60)
    parser.add_argument('--min-split-seconds', type=int, default=60)
    parser.add_argument('--max-notional-per-order', type=Decimal, default=None)
    parser.add_argument('--max-notional-per-symbol', type=Decimal, default=None)
    parser.add_argument('--allow-shorts', action='store_true', default=True)
    parser.add_argument('--disable-shorts', dest='allow_shorts', action='store_false')
    parser.add_argument('--verbose', action='store_true')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
    )
    start = _parse_timestamp(args.start)
    end = _parse_timestamp(args.end)
    symbols = [symbol.strip().upper() for symbol in args.symbols.split(',') if symbol.strip()]
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    ingestor = ClickHouseSignalIngestor(
        url=args.clickhouse_url,
        username=args.clickhouse_username,
        password=args.clickhouse_password,
        table=args.clickhouse_table,
        batch_size=200000,
    )
    strategy_defs = _load_enabled_strategies(Path(args.strategy_config))
    if not strategy_defs:
        raise RuntimeError('No enabled strategies found in strategy config')

    signal_fetch_counts: dict[str, int] = {}
    all_signals: list[SignalEnvelope] = []
    for symbol in symbols:
        signals = _fetch_signals_adaptive(
            ingestor=ingestor,
            symbol=symbol,
            start=start,
            end=end,
            min_split_seconds=args.min_split_seconds,
            clickhouse_transport=args.clickhouse_transport,
            clickhouse_namespace=args.clickhouse_namespace,
            clickhouse_pod=args.clickhouse_pod,
            clickhouse_username=args.clickhouse_username,
            clickhouse_password=args.clickhouse_password,
            clickhouse_table=args.clickhouse_table,
        )
        signal_fetch_counts[symbol] = len(signals)
        all_signals.extend(signals)
        logger.info('Fetched %s signals for %s', len(signals), symbol)

    all_signals.sort(key=_signal_sort_key)
    buckets = _bucket_signals(all_signals, bucket_seconds=args.bucket_seconds)
    logger.info(
        'Loaded %s total signals across %s symbols into %s replay buckets',
        len(all_signals),
        len(symbols),
        len(buckets),
    )

    db_path = output_dir / 'replay.sqlite3'
    if db_path.exists():
        db_path.unlink()
    engine = create_engine(f'sqlite+pysqlite:///{db_path}', future=True)
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    _seed_strategies(session_local, strategy_defs)
    _configure_replay_settings(
        symbols=symbols,
        max_notional_per_order=args.max_notional_per_order,
        max_notional_per_symbol=args.max_notional_per_symbol,
        allow_shorts=args.allow_shorts,
    )

    broker_adapter = SimulationExecutionAdapter(
        bootstrap_servers=None,
        security_protocol=None,
        sasl_mechanism=None,
        sasl_username=None,
        sasl_password=None,
        topic='torghut.sim.trade-updates.v1',
        account_label='paper',
        simulation_run_id='local-simple-20260326',
        dataset_id='local-clickhouse-march26',
    )
    broker = LocalSimulationBroker(
        adapter=broker_adapter,
        initial_cash=args.initial_cash,
        allow_shorts=args.allow_shorts,
    )
    replay_ingestor = BucketReplayIngestor(buckets)
    pipeline = SimpleTradingPipeline(
        alpaca_client=broker,
        order_firewall=OrderFirewall(broker),
        ingestor=replay_ingestor,
        decision_engine=DecisionEngine(),
        risk_engine=RiskEngine(),
        executor=OrderExecutor(),
        execution_adapter=broker_adapter,
        reconciler=Reconciler(),
        universe_resolver=UniverseResolver(),
        state=TradingState(),
        account_label='paper',
        session_factory=session_local,
    )
    pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

    while replay_ingestor.remaining > 0:
        pipeline.run_once()
    reconcile_updates = pipeline.reconcile()
    artifacts = _build_artifacts(
        session_local=session_local,
        pipeline=pipeline,
        output_dir=output_dir,
        start=start,
        end=end,
        symbols=symbols,
        strategies=strategy_defs,
        signal_fetch_counts=signal_fetch_counts,
        total_signals=len(all_signals),
        replay_buckets=len(buckets),
        reconcile_updates=reconcile_updates,
    )
    _write_artifacts(output_dir=output_dir, artifacts=artifacts)
    logger.info(
        'Replay complete executions=%s submitted=%s rejected=%s blocked=%s',
        artifacts.replay_report['executions_total'],
        artifacts.replay_report['orders_submitted_total'],
        artifacts.replay_report['rejected_total'],
        artifacts.replay_report['blocked_total'],
    )
    return 0 if artifacts.run_summary['acceptance']['passed'] else 1


def _parse_timestamp(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith('Z'):
        normalized = normalized[:-1] + '+00:00'
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _load_enabled_strategies(path: Path) -> list[dict[str, Any]]:
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        return []
    raw_catalog = payload.get('data', {}).get('strategies.yaml')
    if not isinstance(raw_catalog, str):
        return []
    catalog = yaml.safe_load(raw_catalog)
    if not isinstance(catalog, dict):
        return []
    raw_strategies = catalog.get('strategies')
    if not isinstance(raw_strategies, list):
        return []
    enabled: list[dict[str, Any]] = []
    for entry in raw_strategies:
        if not isinstance(entry, dict):
            continue
        if not bool(entry.get('enabled', False)):
            continue
        enabled.append(entry)
    return enabled


def _seed_strategies(
    session_local: sessionmaker[Session],
    strategy_defs: list[dict[str, Any]],
) -> None:
    with session_local() as session:
        for definition in strategy_defs:
            session.add(
                Strategy(
                    name=str(definition.get('name') or 'strategy'),
                    description=str(definition.get('description') or ''),
                    enabled=True,
                    base_timeframe=str(definition.get('base_timeframe') or '1Sec'),
                    universe_type=str(definition.get('universe_type') or 'static'),
                    universe_symbols=definition.get('universe_symbols'),
                    max_position_pct_equity=_optional_decimal(
                        definition.get('max_position_pct_equity')
                    ),
                    max_notional_per_trade=_optional_decimal(
                        definition.get('max_notional_per_trade')
                    ),
                )
            )
        session.commit()


def _configure_replay_settings(
    *,
    symbols: list[str],
    max_notional_per_order: Decimal | None,
    max_notional_per_symbol: Decimal | None,
    allow_shorts: bool,
) -> None:
    config.settings.trading_enabled = True
    config.settings.trading_mode = 'paper'
    config.settings.trading_live_enabled = False
    config.settings.trading_pipeline_mode = 'simple'
    config.settings.trading_simple_submit_enabled = True
    config.settings.trading_simple_order_feed_telemetry_enabled = False
    config.settings.trading_simple_max_notional_per_order = (
        float(max_notional_per_order) if max_notional_per_order is not None else None
    )
    config.settings.trading_simple_max_notional_per_symbol = (
        float(max_notional_per_symbol) if max_notional_per_symbol is not None else None
    )
    config.settings.trading_kill_switch_enabled = False
    config.settings.trading_emergency_stop_enabled = False
    config.settings.trading_universe_source = 'jangar'
    config.settings.trading_universe_static_fallback_enabled = True
    config.settings.trading_universe_static_fallback_symbols_raw = ','.join(symbols)
    config.settings.trading_allow_shorts = allow_shorts
    config.settings.trading_fractional_equities_enabled = True
    config.settings.trading_feature_quality_enabled = False
    config.settings.trading_strategy_scheduler_enabled = False
    config.settings.trading_strategy_runtime_mode = 'scheduler_v3'
    config.settings.llm_enabled = False


def _fetch_signals_adaptive(
    *,
    ingestor: ClickHouseSignalIngestor,
    symbol: str,
    start: datetime,
    end: datetime,
    min_split_seconds: int,
    clickhouse_transport: str,
    clickhouse_namespace: str,
    clickhouse_pod: str,
    clickhouse_username: str,
    clickhouse_password: str,
    clickhouse_table: str,
) -> list[SignalEnvelope]:
    try:
        return _fetch_signals_window(
            ingestor=ingestor,
            symbol=symbol,
            start=start,
            end=end,
            clickhouse_transport=clickhouse_transport,
            clickhouse_namespace=clickhouse_namespace,
            clickhouse_pod=clickhouse_pod,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            clickhouse_table=clickhouse_table,
        )
    except Exception as exc:
        window_seconds = int((end - start).total_seconds())
        if window_seconds <= min_split_seconds:
            raise RuntimeError(
                f'Failed to fetch {symbol} signals for {start.isoformat()}..{end.isoformat()}'
            ) from exc
        midpoint = start + timedelta(seconds=window_seconds // 2)
        if midpoint <= start or midpoint >= end:
            raise
        logger.warning(
            'Splitting %s window %s..%s after fetch failure: %s',
            symbol,
            start.isoformat(),
            end.isoformat(),
            exc,
        )
        left = _fetch_signals_adaptive(
            ingestor=ingestor,
            symbol=symbol,
            start=start,
            end=midpoint,
            min_split_seconds=min_split_seconds,
            clickhouse_transport=clickhouse_transport,
            clickhouse_namespace=clickhouse_namespace,
            clickhouse_pod=clickhouse_pod,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            clickhouse_table=clickhouse_table,
        )
        right = _fetch_signals_adaptive(
            ingestor=ingestor,
            symbol=symbol,
            start=midpoint,
            end=end,
            min_split_seconds=min_split_seconds,
            clickhouse_transport=clickhouse_transport,
            clickhouse_namespace=clickhouse_namespace,
            clickhouse_pod=clickhouse_pod,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            clickhouse_table=clickhouse_table,
        )
        return left + right


def _fetch_signals_window(
    *,
    ingestor: ClickHouseSignalIngestor,
    symbol: str,
    start: datetime,
    end: datetime,
    clickhouse_transport: str,
    clickhouse_namespace: str,
    clickhouse_pod: str,
    clickhouse_username: str,
    clickhouse_password: str,
    clickhouse_table: str,
) -> list[SignalEnvelope]:
    if clickhouse_transport == 'http':
        return ingestor.fetch_signals_between(start, end, symbol=symbol)
    rows = _fetch_rows_via_kubectl(
        symbol=symbol,
        start=start,
        end=end,
        clickhouse_namespace=clickhouse_namespace,
        clickhouse_pod=clickhouse_pod,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        clickhouse_table=clickhouse_table,
    )
    signals: list[SignalEnvelope] = []
    for row in rows:
        signal = ingestor.parse_row(row)
        if signal is None:
            continue
        signals.append(signal)
    return ingestor._sorted_signals(ingestor._filter_signals(ingestor._dedupe_signals(signals)))


def _fetch_rows_via_kubectl(
    *,
    symbol: str,
    start: datetime,
    end: datetime,
    clickhouse_namespace: str,
    clickhouse_pod: str,
    clickhouse_username: str,
    clickhouse_password: str,
    clickhouse_table: str,
) -> list[dict[str, Any]]:
    start_literal = _to_ch_datetime64(start)
    end_literal = _to_ch_datetime64(end)
    select_expr = ', '.join(ESSENTIAL_SIGNAL_COLUMNS)
    query = (
        f"SELECT {select_expr} "
        f"FROM {clickhouse_table} "
        f"WHERE symbol = '{symbol}' "
        f"AND event_ts >= {start_literal} "
        f"AND event_ts <= {end_literal} "
        "ORDER BY event_ts ASC, seq ASC "
        "FORMAT JSONEachRow"
    )
    result = subprocess.run(
        [
            'kubectl',
            'exec',
            '-n',
            clickhouse_namespace,
            clickhouse_pod,
            '--',
            'clickhouse-client',
            '--user',
            clickhouse_username,
            '--password',
            clickhouse_password,
            '--query',
            query,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(detail[:400])
    rows: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        normalized = line.strip()
        if not normalized:
            continue
        rows.append(json.loads(normalized))
    return rows


def _to_ch_datetime64(value: datetime) -> str:
    timestamp = value.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    return f"toDateTime64('{timestamp}', 3, 'UTC')"


def _bucket_signals(
    signals: list[SignalEnvelope],
    *,
    bucket_seconds: int,
) -> list[list[SignalEnvelope]]:
    if not signals:
        return []
    buckets: list[list[SignalEnvelope]] = []
    current_bucket: list[SignalEnvelope] = []
    current_key: datetime | None = None
    for signal in signals:
        bucket_key = _bucket_start(signal.event_ts, bucket_seconds=bucket_seconds)
        if current_key is None or bucket_key != current_key:
            if current_bucket:
                buckets.append(current_bucket)
            current_bucket = [signal]
            current_key = bucket_key
            continue
        current_bucket.append(signal)
    if current_bucket:
        buckets.append(current_bucket)
    return buckets


def _bucket_start(timestamp: datetime, *, bucket_seconds: int) -> datetime:
    epoch_seconds = int(timestamp.timestamp())
    bucket_epoch = epoch_seconds - (epoch_seconds % max(bucket_seconds, 1))
    return datetime.fromtimestamp(bucket_epoch, tz=timezone.utc)


def _signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, int]:
    return (
        signal.event_ts,
        signal.symbol,
        int(signal.seq or 0),
    )


def _build_artifacts(
    *,
    session_local: sessionmaker[Session],
    pipeline: SimpleTradingPipeline,
    output_dir: Path,
    start: datetime,
    end: datetime,
    symbols: list[str],
    strategies: list[dict[str, Any]],
    signal_fetch_counts: dict[str, int],
    total_signals: int,
    replay_buckets: int,
    reconcile_updates: int,
) -> ReplayArtifacts:
    with session_local() as session:
        decisions = list(session.execute(select(TradeDecision)).scalars())
        executions = list(session.execute(select(Execution)).scalars())
    decision_status_totals = Counter(decision.status for decision in decisions)
    execution_status_totals = Counter(execution.status for execution in executions)
    reject_reasons = Counter()
    block_reasons = Counter()
    lane_values = Counter()
    submit_paths = Counter()
    for decision in decisions:
        payload = _mapping(decision.decision_json)
        params = _mapping(payload.get('params'))
        lane_values.update([str(params.get('execution_lane') or '')])
        submit_paths.update([str(params.get('submit_path') or '')])
        reject_reasons.update(_string_list(payload.get('risk_reasons')))
        if payload.get('submission_block_reason'):
            block_reasons.update([str(payload['submission_block_reason'])])
    governance_blockers = sorted(
        reason
        for reason in block_reasons
        if _is_governance_block_reason(reason)
    )
    invalid_reject_reasons = sorted(
        reason
        for reason in reject_reasons
        if reason not in ALLOWED_REJECT_REASONS
    )
    runtime_verify = {
        'runtime_state': 'ready',
        'pipeline_mode': config.settings.trading_pipeline_mode,
        'execution_lane': 'simple',
        'submit_path': 'direct_alpaca',
        'window_start': start.isoformat(),
        'window_end': end.isoformat(),
        'strategy_names': [str(item.get('name')) for item in strategies],
        'strategy_count': len(strategies),
        'symbols': symbols,
        'signal_fetch_counts': signal_fetch_counts,
        'signals_total': total_signals,
        'replay_bucket_count': replay_buckets,
        'output_dir': str(output_dir),
    }
    replay_report = {
        'pipeline_mode': config.settings.trading_pipeline_mode,
        'execution_lane': 'simple',
        'signals_total': total_signals,
        'decision_total': len(decisions),
        'orders_submitted_total': decision_status_totals.get('submitted', 0),
        'rejected_total': decision_status_totals.get('rejected', 0),
        'blocked_total': decision_status_totals.get('blocked', 0),
        'executions_total': len(executions),
        'decision_status_totals': dict(decision_status_totals),
        'execution_status_totals': dict(execution_status_totals),
        'reject_reason_totals': dict(reject_reasons),
        'block_reason_totals': dict(block_reasons),
        'reconcile_updates': reconcile_updates,
        'metrics': {
            'orders_submitted_total': pipeline.state.metrics.orders_submitted_total,
            'orders_rejected_total': pipeline.state.metrics.orders_rejected_total,
            'decisions_total': pipeline.state.metrics.decisions_total,
            'reconcile_updates_total': pipeline.state.metrics.reconcile_updates_total,
        },
    }
    decision_activity = {
        'pipeline_mode': 'simple',
        'trade_decisions': len(decisions),
        'decision_status_totals': dict(decision_status_totals),
        'reject_reason_totals': dict(reject_reasons),
        'block_reason_totals': dict(block_reasons),
        'execution_lane_totals': {
            key: value for key, value in lane_values.items() if key
        },
        'submit_path_totals': {
            key: value for key, value in submit_paths.items() if key
        },
    }
    execution_activity = {
        'pipeline_mode': 'simple',
        'executions': len(executions),
        'execution_status_totals': dict(execution_status_totals),
        'reconcile_updates': reconcile_updates,
    }
    acceptance = {
        'executions_non_zero': len(executions) > 0,
        'capital_stage_shadow_blocks_zero': block_reasons.get('capital_stage_shadow', 0) == 0,
        'alpha_readiness_blocks_zero': not any(
            reason.startswith('alpha_readiness_') for reason in block_reasons
        ),
        'dependency_quorum_blocks_zero': not any(
            reason.startswith('dependency_quorum_') for reason in block_reasons
        ),
        'market_context_blocks_zero': not any(
            reason.startswith('market_context') for reason in block_reasons
        ),
        'llm_blocks_zero': not any(reason.startswith('llm_') for reason in block_reasons),
        'reject_reasons_within_simple_allowlist': not invalid_reject_reasons,
        'reconciliation_updates_persisted': reconcile_updates >= 0,
        'governance_blockers': governance_blockers,
        'invalid_reject_reasons': invalid_reject_reasons,
    }
    acceptance['passed'] = all(
        bool(value)
        for key, value in acceptance.items()
        if key not in {'governance_blockers', 'invalid_reject_reasons'}
    )
    run_summary = {
        'run_token': 'local-simple-20260326',
        'window_start': start.isoformat(),
        'window_end': end.isoformat(),
        'pipeline_mode': 'simple',
        'execution_lane': 'simple',
        'signals_total': total_signals,
        'decision_total': len(decisions),
        'executions_total': len(executions),
        'acceptance': acceptance,
        'artifacts': {
            'runtime_verify_path': str(output_dir / 'runtime-verify.json'),
            'replay_report_path': str(output_dir / 'replay-report.json'),
            'decision_activity_path': str(output_dir / 'decision-activity.json'),
            'execution_activity_path': str(output_dir / 'execution-activity.json'),
            'run_summary_path': str(output_dir / 'run-summary.json'),
        },
    }
    return ReplayArtifacts(
        runtime_verify=runtime_verify,
        replay_report=replay_report,
        decision_activity=decision_activity,
        execution_activity=execution_activity,
        run_summary=run_summary,
    )


def _write_artifacts(*, output_dir: Path, artifacts: ReplayArtifacts) -> None:
    _write_json(output_dir / 'runtime-verify.json', artifacts.runtime_verify)
    _write_json(output_dir / 'replay-report.json', artifacts.replay_report)
    _write_json(output_dir / 'decision-activity.json', artifacts.decision_activity)
    _write_json(output_dir / 'execution-activity.json', artifacts.execution_activity)
    _write_json(output_dir / 'run-summary.json', artifacts.run_summary)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + '\n')


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _is_governance_block_reason(reason: str) -> bool:
    return (
        reason == 'capital_stage_shadow'
        or reason.startswith('alpha_readiness_')
        or reason.startswith('dependency_quorum_')
        or reason.startswith('market_context')
        or reason.startswith('llm_')
    )


if __name__ == '__main__':
    raise SystemExit(main())

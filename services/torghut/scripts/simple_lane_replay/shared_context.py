#!/usr/bin/env python3
"""Replay one trading session through Torghut's simple execution lane locally."""

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
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias, cast

import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

if TYPE_CHECKING:
    from app.trading.execution_adapters import (
        SimulationExecutionAdapter as SimulationExecutionAdapterT,
    )
    from app.trading.ingest import (
        ClickHouseSignalIngestor as ClickHouseSignalIngestorT,
        SignalBatch as SignalBatchT,
    )
    from app.trading.models import SignalEnvelope as SignalEnvelopeT
else:
    ClickHouseSignalIngestorT: TypeAlias = Any
    SignalBatchT: TypeAlias = Any
    SignalEnvelopeT: TypeAlias = Any
    SimulationExecutionAdapterT: TypeAlias = Any


SCRIPT_DIR = Path(__file__).resolve().parent

SERVICE_ROOT = SCRIPT_DIR.parent

REPO_ROOT = SERVICE_ROOT.parent.parent

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

config = import_module("app.config")

_models = import_module("app.models")
Base = cast(Any, _models.Base)
Execution = cast(Any, _models.Execution)
Strategy = cast(Any, _models.Strategy)
TradeDecision = cast(Any, _models.TradeDecision)

_strategy_catalog = import_module("app.strategies.catalog")
StrategyConfig = cast(Any, _strategy_catalog.StrategyConfig)
_compose_strategy_description = cast(
    Any, _strategy_catalog._compose_strategy_description
)

DecisionEngine = cast(Any, import_module("app.trading.decisions").DecisionEngine)

OrderExecutor = cast(Any, import_module("app.trading.execution").OrderExecutor)

_execution_adapters = import_module("app.trading.execution_adapters")
OrderSubmission = cast(Any, _execution_adapters.OrderSubmission)
SimulationExecutionAdapter = cast(Any, _execution_adapters.SimulationExecutionAdapter)

OrderFirewall = cast(Any, import_module("app.trading.firewall").OrderFirewall)

_trading_ingest = import_module("app.trading.ingest")
ClickHouseSignalIngestor = cast(Any, _trading_ingest.ClickHouseSignalIngestor)
SignalBatch = cast(Any, _trading_ingest.SignalBatch)

SignalEnvelope = cast(Any, import_module("app.trading.models").SignalEnvelope)

Reconciler = cast(Any, import_module("app.trading.reconcile").Reconciler)

RiskEngine = cast(Any, import_module("app.trading.risk").RiskEngine)

SimpleTradingPipeline = cast(
    Any, import_module("app.trading.scheduler.simple_pipeline").SimpleTradingPipeline
)

TradingState = cast(Any, import_module("app.trading.scheduler.state").TradingState)

UniverseResolver = cast(Any, import_module("app.trading.universe").UniverseResolver)

DEFAULT_SYMBOLS = [
    "NVDA",
    "AAPL",
    "AMZN",
    "GOOGL",
    "AVGO",
    "AMD",
    "ORCL",
    "INTC",
]

ALLOWED_REJECT_REASONS = {
    "kill_switch_enabled",
    "invalid_qty_increment",
    "qty_below_min_after_clamp",
    "insufficient_buying_power",
    "max_notional_exceeded",
    "max_symbol_exposure_exceeded",
    "shorting_not_allowed_for_asset",
    "broker_precheck_failed",
    "broker_submit_failed",
}

DEFAULT_START = "2026-03-26T13:30:00Z"

DEFAULT_END = "2026-03-26T20:00:00Z"

DEFAULT_OUTPUT_DIR = REPO_ROOT / "artifacts/torghut/simulations/local-simple-20260326"

DEFAULT_CLICKHOUSE_URL = "http://torghut-clickhouse.torghut.svc.cluster.local:8123"

DEFAULT_CLICKHOUSE_NAMESPACE = "torghut"

DEFAULT_CLICKHOUSE_POD = "chi-torghut-clickhouse-default-0-0-0"

ESSENTIAL_SIGNAL_COLUMNS = [
    "event_ts",
    "ingest_ts",
    "symbol",
    "window_size",
    "window_step",
    "seq",
    "source",
    "macd",
    "macd_signal",
    "rsi14",
    "vwap_session",
    "vwap_w5m",
    "imbalance_spread",
    "imbalance_bid_px",
    "imbalance_ask_px",
    "imbalance_bid_sz",
    "imbalance_ask_sz",
    "vol_realized_w60s",
    "microstructure_signal_v1",
]

logger = logging.getLogger("torghut.simple_replay")


@dataclass
class ReplayArtifacts:
    runtime_verify: dict[str, Any]
    replay_report: dict[str, Any]
    decision_activity: dict[str, Any]
    execution_activity: dict[str, Any]
    run_summary: dict[str, Any]


class BucketReplayIngestor:
    """Feed preloaded signal buckets into the scheduler."""

    def __init__(self, buckets: list[list[SignalEnvelopeT]]) -> None:
        self._buckets = buckets
        self._cursor = 0
        self.committed_batches = 0

    @property
    def remaining(self) -> int:
        return max(len(self._buckets) - self._cursor, 0)

    def fetch_signals(self, session: Session) -> SignalBatchT:
        _ = session
        if self._cursor >= len(self._buckets):
            return SignalBatch(
                signals=[],
                cursor_at=None,
                cursor_seq=None,
                cursor_symbol=None,
                no_signal_reason="replay_complete",
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
            no_signal_reason=None if signals else "empty_bucket",
        )

    def commit_cursor(self, session: Session, batch: SignalBatchT) -> None:
        _ = (session, batch)
        if self._cursor < len(self._buckets):
            self._cursor += 1
            self.committed_batches += 1


class LocalSimulationBroker:
    """Small wrapper that gives the simulation adapter a broker-like account surface."""

    def __init__(
        self,
        *,
        adapter: SimulationExecutionAdapterT,
        initial_cash: Decimal,
        allow_shorts: bool,
    ) -> None:
        self._adapter = adapter
        self._cash = initial_cash
        self._allow_shorts = allow_shorts

    def get_account(self) -> dict[str, Any]:
        positions = self.list_positions()
        net_market_value = Decimal("0")
        for position in positions:
            raw_market_value = position.get("market_value")
            if raw_market_value is None:
                continue
            try:
                net_market_value += Decimal(str(raw_market_value))
            except Exception:
                continue
        equity = self._cash + net_market_value
        buying_power = max(self._cash, equity, Decimal("0"))
        return {
            "equity": str(equity),
            "cash": str(self._cash),
            "buying_power": str(buying_power),
            "shorting_enabled": self._allow_shorts,
        }

    def list_positions(self) -> list[dict[str, Any]]:
        return self._adapter.list_positions()

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any]:
        return {
            "symbol": symbol_or_asset_id,
            "tradable": True,
            "shortable": self._allow_shorts,
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
            OrderSubmission(
                symbol=symbol,
                side=side,
                qty=qty,
                order_type=order_type,
                time_in_force=time_in_force,
                limit_price=limit_price,
                stop_price=stop_price,
                extra_params=extra_params,
            )
        )
        filled_qty = Decimal(str(order.get("filled_qty") or order.get("qty") or "0"))
        fill_price = Decimal(str(order.get("filled_avg_price") or "0"))
        cash_delta = filled_qty * fill_price
        if side.strip().lower() == "buy":
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

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None:
        return self._adapter.get_order_by_client_order_id(client_order_id)

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        return self._adapter.get_order(alpaca_order_id)

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]:
        return self._adapter.list_orders(status=status)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay a trading session through the simple execution lane.",
    )
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument(
        "--strategy-config",
        default=str(REPO_ROOT / "argocd/applications/torghut/strategy-configmap.yaml"),
    )
    parser.add_argument("--clickhouse-url", default=DEFAULT_CLICKHOUSE_URL)
    parser.add_argument("--clickhouse-username", default="torghut")
    parser.add_argument("--clickhouse-password", required=True)
    parser.add_argument("--clickhouse-table", default="torghut.ta_signals")
    parser.add_argument(
        "--clickhouse-transport",
        choices=["kubectl", "http"],
        default="kubectl",
    )
    parser.add_argument(
        "--clickhouse-namespace",
        default=DEFAULT_CLICKHOUSE_NAMESPACE,
    )
    parser.add_argument(
        "--clickhouse-pod",
        default=DEFAULT_CLICKHOUSE_POD,
    )
    parser.add_argument(
        "--kubectl-context",
        default="",
        help="Optional kube context for kubectl ClickHouse transport.",
    )
    parser.add_argument("--initial-cash", type=Decimal, default=Decimal("10000"))
    parser.add_argument("--bucket-seconds", type=int, default=60)
    parser.add_argument("--min-split-seconds", type=int, default=60)
    parser.add_argument("--max-notional-per-order", type=Decimal, default=None)
    parser.add_argument("--max-notional-per-symbol", type=Decimal, default=None)
    parser.add_argument("--allow-shorts", action="store_true", default=True)
    parser.add_argument("--disable-shorts", dest="allow_shorts", action="store_false")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    start = _parse_timestamp(args.start)
    end = _parse_timestamp(args.end)
    symbols = [
        symbol.strip().upper() for symbol in args.symbols.split(",") if symbol.strip()
    ]
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
        raise RuntimeError("No enabled strategies found in strategy config")

    signal_fetch_counts: dict[str, int] = {}
    all_signals: list[SignalEnvelopeT] = []
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
            kubectl_context=str(args.kubectl_context or ""),
            clickhouse_username=args.clickhouse_username,
            clickhouse_password=args.clickhouse_password,
            clickhouse_table=args.clickhouse_table,
        )
        signal_fetch_counts[symbol] = len(signals)
        all_signals.extend(signals)
        logger.info("Fetched %s signals for %s", len(signals), symbol)

    from .fetch_rows_via_kubectl import (
        _bucket_signals,
        _build_artifacts,
        _signal_sort_key,
        _write_artifacts,
    )

    all_signals.sort(key=_signal_sort_key)
    buckets = _bucket_signals(all_signals, bucket_seconds=args.bucket_seconds)
    logger.info(
        "Loaded %s total signals across %s symbols into %s replay buckets",
        len(all_signals),
        len(symbols),
        len(buckets),
    )

    db_path = output_dir / "replay.sqlite3"
    if db_path.exists():
        db_path.unlink()
    engine = create_engine(f"sqlite+pysqlite:///{db_path}", future=True)
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
        topic="torghut.sim.trade-updates.v1",
        account_label="paper",
        simulation_run_id="local-simple-20260326",
        dataset_id="local-clickhouse-march26",
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
        account_label="paper",
        session_factory=session_local,
    )
    setattr(pipeline, "_is_market_session_open", lambda _now=None: True)

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
        "Replay complete executions=%s submitted=%s rejected=%s blocked=%s",
        artifacts.replay_report["executions_total"],
        artifacts.replay_report["orders_submitted_total"],
        artifacts.replay_report["rejected_total"],
        artifacts.replay_report["blocked_total"],
    )
    return 0 if artifacts.run_summary["acceptance"]["passed"] else 1


def _parse_timestamp(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _load_enabled_strategies(path: Path) -> list[dict[str, Any]]:
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        return []
    raw_catalog = payload.get("data", {}).get("strategies.yaml")
    if not isinstance(raw_catalog, str):
        return []
    catalog = yaml.safe_load(raw_catalog)
    if not isinstance(catalog, dict):
        return []
    raw_strategies = catalog.get("strategies")
    if not isinstance(raw_strategies, list):
        return []
    enabled: list[dict[str, Any]] = []
    for entry in raw_strategies:
        if not isinstance(entry, dict):
            continue
        if not bool(entry.get("enabled", False)):
            continue
        enabled.append(entry)
    return enabled


def _seed_strategies(
    session_local: sessionmaker[Session],
    strategy_defs: list[dict[str, Any]],
) -> None:
    with session_local() as session:
        for definition in strategy_defs:
            config_entry = StrategyConfig.model_validate(definition)
            session.add(
                Strategy(
                    name=str(config_entry.name or "strategy"),
                    description=_compose_strategy_description(config_entry),
                    enabled=True,
                    base_timeframe=str(config_entry.base_timeframe or "1Sec"),
                    universe_type=str(config_entry.universe_type or "static"),
                    universe_symbols=config_entry.universe_symbols,
                    max_position_pct_equity=config_entry.max_position_pct_equity,
                    max_notional_per_trade=config_entry.max_notional_per_trade,
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
    config.settings.trading_mode = "paper"
    config.settings.trading_pipeline_mode = "simple"
    config.settings.trading_simple_submit_enabled = True
    config.settings.trading_simple_order_feed_telemetry_enabled = False
    config.settings.trading_simple_paper_route_probe_enabled = True
    config.settings.trading_simple_paper_route_probe_max_notional = 25.0
    config.settings.trading_simple_max_notional_per_order = (
        float(max_notional_per_order) if max_notional_per_order is not None else None
    )
    config.settings.trading_simple_max_notional_per_symbol = (
        float(max_notional_per_symbol) if max_notional_per_symbol is not None else None
    )
    config.settings.trading_kill_switch_enabled = False
    config.settings.trading_emergency_stop_enabled = False
    config.settings.trading_universe_source = "jangar"
    config.settings.trading_universe_static_fallback_enabled = True
    config.settings.trading_universe_static_fallback_symbols_raw = ",".join(symbols)
    config.settings.trading_allow_shorts = allow_shorts
    config.settings.trading_fractional_equities_enabled = True
    config.settings.trading_feature_quality_enabled = False
    config.settings.trading_strategy_runtime_mode = "scheduler_v3"
    config.settings.llm_enabled = False


def _fetch_signals_adaptive(
    *,
    ingestor: ClickHouseSignalIngestorT,
    symbol: str,
    start: datetime,
    end: datetime,
    min_split_seconds: int,
    clickhouse_transport: str,
    clickhouse_namespace: str,
    clickhouse_pod: str,
    kubectl_context: str,
    clickhouse_username: str,
    clickhouse_password: str,
    clickhouse_table: str,
) -> list[SignalEnvelopeT]:
    try:
        return _fetch_signals_window(
            ingestor=ingestor,
            symbol=symbol,
            start=start,
            end=end,
            clickhouse_transport=clickhouse_transport,
            clickhouse_namespace=clickhouse_namespace,
            clickhouse_pod=clickhouse_pod,
            kubectl_context=kubectl_context,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            clickhouse_table=clickhouse_table,
        )
    except Exception as exc:
        window_seconds = int((end - start).total_seconds())
        if window_seconds <= min_split_seconds:
            raise RuntimeError(
                f"Failed to fetch {symbol} signals for {start.isoformat()}..{end.isoformat()}"
            ) from exc
        midpoint = start + timedelta(seconds=window_seconds // 2)
        if midpoint <= start or midpoint >= end:
            raise
        logger.warning(
            "Splitting %s window %s..%s after fetch failure: %s",
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
            kubectl_context=kubectl_context,
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
            kubectl_context=kubectl_context,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            clickhouse_table=clickhouse_table,
        )
        return left + right


def _fetch_signals_window(
    *,
    ingestor: ClickHouseSignalIngestorT,
    symbol: str,
    start: datetime,
    end: datetime,
    clickhouse_transport: str,
    clickhouse_namespace: str,
    clickhouse_pod: str,
    kubectl_context: str,
    clickhouse_username: str,
    clickhouse_password: str,
    clickhouse_table: str,
) -> list[SignalEnvelopeT]:
    if clickhouse_transport == "http":
        return ingestor.fetch_signals_between(start, end, symbol=symbol)
    from .fetch_rows_via_kubectl import _fetch_rows_via_kubectl

    rows = _fetch_rows_via_kubectl(
        symbol=symbol,
        start=start,
        end=end,
        clickhouse_namespace=clickhouse_namespace,
        clickhouse_pod=clickhouse_pod,
        kubectl_context=kubectl_context,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        clickhouse_table=clickhouse_table,
    )
    signals: list[SignalEnvelopeT] = []
    for row in rows:
        signal = ingestor.parse_row(row)
        if signal is None:
            continue
        signals.append(signal)
    return ingestor._sorted_signals(
        ingestor._filter_signals(ingestor._dedupe_signals(signals))
    )


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ALLOWED_REJECT_REASONS",
    "Any",
    "Base",
    "BucketReplayIngestor",
    "ClickHouseSignalIngestor",
    "Counter",
    "DEFAULT_CLICKHOUSE_NAMESPACE",
    "DEFAULT_CLICKHOUSE_POD",
    "DEFAULT_CLICKHOUSE_URL",
    "DEFAULT_END",
    "DEFAULT_OUTPUT_DIR",
    "DEFAULT_START",
    "DEFAULT_SYMBOLS",
    "Decimal",
    "DecisionEngine",
    "ESSENTIAL_SIGNAL_COLUMNS",
    "Execution",
    "LocalSimulationBroker",
    "OrderExecutor",
    "OrderFirewall",
    "Path",
    "REPO_ROOT",
    "Reconciler",
    "ReplayArtifacts",
    "RiskEngine",
    "SCRIPT_DIR",
    "SERVICE_ROOT",
    "Session",
    "SignalBatch",
    "SignalEnvelope",
    "SimpleTradingPipeline",
    "SimulationExecutionAdapter",
    "Strategy",
    "StrategyConfig",
    "TradeDecision",
    "TradingState",
    "UniverseResolver",
    "_compose_strategy_description",
    "_configure_replay_settings",
    "_fetch_signals_adaptive",
    "_fetch_signals_window",
    "_load_enabled_strategies",
    "_parse_timestamp",
    "_seed_strategies",
    "annotations",
    "argparse",
    "config",
    "create_engine",
    "dataclass",
    "datetime",
    "json",
    "logger",
    "logging",
    "main",
    "parse_args",
    "select",
    "sessionmaker",
    "subprocess",
    "sys",
    "timedelta",
    "timezone",
    "yaml",
)

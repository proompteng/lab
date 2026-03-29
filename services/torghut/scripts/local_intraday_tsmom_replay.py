#!/usr/bin/env python3
"""Run a local deterministic intraday TSMOM replay against ClickHouse signals."""

from __future__ import annotations

import argparse
import csv
import http.client
import json
import logging
import os
import time as time_mod
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable
from urllib import error, request

import yaml
from unittest.mock import patch

from app.models import Strategy
from app.strategies.catalog import StrategyCatalogConfig, _compose_strategy_description
from app.config import settings
from app.trading.costs import CostModelInputs, OrderIntent, TransactionCostModel
from app.trading.decisions import DecisionEngine
from app.trading.execution_policy import _near_touch_limit_price
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.portfolio import allocator_from_settings, sizer_from_settings
from app.trading.quote_quality import (
    DEFAULT_MAX_EXECUTABLE_SPREAD_BPS,
    DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS,
    DEFAULT_MAX_QUOTE_MID_JUMP_BPS,
    QuoteQualityPolicy,
    QuoteQualityStatus,
    SignalQuoteQualityTracker,
    assess_signal_quote_quality,
)

logging.getLogger('alembic').setLevel(logging.WARNING)

logging.getLogger('alembic').setLevel(logging.WARNING)

REGULAR_OPEN_UTC = time(hour=13, minute=30)
REGULAR_CLOSE_UTC = time(hour=20, minute=0)
DEFAULT_CHUNK_MINUTES = 10
DEFAULT_START_EQUITY = Decimal('31590.02')
DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS = 15
logger = logging.getLogger(__name__)
_SHARED_POSITION_OWNER = '__shared__'


def _position_key(symbol: str, strategy_id: str) -> tuple[str, str]:
    return (symbol.strip().upper(), strategy_id.strip())


@dataclass(frozen=True)
class ReplayConfig:
    strategy_configmap_path: Path
    clickhouse_http_url: str
    clickhouse_username: str | None
    clickhouse_password: str | None
    start_date: date
    end_date: date
    chunk_minutes: int
    flatten_eod: bool
    start_equity: Decimal
    symbols: tuple[str, ...] = ()
    progress_log_interval_seconds: int = DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS
    max_executable_spread_bps: Decimal = DEFAULT_MAX_EXECUTABLE_SPREAD_BPS
    max_quote_mid_jump_bps: Decimal = DEFAULT_MAX_QUOTE_MID_JUMP_BPS
    max_jump_with_wide_spread_bps: Decimal = DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS


@dataclass
class PositionState:
    strategy_id: str
    qty: Decimal
    avg_entry_price: Decimal
    opened_at: datetime
    entry_cost_total: Decimal
    decision_at: datetime
    pending_entry: bool = False


@dataclass
class PendingOrder:
    decision: StrategyDecision
    created_at: datetime
    signal: SignalEnvelope


@dataclass
class ClosedTrade:
    symbol: str
    strategy_id: str
    decision_at: datetime
    opened_at: datetime
    closed_at: datetime
    qty: Decimal
    entry_price: Decimal
    exit_price: Decimal
    gross_pnl: Decimal
    net_pnl: Decimal
    exit_reason: str


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Replay intraday TSMOM over a week of ClickHouse `ta_signals`.',
    )
    parser.add_argument(
        '--strategy-configmap',
        default='argocd/applications/torghut/strategy-configmap.yaml',
    )
    parser.add_argument(
        '--clickhouse-http-url',
        default=os.environ.get(
            'TA_CLICKHOUSE_URL',
            'http://torghut-clickhouse.torghut.svc.cluster.local:8123',
        ),
    )
    parser.add_argument(
        '--clickhouse-username',
        default=os.environ.get('CLICKHOUSE_USERNAME', 'torghut'),
    )
    parser.add_argument(
        '--clickhouse-password',
        default=os.environ.get('CLICKHOUSE_PASSWORD', ''),
    )
    parser.add_argument('--start-date', default='2026-03-23')
    parser.add_argument('--end-date', default='2026-03-27')
    parser.add_argument('--chunk-minutes', type=int, default=DEFAULT_CHUNK_MINUTES)
    parser.add_argument('--start-equity', default=str(DEFAULT_START_EQUITY))
    parser.add_argument(
        '--symbols',
        default='',
        help='Optional comma-separated symbol filter applied in the ClickHouse query.',
    )
    parser.add_argument(
        '--progress-log-seconds',
        type=int,
        default=DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS,
        help='Emit replay heartbeat logs at most once per this many seconds.',
    )
    parser.add_argument(
        '--max-executable-spread-bps',
        default=str(DEFAULT_MAX_EXECUTABLE_SPREAD_BPS),
        help='Reject quotes wider than this when evaluating, filling, or flattening.',
    )
    parser.add_argument(
        '--max-quote-mid-jump-bps',
        default=str(DEFAULT_MAX_QUOTE_MID_JUMP_BPS),
        help='Reject wide-spread quotes whose midpoint jumps beyond this many bps from the last sane price.',
    )
    parser.add_argument(
        '--max-jump-with-wide-spread-bps',
        default=str(DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS),
        help='Minimum spread width required before the jump filter blocks a quote.',
    )
    parser.add_argument(
        '--log-level',
        default=os.environ.get('TORGHUT_REPLAY_LOG_LEVEL', 'INFO'),
        help='Python logging level for replay progress logs.',
    )
    parser.add_argument('--no-flatten-eod', action='store_true')
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _load_strategies(path: Path) -> list[Strategy]:
    root_payload = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(root_payload, dict):
        raise RuntimeError('strategy_configmap_not_mapping')
    data = root_payload.get('data')
    if not isinstance(data, dict):
        raise RuntimeError('strategy_configmap_missing_data')
    strategies_yaml = data.get('strategies.yaml')
    if not isinstance(strategies_yaml, str):
        raise RuntimeError('strategy_configmap_missing_strategies_yaml')
    catalog = StrategyCatalogConfig.model_validate(yaml.safe_load(strategies_yaml))
    strategies: list[Strategy] = []
    for item in catalog.strategies:
        if item.name is None:
            continue
        strategies.append(
            Strategy(
                id=uuid.uuid4(),
                name=item.name,
                description=_compose_strategy_description(item),
                enabled=item.enabled,
                base_timeframe=item.base_timeframe,
                universe_type=item.universe_type,
                universe_symbols=item.universe_symbols or None,
                max_position_pct_equity=item.max_position_pct_equity,
                max_notional_per_trade=item.max_notional_per_trade,
            )
        )
    return strategies


def _http_query(
    *,
    url: str,
    username: str | None,
    password: str | None,
    query: str,
) -> str:
    body = query.encode('utf-8')
    last_error: Exception | None = None
    for attempt in range(3):
        req = request.Request(url=url.rstrip('/') + '/', data=body, method='POST')
        if username:
            credentials = f'{username}:{password or ""}'.encode('utf-8')
            req.add_header('Authorization', 'Basic ' + _b64(credentials))
        try:
            with request.urlopen(req, timeout=120) as resp:
                return resp.read().decode('utf-8')
        except error.HTTPError as exc:
            payload = exc.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'clickhouse_http_error: {exc.code}: {payload}') from exc
        except http.client.IncompleteRead as exc:
            if exc.partial:
                return exc.partial.decode('utf-8', errors='replace')
            last_error = exc
        except Exception as exc:  # pragma: no cover - retry path for flaky transport
            last_error = exc
        time_mod.sleep(0.5 * (attempt + 1))
    if last_error is None:
        raise RuntimeError('clickhouse_http_query_failed')
    raise RuntimeError(f'clickhouse_http_query_failed: {last_error}') from last_error


def _b64(raw: bytes) -> str:
    import base64

    return base64.b64encode(raw).decode('ascii')


def _iter_signal_rows(config: ReplayConfig) -> Iterable[SignalEnvelope]:
    chunk_delta = timedelta(minutes=config.chunk_minutes)
    current_day = config.start_date
    while current_day <= config.end_date:
        if current_day.weekday() >= 5:
            logger.info('replay_day_skip day=%s reason=weekend', current_day.isoformat())
            current_day += timedelta(days=1)
            continue
        session_start = datetime.combine(current_day, REGULAR_OPEN_UTC, tzinfo=timezone.utc)
        session_end = datetime.combine(current_day, REGULAR_CLOSE_UTC, tzinfo=timezone.utc)
        logger.info(
            'replay_day_fetch_start day=%s session_start=%s session_end=%s',
            current_day.isoformat(),
            session_start.isoformat(),
            session_end.isoformat(),
        )
        chunk_start = session_start
        while chunk_start < session_end:
            chunk_end = min(chunk_start + chunk_delta, session_end)
            fetch_started_at = time_mod.monotonic()
            logger.debug(
                'replay_chunk_fetch_start day=%s chunk_start=%s chunk_end=%s symbol_count=%s',
                current_day.isoformat(),
                chunk_start.isoformat(),
                chunk_end.isoformat(),
                len(config.symbols),
            )
            rows = _fetch_chunk(
                http_url=config.clickhouse_http_url,
                username=config.clickhouse_username,
                password=config.clickhouse_password,
                chunk_start=chunk_start,
                chunk_end=chunk_end,
                symbols=config.symbols,
            )
            logger.debug(
                'replay_chunk_fetch_done day=%s chunk_start=%s chunk_end=%s rows=%s elapsed_s=%.3f',
                current_day.isoformat(),
                chunk_start.isoformat(),
                chunk_end.isoformat(),
                len(rows),
                time_mod.monotonic() - fetch_started_at,
            )
            rows.sort(key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
            for row in rows:
                yield row
            chunk_start = chunk_end
        current_day += timedelta(days=1)


def _fetch_chunk(
    *,
    http_url: str,
    username: str | None,
    password: str | None,
    chunk_start: datetime,
    chunk_end: datetime,
    symbols: tuple[str, ...] = (),
) -> list[SignalEnvelope]:
    symbol_filter = ''
    if symbols:
        rendered_symbols = ', '.join(f"'{symbol}'" for symbol in symbols)
        symbol_filter = f'\n  AND symbol IN ({rendered_symbols})'
    query = f"""
SELECT
  symbol,
  event_ts,
  seq,
  toString(macd) AS macd,
  toString(macd_signal) AS macd_signal,
  toString(ema12) AS ema12,
  toString(ema26) AS ema26,
  toString(rsi14) AS rsi14,
  toString((imbalance_bid_px + imbalance_ask_px) / 2) AS price,
  toString(imbalance_bid_px) AS bid_px,
  toString(imbalance_ask_px) AS ask_px,
  toString(imbalance_ask_px - imbalance_bid_px) AS spread,
  toString(imbalance_bid_sz) AS bid_sz,
  toString(imbalance_ask_sz) AS ask_sz,
  toString(imbalance_spread) AS imbalance_spread,
  toString(vwap_session) AS vwap_session,
  toString(vwap_w5m) AS vwap_w5m,
  toString(vol_realized_w60s) AS vol_realized_w60s
FROM torghut.ta_signals
WHERE source = 'ta'
  AND window_size = 'PT1S'
  AND event_ts >= toDateTime64('{chunk_start.strftime('%Y-%m-%d %H:%M:%S')}', 3, 'UTC')
  AND event_ts < toDateTime64('{chunk_end.strftime('%Y-%m-%d %H:%M:%S')}', 3, 'UTC')
  {symbol_filter}
  AND isNotNull(imbalance_bid_px)
  AND isNotNull(imbalance_ask_px)
FORMAT TSVRaw
""".strip()
    raw = _http_query(
        url=http_url,
        username=username,
        password=password,
        query=query,
    )
    reader = csv.reader(raw.splitlines(), delimiter='\t')
    rows: list[SignalEnvelope] = []
    for parts in reader:
        parsed = _parse_signal_row(parts)
        if parsed is not None:
            rows.append(parsed)
    return rows


def _parse_signal_row(parts: list[str]) -> SignalEnvelope | None:
    if len(parts) != 18:
        return None
    (
        symbol,
        event_ts,
        seq,
        macd,
        macd_signal,
        ema12,
        ema26,
        rsi14,
        price,
        bid_px,
        ask_px,
        spread,
        bid_sz,
        ask_sz,
        imbalance_spread,
        vwap_session,
        vwap_w5m,
        vol,
    ) = parts
    bid_px_value = _to_decimal(bid_px)
    ask_px_value = _to_decimal(ask_px)
    spread_value = _to_decimal(spread)
    bid_sz_value = _to_decimal(bid_sz)
    ask_sz_value = _to_decimal(ask_sz)
    imbalance_spread_value = _to_decimal(imbalance_spread)
    payload = {
        'macd': _to_decimal(macd),
        'macd_signal': _to_decimal(macd_signal),
        'ema12': _to_decimal(ema12),
        'ema26': _to_decimal(ema26),
        'rsi14': _to_decimal(rsi14),
        'rsi': _to_decimal(rsi14),
        'price': _to_decimal(price),
        'vwap_session': _to_decimal(vwap_session),
        'vwap_w5m': _to_decimal(vwap_w5m),
        'vol_realized_w60s': _to_decimal(vol),
        'imbalance_bid_px': bid_px_value,
        'imbalance_ask_px': ask_px_value,
        'imbalance_bid_sz': bid_sz_value,
        'imbalance_ask_sz': ask_sz_value,
        'imbalance_spread': imbalance_spread_value,
        'imbalance': {
            'bid_px': bid_px_value,
            'ask_px': ask_px_value,
            'bid_sz': bid_sz_value,
            'ask_sz': ask_sz_value,
            'spread': imbalance_spread_value if imbalance_spread_value is not None else spread_value,
        },
        'spread': spread_value,
        'window_size': 'PT1S',
        'window_step': 'PT1S',
    }
    return SignalEnvelope(
        event_ts=_parse_clickhouse_ts(event_ts),
        symbol=symbol,
        timeframe='1Sec',
        seq=int(seq),
        source='ta',
        payload=payload,
    )


def _parse_clickhouse_ts(value: str) -> datetime:
    normalized = value.replace(' ', 'T')
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _to_decimal(value: str) -> Decimal | None:
    stripped = value.strip()
    if not stripped or stripped == '\\N':
        return None
    return Decimal(stripped)


def _positions_payload(
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
    pending_orders: dict[tuple[str, str], PendingOrder] | None = None,
) -> list[dict[str, Any]]:
    projected_positions: dict[tuple[str, str], PositionState] = {
        key: PositionState(
            strategy_id=position.strategy_id,
            qty=position.qty,
            avg_entry_price=position.avg_entry_price,
            opened_at=position.opened_at,
            entry_cost_total=position.entry_cost_total,
            decision_at=position.decision_at,
            pending_entry=position.pending_entry,
        )
        for key, position in positions.items()
    }
    projected_prices = dict(last_prices)

    for pending in (pending_orders or {}).values():
        decision = pending.decision
        symbol = decision.symbol
        owner_strategy_id = _decision_position_owner(decision)
        position_key = _position_key(symbol, owner_strategy_id)
        reference_price = (
            decision.limit_price
            or projected_prices.get(symbol)
            or _extract_price(pending.signal)
        )
        projected_prices[symbol] = reference_price
        existing = projected_positions.get(position_key)
        if decision.action == 'buy':
            if existing is None:
                projected_positions[position_key] = PositionState(
                    strategy_id=owner_strategy_id,
                    qty=decision.qty,
                    avg_entry_price=reference_price,
                    opened_at=pending.signal.event_ts,
                    entry_cost_total=Decimal('0'),
                    decision_at=pending.created_at,
                    pending_entry=True,
                )
                continue
            new_qty = existing.qty + decision.qty
            avg_entry = (
                (existing.avg_entry_price * existing.qty)
                + (reference_price * decision.qty)
            ) / new_qty
            projected_positions[position_key] = PositionState(
                strategy_id=existing.strategy_id,
                qty=new_qty,
                avg_entry_price=avg_entry,
                opened_at=existing.opened_at,
                entry_cost_total=existing.entry_cost_total,
                decision_at=existing.decision_at,
                pending_entry=existing.pending_entry,
            )
            continue
        if existing is None:
            continue
        remaining_qty = existing.qty - min(decision.qty, existing.qty)
        if remaining_qty <= 0:
            projected_positions.pop(position_key, None)
            continue
        projected_positions[position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=remaining_qty,
            avg_entry_price=existing.avg_entry_price,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total,
            decision_at=existing.decision_at,
            pending_entry=existing.pending_entry,
        )

    payload: list[dict[str, Any]] = []
    for (symbol, _owner_strategy_id), position in projected_positions.items():
        market_price = last_prices.get(symbol, position.avg_entry_price)
        payload.append(
            {
                'symbol': symbol,
                'strategy_id': position.strategy_id,
                'qty': str(position.qty),
                'side': 'long',
                'market_value': str(position.qty * market_price),
                'avg_entry_price': str(position.avg_entry_price),
                'opened_at': position.opened_at.isoformat(),
                'decision_at': position.decision_at.isoformat(),
                'pending_entry': position.pending_entry,
            }
        )
    return payload


def _position_equity(
    *,
    cash: Decimal,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> Decimal:
    equity = cash
    for (symbol, _owner_strategy_id), position in positions.items():
        equity += position.qty * last_prices.get(symbol, position.avg_entry_price)
    return equity


def _extract_spread(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get('spread')
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_bid(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get('imbalance_bid_px')
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_ask(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get('imbalance_ask_px')
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_price(signal: SignalEnvelope) -> Decimal:
    raw = signal.payload.get('price')
    if isinstance(raw, Decimal):
        return raw
    return Decimal(str(raw))


def _extract_volatility(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get('vol_realized_w60s')
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    return Decimal(str(raw))


def _signal_spread_bps(*, signal: SignalEnvelope, price: Decimal | None = None) -> Decimal | None:
    resolved_price = _extract_price(signal) if price is None else price
    if resolved_price <= 0:
        return None
    spread = _extract_spread(signal)
    if spread is None:
        return None
    return (abs(spread) / resolved_price) * Decimal('10000')


def _signal_mid_jump_bps(*, price: Decimal, reference_price: Decimal | None) -> Decimal | None:
    if reference_price is None or reference_price <= 0:
        return None
    return (abs(price - reference_price) / reference_price) * Decimal('10000')


def _quote_quality_status(
    *,
    signal: SignalEnvelope,
    previous_price: Decimal | None,
    config: ReplayConfig,
) -> QuoteQualityStatus:
    return assess_signal_quote_quality(
        signal=signal,
        previous_price=previous_price,
        policy=QuoteQualityPolicy(
            max_executable_spread_bps=config.max_executable_spread_bps,
            max_quote_mid_jump_bps=config.max_quote_mid_jump_bps,
            max_jump_with_wide_spread_bps=config.max_jump_with_wide_spread_bps,
        ),
    )


def _log_quote_skipped(
    *,
    signal: SignalEnvelope,
    status: QuoteQualityStatus,
    has_open_position: bool,
    has_pending_order: bool,
) -> None:
    logger.info(
        'replay_quote_skipped ts=%s symbol=%s reason=%s spread_bps=%s jump_bps=%s open_position=%s pending_order=%s',
        signal.event_ts.isoformat(),
        signal.symbol,
        status.reason or 'unknown',
        _decimal_text(status.spread_bps) if status.spread_bps is not None else 'None',
        _decimal_text(status.jump_bps) if status.jump_bps is not None else 'None',
        has_open_position,
        has_pending_order,
    )


def _estimate_trade_cost(
    *,
    model: TransactionCostModel,
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> Decimal:
    price = _extract_price(signal)
    spread = _extract_spread(signal)
    volatility = _extract_volatility(signal)
    estimate = model.estimate_costs(
        order=OrderIntent(
            symbol=decision.symbol,
            side=decision.action,
            qty=decision.qty,
            price=price,
            order_type=decision.order_type,
            time_in_force=decision.time_in_force,
        ),
        market=CostModelInputs(
            price=price,
            spread=spread,
            volatility=volatility,
        ),
    )
    return estimate.total_cost


def _record_decision(stats: dict[str, Any], decision: StrategyDecision) -> None:
    stats['decision_count'] += 1
    symbol_counts = stats.setdefault('decision_symbols', defaultdict(int))
    symbol_counts[decision.symbol] += 1


def _apply_order_preferences(
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> StrategyDecision:
    position_exit = decision.params.get('position_exit')
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get('type') or '').strip()
        if exit_type == 'session_flatten_minute_utc':
            return decision
    if not settings.trading_execution_prefer_limit:
        return decision
    if decision.order_type != 'market':
        return decision
    price = _extract_price(signal)
    spread = _extract_spread(signal)
    return decision.model_copy(
        update={
            'order_type': 'limit',
            'limit_price': _near_touch_limit_price(price, spread, decision.action),
        }
    )


def _init_day_stats() -> dict[str, Any]:
    return {
        'decision_count': 0,
        'filled_count': 0,
        'gross_pnl': Decimal('0'),
        'net_pnl': Decimal('0'),
        'cost_total': Decimal('0'),
        'wins': 0,
        'losses': 0,
        'closed_trades': [],
    }


def _decimal_text(value: Decimal) -> str:
    return format(value, 'f')


def _log_decision_queued(decision: StrategyDecision, created_at: datetime) -> None:
    logger.info(
        'replay_decision_queued ts=%s strategy_id=%s symbol=%s action=%s qty=%s order_type=%s limit_price=%s rationale=%s',
        created_at.isoformat(),
        decision.strategy_id,
        decision.symbol,
        decision.action,
        _decimal_text(decision.qty),
        decision.order_type,
        _decimal_text(decision.limit_price) if decision.limit_price is not None else 'None',
        decision.rationale or '',
    )


def _log_trade_closed(trade: ClosedTrade) -> None:
    logger.info(
        'replay_trade_closed symbol=%s strategy_id=%s opened_at=%s closed_at=%s qty=%s entry=%s exit=%s gross_pnl=%s net_pnl=%s exit_reason=%s',
        trade.symbol,
        trade.strategy_id,
        trade.opened_at.isoformat(),
        trade.closed_at.isoformat(),
        _decimal_text(trade.qty),
        _decimal_text(trade.entry_price),
        _decimal_text(trade.exit_price),
        _decimal_text(trade.gross_pnl),
        _decimal_text(trade.net_pnl),
        trade.exit_reason,
    )


def _resolve_pending_fill_price(
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> Decimal | None:
    price = _extract_price(signal)
    bid = _extract_bid(signal)
    ask = _extract_ask(signal)
    normalized_action = decision.action.strip().lower()

    if decision.order_type == 'limit' and decision.limit_price is not None:
        if normalized_action == 'buy':
            executable_price = ask if ask is not None else price
            if executable_price > decision.limit_price:
                return None
            return executable_price
        executable_price = bid if bid is not None else price
        if executable_price < decision.limit_price:
            return None
        return executable_price

    if normalized_action == 'buy':
        return ask if ask is not None else price
    return bid if bid is not None else price


def _decision_exit_reason(decision: StrategyDecision) -> str:
    position_exit = decision.params.get('position_exit')
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get('type') or '').strip()
        if exit_type:
            return exit_type
    rationale = str(decision.rationale or '').strip()
    if rationale:
        return rationale.split(',')[0]
    return 'signal_exit'


def _decision_position_owner(decision: StrategyDecision) -> str:
    runtime_payload = decision.params.get('strategy_runtime')
    if isinstance(runtime_payload, dict):
        isolation_mode = str(runtime_payload.get('position_isolation_mode') or '').strip().lower()
        if isolation_mode == 'per_strategy':
            return decision.strategy_id
    return _SHARED_POSITION_OWNER


def _pending_order_priority(decision: StrategyDecision) -> int:
    if decision.action.strip().lower() != 'sell':
        return 0
    position_exit = decision.params.get('position_exit')
    exit_type = ''
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get('type') or '').strip()
    if exit_type == 'session_flatten_minute_utc':
        return 5
    if exit_type in {'long_stop_loss_bps', 'long_trailing_stop_bps'}:
        return 4
    if decision.order_type == 'market':
        return 3
    if exit_type:
        return 2
    return 1


def _should_replace_pending_order(
    *,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> bool:
    existing_priority = _pending_order_priority(existing)
    replacement_priority = _pending_order_priority(replacement)
    if replacement_priority != existing_priority:
        return replacement_priority > existing_priority

    existing_action = existing.action.strip().lower()
    replacement_action = replacement.action.strip().lower()
    if existing_action != replacement_action:
        return False

    if existing.order_type != replacement.order_type:
        return existing.order_type == 'limit' and replacement.order_type == 'market'

    if existing.order_type != 'limit':
        return False

    existing_limit = existing.limit_price
    replacement_limit = replacement.limit_price
    if existing_limit is None or replacement_limit is None:
        return False

    if replacement_action == 'sell':
        return replacement_limit < existing_limit
    if replacement_action == 'buy':
        return replacement_limit > existing_limit
    return False


def _log_pending_order_replaced(
    *,
    created_at: datetime,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> None:
    logger.info(
        'replay_pending_order_replaced ts=%s symbol=%s existing_order_type=%s existing_limit=%s existing_exit=%s replacement_order_type=%s replacement_limit=%s replacement_exit=%s',
        created_at.isoformat(),
        replacement.symbol,
        existing.order_type,
        _decimal_text(existing.limit_price) if existing.limit_price is not None else 'None',
        _decision_exit_reason(existing),
        replacement.order_type,
        _decimal_text(replacement.limit_price) if replacement.limit_price is not None else 'None',
        _decision_exit_reason(replacement),
    )


def _log_day_summary(
    *,
    day: date,
    stats: dict[str, Any],
    cash: Decimal,
    equity: Decimal,
    open_positions: int,
) -> None:
    logger.info(
        'replay_day_complete day=%s decisions=%s fills=%s wins=%s losses=%s gross_pnl=%s net_pnl=%s cost_total=%s cash=%s equity=%s open_positions=%s',
        day.isoformat(),
        stats['decision_count'],
        stats['filled_count'],
        stats['wins'],
        stats['losses'],
        _decimal_text(stats['gross_pnl']),
        _decimal_text(stats['net_pnl']),
        _decimal_text(stats['cost_total']),
        _decimal_text(cash),
        _decimal_text(equity),
        open_positions,
    )


def _log_progress(
    *,
    signal_day: date,
    signal_ts: datetime,
    signals_seen: int,
    day_bucket: dict[str, Any],
    positions: dict[str, PositionState],
    pending_orders: dict[str, PendingOrder],
    cash: Decimal,
    equity: Decimal,
) -> None:
    logger.info(
        'replay_progress day=%s ts=%s signals=%s decisions=%s fills=%s wins=%s losses=%s pending_orders=%s open_positions=%s cash=%s equity=%s',
        signal_day.isoformat(),
        signal_ts.isoformat(),
        signals_seen,
        day_bucket['decision_count'],
        day_bucket['filled_count'],
        day_bucket['wins'],
        day_bucket['losses'],
        len(pending_orders),
        len(positions),
        _decimal_text(cash),
        _decimal_text(equity),
    )


def _close_position(
    *,
    symbol: str,
    position: PositionState,
    sell_qty: Decimal,
    fill_price: Decimal,
    closed_at: datetime,
    exit_reason: str,
    entry_cost_allocated: Decimal,
    exit_cost_total: Decimal,
) -> tuple[PositionState | None, ClosedTrade]:
    remaining_qty = position.qty - sell_qty
    gross_pnl = (fill_price - position.avg_entry_price) * sell_qty
    net_pnl = gross_pnl - entry_cost_allocated - exit_cost_total
    remaining_position: PositionState | None = None
    if remaining_qty > 0:
        remaining_position = PositionState(
            strategy_id=position.strategy_id,
            qty=remaining_qty,
            avg_entry_price=position.avg_entry_price,
            opened_at=position.opened_at,
            entry_cost_total=position.entry_cost_total - entry_cost_allocated,
            decision_at=position.decision_at,
            pending_entry=False,
        )
    return remaining_position, ClosedTrade(
        symbol=symbol,
        strategy_id=position.strategy_id,
        decision_at=position.decision_at,
        opened_at=position.opened_at,
        closed_at=closed_at,
        qty=sell_qty,
        entry_price=position.avg_entry_price,
        exit_price=fill_price,
        gross_pnl=gross_pnl,
        net_pnl=net_pnl,
        exit_reason=exit_reason,
    )


def _apply_filled_decision(
    *,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    fill_price: Decimal,
    filled_at: datetime,
    created_at: datetime,
    positions: dict[tuple[str, str], PositionState],
    day_bucket: dict[str, Any],
    cost_model: TransactionCostModel,
    cash: Decimal,
    all_closed_trades: list[ClosedTrade],
) -> Decimal:
    owner_strategy_id = _decision_position_owner(decision)
    position_key = _position_key(decision.symbol, owner_strategy_id)
    if decision.action == 'buy':
        fill_cost = _estimate_trade_cost(model=cost_model, decision=decision, signal=signal)
        day_bucket['cost_total'] += fill_cost
        day_bucket['filled_count'] += 1
        cash -= (fill_price * decision.qty) + fill_cost
        existing = positions.get(position_key)
        if existing is None:
            positions[position_key] = PositionState(
                strategy_id=owner_strategy_id,
                qty=decision.qty,
                avg_entry_price=fill_price,
                opened_at=filled_at,
                entry_cost_total=fill_cost,
                decision_at=created_at,
                pending_entry=False,
            )
            return cash
        new_qty = existing.qty + decision.qty
        avg_entry = (
            (existing.avg_entry_price * existing.qty) + (fill_price * decision.qty)
        ) / new_qty
        positions[position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=new_qty,
            avg_entry_price=avg_entry,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total + fill_cost,
            decision_at=existing.decision_at,
            pending_entry=False,
        )
        return cash

    existing = positions.get(position_key)
    if existing is None or existing.qty <= 0:
        return cash
    fill_cost = _estimate_trade_cost(model=cost_model, decision=decision, signal=signal)
    day_bucket['cost_total'] += fill_cost
    day_bucket['filled_count'] += 1
    sell_qty = min(decision.qty, existing.qty)
    cash += (fill_price * sell_qty) - fill_cost
    entry_cost_allocated = existing.entry_cost_total * (sell_qty / existing.qty)
    remaining, trade = _close_position(
        symbol=decision.symbol,
        position=existing,
        sell_qty=sell_qty,
        fill_price=fill_price,
        closed_at=filled_at,
        exit_reason=_decision_exit_reason(decision),
        entry_cost_allocated=entry_cost_allocated,
        exit_cost_total=fill_cost,
    )
    if remaining is None:
        positions.pop(position_key, None)
    else:
        positions[position_key] = remaining
    day_bucket['gross_pnl'] += trade.gross_pnl
    day_bucket['net_pnl'] += trade.net_pnl
    if trade.net_pnl > 0:
        day_bucket['wins'] += 1
    elif trade.net_pnl < 0:
        day_bucket['losses'] += 1
    day_bucket['closed_trades'].append(trade)
    all_closed_trades.append(trade)
    _log_trade_closed(trade)
    return cash


def run_replay(config: ReplayConfig) -> dict[str, Any]:
    strategies = _load_strategies(config.strategy_configmap_path)
    strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
    engine = DecisionEngine(price_fetcher=None)
    quote_quality = SignalQuoteQualityTracker(
        policy=QuoteQualityPolicy(
            max_executable_spread_bps=config.max_executable_spread_bps,
            max_quote_mid_jump_bps=config.max_quote_mid_jump_bps,
            max_jump_with_wide_spread_bps=config.max_jump_with_wide_spread_bps,
        )
    )
    cost_model = TransactionCostModel()
    positions: dict[tuple[str, str], PositionState] = {}
    pending_orders: dict[tuple[str, str], PendingOrder] = {}
    last_prices: dict[str, Decimal] = {}
    last_signals: dict[str, SignalEnvelope] = {}
    cash = config.start_equity
    day_stats: dict[str, dict[str, Any]] = {}
    all_closed_trades: list[ClosedTrade] = []
    current_day: date | None = None
    signals_seen = 0
    replay_started_at = time_mod.monotonic()
    last_progress_at = replay_started_at

    logger.info(
        'replay_start start_date=%s end_date=%s chunk_minutes=%s flatten_eod=%s start_equity=%s symbol_count=%s symbols=%s',
        config.start_date.isoformat(),
        config.end_date.isoformat(),
        config.chunk_minutes,
        config.flatten_eod,
        _decimal_text(config.start_equity),
        len(config.symbols),
        ','.join(config.symbols) if config.symbols else '*',
    )

    def _active_day_stats(target_day: date) -> dict[str, Any]:
        return day_stats.setdefault(target_day.isoformat(), _init_day_stats())

    with (
        patch.object(settings, 'trading_strategy_runtime_mode', 'scheduler_v3'),
        patch.object(settings, 'trading_strategy_scheduler_enabled', True),
        patch.object(settings, 'trading_allow_shorts', True),
        patch.object(settings, 'trading_fractional_equities_enabled', True),
    ):
        for signal in _iter_signal_rows(config):
            signal_day = signal.event_ts.date()
            if current_day is None:
                current_day = signal_day
                logger.info('replay_day_start day=%s', current_day.isoformat())
            if current_day != signal_day:
                if config.flatten_eod:
                    cash_ref = [cash]
                    _flatten_positions(
                        day=current_day,
                        stats=_active_day_stats(current_day),
                        positions=positions,
                        last_signals=last_signals,
                        last_prices=last_prices,
                        cost_model=cost_model,
                        cash_ref=cash_ref,
                        all_closed_trades=all_closed_trades,
                    )
                    cash = cash_ref[0]
                pending_orders.clear()
                completed_day_stats = _active_day_stats(current_day)
                completed_day_equity = _position_equity(
                    cash=cash,
                    positions=positions,
                    last_prices=last_prices,
                )
                _log_day_summary(
                    day=current_day,
                    stats=completed_day_stats,
                    cash=cash,
                    equity=completed_day_equity,
                    open_positions=len(positions),
                )
                current_day = signal_day
                logger.info('replay_day_start day=%s', current_day.isoformat())

            signals_seen += 1
            day_bucket = _active_day_stats(signal_day)
            quote_status = quote_quality.assess(signal)
            if not quote_status.valid:
                engine.observe_signal(signal)
                has_open_position = any(symbol == signal.symbol for symbol, _ in positions)
                has_pending_order = any(symbol == signal.symbol for symbol, _ in pending_orders)
                if has_open_position or has_pending_order:
                    _log_quote_skipped(
                        signal=signal,
                        status=quote_status,
                        has_open_position=has_open_position,
                        has_pending_order=has_pending_order,
                    )
                continue

            price = _extract_price(signal)
            last_prices[signal.symbol] = price
            last_signals[signal.symbol] = signal

            matching_pending_keys = [
                pending_key
                for pending_key in sorted(pending_orders)
                if pending_key[0] == signal.symbol
            ]
            for pending_key in matching_pending_keys:
                pending = pending_orders.pop(pending_key, None)
                if pending is None:
                    continue
                decision = pending.decision
                fill_price = _resolve_pending_fill_price(decision, signal)
                if fill_price is None:
                    pending_orders[pending_key] = pending
                    continue
                cash = _apply_filled_decision(
                    decision=decision,
                    signal=signal,
                    fill_price=fill_price,
                    filled_at=signal.event_ts,
                    created_at=pending.created_at,
                    positions=positions,
                    day_bucket=day_bucket,
                    cost_model=cost_model,
                    cash=cash,
                    all_closed_trades=all_closed_trades,
                )

            equity = _position_equity(cash=cash, positions=positions, last_prices=last_prices)
            live_positions = _positions_payload(
                positions,
                last_prices,
                pending_orders,
            )
            raw_decisions = engine.evaluate(
                signal,
                strategies,
                equity=equity,
                positions=live_positions,
            )
            regime_label = _signal_regime_label(signal)
            allocator = allocator_from_settings(equity)
            account = {'equity': str(equity)}
            executable_decisions: list[StrategyDecision] = []
            for allocation_result in allocator.allocate(
                raw_decisions,
                account=account,
                positions=live_positions,
                regime_label=regime_label,
            ):
                if not allocation_result.approved:
                    continue
                decision = allocation_result.decision
                strategy = strategies_by_id.get(decision.strategy_id)
                if strategy is None:
                    executable_decisions.append(decision)
                    continue
                sizing_result = sizer_from_settings(strategy, equity).size(
                    decision,
                    account=account,
                    positions=live_positions,
                )
                if not sizing_result.approved:
                    continue
                executable_decisions.append(sizing_result.decision)

            for decision in executable_decisions:
                decision = _apply_order_preferences(decision, signal)
                _record_decision(day_bucket, decision)
                if decision.qty <= 0:
                    continue
                immediate_fill_price = _resolve_pending_fill_price(decision, signal)
                if immediate_fill_price is not None:
                    cash = _apply_filled_decision(
                        decision=decision,
                        signal=signal,
                        fill_price=immediate_fill_price,
                        filled_at=signal.event_ts,
                        created_at=signal.event_ts,
                        positions=positions,
                        day_bucket=day_bucket,
                        cost_model=cost_model,
                        cash=cash,
                        all_closed_trades=all_closed_trades,
                    )
                    continue
                pending_key = _position_key(
                    decision.symbol,
                    _decision_position_owner(decision),
                )
                existing_pending = pending_orders.get(pending_key)
                if existing_pending is not None:
                    if _should_replace_pending_order(
                        existing=existing_pending.decision,
                        replacement=decision,
                    ):
                        pending_orders[pending_key] = PendingOrder(
                            decision=decision,
                            created_at=signal.event_ts,
                            signal=signal,
                        )
                        _log_pending_order_replaced(
                            created_at=signal.event_ts,
                            existing=existing_pending.decision,
                            replacement=decision,
                        )
                        _log_decision_queued(decision, signal.event_ts)
                    continue
                pending_orders[pending_key] = PendingOrder(
                    decision=decision,
                    created_at=signal.event_ts,
                    signal=signal,
                )
                _log_decision_queued(decision, signal.event_ts)

            now = time_mod.monotonic()
            if now - last_progress_at >= config.progress_log_interval_seconds:
                _log_progress(
                    signal_day=signal_day,
                    signal_ts=signal.event_ts,
                    signals_seen=signals_seen,
                    day_bucket=day_bucket,
                    positions=positions,
                    pending_orders=pending_orders,
                    cash=cash,
                    equity=equity,
                )
                last_progress_at = now

        if current_day is not None and config.flatten_eod:
            cash_ref = [cash]
            _flatten_positions(
                day=current_day,
                stats=_active_day_stats(current_day),
                positions=positions,
                last_signals=last_signals,
                last_prices=last_prices,
                cost_model=cost_model,
                cash_ref=cash_ref,
                all_closed_trades=all_closed_trades,
            )
            cash = cash_ref[0]
        if current_day is not None:
            final_day_stats = _active_day_stats(current_day)
            final_day_equity = _position_equity(cash=cash, positions=positions, last_prices=last_prices)
            _log_day_summary(
                day=current_day,
                stats=final_day_stats,
                cash=cash,
                equity=final_day_equity,
                open_positions=len(positions),
            )

    final_equity = _position_equity(cash=cash, positions=positions, last_prices=last_prices)
    total_decisions = sum(item['decision_count'] for item in day_stats.values())
    total_filled = sum(item['filled_count'] for item in day_stats.values())
    total_gross = sum((item['gross_pnl'] for item in day_stats.values()), Decimal('0'))
    total_net = final_equity - config.start_equity
    total_cost = sum((item['cost_total'] for item in day_stats.values()), Decimal('0'))
    wins = sum(item['wins'] for item in day_stats.values())
    losses = sum(item['losses'] for item in day_stats.values())
    closed_trade_payload = sorted(
        all_closed_trades,
        key=lambda item: item.net_pnl,
    )
    logger.info(
        'replay_complete elapsed_s=%.3f signals=%s decisions=%s fills=%s wins=%s losses=%s gross_pnl=%s net_pnl=%s total_cost=%s final_equity=%s',
        time_mod.monotonic() - replay_started_at,
        signals_seen,
        total_decisions,
        total_filled,
        wins,
        losses,
        _decimal_text(total_gross),
        _decimal_text(total_net),
        _decimal_text(total_cost),
        _decimal_text(final_equity),
    )
    return {
        'start_equity': str(config.start_equity),
        'final_equity': str(final_equity),
        'net_pnl': str(total_net),
        'gross_pnl': str(total_gross),
        'total_cost': str(total_cost),
        'decision_count': total_decisions,
        'filled_count': total_filled,
        'wins': wins,
        'losses': losses,
        'open_positions': {
            f'{symbol}|{owner_strategy_id}': {
                'strategy_id': position.strategy_id,
                'qty': str(position.qty),
                'avg_entry_price': str(position.avg_entry_price),
                'last_price': str(last_prices.get(symbol, position.avg_entry_price)),
            }
            for (symbol, owner_strategy_id), position in positions.items()
        },
        'daily': {
            key: {
                'decision_count': value['decision_count'],
                'filled_count': value['filled_count'],
                'gross_pnl': str(value['gross_pnl']),
                'net_pnl': str(value['net_pnl']),
                'cost_total': str(value['cost_total']),
                'wins': value['wins'],
                'losses': value['losses'],
            }
            for key, value in sorted(day_stats.items())
        },
        'largest_losses': [
            {
                'symbol': item.symbol,
                'strategy_id': item.strategy_id,
                'decision_at': item.decision_at.isoformat(),
                'opened_at': item.opened_at.isoformat(),
                'closed_at': item.closed_at.isoformat(),
                'qty': str(item.qty),
                'entry_price': str(item.entry_price),
                'exit_price': str(item.exit_price),
                'net_pnl': str(item.net_pnl),
                'exit_reason': item.exit_reason,
            }
            for item in closed_trade_payload[:10]
        ],
        'largest_wins': [
            {
                'symbol': item.symbol,
                'strategy_id': item.strategy_id,
                'decision_at': item.decision_at.isoformat(),
                'opened_at': item.opened_at.isoformat(),
                'closed_at': item.closed_at.isoformat(),
                'qty': str(item.qty),
                'entry_price': str(item.entry_price),
                'exit_price': str(item.exit_price),
                'net_pnl': str(item.net_pnl),
                'exit_reason': item.exit_reason,
            }
            for item in list(reversed(closed_trade_payload[-10:]))
        ],
    }


def _signal_regime_label(signal: SignalEnvelope) -> str | None:
    payload = signal.payload or {}
    for key in ('route_regime_label', 'regime_label'):
        raw = payload.get(key)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            return value
    return None


def _flatten_positions(
    *,
    day: date,
    stats: dict[str, Any],
    positions: dict[tuple[str, str], PositionState],
    last_signals: dict[str, SignalEnvelope],
    last_prices: dict[str, Decimal],
    cost_model: TransactionCostModel,
    cash_ref: list[Decimal],
    all_closed_trades: list[ClosedTrade],
) -> None:
    if not positions:
        return
    current_cash = cash_ref[0]
    for position_key in sorted(list(positions)):
        symbol, owner_strategy_id = position_key
        position = positions.pop(position_key)
        last_signal = last_signals.get(symbol)
        if last_signal is None:
            continue
        fill_price = last_prices.get(symbol, position.avg_entry_price)
        synthetic_decision = StrategyDecision(
            strategy_id=owner_strategy_id if owner_strategy_id != _SHARED_POSITION_OWNER else 'flatten',
            symbol=symbol,
            event_ts=last_signal.event_ts,
            timeframe='1Sec',
            action='sell',
            qty=position.qty,
            order_type='market',
            time_in_force='day',
            params={},
        )
        exit_cost = _estimate_trade_cost(
            model=cost_model,
            decision=synthetic_decision,
            signal=last_signal,
        )
        sell_value = fill_price * position.qty
        current_cash += sell_value - exit_cost
        trade = ClosedTrade(
            symbol=symbol,
            strategy_id=position.strategy_id,
            decision_at=position.decision_at,
            opened_at=position.opened_at,
            closed_at=datetime.combine(day, REGULAR_CLOSE_UTC, tzinfo=timezone.utc),
            qty=position.qty,
            entry_price=position.avg_entry_price,
            exit_price=fill_price,
            gross_pnl=(fill_price - position.avg_entry_price) * position.qty,
            net_pnl=(
                (fill_price - position.avg_entry_price) * position.qty
                - position.entry_cost_total
                - exit_cost
            ),
            exit_reason='eod_flatten',
        )
        stats['gross_pnl'] += trade.gross_pnl
        stats['net_pnl'] += trade.net_pnl
        stats['cost_total'] += exit_cost
        stats['filled_count'] += 1
        if trade.net_pnl > 0:
            stats['wins'] += 1
        elif trade.net_pnl < 0:
            stats['losses'] += 1
        stats['closed_trades'].append(trade)
        all_closed_trades.append(trade)
        _log_trade_closed(trade)
    cash_ref[0] = current_cash


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format='%(asctime)s %(levelname)s %(message)s',
    )
    logging.getLogger('alembic').setLevel(logging.WARNING)
    config = ReplayConfig(
        strategy_configmap_path=Path(args.strategy_configmap).resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_date=date.fromisoformat(args.start_date),
        end_date=date.fromisoformat(args.end_date),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        flatten_eod=not args.no_flatten_eod,
        start_equity=Decimal(str(args.start_equity)),
        symbols=tuple(
            symbol.strip().upper()
            for symbol in str(args.symbols or '').split(',')
            if symbol.strip()
        ),
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
        max_executable_spread_bps=Decimal(str(args.max_executable_spread_bps)),
        max_quote_mid_jump_bps=Decimal(str(args.max_quote_mid_jump_bps)),
        max_jump_with_wide_spread_bps=Decimal(str(args.max_jump_with_wide_spread_bps)),
    )
    payload = run_replay(config)
    if args.json:
        print(json.dumps(payload, sort_keys=True, separators=(',', ':')))
        return
    print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()

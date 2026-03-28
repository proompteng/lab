#!/usr/bin/env python3
"""Run a local deterministic intraday TSMOM replay against ClickHouse signals."""

from __future__ import annotations

import argparse
import csv
import http.client
import json
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

REGULAR_OPEN_UTC = time(hour=13, minute=30)
REGULAR_CLOSE_UTC = time(hour=20, minute=0)
DEFAULT_CHUNK_MINUTES = 10
DEFAULT_START_EQUITY = Decimal('31590.02')


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


@dataclass
class PositionState:
    qty: Decimal
    avg_entry_price: Decimal
    opened_at: datetime
    entry_cost_total: Decimal
    decision_at: datetime


@dataclass
class PendingOrder:
    decision: StrategyDecision
    created_at: datetime
    signal: SignalEnvelope


@dataclass
class ClosedTrade:
    symbol: str
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
        session_start = datetime.combine(current_day, REGULAR_OPEN_UTC, tzinfo=timezone.utc)
        session_end = datetime.combine(current_day, REGULAR_CLOSE_UTC, tzinfo=timezone.utc)
        chunk_start = session_start
        while chunk_start < session_end:
            chunk_end = min(chunk_start + chunk_delta, session_end)
            rows = _fetch_chunk(
                http_url=config.clickhouse_http_url,
                username=config.clickhouse_username,
                password=config.clickhouse_password,
                chunk_start=chunk_start,
                chunk_end=chunk_end,
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
) -> list[SignalEnvelope]:
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
  toString(vol_realized_w60s) AS vol_realized_w60s
FROM torghut.ta_signals
WHERE source = 'ta'
  AND window_size = 'PT1S'
  AND event_ts >= toDateTime64('{chunk_start.strftime('%Y-%m-%d %H:%M:%S')}', 3, 'UTC')
  AND event_ts < toDateTime64('{chunk_end.strftime('%Y-%m-%d %H:%M:%S')}', 3, 'UTC')
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
        if len(parts) != 13:
            continue
        symbol, event_ts, seq, macd, macd_signal, ema12, ema26, rsi14, price, bid_px, ask_px, spread, vol = parts
        payload = {
            'macd': _to_decimal(macd),
            'macd_signal': _to_decimal(macd_signal),
            'ema12': _to_decimal(ema12),
            'ema26': _to_decimal(ema26),
            'rsi14': _to_decimal(rsi14),
            'rsi': _to_decimal(rsi14),
            'price': _to_decimal(price),
            'vol_realized_w60s': _to_decimal(vol),
            'imbalance': {
                'bid_px': _to_decimal(bid_px),
                'ask_px': _to_decimal(ask_px),
                'spread': _to_decimal(spread),
            },
            'spread': _to_decimal(spread),
            'window_size': 'PT1S',
            'window_step': 'PT1S',
        }
        rows.append(
            SignalEnvelope(
                event_ts=_parse_clickhouse_ts(event_ts),
                symbol=symbol,
                timeframe='1Sec',
                seq=int(seq),
                source='ta',
                payload=payload,
            )
        )
    return rows


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
    positions: dict[str, PositionState],
    last_prices: dict[str, Decimal],
) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for symbol, position in positions.items():
        market_price = last_prices.get(symbol, position.avg_entry_price)
        payload.append(
            {
                'symbol': symbol,
                'qty': str(position.qty),
                'side': 'long',
                'market_value': str(position.qty * market_price),
                'avg_entry_price': str(position.avg_entry_price),
            }
        )
    return payload


def _position_equity(
    *,
    cash: Decimal,
    positions: dict[str, PositionState],
    last_prices: dict[str, Decimal],
) -> Decimal:
    equity = cash
    for symbol, position in positions.items():
        equity += position.qty * last_prices.get(symbol, position.avg_entry_price)
    return equity


def _extract_spread(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get('spread')
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
            qty=remaining_qty,
            avg_entry_price=position.avg_entry_price,
            opened_at=position.opened_at,
            entry_cost_total=position.entry_cost_total - entry_cost_allocated,
            decision_at=position.decision_at,
        )
    return remaining_position, ClosedTrade(
        symbol=symbol,
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


def run_replay(config: ReplayConfig) -> dict[str, Any]:
    strategies = _load_strategies(config.strategy_configmap_path)
    engine = DecisionEngine(price_fetcher=None)
    cost_model = TransactionCostModel()
    positions: dict[str, PositionState] = {}
    pending_orders: dict[str, PendingOrder] = {}
    last_prices: dict[str, Decimal] = {}
    last_signals: dict[str, SignalEnvelope] = {}
    cash = config.start_equity
    day_stats: dict[str, dict[str, Any]] = {}
    all_closed_trades: list[ClosedTrade] = []
    current_day: date | None = None

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
                current_day = signal_day

            price = _extract_price(signal)
            last_prices[signal.symbol] = price
            last_signals[signal.symbol] = signal
            day_bucket = _active_day_stats(signal_day)

            pending = pending_orders.pop(signal.symbol, None)
            if pending is not None:
                fill_cost = _estimate_trade_cost(model=cost_model, decision=pending.decision, signal=signal)
                decision = pending.decision
                day_bucket['cost_total'] += fill_cost
                day_bucket['filled_count'] += 1
                if decision.action == 'buy':
                    cash -= (price * decision.qty) + fill_cost
                    existing = positions.get(decision.symbol)
                    if existing is None:
                        positions[decision.symbol] = PositionState(
                            qty=decision.qty,
                            avg_entry_price=price,
                            opened_at=signal.event_ts,
                            entry_cost_total=fill_cost,
                            decision_at=pending.created_at,
                        )
                    else:
                        new_qty = existing.qty + decision.qty
                        avg_entry = (
                            (existing.avg_entry_price * existing.qty) + (price * decision.qty)
                        ) / new_qty
                        positions[decision.symbol] = PositionState(
                            qty=new_qty,
                            avg_entry_price=avg_entry,
                            opened_at=existing.opened_at,
                            entry_cost_total=existing.entry_cost_total + fill_cost,
                            decision_at=existing.decision_at,
                        )
                else:
                    existing = positions.get(decision.symbol)
                    if existing is not None and existing.qty > 0:
                        sell_qty = min(decision.qty, existing.qty)
                        cash += (price * sell_qty) - fill_cost
                        entry_cost_allocated = existing.entry_cost_total * (
                            sell_qty / existing.qty
                        )
                        remaining, trade = _close_position(
                            symbol=decision.symbol,
                            position=existing,
                            sell_qty=sell_qty,
                            fill_price=price,
                            closed_at=signal.event_ts,
                            exit_reason='signal_exit',
                            entry_cost_allocated=entry_cost_allocated,
                            exit_cost_total=fill_cost,
                        )
                        if remaining is None:
                            positions.pop(decision.symbol, None)
                        else:
                            positions[decision.symbol] = remaining
                        day_bucket['gross_pnl'] += trade.gross_pnl
                        day_bucket['net_pnl'] += trade.net_pnl
                        if trade.net_pnl > 0:
                            day_bucket['wins'] += 1
                        elif trade.net_pnl < 0:
                            day_bucket['losses'] += 1
                        day_bucket['closed_trades'].append(trade)
                        all_closed_trades.append(trade)

            equity = _position_equity(cash=cash, positions=positions, last_prices=last_prices)
            decisions = engine.evaluate(
                signal,
                strategies,
                equity=equity,
                positions=_positions_payload(positions, last_prices),
            )
            for decision in decisions:
                decision = _apply_order_preferences(decision, signal)
                _record_decision(day_bucket, decision)
                if decision.qty <= 0:
                    continue
                if decision.symbol in pending_orders:
                    continue
                pending_orders[decision.symbol] = PendingOrder(
                    decision=decision,
                    created_at=signal.event_ts,
                    signal=signal,
                )

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
            symbol: {
                'qty': str(position.qty),
                'avg_entry_price': str(position.avg_entry_price),
                'last_price': str(last_prices.get(symbol, position.avg_entry_price)),
            }
            for symbol, position in positions.items()
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


def _flatten_positions(
    *,
    day: date,
    stats: dict[str, Any],
    positions: dict[str, PositionState],
    last_signals: dict[str, SignalEnvelope],
    last_prices: dict[str, Decimal],
    cost_model: TransactionCostModel,
    cash_ref: list[Decimal],
    all_closed_trades: list[ClosedTrade],
) -> None:
    if not positions:
        return
    current_cash = cash_ref[0]
    for symbol in sorted(list(positions)):
        position = positions.pop(symbol)
        last_signal = last_signals.get(symbol)
        if last_signal is None:
            continue
        fill_price = last_prices.get(symbol, position.avg_entry_price)
        synthetic_decision = StrategyDecision(
            strategy_id='flatten',
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
    cash_ref[0] = current_cash


def main() -> None:
    args = _parse_args()
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
    )
    payload = run_replay(config)
    if args.json:
        print(json.dumps(payload, sort_keys=True, separators=(',', ':')))
        return
    print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import argparse
import contextlib
import itertools
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, cast
from unittest.mock import patch

import yaml

from app.trading.discovery.dataset_snapshot import (
    build_dataset_snapshot_receipt,
    ensure_fresh_snapshot,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.family_templates import (
    derive_family_template_id,
    family_template_dir,
    load_family_template,
)
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    evaluate_vetoes,
    rank_scorecards,
)
from app.trading.reporting import (
    ProfitabilityConstraintPolicy,
    score_replay_profitability_candidate,
    summarize_replay_profitability,
)
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.local_intraday_tsmom_replay import run_replay
from scripts.search_profitability_frontier import (
    _SWEEP_SCHEMA_VERSION,
    _build_replay_config,
    _load_sweep_config,
    _resolve_recent_trading_days,
    apply_candidate_to_configmap,
    iter_parameter_candidates,
    resolve_sweep_window,
)

_LOCAL_ONLY_OVERRIDE_KEYS = frozenset({'normalization_regime'})


@dataclass(frozen=True)
class FullWindowConsistencyPolicy:
    target_net_per_day: Decimal
    min_active_days: int
    min_active_ratio: Decimal
    min_positive_days: int
    max_worst_day_loss: Decimal
    max_negative_days: int
    max_drawdown: Decimal
    max_best_day_share_of_total_pnl: Decimal
    min_avg_filled_notional_per_day: Decimal
    min_avg_filled_notional_per_active_day: Decimal
    require_every_day_active: bool
    min_regime_slice_pass_rate: Decimal = Decimal('0')
    max_symbol_concentration_share: Decimal = Decimal('1')
    max_entry_family_contribution_share: Decimal = Decimal('1')

    def to_payload(self) -> dict[str, Any]:
        return {
            'target_net_per_day': str(self.target_net_per_day),
            'min_active_days': self.min_active_days,
            'min_active_ratio': str(self.min_active_ratio),
            'min_positive_days': self.min_positive_days,
            'max_worst_day_loss': str(self.max_worst_day_loss),
            'max_negative_days': self.max_negative_days,
            'max_drawdown': str(self.max_drawdown),
            'max_best_day_share_of_total_pnl': str(self.max_best_day_share_of_total_pnl),
            'min_avg_filled_notional_per_day': str(self.min_avg_filled_notional_per_day),
            'min_avg_filled_notional_per_active_day': str(self.min_avg_filled_notional_per_active_day),
            'require_every_day_active': self.require_every_day_active,
            'min_regime_slice_pass_rate': str(self.min_regime_slice_pass_rate),
            'max_symbol_concentration_share': str(self.max_symbol_concentration_share),
            'max_entry_family_contribution_share': str(self.max_entry_family_contribution_share),
        }


def _optional_int(value: Any, *, default: int) -> int:
    if value is None:
        return default
    return int(value)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Search replay configs using holdout profitability plus full-window consistency.',
    )
    parser.add_argument(
        '--strategy-configmap',
        type=Path,
        default=Path('argocd/applications/torghut/strategy-configmap.yaml'),
    )
    parser.add_argument(
        '--sweep-config',
        type=Path,
        default=Path('config/trading/profitability-frontier-consistent-tsmom.yaml'),
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
        default=os.environ.get(
            'TA_CLICKHOUSE_USERNAME',
            os.environ.get('CLICKHOUSE_USERNAME', 'torghut'),
        ),
    )
    parser.add_argument(
        '--clickhouse-password',
        default=os.environ.get(
            'TA_CLICKHOUSE_PASSWORD',
            os.environ.get('CLICKHOUSE_PASSWORD', ''),
        ),
    )
    parser.add_argument('--start-equity', default='31590.02')
    parser.add_argument('--chunk-minutes', type=int, default=10)
    parser.add_argument('--symbols', default='')
    parser.add_argument('--progress-log-seconds', type=int, default=30)
    parser.add_argument('--train-days', type=int, default=6)
    parser.add_argument('--holdout-days', type=int, default=3)
    parser.add_argument('--full-window-start-date', default='')
    parser.add_argument('--full-window-end-date', default='')
    parser.add_argument(
        '--expected-last-trading-day',
        default='',
        help='Optional ISO date freshness witness. If omitted, recent sweeps expect the latest completed trading day.',
    )
    parser.add_argument(
        '--allow-stale-tape',
        action='store_true',
        help='Persist and continue even when the latest expected trading day is missing from PT1S tape.',
    )
    parser.add_argument(
        '--family-template-dir',
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        '--prefetch-full-window-rows',
        action='store_true',
        help='Fetch full-window replay rows once and reuse them for every candidate replay.',
    )
    parser.add_argument('--top-n', type=int, default=10)
    parser.add_argument(
        '--max-candidates-to-evaluate',
        type=int,
        default=0,
        help='Optional cap on evaluated candidates inside one frontier run. 0 means unbounded.',
    )
    parser.add_argument('--json-output', type=Path)
    parser.add_argument(
        '--symbol-prune-iterations',
        type=int,
        default=0,
        help='Greedily generate child candidates by removing downside-contributing symbols from replay attribution.',
    )
    parser.add_argument(
        '--symbol-prune-candidates',
        type=int,
        default=1,
        help='How many worst-contributing symbols to branch on per pruning step.',
    )
    parser.add_argument(
        '--symbol-prune-min-universe-size',
        type=int,
        default=2,
        help='Do not prune below this many symbols in the candidate universe.',
    )
    return parser.parse_args()


def _rolling_lower_bound(daily_net: Mapping[str, Decimal], *, window: int) -> Decimal:
    ordered = [daily_net[key] for key in sorted(daily_net)]
    if not ordered:
        return Decimal('0')
    if len(ordered) < window:
        return sum(ordered, Decimal('0')) / Decimal(len(ordered))
    values: list[Decimal] = []
    for index in range(len(ordered) - window + 1):
        sample = ordered[index : index + window]
        values.append(sum(sample, Decimal('0')) / Decimal(window))
    return min(values) if values else Decimal('0')


def _objective_veto_policy(
    *,
    consistency_policy: FullWindowConsistencyPolicy,
    template_defaults: Mapping[str, Any],
    trading_day_count: int,
) -> ObjectiveVetoPolicy:
    required_min_active_day_ratio = consistency_policy.min_active_ratio
    if required_min_active_day_ratio <= 0 and trading_day_count > 0 and consistency_policy.min_active_days > 0:
        required_min_active_day_ratio = Decimal(consistency_policy.min_active_days) / Decimal(trading_day_count)
    return ObjectiveVetoPolicy(
        required_min_active_day_ratio=max(
            required_min_active_day_ratio,
            Decimal(str(template_defaults.get('required_min_active_day_ratio', '0'))),
        ),
        required_min_daily_notional=max(
            consistency_policy.min_avg_filled_notional_per_day,
            Decimal(str(template_defaults.get('required_min_daily_notional', '0'))),
        ),
        required_max_best_day_share=min(
            consistency_policy.max_best_day_share_of_total_pnl,
            Decimal(str(template_defaults.get('required_max_best_day_share', '1'))),
        ),
        required_max_worst_day_loss=min(
            consistency_policy.max_worst_day_loss,
            Decimal(str(template_defaults.get('required_max_worst_day_loss', str(consistency_policy.max_worst_day_loss)))),
        ),
        required_max_drawdown=min(
            consistency_policy.max_drawdown,
            Decimal(str(template_defaults.get('required_max_drawdown', str(consistency_policy.max_drawdown)))),
        ),
        required_min_regime_slice_pass_rate=max(
            consistency_policy.min_regime_slice_pass_rate,
            Decimal(str(template_defaults.get('required_min_regime_slice_pass_rate', '0'))),
        ),
    )


def _iter_strategy_override_candidates(
    strategy_override_grid: Mapping[str, Iterable[Any]] | None,
) -> list[dict[str, Any]]:
    if strategy_override_grid is None:
        return [{}]
    return iter_parameter_candidates(strategy_override_grid)


def _candidate_symbols(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
) -> tuple[str, ...]:
    if cli_symbols:
        return cli_symbols
    override_symbols = strategy_overrides.get('universe_symbols')
    if not isinstance(override_symbols, (list, tuple)):
        return ()
    values = tuple(
        str(item).strip().upper()
        for item in override_symbols
        if str(item).strip()
    )
    return values


def _strategy_universe_symbols(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    data = configmap_payload.get('data')
    if not isinstance(data, Mapping):
        return ()
    strategies_yaml = data.get('strategies.yaml')
    if not isinstance(strategies_yaml, str):
        return ()
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, Mapping):
        return ()
    strategies = catalog.get('strategies')
    if not isinstance(strategies, list):
        return ()
    for item in strategies:
        if not isinstance(item, Mapping):
            continue
        if str(item.get('name') or '').strip() != strategy_name:
            continue
        raw_symbols = item.get('universe_symbols')
        if not isinstance(raw_symbols, (list, tuple)):
            return ()
        return tuple(
            str(symbol).strip().upper()
            for symbol in raw_symbols
            if str(symbol).strip()
        )
    return ()


def _candidate_universe_symbols(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    override_symbols = _candidate_symbols(
        cli_symbols=cli_symbols,
        strategy_overrides=strategy_overrides,
    )
    if override_symbols:
        return override_symbols
    if cli_symbols:
        return cli_symbols
    return _strategy_universe_symbols(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
    )


def _candidate_search_key(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
) -> str:
    def _normalize(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {str(key): _normalize(val) for key, val in sorted(value.items(), key=lambda item: str(item[0]))}
        if isinstance(value, tuple):
            return [_normalize(item) for item in value]
        if isinstance(value, list):
            return [_normalize(item) for item in value]
        return value

    return json.dumps(
        {
            'params': _normalize(params_candidate),
            'strategy_overrides': _normalize(
                {
                    str(key): value
                    for key, value in strategy_overrides.items()
                    if str(key) not in _LOCAL_ONLY_OVERRIDE_KEYS
                }
            ),
        },
        sort_keys=True,
        separators=(',', ':'),
    )


def _resolve_prefetch_symbols(
    *,
    cli_symbols: tuple[str, ...],
    override_candidates: Iterable[Mapping[str, Any]],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    if cli_symbols:
        return cli_symbols
    ordered: list[str] = []
    seen: set[str] = set()
    for candidate in override_candidates:
        for symbol in _candidate_symbols(cli_symbols=(), strategy_overrides=candidate):
            if symbol in seen:
                continue
            seen.add(symbol)
            ordered.append(symbol)
    if ordered:
        return tuple(ordered)
    return _strategy_universe_symbols(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
    )


def _prefetch_signal_rows(
    *,
    strategy_configmap_path: Path,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    start_date: date,
    end_date: date,
    start_equity: Decimal,
    chunk_minutes: int,
    symbols: tuple[str, ...],
    progress_log_interval_seconds: int,
) -> list[Any]:
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=strategy_configmap_path,
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=chunk_minutes,
        flatten_eod=True,
        start_equity=start_equity,
        symbols=symbols,
        progress_log_interval_seconds=progress_log_interval_seconds,
    )
    rows = list(replay_mod._iter_signal_rows(config))
    rows.sort(key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    return rows


def _cached_iter_signal_rows_factory(
    rows: list[Any],
) -> Callable[[replay_mod.ReplayConfig], Iterator[Any]]:
    def _iter_signal_rows(config: replay_mod.ReplayConfig) -> Iterator[Any]:
        selected_symbols = {symbol.upper() for symbol in config.symbols} if config.symbols else None
        for row in rows:
            signal_day = row.event_ts.date()
            if signal_day < config.start_date or signal_day > config.end_date:
                continue
            if selected_symbols is not None and row.symbol.upper() not in selected_symbols:
                continue
            yield row

    return _iter_signal_rows


@contextlib.contextmanager
def _cached_signal_rows_patch(rows: list[Any]) -> Iterator[None]:
    with patch.object(
        replay_mod,
        '_iter_signal_rows',
        _cached_iter_signal_rows_factory(rows),
    ):
        yield


def apply_candidate_to_configmap_with_overrides(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    candidate_params: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    disable_other_strategies: bool,
) -> dict[str, Any]:
    root = apply_candidate_to_configmap(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
        candidate_params=candidate_params,
        disable_other_strategies=disable_other_strategies,
    )
    if not strategy_overrides:
        return root

    data = root.get('data')
    if not isinstance(data, dict):
        raise ValueError('strategy_configmap_missing_data')
    strategies_yaml = data.get('strategies.yaml')
    if not isinstance(strategies_yaml, str):
        raise ValueError('strategy_configmap_missing_strategies_yaml')
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, dict):
        raise ValueError('strategy_catalog_not_mapping')
    strategies = catalog.get('strategies')
    if not isinstance(strategies, list):
        raise ValueError('strategy_catalog_missing_strategies')

    matched = False
    for item in strategies:
        if not isinstance(item, dict):
            continue
        item_name = str(item.get('name') or '').strip()
        if item_name != strategy_name:
            continue
        matched = True
        for key, value in strategy_overrides.items():
            if key == 'params':
                raise ValueError('strategy_override_key_reserved:params')
            if key in _LOCAL_ONLY_OVERRIDE_KEYS:
                continue
            item[key] = value
        break
    if not matched:
        raise ValueError(f'strategy_not_found:{strategy_name}')

    data['strategies.yaml'] = yaml.safe_dump(catalog, sort_keys=False)
    return root


def _resolve_full_window(
    *,
    args: argparse.Namespace,
    train_days: tuple[date, ...],
    holdout_days: tuple[date, ...],
) -> tuple[date, date]:
    if str(args.full_window_start_date or '').strip():
        start = date.fromisoformat(str(args.full_window_start_date))
    else:
        start = train_days[0]
    if str(args.full_window_end_date or '').strip():
        end = date.fromisoformat(str(args.full_window_end_date))
    else:
        end = holdout_days[-1]
    if start > end:
        raise ValueError('full_window_invalid_range')
    return (start, end)


def _max_drawdown_from_daily_net(daily_net: Mapping[str, Decimal]) -> Decimal:
    equity = Decimal('0')
    peak = Decimal('0')
    max_drawdown = Decimal('0')
    for trading_day in sorted(daily_net):
        equity += daily_net[trading_day]
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _daily_filled_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = cast(Mapping[str, Any], payload.get('daily') or {})
    filled_notional: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        if not isinstance(value, Mapping):
            continue
        value_mapping = cast(Mapping[str, Any], value)
        filled_notional[str(day)] = Decimal(str(value_mapping.get('filled_notional', '0')))
    return filled_notional


def _max_best_day_share_of_total_pnl(
    *,
    daily_net: Mapping[str, Decimal],
    total_net_pnl: Decimal,
) -> Decimal:
    if total_net_pnl <= 0:
        return Decimal('1')
    best_positive_day = max((value for value in daily_net.values() if value > 0), default=Decimal('0'))
    if best_positive_day <= 0:
        return Decimal('0')
    return best_positive_day / total_net_pnl


def _consistency_penalty(
    *,
    full_window_payload: Mapping[str, Any],
    policy: FullWindowConsistencyPolicy,
) -> tuple[Decimal, dict[str, Any]]:
    summary = summarize_replay_profitability(full_window_payload)
    daily_filled_notional = _daily_filled_notional(full_window_payload)
    negative_days = sum(1 for value in summary.daily_net.values() if value < 0)
    positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
    drawdown = _max_drawdown_from_daily_net(summary.daily_net)
    active_ratio = (
        Decimal(summary.active_days) / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal('0')
    )
    total_filled_notional = sum(daily_filled_notional.values(), Decimal('0'))
    avg_filled_notional_per_day = (
        total_filled_notional / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal('0')
    )
    avg_filled_notional_per_active_day = (
        total_filled_notional / Decimal(summary.active_days)
        if summary.active_days > 0
        else Decimal('0')
    )
    best_day_share_of_total_pnl = _max_best_day_share_of_total_pnl(
        daily_net=summary.daily_net,
        total_net_pnl=summary.net_pnl,
    )
    penalties = Decimal('0')

    if summary.net_per_day < policy.target_net_per_day:
        penalties += policy.target_net_per_day - summary.net_per_day
    if summary.active_days < policy.min_active_days:
        penalties += Decimal(policy.min_active_days - summary.active_days) * Decimal('250')
    if active_ratio < policy.min_active_ratio:
        penalties += (policy.min_active_ratio - active_ratio) * Decimal('2000')
    if positive_days < policy.min_positive_days:
        penalties += Decimal(policy.min_positive_days - positive_days) * Decimal('350')
    if policy.require_every_day_active and summary.active_days < summary.trading_day_count:
        penalties += Decimal(summary.trading_day_count - summary.active_days) * Decimal('400')
    if summary.worst_day_net < -policy.max_worst_day_loss:
        penalties += abs(summary.worst_day_net + policy.max_worst_day_loss)
    if negative_days > policy.max_negative_days:
        penalties += Decimal(negative_days - policy.max_negative_days) * Decimal('300')
    if drawdown > policy.max_drawdown:
        penalties += drawdown - policy.max_drawdown
    if best_day_share_of_total_pnl > policy.max_best_day_share_of_total_pnl:
        penalties += (
            best_day_share_of_total_pnl - policy.max_best_day_share_of_total_pnl
        ) * abs(summary.net_pnl)
    if avg_filled_notional_per_day < policy.min_avg_filled_notional_per_day:
        penalties += (
            policy.min_avg_filled_notional_per_day - avg_filled_notional_per_day
        ) / Decimal('1000')
    if avg_filled_notional_per_active_day < policy.min_avg_filled_notional_per_active_day:
        penalties += (
            policy.min_avg_filled_notional_per_active_day - avg_filled_notional_per_active_day
        ) / Decimal('1000')

    return (
        penalties,
        {
            'start_date': summary.start_date,
            'end_date': summary.end_date,
            'trading_day_count': summary.trading_day_count,
            'net_pnl': str(summary.net_pnl),
            'net_per_day': str(summary.net_per_day),
            'active_days': summary.active_days,
            'active_ratio': str(active_ratio),
            'positive_days': positive_days,
            'worst_day_net': str(summary.worst_day_net),
            'negative_days': negative_days,
            'max_drawdown': str(drawdown),
            'total_filled_notional': str(total_filled_notional),
            'avg_filled_notional_per_day': str(avg_filled_notional_per_day),
            'avg_filled_notional_per_active_day': str(avg_filled_notional_per_active_day),
            'best_day_share_of_total_pnl': str(best_day_share_of_total_pnl),
            'daily_net': {day: str(value) for day, value in summary.daily_net.items()},
            'daily_filled_notional': {day: str(value) for day, value in daily_filled_notional.items()},
        },
    )


def _symbol_contributions_from_replay_payload(
    payload: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    funnel = payload.get('funnel')
    if not isinstance(funnel, Mapping):
        return {}
    buckets = funnel.get('buckets')
    if not isinstance(buckets, list):
        return {}

    contributions: dict[str, dict[str, Any]] = {}
    for raw_bucket in buckets:
        if not isinstance(raw_bucket, Mapping):
            continue
        symbol = str(raw_bucket.get('symbol') or '').strip().upper()
        if not symbol:
            continue
        bucket_net = Decimal(str(raw_bucket.get('net_pnl', '0')))
        bucket_cost = Decimal(str(raw_bucket.get('cost_total', '0')))
        bucket_filled = int(raw_bucket.get('filled_count', 0) or 0)
        bucket_day = str(raw_bucket.get('trading_day') or '').strip()
        aggregate = contributions.setdefault(
            symbol,
            {
                'net_pnl': Decimal('0'),
                'cost_total': Decimal('0'),
                'downside_pnl': Decimal('0'),
                'worst_day_net': Decimal('0'),
                'active_days': set(),
                'negative_days': set(),
                'filled_count': 0,
            },
        )
        aggregate['net_pnl'] += bucket_net
        aggregate['cost_total'] += bucket_cost
        aggregate['filled_count'] += bucket_filled
        if bucket_filled > 0 and bucket_day:
            aggregate['active_days'].add(bucket_day)
        if bucket_net < 0:
            aggregate['downside_pnl'] += -bucket_net
            if bucket_day:
                aggregate['negative_days'].add(bucket_day)
            if bucket_net < aggregate['worst_day_net']:
                aggregate['worst_day_net'] = bucket_net

    result: dict[str, dict[str, Any]] = {}
    for symbol, aggregate in contributions.items():
        net_pnl = aggregate['net_pnl']
        downside_pnl = aggregate['downside_pnl']
        worst_day_net = aggregate['worst_day_net']
        # Risk-sensitive marginal contribution: reward positive contribution, penalize
        # downside and especially severe one-day losses.
        contribution_score = net_pnl - downside_pnl - abs(worst_day_net)
        result[symbol] = {
            'net_pnl': str(net_pnl),
            'cost_total': str(aggregate['cost_total']),
            'downside_pnl': str(downside_pnl),
            'worst_day_net': str(worst_day_net),
            'active_days': len(aggregate['active_days']),
            'negative_days': len(aggregate['negative_days']),
            'filled_count': aggregate['filled_count'],
            'contribution_score': str(contribution_score),
        }
    return dict(
        sorted(
            result.items(),
            key=lambda item: (
                Decimal(str(item[1]['contribution_score'])),
                Decimal(str(item[1]['net_pnl'])),
            ),
        )
    )


def _generate_symbol_prune_children(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    symbol_contributions: Mapping[str, Mapping[str, Any]],
    branch_count: int,
    min_universe_size: int,
) -> list[tuple[str, dict[str, Any]]]:
    if cli_symbols:
        return []
    universe = list(
        _candidate_universe_symbols(
            cli_symbols=cli_symbols,
            strategy_overrides=strategy_overrides,
            configmap_payload=configmap_payload,
            strategy_name=strategy_name,
        )
    )
    if len(universe) <= max(1, min_universe_size):
        return []

    ranked_symbols = [
        symbol
        for symbol in symbol_contributions
        if symbol in universe
    ]
    children: list[tuple[str, dict[str, Any]]] = []
    for symbol in ranked_symbols[: max(1, branch_count)]:
        pruned_universe = [item for item in universe if item != symbol]
        if len(pruned_universe) < max(1, min_universe_size):
            continue
        next_override = dict(strategy_overrides)
        next_override['universe_symbols'] = pruned_universe
        children.append((symbol, next_override))
    return children


def _rank_scored_candidates(scored: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not scored:
        return []
    scorecards = {
        str(item['candidate_id']): build_scorecard(
            candidate_id=str(item['candidate_id']),
            trading_day_count=int(item['full_window']['trading_day_count']),
            net_pnl_per_day=Decimal(str(item['objective_scorecard']['net_pnl_per_day'])),
            active_days=int(
                Decimal(str(item['objective_scorecard']['active_day_ratio']))
                * Decimal(str(item['full_window']['trading_day_count']))
            ),
            positive_days=int(
                Decimal(str(item['objective_scorecard']['positive_day_ratio']))
                * Decimal(str(item['full_window']['trading_day_count']))
            ),
            avg_filled_notional_per_day=Decimal(str(item['objective_scorecard']['avg_filled_notional_per_day'])),
            avg_filled_notional_per_active_day=Decimal(
                str(item['objective_scorecard']['avg_filled_notional_per_active_day'])
            ),
            worst_day_loss=Decimal(str(item['objective_scorecard']['worst_day_loss'])),
            max_drawdown=Decimal(str(item['objective_scorecard']['max_drawdown'])),
            best_day_share=Decimal(str(item['objective_scorecard']['best_day_share'])),
            negative_day_count=int(item['objective_scorecard']['negative_day_count']),
            rolling_3d_lower_bound=Decimal(str(item['objective_scorecard']['rolling_3d_lower_bound'])),
            rolling_5d_lower_bound=Decimal(str(item['objective_scorecard']['rolling_5d_lower_bound'])),
            regime_slice_pass_rate=Decimal(str(item['objective_scorecard']['regime_slice_pass_rate'])),
            symbol_concentration_share=Decimal(str(item['objective_scorecard']['symbol_concentration_share'])),
            entry_family_contribution_share=Decimal(
                str(item['objective_scorecard']['entry_family_contribution_share'])
            ),
        )
        for item in scored
    }
    ranked_scorecards = rank_scorecards(
        scorecards.values(),
        veto_lookup={
            str(item['candidate_id']): tuple(cast(list[str], item.get('hard_vetoes') or []))
            for item in scored
        },
    )
    ranked_lookup = {
        item.candidate_id: item
        for item in ranked_scorecards
    }
    ranked_items = [dict(item) for item in scored]
    for item in ranked_items:
        ranked = ranked_lookup[str(item['candidate_id'])]
        item['objective_scorecard'] = ranked.to_payload()
        item['ranking'] = {
            'method': 'pareto_frontier_v2',
            'pareto_tier': ranked.pareto_tier,
            'tie_breaker_score': str(ranked.tie_breaker_score),
            'vetoed': bool(ranked.veto_reasons),
        }
    ranked_items.sort(
        key=lambda item: (
            bool(item['ranking']['vetoed']),
            int(item['ranking']['pareto_tier']),
            -Decimal(str(item['ranking']['tie_breaker_score'])),
            -Decimal(str(item['full_window']['net_per_day'])),
        )
    )
    return ranked_items


def _build_frontier_payload(
    *,
    scored: list[dict[str, Any]],
    family: str,
    strategy_name: str,
    family_template: Any,
    dataset_snapshot_receipt: Any,
    window: Any,
    full_window_start: date,
    full_window_end: date,
    holdout_policy: ProfitabilityConstraintPolicy,
    consistency_policy: FullWindowConsistencyPolicy,
    objective_veto_policy: ObjectiveVetoPolicy,
    top_n: int,
    status: str,
    pending_candidates: int,
) -> dict[str, Any]:
    ranked_items = _rank_scored_candidates(scored)
    return {
        'schema_version': _SWEEP_SCHEMA_VERSION,
        'status': status,
        'family': family,
        'strategy_name': strategy_name,
        'family_template': family_template.to_payload(),
        'dataset_snapshot_receipt': dataset_snapshot_receipt.to_payload(),
        'window': {
            'train_days': [item.isoformat() for item in window.train_days],
            'holdout_days': [item.isoformat() for item in window.holdout_days],
            'full_window_start_date': full_window_start.isoformat(),
            'full_window_end_date': full_window_end.isoformat(),
        },
        'constraints': {
            'holdout': {
                'holdout_target_net_per_day': str(holdout_policy.holdout_target_net_per_day),
                'min_active_holdout_days': holdout_policy.min_active_holdout_days,
                'max_worst_holdout_day_loss': str(holdout_policy.max_worst_holdout_day_loss),
                'min_profit_factor': str(holdout_policy.min_profit_factor),
                'require_training_decisions': holdout_policy.require_training_decisions,
                'require_holdout_decisions': holdout_policy.require_holdout_decisions,
            },
            'consistency': consistency_policy.to_payload(),
            'hard_vetoes': objective_veto_policy.to_payload(),
        },
        'ranking': {
            'method': 'pareto_frontier_v2',
            'stale_override_used': dataset_snapshot_receipt.stale_override_used,
        },
        'progress': {
            'evaluated_candidates': len(scored),
            'pending_candidates': pending_candidates,
        },
        'candidate_count': len(scored),
        'top': ranked_items[: max(1, int(top_n))],
    }


def _selected_normalization_regime(
    *,
    strategy_overrides: Mapping[str, Any],
    template_allowed_normalizations: tuple[str, ...],
) -> str | None:
    override = str(strategy_overrides.get('normalization_regime') or '').strip()
    if override:
        return override
    return template_allowed_normalizations[0] if template_allowed_normalizations else None


def run_consistent_profitability_frontier(args: argparse.Namespace) -> dict[str, Any]:
    sweep_config = _load_sweep_config(args.sweep_config.resolve())
    recent_days = _resolve_recent_trading_days(
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        limit=max(1, int(args.train_days)) + max(1, int(args.holdout_days)),
    )
    window = resolve_sweep_window(
        recent_days,
        train_days=max(1, int(args.train_days)),
        holdout_days=max(1, int(args.holdout_days)),
    )
    full_window_start, full_window_end = _resolve_full_window(
        args=args,
        train_days=window.train_days,
        holdout_days=window.holdout_days,
    )

    base_configmap = yaml.safe_load(args.strategy_configmap.resolve().read_text(encoding='utf-8'))
    if not isinstance(base_configmap, dict):
        raise ValueError('base_strategy_configmap_not_mapping')

    family = str(sweep_config.get('family') or '').strip()
    strategy_name = str(sweep_config.get('strategy_name') or '').strip()
    if not family or not strategy_name:
        raise ValueError('sweep_config_missing_family_or_strategy_name')
    family_template = load_family_template(
        derive_family_template_id(
            explicit_id=str(sweep_config.get('family_template_id') or '').strip() or None,
            family=family,
        ),
        directory=args.family_template_dir,
    )
    disable_other_strategies = bool(sweep_config.get('disable_other_strategies', True))

    parameter_grid = sweep_config.get('parameters')
    if not isinstance(parameter_grid, Mapping):
        raise ValueError('sweep_config_parameters_not_mapping')
    strategy_override_grid = sweep_config.get('strategy_overrides')
    if strategy_override_grid is not None and not isinstance(strategy_override_grid, Mapping):
        raise ValueError('sweep_config_strategy_overrides_not_mapping')

    constraints_value = sweep_config.get('constraints')
    if constraints_value is None:
        constraints: Mapping[str, Any] = {}
    elif isinstance(constraints_value, Mapping):
        constraints = cast(Mapping[str, Any], constraints_value)
    else:
        raise ValueError('sweep_config_constraints_not_mapping')

    consistency_value = sweep_config.get('consistency_constraints')
    if consistency_value is None:
        consistency_constraints: Mapping[str, Any] = {}
    elif isinstance(consistency_value, Mapping):
        consistency_constraints = cast(Mapping[str, Any], consistency_value)
    else:
        raise ValueError('sweep_config_consistency_constraints_not_mapping')

    holdout_policy = ProfitabilityConstraintPolicy(
        holdout_target_net_per_day=Decimal(str(constraints.get('holdout_target_net_per_day', '200'))),
        min_active_holdout_days=int(constraints.get('min_active_holdout_days', 2)),
        max_worst_holdout_day_loss=Decimal(str(constraints.get('max_worst_holdout_day_loss', '200'))),
        min_profit_factor=Decimal(str(constraints.get('min_profit_factor', '1.2'))),
        require_training_decisions=bool(constraints.get('require_training_decisions', True)),
        require_holdout_decisions=bool(constraints.get('require_holdout_decisions', True)),
    )
    consistency_policy = FullWindowConsistencyPolicy(
        target_net_per_day=Decimal(str(consistency_constraints.get('target_net_per_day', '200'))),
        # Widened full-window evaluations intentionally omit count-based activity thresholds
        # because train+holdout counts are not authoritative for the larger window.
        min_active_days=_optional_int(consistency_constraints.get('min_active_days'), default=0),
        min_active_ratio=Decimal(str(consistency_constraints.get('min_active_ratio', '0'))),
        min_positive_days=int(consistency_constraints.get('min_positive_days', 0)),
        max_worst_day_loss=Decimal(str(consistency_constraints.get('max_worst_day_loss', '250'))),
        max_negative_days=int(consistency_constraints.get('max_negative_days', 2)),
        max_drawdown=Decimal(str(consistency_constraints.get('max_drawdown', '600'))),
        max_best_day_share_of_total_pnl=Decimal(str(consistency_constraints.get('max_best_day_share_of_total_pnl', '1'))),
        min_avg_filled_notional_per_day=Decimal(str(consistency_constraints.get('min_avg_filled_notional_per_day', '0'))),
        min_avg_filled_notional_per_active_day=Decimal(str(consistency_constraints.get('min_avg_filled_notional_per_active_day', '0'))),
        require_every_day_active=bool(consistency_constraints.get('require_every_day_active', True)),
        min_regime_slice_pass_rate=Decimal(str(consistency_constraints.get('min_regime_slice_pass_rate', '0'))),
        max_symbol_concentration_share=Decimal(str(consistency_constraints.get('max_symbol_concentration_share', '1'))),
        max_entry_family_contribution_share=Decimal(str(consistency_constraints.get('max_entry_family_contribution_share', '1'))),
    )
    expected_last_trading_day = (
        date.fromisoformat(str(args.expected_last_trading_day))
        if str(args.expected_last_trading_day or '').strip()
        else (full_window_end if str(args.full_window_end_date or '').strip() else None)
    )
    dataset_snapshot_receipt = build_dataset_snapshot_receipt(
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_day=full_window_start,
        end_day=full_window_end,
        expected_last_trading_day=expected_last_trading_day,
        expected_trading_days=window.train_days + window.holdout_days,
        allow_stale_tape=bool(args.allow_stale_tape),
    )
    ensure_fresh_snapshot(
        dataset_snapshot_receipt,
        allow_stale_tape=bool(args.allow_stale_tape),
    )
    objective_veto_policy = _objective_veto_policy(
        consistency_policy=consistency_policy,
        template_defaults=family_template.default_hard_vetoes,
        trading_day_count=len(window.train_days) + len(window.holdout_days),
    )

    symbols = tuple(
        symbol.strip().upper()
        for symbol in str(args.symbols or '').split(',')
        if symbol.strip()
    )
    param_candidates = iter_parameter_candidates(parameter_grid)
    override_candidates = _iter_strategy_override_candidates(
        cast(Mapping[str, Iterable[Any]] | None, strategy_override_grid)
    )
    prefetch_symbols = _resolve_prefetch_symbols(
        cli_symbols=symbols,
        override_candidates=override_candidates,
        configmap_payload=base_configmap,
        strategy_name=strategy_name,
    )
    scored: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix='torghut-consistent-profitability-frontier-') as tmpdir:
        root = Path(tmpdir)
        cached_rows: list[Any] | None = None
        if args.prefetch_full_window_rows:
            cached_rows = _prefetch_signal_rows(
                strategy_configmap_path=args.strategy_configmap.resolve(),
                clickhouse_http_url=str(args.clickhouse_http_url),
                clickhouse_username=(str(args.clickhouse_username).strip() or None),
                clickhouse_password=(str(args.clickhouse_password).strip() or None),
                start_date=full_window_start,
                end_date=full_window_end,
                start_equity=Decimal(str(args.start_equity)),
                chunk_minutes=max(1, int(args.chunk_minutes)),
                symbols=prefetch_symbols,
                progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
            )
        candidate_index = 0
        worklist: list[tuple[dict[str, Any], dict[str, Any], int, str | None, str | None]] = [
            (dict(params_candidate), dict(override_candidate), 0, None, None)
            for params_candidate, override_candidate in itertools.product(param_candidates, override_candidates)
        ]
        seen_candidate_keys: set[str] = set()
        cache_context: contextlib.AbstractContextManager[None]
        cache_context = _cached_signal_rows_patch(cached_rows) if cached_rows is not None else contextlib.nullcontext()
        with cache_context:
            budget_exhausted = False
            while worklist:
                if int(args.max_candidates_to_evaluate) > 0 and len(scored) >= int(args.max_candidates_to_evaluate):
                    budget_exhausted = True
                    break
                params_candidate, override_candidate, prune_iteration, pruned_symbol, parent_candidate_id = worklist.pop(0)
                candidate_key = _candidate_search_key(
                    params_candidate=params_candidate,
                    strategy_overrides=override_candidate,
                )
                if candidate_key in seen_candidate_keys:
                    continue
                seen_candidate_keys.add(candidate_key)
                candidate_index += 1
                candidate_symbols = _candidate_symbols(
                    cli_symbols=symbols,
                    strategy_overrides=override_candidate,
                )
                candidate_configmap = apply_candidate_to_configmap_with_overrides(
                    configmap_payload=base_configmap,
                    strategy_name=strategy_name,
                    candidate_params=params_candidate,
                    strategy_overrides=override_candidate,
                    disable_other_strategies=disable_other_strategies,
                )
                candidate_configmap_path = root / f'candidate-{candidate_index:04d}.yaml'
                candidate_configmap_path.write_text(
                    yaml.safe_dump(candidate_configmap, sort_keys=False),
                    encoding='utf-8',
                )

                train_payload = run_replay(
                    _build_replay_config(
                        strategy_configmap_path=candidate_configmap_path,
                        clickhouse_http_url=str(args.clickhouse_http_url),
                        clickhouse_username=(str(args.clickhouse_username).strip() or None),
                        clickhouse_password=(str(args.clickhouse_password).strip() or None),
                        start_date=window.train_start,
                        end_date=window.train_end,
                        start_equity=Decimal(str(args.start_equity)),
                        chunk_minutes=max(1, int(args.chunk_minutes)),
                        symbols=candidate_symbols,
                        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
                    )
                )
                holdout_payload = run_replay(
                    _build_replay_config(
                        strategy_configmap_path=candidate_configmap_path,
                        clickhouse_http_url=str(args.clickhouse_http_url),
                        clickhouse_username=(str(args.clickhouse_username).strip() or None),
                        clickhouse_password=(str(args.clickhouse_password).strip() or None),
                        start_date=window.holdout_start,
                        end_date=window.holdout_end,
                        start_equity=Decimal(str(args.start_equity)),
                        chunk_minutes=max(1, int(args.chunk_minutes)),
                        symbols=candidate_symbols,
                        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
                    )
                )
                full_window_payload = run_replay(
                    _build_replay_config(
                        strategy_configmap_path=candidate_configmap_path,
                        clickhouse_http_url=str(args.clickhouse_http_url),
                        clickhouse_username=(str(args.clickhouse_username).strip() or None),
                        clickhouse_password=(str(args.clickhouse_password).strip() or None),
                        start_date=full_window_start,
                        end_date=full_window_end,
                        start_equity=Decimal(str(args.start_equity)),
                        chunk_minutes=max(1, int(args.chunk_minutes)),
                        symbols=candidate_symbols,
                        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
                    )
                )

                base_result = score_replay_profitability_candidate(
                    family=family,
                    strategy_name=strategy_name,
                    replay_config={
                        'candidate_index': candidate_index,
                        'params': params_candidate,
                        'strategy_overrides': override_candidate,
                        'train_start_date': window.train_start.isoformat(),
                        'train_end_date': window.train_end.isoformat(),
                        'holdout_start_date': window.holdout_start.isoformat(),
                        'holdout_end_date': window.holdout_end.isoformat(),
                        'full_window_start_date': full_window_start.isoformat(),
                        'full_window_end_date': full_window_end.isoformat(),
                    },
                    train_payload=train_payload,
                    holdout_payload=holdout_payload,
                    policy=holdout_policy,
                )
                consistency_penalty, full_window_summary = _consistency_penalty(
                    full_window_payload=full_window_payload,
                    policy=consistency_policy,
                )
                adjusted_score = base_result.score + Decimal(full_window_summary['net_per_day']) - consistency_penalty
                candidate_payload = base_result.to_payload()
                candidate_payload['full_window'] = full_window_summary
                candidate_payload['consistency_penalty'] = str(consistency_penalty)
                candidate_payload['adjusted_score'] = str(adjusted_score)
                candidate_payload['search_iteration'] = prune_iteration
                candidate_payload['family_template_id'] = family_template.family_id
                candidate_payload['dataset_snapshot_id'] = dataset_snapshot_receipt.snapshot_id
                if pruned_symbol is not None:
                    candidate_payload['pruned_symbol'] = pruned_symbol
                if parent_candidate_id is not None:
                    candidate_payload['parent_candidate_id'] = parent_candidate_id
                symbol_contributions = _symbol_contributions_from_replay_payload(full_window_payload)
                if symbol_contributions:
                    candidate_payload['symbol_contributions'] = symbol_contributions
                normalization_regime = _selected_normalization_regime(
                    strategy_overrides=override_candidate,
                    template_allowed_normalizations=family_template.allowed_normalizations,
                )
                decomposition = build_replay_decomposition(
                    replay_payload=full_window_payload,
                    family_id=family_template.family_id,
                    normalization_regime=normalization_regime,
                )
                summary = summarize_replay_profitability(full_window_payload)
                total_filled_notional = sum(
                    _daily_filled_notional(full_window_payload).values(),
                    Decimal('0'),
                )
                positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
                negative_days = sum(1 for value in summary.daily_net.values() if value < 0)
                objective_scorecard = build_scorecard(
                    candidate_id=str(candidate_payload['candidate_id']),
                    trading_day_count=summary.trading_day_count,
                    net_pnl_per_day=summary.net_per_day,
                    active_days=summary.active_days,
                    positive_days=positive_days,
                    avg_filled_notional_per_day=(
                        total_filled_notional / Decimal(summary.trading_day_count)
                        if summary.trading_day_count > 0
                        else Decimal('0')
                    ),
                    avg_filled_notional_per_active_day=(
                        total_filled_notional / Decimal(summary.active_days)
                        if summary.active_days > 0
                        else Decimal('0')
                    ),
                    worst_day_loss=abs(summary.worst_day_net) if summary.worst_day_net < 0 else Decimal('0'),
                    max_drawdown=_max_drawdown_from_daily_net(summary.daily_net),
                    best_day_share=_max_best_day_share_of_total_pnl(
                        daily_net=summary.daily_net,
                        total_net_pnl=summary.net_pnl,
                    ),
                    negative_day_count=negative_days,
                    rolling_3d_lower_bound=_rolling_lower_bound(summary.daily_net, window=3),
                    rolling_5d_lower_bound=_rolling_lower_bound(summary.daily_net, window=5),
                    regime_slice_pass_rate=regime_slice_pass_rate(decomposition),
                    symbol_concentration_share=max_symbol_concentration_share(decomposition),
                    entry_family_contribution_share=max_family_contribution_share(decomposition),
                )
                hard_vetoes = list(
                    evaluate_vetoes(
                        objective_scorecard,
                        policy=objective_veto_policy,
                        is_fresh=(dataset_snapshot_receipt.is_fresh or bool(args.allow_stale_tape)),
                    )
                )
                if objective_scorecard.symbol_concentration_share > consistency_policy.max_symbol_concentration_share:
                    hard_vetoes.append('symbol_concentration_above_max')
                if objective_scorecard.entry_family_contribution_share > consistency_policy.max_entry_family_contribution_share:
                    hard_vetoes.append('entry_family_contribution_above_max')
                candidate_payload['decomposition'] = decomposition.to_payload()
                candidate_payload['normalization_regime'] = normalization_regime
                candidate_payload['objective_scorecard'] = objective_scorecard.to_payload()
                candidate_payload['hard_vetoes'] = sorted(dict.fromkeys(hard_vetoes))
                if cached_rows is not None:
                    candidate_payload['prefetched_row_count'] = len(cached_rows)
                    candidate_payload['prefetched_symbols'] = list(prefetch_symbols)
                scored.append(candidate_payload)
                if prune_iteration < max(0, int(args.symbol_prune_iterations)):
                    for removed_symbol, next_override in _generate_symbol_prune_children(
                        cli_symbols=symbols,
                        strategy_overrides=override_candidate,
                        configmap_payload=base_configmap,
                        strategy_name=strategy_name,
                        symbol_contributions=symbol_contributions,
                        branch_count=max(1, int(args.symbol_prune_candidates)),
                        min_universe_size=max(1, int(args.symbol_prune_min_universe_size)),
                    ):
                        worklist.append(
                            (
                                dict(params_candidate),
                                next_override,
                                prune_iteration + 1,
                                removed_symbol,
                                str(candidate_payload['candidate_id']),
                            )
                        )
                if args.json_output is not None:
                    partial_payload = _build_frontier_payload(
                        scored=scored,
                        family=family,
                        strategy_name=strategy_name,
                        family_template=family_template,
                        dataset_snapshot_receipt=dataset_snapshot_receipt,
                        window=window,
                        full_window_start=full_window_start,
                        full_window_end=full_window_end,
                        holdout_policy=holdout_policy,
                        consistency_policy=consistency_policy,
                        objective_veto_policy=objective_veto_policy,
                        top_n=max(1, int(args.top_n)),
                        status='running',
                        pending_candidates=len(worklist),
                    )
                    args.json_output.write_text(
                        json.dumps(partial_payload, indent=2, sort_keys=True),
                        encoding='utf-8',
                    )

    payload = _build_frontier_payload(
        scored=scored,
        family=family,
        strategy_name=strategy_name,
        family_template=family_template,
        dataset_snapshot_receipt=dataset_snapshot_receipt,
        window=window,
        full_window_start=full_window_start,
        full_window_end=full_window_end,
        holdout_policy=holdout_policy,
        consistency_policy=consistency_policy,
        objective_veto_policy=objective_veto_policy,
        top_n=max(1, int(args.top_n)),
        status='candidate_budget_exhausted' if budget_exhausted and worklist else 'completed',
        pending_candidates=len(worklist),
    )
    if args.json_output is not None:
        args.json_output.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding='utf-8')
    return payload


def main() -> int:
    args = _parse_args()
    payload = run_consistent_profitability_frontier(args)
    if args.json_output:
        args.json_output.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding='utf-8')
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cli_main() -> int:
    try:
        return main()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(cli_main())

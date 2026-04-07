"""Replay decomposition helpers for Harness v2 diagnostics."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value or '0'))


@dataclass(frozen=True)
class ReplayDecomposition:
    days: dict[str, dict[str, Any]]
    symbols: dict[str, dict[str, Any]]
    families: dict[str, dict[str, Any]]
    entry_motifs: dict[str, dict[str, Any]]
    regime_slices: dict[str, dict[str, Any]]
    normalization_regimes: dict[str, dict[str, Any]]

    def to_payload(self) -> dict[str, Any]:
        return {
            'days': dict(self.days),
            'symbols': dict(self.symbols),
            'families': dict(self.families),
            'entry_motifs': dict(self.entry_motifs),
            'regime_slices': dict(self.regime_slices),
            'normalization_regimes': dict(self.normalization_regimes),
        }


def _sorted_payload(raw: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return dict(sorted(raw.items(), key=lambda item: item[0]))


def _decompose_symbols(payload: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    funnel = cast(Mapping[str, Any], payload.get('funnel') or {})
    buckets = cast(list[Mapping[str, Any]], funnel.get('buckets') or [])
    totals: dict[str, dict[str, Any]] = {}
    total_positive = Decimal('0')
    for bucket in buckets:
        symbol = str(bucket.get('symbol') or '').strip().upper()
        if not symbol:
            continue
        entry = totals.setdefault(
            symbol,
            {
                'net_pnl': Decimal('0'),
                'filled_notional': Decimal('0'),
                'filled_count': 0,
                'active_days': set(),
            },
        )
        net_pnl = _decimal(bucket.get('net_pnl'))
        filled_notional = _decimal(bucket.get('filled_notional'))
        entry['net_pnl'] += net_pnl
        entry['filled_notional'] += filled_notional
        entry['filled_count'] += int(bucket.get('filled_count') or 0)
        trading_day = str(bucket.get('trading_day') or '').strip()
        if trading_day and int(bucket.get('filled_count') or 0) > 0:
            entry['active_days'].add(trading_day)
        if net_pnl > 0:
            total_positive += net_pnl
    result: dict[str, dict[str, Any]] = {}
    for symbol, entry in totals.items():
        share = Decimal('0')
        if total_positive > 0 and entry['net_pnl'] > 0:
            share = entry['net_pnl'] / total_positive
        result[symbol] = {
            'net_pnl': str(entry['net_pnl']),
            'filled_notional': str(entry['filled_notional']),
            'filled_count': entry['filled_count'],
            'active_days': len(cast(set[str], entry['active_days'])),
            'positive_pnl_share': str(share),
        }
    return _sorted_payload(result)


def _trace_iter(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw_trace = payload.get('trace')
    if not isinstance(raw_trace, list):
        return []
    trace = cast(list[Any], raw_trace)
    resolved: list[Mapping[str, Any]] = []
    for raw_item in trace:
        if isinstance(raw_item, Mapping):
            resolved.append(cast(Mapping[str, Any], raw_item))
    return resolved


def _decompose_families(
    *,
    payload: Mapping[str, Any],
    fallback_family_id: str,
) -> dict[str, dict[str, Any]]:
    traces = _trace_iter(payload)
    if not traces:
        return {
            fallback_family_id: {
                'evaluations': int(payload.get('decision_count', 0) or 0),
                'fills': int(payload.get('filled_count', 0) or 0),
                'filled_share': '1' if int(payload.get('filled_count', 0) or 0) > 0 else '0',
            }
        }
    by_family: dict[str, dict[str, Any]] = defaultdict(lambda: {'evaluations': 0, 'fills': 0})
    total_fills = 0
    for item in traces:
        strategy_trace = cast(Mapping[str, Any], item.get('strategy_trace') or {})
        family_id = str(
            strategy_trace.get('strategy_type')
            or strategy_trace.get('strategy_id')
            or fallback_family_id
        ).strip()
        if not family_id:
            family_id = fallback_family_id
        entry = by_family[family_id]
        entry['evaluations'] += 1
        if str(item.get('fill_status') or '') == 'filled':
            entry['fills'] += 1
            total_fills += 1
    result: dict[str, dict[str, Any]] = {}
    for family_id, entry in by_family.items():
        fill_share = (
            Decimal(entry['fills']) / Decimal(total_fills)
            if total_fills > 0
            else Decimal('0')
        )
        result[family_id] = {
            'evaluations': entry['evaluations'],
            'fills': entry['fills'],
            'filled_share': str(fill_share),
        }
    return _sorted_payload(result)


def _decompose_entry_motifs(payload: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    traces = _trace_iter(payload)
    by_motif: dict[str, dict[str, Any]] = defaultdict(lambda: {'evaluations': 0, 'fills': 0})
    for item in traces:
        strategy_trace = cast(Mapping[str, Any], item.get('strategy_trace') or {})
        context = cast(Mapping[str, Any], strategy_trace.get('context') or {})
        motif = str(context.get('entry_motif') or context.get('motif') or strategy_trace.get('action') or 'unspecified').strip()
        entry = by_motif[motif or 'unspecified']
        entry['evaluations'] += 1
        if str(item.get('fill_status') or '') == 'filled':
            entry['fills'] += 1
    return _sorted_payload(dict(by_motif))


def _decompose_regime_slices(payload: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    traces = _trace_iter(payload)
    if not traces:
        return {}
    by_regime: dict[str, dict[str, Any]] = defaultdict(lambda: {'evaluations': 0, 'passes': 0, 'fills': 0})
    for item in traces:
        strategy_trace = cast(Mapping[str, Any], item.get('strategy_trace') or {})
        context = cast(Mapping[str, Any], strategy_trace.get('context') or {})
        regime = str(
            context.get('route_regime_label')
            or context.get('regime_label')
            or context.get('regime_slice')
            or 'unknown'
        ).strip()
        entry = by_regime[regime or 'unknown']
        entry['evaluations'] += 1
        if bool(strategy_trace.get('passed')):
            entry['passes'] += 1
        if str(item.get('fill_status') or '') == 'filled':
            entry['fills'] += 1
    result: dict[str, dict[str, Any]] = {}
    for regime, entry in by_regime.items():
        pass_rate = (
            Decimal(entry['passes']) / Decimal(entry['evaluations'])
            if entry['evaluations'] > 0
            else Decimal('0')
        )
        result[regime] = {
            'evaluations': entry['evaluations'],
            'passes': entry['passes'],
            'fills': entry['fills'],
            'pass_rate': str(pass_rate),
        }
    return _sorted_payload(result)


def build_replay_decomposition(
    *,
    replay_payload: Mapping[str, Any],
    family_id: str,
    normalization_regime: str | None,
) -> ReplayDecomposition:
    daily = cast(Mapping[str, Any], replay_payload.get('daily') or {})
    normalized_days = {
        str(day): {
            'net_pnl': str(_decimal(cast(Mapping[str, Any], value).get('net_pnl'))),
            'filled_notional': str(_decimal(cast(Mapping[str, Any], value).get('filled_notional'))),
            'filled_count': int(cast(Mapping[str, Any], value).get('filled_count') or 0),
        }
        for day, value in daily.items()
        if isinstance(value, Mapping)
    }
    normalization_key = (normalization_regime or 'default').strip() or 'default'
    family_payload = _decompose_families(payload=replay_payload, fallback_family_id=family_id)
    fills = int(replay_payload.get('filled_count') or 0)
    return ReplayDecomposition(
        days=_sorted_payload(normalized_days),
        symbols=_decompose_symbols(replay_payload),
        families=family_payload,
        entry_motifs=_decompose_entry_motifs(replay_payload),
        regime_slices=_decompose_regime_slices(replay_payload),
        normalization_regimes={
            normalization_key: {
                'filled_count': fills,
                'family_id': family_id,
            }
        },
    )


def regime_slice_pass_rate(decomposition: ReplayDecomposition) -> Decimal:
    if not decomposition.regime_slices:
        return Decimal('1')
    pass_rates = [
        _decimal(payload.get('pass_rate'))
        for payload in decomposition.regime_slices.values()
    ]
    if not pass_rates:
        return Decimal('1')
    return sum(pass_rates, Decimal('0')) / Decimal(len(pass_rates))


def max_symbol_concentration_share(decomposition: ReplayDecomposition) -> Decimal:
    shares = [
        _decimal(payload.get('positive_pnl_share'))
        for payload in decomposition.symbols.values()
    ]
    return max(shares, default=Decimal('0'))


def max_family_contribution_share(decomposition: ReplayDecomposition) -> Decimal:
    shares = [
        _decimal(payload.get('filled_share'))
        for payload in decomposition.families.values()
    ]
    return max(shares, default=Decimal('0'))

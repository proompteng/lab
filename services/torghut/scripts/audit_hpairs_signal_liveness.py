#!/usr/bin/env python
"""Read-only H-PAIRS signal/route liveness diagnostics.

The audit intentionally consumes only fixture JSON, local status JSON, or an
optional bounded HTTP GET. It never submits orders, writes proof artifacts, or
mutates database/cluster state.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

DEFAULT_HPAIRS_HYPOTHESIS_ID = 'H-PAIRS-01'
DEFAULT_HPAIRS_CANDIDATE_ID = 'c88421d619759b2cfaa6f4d0'
DEFAULT_HPAIRS_RUNTIME_STRATEGY = 'microbar-cross-sectional-pairs-v1'
DEFAULT_HPAIRS_ACCOUNT_LABEL = 'TORGHUT_SIM'
DEFAULT_OBSERVED_STAGE = 'paper'
HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION = 'torghut.hpairs-signal-liveness.v1'

NEXT_ACTIONS = (
    'no_target',
    'wrong_account',
    'no_market_data',
    'signal_below_threshold',
    'risk_veto',
    'route_disabled',
    'evidence_collection_disabled',
    'ready_to_submit_sim_order',
    'unsupported_inputs',
)

_MARKET_DATA_READY_KEYS = (
    'ready',
    'is_ready',
    'available',
    'is_available',
    'fresh',
    'has_latest',
)
_ROUTE_FLAG_KEYS = (
    'route_enabled',
    'route_eligible',
    'paper_route_enabled',
    'paper_route_eligible',
    'order_route_enabled',
    'order_route_eligible',
    'submit_route_enabled',
    'submit_route_eligible',
    'simulation_route_enabled',
    'sim_route_enabled',
)
_EVIDENCE_COLLECTION_KEYS = (
    'evidence_collection_ok',
    'evidence_collection_enabled',
    'bounded_evidence_collection_authorized',
    'source_collection_enabled',
    'source_collection_ok',
    'collection_enabled',
)
_SIMPLE_SUBMIT_KEYS = (
    'simple_submit_enabled',
    'submit_enabled',
    'trading_simple_submit_enabled',
)


@dataclass(frozen=True)
class AuditExpectations:
    hypothesis_id: str
    candidate_id: str
    account_label: str
    observed_stage: str
    runtime_strategy: str
    max_quote_age_seconds: float
    max_feature_age_seconds: float


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def _bool_or_none(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {'1', 'true', 't', 'yes', 'y', 'enabled', 'ready', 'ok'}:
            return True
        if normalized in {'0', 'false', 'f', 'no', 'n', 'disabled', 'blocked'}:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    return None


def _float_or_none(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _unique_text_items(value: object) -> list[str]:
    raw_items: Iterable[object]
    if isinstance(value, str):
        raw_items = (item for item in value.replace(';', ',').split(','))
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = value
    elif isinstance(value, Mapping):
        raw_items = value.keys()
    elif value is None:
        raw_items = ()
    else:
        raw_items = (value,)
    seen: set[str] = set()
    items: list[str] = []
    for raw_item in raw_items:
        item = _text(raw_item)
        if item is None or item in seen:
            continue
        seen.add(item)
        items.append(item)
    return items


def _json_default(value: object) -> str:
    return str(value)


def stable_json(payload: Mapping[str, object]) -> str:
    return json.dumps(payload, default=_json_default, indent=2, sort_keys=True) + '\n'


def _read_json_path(path: str | Path) -> Mapping[str, object]:
    loaded = json.loads(Path(path).read_text())
    if not isinstance(loaded, Mapping):
        raise ValueError(f'{path} must contain a JSON object')
    return cast(Mapping[str, object], loaded)


def _read_status_url(url: str, timeout: float) -> Mapping[str, object]:
    request = urllib.request.Request(url, method='GET')
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - bounded explicit URL is user supplied.
        loaded = json.loads(response.read().decode('utf-8'))
    if not isinstance(loaded, Mapping):
        raise ValueError(f'{url} returned a non-object JSON payload')
    return cast(Mapping[str, object], loaded)


def _merge_inputs(base: Mapping[str, object], overrides: Mapping[str, Mapping[str, object]]) -> dict[str, object]:
    merged: dict[str, object] = dict(base)
    for key, value in overrides.items():
        if value:
            merged[key] = dict(value)
    return merged


def _target_matches(candidate: Mapping[str, object], expectations: AuditExpectations) -> bool:
    candidate_id = _text(candidate.get('candidate_id') or candidate.get('target_candidate_id'))
    hypothesis_id = _text(candidate.get('hypothesis_id') or candidate.get('hypothesis'))
    runtime_strategy = _text(
        candidate.get('runtime_strategy_name')
        or candidate.get('runtime_strategy')
        or candidate.get('strategy_name')
        or candidate.get('strategy')
    )
    if candidate_id == expectations.candidate_id:
        return True
    if hypothesis_id == expectations.hypothesis_id and runtime_strategy in (None, expectations.runtime_strategy):
        return True
    return False


def _first_mapping_from_keys(source: Mapping[str, object], keys: Sequence[str]) -> Mapping[str, object]:
    for key in keys:
        candidate = _mapping(source.get(key))
        if candidate:
            return candidate
    return {}


def _target_from_source(source: Mapping[str, object], expectations: AuditExpectations) -> Mapping[str, object]:
    target = _first_mapping_from_keys(source, ('target', 'target_candidate', 'target_candidate_identity'))
    if target:
        return target
    for key in ('targets', 'planned_targets', 'target_candidates', 'source_targets'):
        sequence = _sequence(source.get(key))
        mappings = [_mapping(item) for item in sequence]
        for candidate in mappings:
            if candidate and _target_matches(candidate, expectations):
                return candidate
        for candidate in mappings:
            if candidate:
                return candidate
    return {}


def _candidate_identity(target: Mapping[str, object], expectations: AuditExpectations) -> dict[str, object]:
    observed = {
        'hypothesis_id': _text(target.get('hypothesis_id') or target.get('hypothesis')),
        'candidate_id': _text(target.get('candidate_id') or target.get('target_candidate_id')),
        'account_label': _text(target.get('account_label') or target.get('account')),
        'observed_stage': _text(target.get('observed_stage') or target.get('stage') or target.get('evidence_collection_stage')),
        'runtime_strategy': _text(
            target.get('runtime_strategy_name')
            or target.get('runtime_strategy')
            or target.get('strategy_name')
            or target.get('strategy')
        ),
    }
    expected = {
        'hypothesis_id': expectations.hypothesis_id,
        'candidate_id': expectations.candidate_id,
        'account_label': expectations.account_label,
        'observed_stage': expectations.observed_stage,
        'runtime_strategy': expectations.runtime_strategy,
    }
    matches = {
        key: observed_value == expected[key]
        for key, observed_value in observed.items()
        if observed_value is not None
    }
    missing = sorted(key for key, value in observed.items() if value is None)
    return {
        'materialized': bool(target),
        'expected': expected,
        'observed': observed,
        'matches': matches,
        'missing_fields': missing,
    }


def _symbols_from_target(target: Mapping[str, object]) -> list[str]:
    symbols: list[str] = []
    for key in ('symbols', 'symbol_universe', 'required_symbols', 'pair_symbols', 'legs'):
        raw_value = target.get(key)
        if isinstance(raw_value, Mapping):
            symbols.extend(str(symbol) for symbol in raw_value.keys())
        else:
            for item in _sequence(raw_value):
                if isinstance(item, Mapping):
                    symbol = _text(item.get('symbol') or item.get('ticker'))
                    if symbol is not None:
                        symbols.append(symbol)
                else:
                    symbol = _text(item)
                    if symbol is not None:
                        symbols.append(symbol)
    for key in ('symbol', 'primary_symbol', 'secondary_symbol', 'long_symbol', 'short_symbol'):
        symbol = _text(target.get(key))
        if symbol is not None:
            symbols.append(symbol)
    return _normalize_symbols(symbols)


def _normalize_symbols(symbols: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for symbol in symbols:
        item = symbol.strip().upper()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return sorted(normalized)


def _symbol_payload(container: Mapping[str, object]) -> Mapping[str, object]:
    explicit = _mapping(container.get('symbols'))
    if explicit:
        return explicit
    latest = _mapping(container.get('latest'))
    latest_symbols = _mapping(latest.get('symbols'))
    if latest_symbols:
        return latest_symbols
    by_symbol = _mapping(container.get('by_symbol'))
    if by_symbol:
        return by_symbol
    return {}


def _availability_for_symbol(
    symbol: str,
    payload: Mapping[str, object],
    max_age_seconds: float,
    *,
    quote_mode: bool,
) -> tuple[bool, dict[str, object]]:
    raw = payload.get(symbol) or payload.get(symbol.lower()) or payload.get(symbol.upper())
    details = _mapping(raw)
    ready = _bool_or_none(details.get('ready'))
    for key in _MARKET_DATA_READY_KEYS:
        value = _bool_or_none(details.get(key))
        if value is not None:
            ready = value
            break
    age_seconds = _float_or_none(details.get('age_seconds') or details.get('staleness_seconds'))
    if ready is None:
        ready = bool(details)
    if quote_mode and details:
        bid = _float_or_none(details.get('bid') or details.get('bid_price'))
        ask = _float_or_none(details.get('ask') or details.get('ask_price'))
        if bid is not None and ask is not None and (bid <= 0.0 or ask <= 0.0 or bid > ask):
            ready = False
    if age_seconds is not None and age_seconds > max_age_seconds:
        ready = False
    return ready, {
        'available': bool(details),
        'ready': ready,
        'age_seconds': age_seconds,
        'timestamp': _text(details.get('timestamp') or details.get('as_of') or details.get('updated_at')),
    }


def _availability_report(
    container: Mapping[str, object],
    symbols: Sequence[str],
    *,
    max_age_seconds: float,
    quote_mode: bool,
) -> dict[str, object]:
    payload = _symbol_payload(container)
    available_symbols = _normalize_symbols(str(key) for key in payload.keys())
    evaluated_symbols = list(symbols) or available_symbols
    by_symbol: dict[str, object] = {}
    missing_symbols: list[str] = []
    stale_symbols: list[str] = []
    not_ready_symbols: list[str] = []
    for symbol in evaluated_symbols:
        ready, details = _availability_for_symbol(
            symbol,
            payload,
            max_age_seconds,
            quote_mode=quote_mode,
        )
        by_symbol[symbol] = details
        if not bool(details['available']):
            missing_symbols.append(symbol)
        elif not ready:
            not_ready_symbols.append(symbol)
            if details.get('age_seconds') is not None:
                stale_symbols.append(symbol)
    return {
        'ready': bool(evaluated_symbols) and not missing_symbols and not not_ready_symbols,
        'symbols_evaluated': evaluated_symbols,
        'available_symbols': available_symbols,
        'missing_symbols': missing_symbols,
        'stale_symbols': stale_symbols,
        'not_ready_symbols': not_ready_symbols,
        'by_symbol': by_symbol,
        'latest_timestamp': _text(
            container.get('latest_timestamp')
            or container.get('timestamp')
            or _mapping(container.get('latest')).get('timestamp')
        ),
    }


def _signal_threshold_report(signal: Mapping[str, object]) -> dict[str, object]:
    score = _float_or_none(
        signal.get('entry_score')
        or signal.get('score')
        or signal.get('signal')
        or signal.get('entry_signal')
        or signal.get('zscore')
    )
    threshold = _float_or_none(
        signal.get('entry_threshold')
        or signal.get('threshold')
        or signal.get('min_entry_score')
        or signal.get('abs_entry_zscore_threshold')
    )
    margin = None if score is None or threshold is None else abs(score) - threshold
    explicit_pass = _bool_or_none(
        signal.get('passes_threshold')
        or signal.get('threshold_passed')
        or signal.get('entry_signal_ready')
    )
    passes = explicit_pass if explicit_pass is not None else (None if margin is None else margin >= 0.0)
    return {
        'score': score,
        'threshold': threshold,
        'margin': margin,
        'passes': passes,
        'direction': _text(signal.get('direction') or signal.get('side') or signal.get('entry_side')),
        'missing_inputs': [
            key
            for key, value in (('score', score), ('threshold', threshold))
            if value is None and explicit_pass is None
        ],
    }


def _veto_report(target: Mapping[str, object], signal: Mapping[str, object], risk: Mapping[str, object]) -> dict[str, object]:
    entry_vetoes = _unique_text_items(target.get('entry_vetoes'))
    entry_vetoes.extend(_unique_text_items(signal.get('entry_vetoes')))
    exit_vetoes = _unique_text_items(target.get('exit_vetoes'))
    exit_vetoes.extend(_unique_text_items(signal.get('exit_vetoes')))
    risk_vetoes = _unique_text_items(risk.get('vetoes') or risk.get('risk_vetoes') or risk.get('blockers'))
    if _bool_or_none(risk.get('risk_veto') or risk.get('vetoed')) is True and not risk_vetoes:
        risk_vetoes.append('risk_veto')
    return {
        'entry_vetoes': sorted(set(entry_vetoes)),
        'exit_vetoes': sorted(set(exit_vetoes)),
        'risk_vetoes': sorted(set(risk_vetoes)),
        'has_risk_veto': bool(risk_vetoes),
    }


def _nested_flag_containers(container: Mapping[str, object]) -> list[Mapping[str, object]]:
    containers = [container]
    for key in ('simple_lane', 'live_submission_gate', 'submission_gate', 'submit_gate', 'gate'):
        nested = _mapping(container.get(key))
        if nested:
            containers.extend(_nested_flag_containers(nested))
    return containers


def _flag_report(containers: Sequence[Mapping[str, object]], keys: Sequence[str]) -> dict[str, object]:
    observed: dict[str, object] = {}
    disabled: list[str] = []
    enabled: list[str] = []
    for root_container in containers:
        for container in _nested_flag_containers(root_container):
            for key in keys:
                if key not in container or key in observed:
                    continue
                value = _bool_or_none(container.get(key))
                if value is None:
                    observed[key] = container.get(key)
                    continue
                observed[key] = value
                if value:
                    enabled.append(key)
                else:
                    disabled.append(key)
    return {
        'observed': observed,
        'enabled_flags': sorted(enabled),
        'disabled_flags': sorted(disabled),
        'eligible': not disabled,
        'observed_any': bool(observed),
    }


def _choose_next_action(blocker_codes: Sequence[str], unsupported: bool) -> str:
    blockers = set(blocker_codes)
    if 'target_missing' in blockers:
        return 'no_target'
    if blockers.intersection({'account_label_mismatch', 'observed_stage_mismatch', 'runtime_strategy_mismatch'}):
        return 'wrong_account'
    if blockers.intersection({'latest_features_missing', 'latest_quotes_missing', 'latest_features_not_ready', 'latest_quotes_not_ready'}):
        return 'no_market_data'
    if 'signal_below_threshold' in blockers:
        return 'signal_below_threshold'
    if blockers.intersection({'risk_veto', 'entry_veto_present', 'exit_veto_present'}):
        return 'risk_veto'
    if blockers.intersection({'route_disabled', 'simple_submit_disabled'}):
        return 'route_disabled'
    if 'evidence_collection_disabled' in blockers:
        return 'evidence_collection_disabled'
    if unsupported:
        return 'unsupported_inputs'
    return 'ready_to_submit_sim_order'


def build_liveness_report(source: Mapping[str, object], expectations: AuditExpectations) -> dict[str, object]:
    target = _target_from_source(source, expectations)
    status = _first_mapping_from_keys(source, ('status', 'service_status', 'runtime_status'))
    features = _first_mapping_from_keys(source, ('features', 'latest_features', 'feature_status'))
    quotes = _first_mapping_from_keys(source, ('quotes', 'latest_quotes', 'quote_status', 'market_data'))
    signal = _first_mapping_from_keys(source, ('signal', 'signals', 'signal_status'))
    route = _first_mapping_from_keys(source, ('route', 'route_eligibility', 'route_status'))
    risk = _first_mapping_from_keys(source, ('risk', 'risk_status', 'risk_veto'))

    identity = _candidate_identity(target, expectations)
    symbols = _symbols_from_target(target)
    if not symbols:
        symbols = _normalize_symbols(str(key) for key in _symbol_payload(features).keys())
    if not symbols:
        symbols = _normalize_symbols(str(key) for key in _symbol_payload(quotes).keys())

    feature_report = _availability_report(
        features,
        symbols,
        max_age_seconds=expectations.max_feature_age_seconds,
        quote_mode=False,
    )
    quote_report = _availability_report(
        quotes,
        symbols,
        max_age_seconds=expectations.max_quote_age_seconds,
        quote_mode=True,
    )
    signal_report = _signal_threshold_report(signal)
    vetoes = _veto_report(target, signal, risk)
    route_flags = _flag_report((target, status, route), _ROUTE_FLAG_KEYS)
    evidence_flags = _flag_report((target, status, route), _EVIDENCE_COLLECTION_KEYS)
    submit_flags = _flag_report((status, route, target), _SIMPLE_SUBMIT_KEYS)

    blocker_codes: list[str] = []
    if not target:
        blocker_codes.append('target_missing')
    observed = _mapping(identity['observed'])
    if observed.get('account_label') not in (None, expectations.account_label):
        blocker_codes.append('account_label_mismatch')
    if observed.get('observed_stage') not in (None, expectations.observed_stage):
        blocker_codes.append('observed_stage_mismatch')
    if observed.get('runtime_strategy') not in (None, expectations.runtime_strategy):
        blocker_codes.append('runtime_strategy_mismatch')
    if not features:
        blocker_codes.append('latest_features_missing')
    elif not bool(feature_report['ready']):
        blocker_codes.append('latest_features_not_ready')
    if not quotes:
        blocker_codes.append('latest_quotes_missing')
    elif not bool(quote_report['ready']):
        blocker_codes.append('latest_quotes_not_ready')
    if signal_report['passes'] is False:
        blocker_codes.append('signal_below_threshold')
    if vetoes['entry_vetoes']:
        blocker_codes.append('entry_veto_present')
    if vetoes['exit_vetoes']:
        blocker_codes.append('exit_veto_present')
    if vetoes['has_risk_veto']:
        blocker_codes.append('risk_veto')
    if route_flags['disabled_flags']:
        blocker_codes.append('route_disabled')
    if submit_flags['disabled_flags']:
        blocker_codes.append('simple_submit_disabled')
    if evidence_flags['disabled_flags']:
        blocker_codes.append('evidence_collection_disabled')

    explicit_blockers = _unique_text_items(source.get('blockers'))
    explicit_blockers.extend(_unique_text_items(status.get('blockers') or status.get('blocked_reasons')))
    for nested_status in _nested_flag_containers(status):
        explicit_blockers.extend(_unique_text_items(nested_status.get('blockers') or nested_status.get('blocked_reasons')))
    explicit_blockers.extend(_unique_text_items(target.get('blockers')))
    explicit_blockers.extend(_unique_text_items(route.get('blockers')))
    blocker_codes.extend(explicit_blockers)

    unsupported = False
    unsupported_reasons: list[str] = []
    if signal_report['passes'] is None:
        unsupported = True
        unsupported_reasons.extend(cast(list[str], signal_report['missing_inputs']))
        blocker_codes.append('unsupported_signal_threshold_inputs')
    if not symbols and target:
        unsupported = True
        unsupported_reasons.append('symbol_universe')
        blocker_codes.append('unsupported_symbol_universe_inputs')

    blocker_codes = sorted(set(blocker_codes))
    next_action = _choose_next_action(blocker_codes, unsupported)
    ready = next_action == 'ready_to_submit_sim_order'
    human_verdict = (
        'H-PAIRS liveness READY: target can submit a TORGHUT_SIM paper order.'
        if ready
        else f'H-PAIRS liveness BLOCKED: next_action={next_action}; blockers={",".join(blocker_codes)}.'
    )

    return {
        'schema_version': HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION,
        'read_only': True,
        'target_candidate_identity': identity,
        'account_stage_runtime_strategy': {
            'account_label': observed.get('account_label'),
            'observed_stage': observed.get('observed_stage'),
            'runtime_strategy': observed.get('runtime_strategy'),
            'expected_account_label': expectations.account_label,
            'expected_observed_stage': expectations.observed_stage,
            'expected_runtime_strategy': expectations.runtime_strategy,
        },
        'symbol_universe': {
            'symbols': symbols,
            'count': len(symbols),
        },
        'latest_feature_availability': feature_report,
        'latest_quote_availability': quote_report,
        'signal_threshold_status': signal_report,
        'entry_exit_vetoes': vetoes,
        'route_eligibility_flags': route_flags,
        'simple_submit_flag_state': submit_flags,
        'evidence_collection_flags': evidence_flags,
        'blocker_codes': blocker_codes,
        'unsupported_reasons': sorted(set(unsupported_reasons)),
        'next_action': next_action,
        'ready_to_submit_sim_order': ready,
        'human_verdict': human_verdict,
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-json', '--input-json', dest='fixture_json')
    parser.add_argument('--target-json')
    parser.add_argument('--status-json')
    parser.add_argument('--features-json')
    parser.add_argument('--quotes-json')
    parser.add_argument('--signal-json')
    parser.add_argument('--route-json')
    parser.add_argument('--risk-json')
    parser.add_argument('--status-url', help='optional bounded read-only HTTP GET that returns status JSON')
    parser.add_argument('--http-timeout-seconds', type=float, default=2.0)
    parser.add_argument('--hypothesis-id', default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument('--candidate-id', default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument('--account-label', default=DEFAULT_HPAIRS_ACCOUNT_LABEL)
    parser.add_argument('--observed-stage', default=DEFAULT_OBSERVED_STAGE)
    parser.add_argument('--runtime-strategy-name', default=DEFAULT_HPAIRS_RUNTIME_STRATEGY)
    parser.add_argument('--max-quote-age-seconds', type=float, default=90.0)
    parser.add_argument('--max-feature-age-seconds', type=float, default=180.0)
    parser.add_argument(
        '--fail-on-blockers',
        action='store_true',
        help='exit non-zero when the diagnostic next_action is not ready_to_submit_sim_order',
    )
    return parser.parse_args(list(argv))


def _load_cli_source(args: argparse.Namespace) -> Mapping[str, object]:
    source: Mapping[str, object] = _read_json_path(args.fixture_json) if args.fixture_json else {}
    overrides: dict[str, Mapping[str, object]] = {}
    for key, attr in (
        ('target', 'target_json'),
        ('status', 'status_json'),
        ('features', 'features_json'),
        ('quotes', 'quotes_json'),
        ('signal', 'signal_json'),
        ('route', 'route_json'),
        ('risk', 'risk_json'),
    ):
        value = getattr(args, attr)
        if value:
            overrides[key] = _read_json_path(value)
    if args.status_url:
        overrides['status'] = _read_status_url(args.status_url, args.http_timeout_seconds)
    return _merge_inputs(source, overrides)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    expectations = AuditExpectations(
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        account_label=args.account_label,
        observed_stage=args.observed_stage,
        runtime_strategy=args.runtime_strategy_name,
        max_quote_age_seconds=args.max_quote_age_seconds,
        max_feature_age_seconds=args.max_feature_age_seconds,
    )
    try:
        source = _load_cli_source(args)
        report = build_liveness_report(source, expectations)
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
        report = {
            'schema_version': HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION,
            'read_only': True,
            'next_action': 'unsupported_inputs',
            'ready_to_submit_sim_order': False,
            'blocker_codes': ['unsupported_input_read_error'],
            'human_verdict': f'H-PAIRS liveness BLOCKED: next_action=unsupported_inputs; error={exc}.',
            'error': str(exc),
        }
    sys.stdout.write(stable_json(report))
    sys.stderr.write(str(report['human_verdict']) + '\n')
    if args.fail_on_blockers and report.get('next_action') != 'ready_to_submit_sim_order':
        return 1
    return 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())

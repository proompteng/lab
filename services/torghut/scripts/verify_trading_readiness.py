#!/usr/bin/env python
"""Verify Torghut trading readiness from a `/trading/status` payload."""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast
from urllib.request import urlopen


SCHEMA_VERSION = 'torghut.trading-readiness-verification.v1'
ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION = 'torghut.route-reacquisition-board.v1'
_MISSING_QUANT_REASONS = {
    'quant_health_fetch_failed',
    'quant_health_missing',
    'quant_latest_metrics_empty',
    'quant_latest_store_alarm',
    'quant_pipeline_stages_missing',
}


def _text(value: object, default: str = '') -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {'1', 'true', 'yes', 'y', 'open'}
    return False


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise ValueError(f'json_object_required:{path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_status_url(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    with urlopen(url, timeout=timeout_seconds) as response:
        payload = json.loads(response.read().decode('utf-8'))
    if not isinstance(payload, Mapping):
        raise ValueError(f'json_object_required:{url}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _dimension_by_name(proof_floor: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    dimensions: dict[str, Mapping[str, Any]] = {}
    for raw_dimension in _sequence(proof_floor.get('proof_dimensions')):
        dimension = _mapping(raw_dimension)
        name = _text(dimension.get('dimension'))
        if name:
            dimensions[name] = dimension
    return dimensions


def _market_session_open(status: Mapping[str, Any], proof_floor: Mapping[str, Any]) -> bool:
    metrics = _mapping(status.get('metrics'))
    if 'market_session_open' in metrics:
        return _bool(metrics.get('market_session_open'))
    market_window = _mapping(proof_floor.get('market_window'))
    return _bool(market_window.get('session_open'))


def _add_check(
    checks: dict[str, dict[str, Any]],
    key: str,
    *,
    passed: bool,
    observed: object,
    expected: object,
    detail: object | None = None,
) -> None:
    payload: dict[str, Any] = {
        'passed': passed,
        'observed': observed,
        'expected': expected,
    }
    if detail is not None:
        payload['detail'] = detail
    checks[key] = payload


def _expected_floor_states(profile: str) -> tuple[set[str], set[str], set[str]]:
    if profile == 'paper':
        return {'paper_ready'}, {'paper_candidate'}, {'paper_allowed'}
    if profile == 'live':
        return (
            {'live_micro_ready', 'live_scale_ready'},
            {'live_micro_candidate', 'live_scale_candidate'},
            {'live_allowed'},
        )
    return (
        {'paper_ready', 'live_micro_ready', 'live_scale_ready'},
        {'paper_candidate', 'live_micro_candidate', 'live_scale_candidate'},
        {'paper_allowed', 'live_allowed'},
    )


def evaluate_trading_readiness(
    status: Mapping[str, Any],
    *,
    profile: str = 'paper',
    min_routeable_symbols: int = 2,
    min_decisions: int = 0,
    min_orders: int = 0,
    require_market_open: bool = True,
    require_quant_fresh: bool = True,
) -> dict[str, Any]:
    """Return a strict readiness verdict from a Torghut trading status payload."""

    checks: dict[str, dict[str, Any]] = {}
    metrics = _mapping(status.get('metrics'))
    proof_floor = _mapping(status.get('proof_floor'))
    dimensions = _dimension_by_name(proof_floor)

    mode = _text(status.get('mode') or status.get('trading_mode')).lower()
    if profile in {'paper', 'live'}:
        _add_check(
            checks,
            'trading_mode',
            passed=mode == profile,
            observed=mode,
            expected=profile,
        )

    _add_check(
        checks,
        'scheduler_running',
        passed=_bool(status.get('running')),
        observed=status.get('running'),
        expected=True,
    )
    last_error = _text(status.get('last_error'))
    _add_check(
        checks,
        'last_error_clear',
        passed=not last_error,
        observed=last_error or None,
        expected=None,
    )
    _add_check(
        checks,
        'proof_floor_present',
        passed=bool(proof_floor),
        observed=bool(proof_floor),
        expected=True,
    )

    market_open = _market_session_open(status, proof_floor)
    if require_market_open:
        _add_check(
            checks,
            'market_session_open',
            passed=market_open,
            observed=market_open,
            expected=True,
        )

    floor_states, route_states, capital_states = _expected_floor_states(profile)
    floor_state = _text(proof_floor.get('floor_state'))
    route_state = _text(proof_floor.get('route_state'))
    capital_state = _text(proof_floor.get('capital_state'))
    max_notional = _decimal(proof_floor.get('max_notional'))
    blocking_reasons = [
        _text(reason)
        for reason in _sequence(proof_floor.get('blocking_reasons'))
        if _text(reason)
    ]
    _add_check(
        checks,
        'proof_floor_state',
        passed=floor_state in floor_states,
        observed=floor_state,
        expected=sorted(floor_states),
    )
    _add_check(
        checks,
        'route_state',
        passed=route_state in route_states,
        observed=route_state,
        expected=sorted(route_states),
    )
    _add_check(
        checks,
        'capital_state',
        passed=capital_state in capital_states,
        observed=capital_state,
        expected=sorted(capital_states),
    )
    _add_check(
        checks,
        'max_notional_positive',
        passed=max_notional is not None and max_notional > 0,
        observed=str(proof_floor.get('max_notional')),
        expected='>0',
    )
    _add_check(
        checks,
        'blocking_reasons_empty',
        passed=not blocking_reasons,
        observed=blocking_reasons,
        expected=[],
    )

    for dimension_name in ('alpha_readiness', 'execution_tca', 'market_context'):
        dimension = dimensions.get(dimension_name, {})
        state = _text(dimension.get('state'))
        _add_check(
            checks,
            f'{dimension_name}_pass',
            passed=state == 'pass',
            observed={'state': state, 'reason': dimension.get('reason')},
            expected={'state': 'pass'},
        )

    quant_dimension = dimensions.get('quant_ingestion', {})
    quant_state = _text(quant_dimension.get('state'))
    quant_reason = _text(quant_dimension.get('reason'))
    quant_passed = quant_state == 'pass' or (
        not require_quant_fresh and quant_state == 'informational'
    )
    if require_quant_fresh and quant_reason in _MISSING_QUANT_REASONS:
        quant_passed = False
    _add_check(
        checks,
        'quant_ingestion_ready',
        passed=quant_passed,
        observed={'state': quant_state, 'reason': quant_reason},
        expected={'state': 'pass'} if require_quant_fresh else {'state': 'pass|informational'},
    )

    tca_source_ref = _mapping(dimensions.get('execution_tca', {}).get('source_ref'))
    symbol_routes = _mapping(tca_source_ref.get('symbol_routes'))
    routeable_symbol_count = _int(symbol_routes.get('routeable_symbol_count'))
    blocked_symbol_count = _int(symbol_routes.get('blocked_symbol_count'))
    missing_symbol_count = _int(symbol_routes.get('missing_symbol_count'))
    _add_check(
        checks,
        'routeable_symbol_count',
        passed=routeable_symbol_count >= min_routeable_symbols,
        observed=routeable_symbol_count,
        expected=f'>={min_routeable_symbols}',
        detail={
            'routeable_symbols': symbol_routes.get('routeable_symbols') or [],
            'scope_symbols': symbol_routes.get('scope_symbols') or [],
        },
    )
    _add_check(
        checks,
        'blocked_symbol_count',
        passed=blocked_symbol_count == 0,
        observed=blocked_symbol_count,
        expected=0,
        detail=symbol_routes.get('blocked_symbols') or [],
    )
    _add_check(
        checks,
        'missing_symbol_count',
        passed=missing_symbol_count == 0,
        observed=missing_symbol_count,
        expected=0,
        detail=symbol_routes.get('missing_symbols') or [],
    )

    route_board = _mapping(status.get('route_reacquisition_board'))
    route_board_summary = _mapping(route_board.get('summary'))
    route_board_capital_eligible_symbols = _int(
        route_board_summary.get('capital_eligible_symbol_count')
    )
    route_board_zero_notional_rows = _int(
        route_board_summary.get('zero_notional_row_count')
    )
    _add_check(
        checks,
        'route_reacquisition_board_present',
        passed=bool(route_board),
        observed=bool(route_board),
        expected=True,
    )
    _add_check(
        checks,
        'route_board_schema_version',
        passed=_text(route_board.get('schema_version'))
        == ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
        observed=_text(route_board.get('schema_version')),
        expected=ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
    )
    _add_check(
        checks,
        'route_board_capital_eligible_symbols',
        passed=route_board_capital_eligible_symbols >= min_routeable_symbols,
        observed=route_board_capital_eligible_symbols,
        expected=f'>={min_routeable_symbols}',
        detail=route_board_summary,
    )
    _add_check(
        checks,
        'route_board_zero_notional_rows',
        passed=route_board_zero_notional_rows == 0,
        observed=route_board_zero_notional_rows,
        expected=0,
        detail=route_board_summary,
    )

    decisions_total = _int(metrics.get('decisions_total'))
    orders_submitted_total = _int(metrics.get('orders_submitted_total'))
    _add_check(
        checks,
        'decisions_total',
        passed=decisions_total >= min_decisions,
        observed=decisions_total,
        expected=f'>={min_decisions}',
    )
    _add_check(
        checks,
        'orders_submitted_total',
        passed=orders_submitted_total >= min_orders,
        observed=orders_submitted_total,
        expected=f'>={min_orders}',
    )

    failed_checks = [key for key, value in checks.items() if not value['passed']]
    return {
        'schema_version': SCHEMA_VERSION,
        'ok': not failed_checks,
        'profile': profile,
        'failed_checks': failed_checks,
        'checks': checks,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--status-file', type=Path, help='Path to a /trading/status JSON payload.')
    source.add_argument('--status-url', help='URL returning a /trading/status JSON payload.')
    parser.add_argument('--profile', choices=('paper', 'live', 'either'), default='paper')
    parser.add_argument('--min-routeable-symbols', type=int, default=2)
    parser.add_argument('--min-decisions', type=int, default=0)
    parser.add_argument('--min-orders', type=int, default=0)
    parser.add_argument('--allow-closed-session', action='store_true')
    parser.add_argument('--allow-informational-quant', action='store_true')
    parser.add_argument('--timeout-seconds', type=float, default=10.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    status = (
        _load_json_object(args.status_file)
        if args.status_file is not None
        else _load_status_url(str(args.status_url), timeout_seconds=args.timeout_seconds)
    )
    result = evaluate_trading_readiness(
        status,
        profile=str(args.profile),
        min_routeable_symbols=max(0, int(args.min_routeable_symbols)),
        min_decisions=max(0, int(args.min_decisions)),
        min_orders=max(0, int(args.min_orders)),
        require_market_open=not bool(args.allow_closed_session),
        require_quant_fresh=not bool(args.allow_informational_quant),
    )
    result['evaluated_at'] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

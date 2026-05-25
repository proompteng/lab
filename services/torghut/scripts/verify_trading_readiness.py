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
ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION = 'torghut.route-reacquisition-book.v1'
DOC29_LIVE_SCALE_GATE = 'live_scale_observed'
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


def _decimal_positive(value: object) -> bool:
    parsed = _decimal(value)
    return parsed is not None and parsed > 0


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


def _load_optional_json_object(
    *,
    path: Path | None,
    url: str | None,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    if path is not None:
        return _load_json_object(path)
    if url:
        return _load_status_url(url, timeout_seconds=timeout_seconds)
    return None


def _dimension_by_name(proof_floor: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    dimensions: dict[str, Mapping[str, Any]] = {}
    for raw_dimension in _sequence(proof_floor.get('proof_dimensions')):
        dimension = _mapping(raw_dimension)
        name = _text(dimension.get('dimension'))
        if name:
            dimensions[name] = dimension
    return dimensions


def _dimension_is_required(dimension: Mapping[str, Any]) -> bool:
    source_ref = _mapping(dimension.get('source_ref'))
    if 'required' in source_ref:
        return _bool(source_ref.get('required'))
    if 'evidence_required' in source_ref:
        return _bool(source_ref.get('evidence_required'))
    return True


def _market_session_open(
    status: Mapping[str, Any], proof_floor: Mapping[str, Any]
) -> bool:
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


def _paper_route_probe_summary(
    status: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
) -> dict[str, Any]:
    route_book = _mapping(status.get('route_reacquisition_book')) or _mapping(
        proof_floor.get('route_reacquisition_book')
    )
    route_summary = _mapping(route_book.get('summary'))
    probe = _mapping(route_book.get('paper_route_probe'))
    eligible_symbols = _sequence(probe.get('eligible_symbols')) or _sequence(
        route_summary.get('paper_route_probe_eligible_symbols')
    )
    active_symbols = _sequence(probe.get('active_symbols')) or _sequence(
        route_summary.get('paper_route_probe_active_symbols')
    )
    return {
        'route_book_present': bool(route_book),
        'route_book_schema_version': _text(route_book.get('schema_version')),
        'configured_enabled': _bool(probe.get('configured_enabled')),
        'configured_max_notional': _text(probe.get('configured_max_notional'), '0'),
        'active': _bool(probe.get('active')),
        'effective_max_notional': _text(probe.get('effective_max_notional'), '0'),
        'next_session_max_notional': _text(probe.get('next_session_max_notional'), '0'),
        'eligible_symbol_count': _int(
            probe.get('eligible_symbol_count'), default=len(eligible_symbols)
        ),
        'eligible_symbols': [
            _text(symbol) for symbol in eligible_symbols if _text(symbol)
        ],
        'active_symbols': [_text(symbol) for symbol in active_symbols if _text(symbol)],
        'blocking_reasons': [
            _text(reason)
            for reason in _sequence(probe.get('blocking_reasons'))
            if _text(reason)
        ],
        'capital_authority': _text(probe.get('capital_authority'), 'none'),
    }


def _completion_gate(
    completion_status: Mapping[str, Any], gate_id: str
) -> Mapping[str, Any]:
    for raw_gate in _sequence(completion_status.get('gates')):
        gate = _mapping(raw_gate)
        if _text(gate.get('gate_id')) == gate_id:
            return gate
    return {}


def _runtime_ledger_summary(gate: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(gate.get('runtime_ledger_summary'))


def _runtime_ledger_refs(gate: Mapping[str, Any], key: str) -> Sequence[object]:
    refs = _mapping(gate.get('db_row_refs'))
    return _sequence(refs.get(key))


def _add_runtime_ledger_profit_proof_checks(
    checks: dict[str, dict[str, Any]],
    *,
    completion_status: Mapping[str, Any] | None,
    min_runtime_ledger_net_pnl: Decimal,
) -> None:
    completion_present = completion_status is not None
    _add_check(
        checks,
        'completion_status_present',
        passed=completion_present,
        observed=completion_present,
        expected=True,
    )
    if completion_status is None:
        return

    gate = _completion_gate(completion_status, DOC29_LIVE_SCALE_GATE)
    summary = _runtime_ledger_summary(gate)
    ledger_refs = _runtime_ledger_refs(gate, 'strategy_runtime_ledger_buckets')
    unbacked_refs = _runtime_ledger_refs(
        gate,
        'runtime_ledger_unbacked_hypothesis_metric_windows',
    )
    gate_status = _text(gate.get('status'))
    blocked_reason = _text(gate.get('blocked_reason'))
    _add_check(
        checks,
        'doc29_live_scale_gate_satisfied',
        passed=gate_status == 'satisfied' and not blocked_reason,
        observed={'status': gate_status, 'blocked_reason': blocked_reason or None},
        expected={'status': 'satisfied', 'blocked_reason': None},
    )
    _add_check(
        checks,
        'runtime_ledger_db_refs_present',
        passed=len(ledger_refs) > 0,
        observed=len(ledger_refs),
        expected='>0',
        detail=list(ledger_refs),
    )
    _add_check(
        checks,
        'runtime_ledger_unbacked_windows_empty',
        passed=len(unbacked_refs) == 0,
        observed=len(unbacked_refs),
        expected=0,
        detail=list(unbacked_refs),
    )
    _add_check(
        checks,
        'runtime_ledger_bucket_count',
        passed=_int(summary.get('runtime_ledger_bucket_count')) > 0,
        observed=summary.get('runtime_ledger_bucket_count'),
        expected='>0',
    )
    _add_check(
        checks,
        'runtime_ledger_fill_count',
        passed=_int(summary.get('runtime_ledger_fill_count')) > 0,
        observed=summary.get('runtime_ledger_fill_count'),
        expected='>0',
    )
    _add_check(
        checks,
        'runtime_ledger_closed_trade_count',
        passed=_int(summary.get('runtime_ledger_closed_trade_count')) > 0,
        observed=summary.get('runtime_ledger_closed_trade_count'),
        expected='>0',
    )
    _add_check(
        checks,
        'runtime_ledger_filled_notional',
        passed=_decimal_positive(summary.get('runtime_ledger_filled_notional')),
        observed=summary.get('runtime_ledger_filled_notional'),
        expected='>0',
    )
    net_pnl = _decimal(summary.get('runtime_ledger_net_strategy_pnl_after_costs'))
    _add_check(
        checks,
        'runtime_ledger_net_pnl_target',
        passed=net_pnl is not None and net_pnl >= min_runtime_ledger_net_pnl,
        observed=str(net_pnl) if net_pnl is not None else None,
        expected=f'>={min_runtime_ledger_net_pnl}',
    )
    _add_check(
        checks,
        'runtime_ledger_post_cost_expectancy_positive',
        passed=_decimal_positive(
            summary.get('runtime_ledger_post_cost_expectancy_bps')
        ),
        observed=summary.get('runtime_ledger_post_cost_expectancy_bps'),
        expected='>0',
    )


def evaluate_trading_readiness(
    status: Mapping[str, Any],
    *,
    completion_status: Mapping[str, Any] | None = None,
    profile: str = 'paper',
    min_routeable_symbols: int = 2,
    min_decisions: int = 0,
    min_orders: int = 0,
    min_runtime_ledger_net_pnl: Decimal = Decimal('0'),
    require_market_open: bool = True,
    require_quant_fresh: bool = True,
    require_paper_route_probe_candidate: bool = False,
    require_runtime_ledger_profit_proof: bool = False,
) -> dict[str, Any]:
    """Return a strict readiness verdict from a Torghut trading status payload."""

    checks: dict[str, dict[str, Any]] = {}
    metrics = _mapping(status.get('metrics'))
    proof_floor = _mapping(status.get('proof_floor'))
    dimensions = _dimension_by_name(proof_floor)
    paper_route_probe = _paper_route_probe_summary(status, proof_floor)

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
    quant_required = _dimension_is_required(quant_dimension)
    quant_passed = quant_state == 'pass' or (
        not require_quant_fresh
        and not quant_required
        and quant_state == 'informational'
    )
    if require_quant_fresh and quant_reason in _MISSING_QUANT_REASONS:
        quant_passed = False
    _add_check(
        checks,
        'quant_ingestion_ready',
        passed=quant_passed,
        observed={
            'state': quant_state,
            'reason': quant_reason,
            'required': quant_required,
        },
        expected={'state': 'pass'}
        if require_quant_fresh or quant_required
        else {'state': 'pass|optional_informational'},
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
    route_board_continuity = _mapping(route_board.get('jangar_continuity'))
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
    route_board_continuity_decision = _text(route_board_continuity.get('decision'))
    route_board_continuity_state = _text(route_board_continuity.get('state'))
    route_board_continuity_ready = (
        route_board_continuity_state == 'present'
        and route_board_continuity_decision == 'allow'
    )
    _add_check(
        checks,
        'route_board_jangar_continuity_ready',
        passed=route_board_continuity_ready,
        observed={
            'state': route_board_continuity_state,
            'decision': route_board_continuity_decision,
            'epoch_id': route_board_continuity.get('epoch_id'),
            'blocking_reasons': route_board_continuity.get('blocking_reasons') or [],
        },
        expected={'state': 'present', 'decision': 'allow'},
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

    if require_paper_route_probe_candidate:
        allowed_probe_blockers = (
            set() if require_market_open else {'market_session_closed'}
        )
        unexpected_probe_blockers = [
            reason
            for reason in paper_route_probe['blocking_reasons']
            if reason not in allowed_probe_blockers
        ]
        _add_check(
            checks,
            'paper_route_probe_book_present',
            passed=paper_route_probe['route_book_present'],
            observed=paper_route_probe['route_book_present'],
            expected=True,
        )
        _add_check(
            checks,
            'paper_route_probe_book_schema_version',
            passed=paper_route_probe['route_book_schema_version']
            == ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
            observed=paper_route_probe['route_book_schema_version'],
            expected=ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
        )
        _add_check(
            checks,
            'paper_route_probe_configured',
            passed=paper_route_probe['configured_enabled'],
            observed=paper_route_probe['configured_enabled'],
            expected=True,
        )
        _add_check(
            checks,
            'paper_route_probe_candidate_symbols',
            passed=paper_route_probe['eligible_symbol_count'] > 0,
            observed={
                'eligible_symbol_count': paper_route_probe['eligible_symbol_count'],
                'eligible_symbols': paper_route_probe['eligible_symbols'],
            },
            expected='>=1',
        )
        _add_check(
            checks,
            'paper_route_probe_notional_positive',
            passed=_decimal_positive(paper_route_probe['effective_max_notional'])
            or _decimal_positive(paper_route_probe['next_session_max_notional']),
            observed={
                'effective_max_notional': paper_route_probe['effective_max_notional'],
                'next_session_max_notional': paper_route_probe[
                    'next_session_max_notional'
                ],
            },
            expected='effective_or_next_session_>0',
        )
        _add_check(
            checks,
            'paper_route_probe_blockers',
            passed=not unexpected_probe_blockers,
            observed=paper_route_probe['blocking_reasons'],
            expected=sorted(allowed_probe_blockers),
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

    if require_runtime_ledger_profit_proof:
        _add_runtime_ledger_profit_proof_checks(
            checks,
            completion_status=completion_status,
            min_runtime_ledger_net_pnl=min_runtime_ledger_net_pnl,
        )

    failed_checks = [key for key, value in checks.items() if not value['passed']]
    return {
        'schema_version': SCHEMA_VERSION,
        'ok': not failed_checks,
        'profile': profile,
        'failed_checks': failed_checks,
        'checks': checks,
        'paper_route_probe': paper_route_probe,
        'completion_profit_proof': {
            'required': require_runtime_ledger_profit_proof,
            'gate_id': DOC29_LIVE_SCALE_GATE,
            'min_runtime_ledger_net_pnl': str(min_runtime_ledger_net_pnl),
        },
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        '--status-file', type=Path, help='Path to a /trading/status JSON payload.'
    )
    source.add_argument(
        '--status-url', help='URL returning a /trading/status JSON payload.'
    )
    completion_source = parser.add_mutually_exclusive_group(required=False)
    completion_source.add_argument(
        '--completion-file',
        type=Path,
        help='Path to a /trading/completion/doc29 JSON payload.',
    )
    completion_source.add_argument(
        '--completion-url',
        help='URL returning a /trading/completion/doc29 JSON payload.',
    )
    parser.add_argument(
        '--profile', choices=('paper', 'live', 'either'), default='paper'
    )
    parser.add_argument('--min-routeable-symbols', type=int, default=2)
    parser.add_argument('--min-decisions', type=int, default=0)
    parser.add_argument('--min-orders', type=int, default=0)
    parser.add_argument(
        '--min-runtime-ledger-net-pnl',
        default='0',
        help='Minimum runtime-ledger net strategy PnL after costs required when runtime proof is required.',
    )
    parser.add_argument('--allow-closed-session', action='store_true')
    parser.add_argument('--allow-informational-quant', action='store_true')
    parser.add_argument(
        '--require-paper-route-probe-candidate',
        action='store_true',
        help='Require a bounded paper-route probe candidate in route_reacquisition_book.',
    )
    parser.add_argument(
        '--require-runtime-ledger-profit-proof',
        action='store_true',
        help='Require doc29 live-scale runtime-ledger proof from /trading/completion/doc29.',
    )
    parser.add_argument('--timeout-seconds', type=float, default=10.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    status = (
        _load_json_object(args.status_file)
        if args.status_file is not None
        else _load_status_url(
            str(args.status_url), timeout_seconds=args.timeout_seconds
        )
    )
    completion_status = _load_optional_json_object(
        path=args.completion_file,
        url=args.completion_url,
        timeout_seconds=args.timeout_seconds,
    )
    min_runtime_ledger_net_pnl = _decimal(args.min_runtime_ledger_net_pnl)
    if min_runtime_ledger_net_pnl is None:
        raise SystemExit(
            f'--min-runtime-ledger-net-pnl must be decimal, got {args.min_runtime_ledger_net_pnl!r}'
        )
    result = evaluate_trading_readiness(
        status,
        completion_status=completion_status,
        profile=str(args.profile),
        min_routeable_symbols=max(0, int(args.min_routeable_symbols)),
        min_decisions=max(0, int(args.min_decisions)),
        min_orders=max(0, int(args.min_orders)),
        min_runtime_ledger_net_pnl=min_runtime_ledger_net_pnl,
        require_market_open=not bool(args.allow_closed_session),
        require_quant_fresh=not bool(args.allow_informational_quant),
        require_paper_route_probe_candidate=bool(
            args.require_paper_route_probe_candidate
        ),
        require_runtime_ledger_profit_proof=bool(
            args.require_runtime_ledger_profit_proof
        ),
    )
    result['evaluated_at'] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

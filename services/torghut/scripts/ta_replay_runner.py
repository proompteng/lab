#!/usr/bin/env python3
"""Execute the standardized Torghut TA replay rollout workflow."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from base64 import b64encode
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.error import URLError
from urllib.request import Request, urlopen

import yaml


TA_CONFIGMAP = 'torghut-ta-config'
TA_DEPLOYMENT = 'torghut-ta'
APPLY_CONFIRMATION_PHRASE = 'REPLAY_TA_CANARY'
SUPPORTED_NAMESPACE = 'torghut'
FAILED_RUN_STATES = {
    'FAILED',
    'FAILED_FINISHED',
    'FAILED_RESTARTING',
}


@dataclass(frozen=True)
class ReplayState:
    namespace: str
    ta_group_id: str
    ta_auto_offset_reset: str
    flink_job_state: str | None
    flink_restart_nonce: int
    flink_status_state: str | None


def _require_kubectl() -> None:
    if shutil.which('kubectl') is None:
        raise SystemExit('kubectl not found in PATH')


def _require_supported_namespace(namespace: str) -> None:
    if namespace != SUPPORTED_NAMESPACE:
        raise SystemExit(
            f'unsupported namespace {namespace!r}; only {SUPPORTED_NAMESPACE!r} is allowed'
        )


def _kubectl_binary() -> str:
    kubectl = shutil.which('kubectl')
    if not kubectl:
        raise SystemExit('kubectl not found in PATH')
    return kubectl


def _run_kubectl(
    args: list[str],
    *,
    input: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [_kubectl_binary(), *args],
        check=True,
        text=True,
        capture_output=True,
        input=input,
    )


def _kubectl_get_ta_config_json() -> dict[str, Any]:
    result = _run_kubectl(
        ['-n', SUPPORTED_NAMESPACE, 'get', 'configmap', TA_CONFIGMAP, '-o', 'json']
    )
    return json.loads(result.stdout)


def _kubectl_get_ta_deployment_json() -> dict[str, Any]:
    result = _run_kubectl(
        [
            '-n',
            SUPPORTED_NAMESPACE,
            'get',
            'flinkdeployment',
            TA_DEPLOYMENT,
            '-o',
            'json',
        ]
    )
    return json.loads(result.stdout)


def _kubectl_merge_patch(kind: str, name: str, patch: dict[str, Any]) -> None:
    _run_kubectl(
        [
            '-n',
            SUPPORTED_NAMESPACE,
            'patch',
            kind,
            name,
            '--type',
            'merge',
            '-p',
            yaml.safe_dump(patch),
        ]
    )


def _parse_int(value: object, fallback: int = 0) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            pass
    return fallback


def _load_state(namespace: str) -> ReplayState:
    _require_supported_namespace(namespace)

    cm = _kubectl_get_ta_config_json()
    cm_data = cm.get('data')
    if not isinstance(cm_data, dict):
        raise SystemExit('configmap data is not parseable')

    ta_group_id = str(cm_data.get('TA_GROUP_ID', '')).strip()
    ta_auto_offset_reset = str(cm_data.get('TA_AUTO_OFFSET_RESET', 'latest')).strip()
    if not ta_group_id:
        raise SystemExit('TA_GROUP_ID missing in torghut-ta-config')

    flink = _kubectl_get_ta_deployment_json()
    spec = flink.get('spec')
    if not isinstance(spec, dict):
        raise SystemExit('flinkdeployment spec is missing')

    job_spec = spec.get('job')
    job_state = None
    if isinstance(job_spec, dict):
        raw_job_state = job_spec.get('state')
        if isinstance(raw_job_state, str):
            job_state = raw_job_state.strip() or None

    restart_nonce = _parse_int(spec.get('restartNonce'), 0)

    status = flink.get('status')
    flink_status_state = None
    if isinstance(status, dict):
        job_status = status.get('jobStatus')
        if isinstance(job_status, dict):
            raw_status = job_status.get('state')
            if isinstance(raw_status, str):
                flink_status_state = raw_status.strip() or None

    return ReplayState(
        namespace=namespace,
        ta_group_id=ta_group_id,
        ta_auto_offset_reset=ta_auto_offset_reset,
        flink_job_state=job_state,
        flink_restart_nonce=restart_nonce,
        flink_status_state=flink_status_state,
    )


def _plan_command(
    replay_id: str, group_prefix: str, auto_offset_reset: str
) -> dict[str, str]:
    if not replay_id:
        raise SystemExit('replay-id must be provided')
    normalized_prefix = group_prefix.strip().replace('__', '-').strip('-')
    normalized_id = replay_id.strip().replace('__', '-').strip('-')
    replay_group_id = f'{normalized_prefix}-{normalized_id}'
    auto_offset_reset = auto_offset_reset.strip() or 'earliest'
    return {
        'replay_group_id': replay_group_id,
        'ta_auto_offset_reset': auto_offset_reset,
    }


def _validate_plan_args(replay_id: str, group_prefix: str) -> None:
    if not replay_id.strip():
        raise SystemExit('replay-id cannot be empty')
    if not group_prefix.strip():
        raise SystemExit('group-prefix cannot be empty')


def _validate_apply_preconditions(
    *,
    state: ReplayState,
    plan: dict[str, str],
    allow_existing_group: bool,
) -> list[str]:
    warnings: list[str] = []
    if state.ta_group_id == plan['replay_group_id'] and not allow_existing_group:
        warnings.append(
            'planned TA_GROUP_ID already equals current value; pass --allow-existing-group-id to continue'
        )
    if state.ta_auto_offset_reset == plan['ta_auto_offset_reset']:
        warnings.append('TA_AUTO_OFFSET_RESET already matches the replay target')
    return warnings


def _build_plan_report(
    *,
    namespace: str,
    mode: str,
    state: ReplayState,
    plan: dict[str, str],
    warnings: list[str],
    verify: bool,
    verification: dict[str, bool] | None = None,
    coverage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        'status': 'ok',
        'mode': mode,
        'namespace': namespace,
        'current': {
            'ta_group_id': state.ta_group_id,
            'ta_auto_offset_reset': state.ta_auto_offset_reset,
            'flink_job_state': state.flink_job_state,
            'flink_restart_nonce': state.flink_restart_nonce,
            'flink_status_state': state.flink_status_state,
        },
        'plan': plan,
        'warnings': warnings,
        'verify': verification,
        'verify_requested': verify,
        'coverage': coverage,
    }


def _print_plan_text(
    state: ReplayState,
    plan: dict[str, str],
    namespace: str,
    dry_run: bool,
    warnings: list[str],
    coverage: dict[str, Any] | None = None,
) -> None:
    print('Current replay state:')
    print(f'  namespace: {namespace}')
    print(f'  TA_GROUP_ID: {state.ta_group_id}')
    print(f'  TA_AUTO_OFFSET_RESET: {state.ta_auto_offset_reset}')
    print(f'  TA job state: {state.flink_job_state or "unknown"}')
    print(f'  TA restartNonce: {state.flink_restart_nonce}')
    print(f'  TA status state: {state.flink_status_state or "unknown"}')
    print('')
    print('Planned action:')
    print(f'  replay-group: {plan["replay_group_id"]}')
    print(f'  ta-auto-offset-reset: {plan["ta_auto_offset_reset"]}')
    print('Execution sequence (non-destructive replay mode):')
    print('  1) Set TA_GROUP_ID and TA_AUTO_OFFSET_RESET in torghut-ta-config')
    print('  2) Suspend torghut-ta if currently running')
    print('  3) Resume torghut-ta with an incremented restartNonce')
    if dry_run:
        print('  4) Optional post-change verify')
    if warnings:
        print('Warnings:')
        for warning in warnings:
            print(f'  - {warning}')
    if coverage is not None:
        summary_payload = coverage.get('summary')
        summary: Mapping[str, Any] = (
            summary_payload if isinstance(summary_payload, dict) else {}
        )
        print('Coverage preflight:')
        print(f'  status: {coverage.get("status")}')
        print(f'  required-trading-days: {summary.get("required_trading_days", 0)}')
        print(f'  signal-days: {summary.get("ta_signals_days", 0)}')
        print(f'  microbar-days: {summary.get("ta_microbars_days", 0)}')
        print(
            f'  missing-signal-days-vs-required: {summary.get("missing_signal_days_vs_required", 0)}'
        )
        print(f'  microbar-only-days: {summary.get("microbar_only_day_count", 0)}')
    if dry_run:
        print(
            f'Use --mode=apply --confirm {APPLY_CONFIRMATION_PHRASE} to execute the plan.'
        )


def _clickhouse_basic_auth(username: str, password: str) -> str:
    token = b64encode(f'{username}:{password}'.encode('utf-8')).decode('ascii')
    return f'Basic {token}'


def _clickhouse_query(
    *,
    http_url: str,
    username: str,
    password: str,
    query: str,
    timeout_seconds: int,
) -> str:
    request = Request(
        http_url,
        data=query.encode('utf-8'),
        method='POST',
        headers={'Authorization': _clickhouse_basic_auth(username, password)},
    )
    try:
        with urlopen(request, timeout=max(1, timeout_seconds)) as response:
            return response.read().decode('utf-8')
    except URLError as exc:
        raise RuntimeError(f'clickhouse_coverage_query_failed:{exc}') from exc


def _parse_tsv_with_names(raw: str) -> list[dict[str, str]]:
    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines:
        return []
    header = lines[0].split('\t')
    rows: list[dict[str, str]] = []
    for line in lines[1:]:
        values = line.split('\t')
        rows.append(
            {
                name: values[index] if index < len(values) else ''
                for index, name in enumerate(header)
            }
        )
    return rows


def _parse_int_field(row: Mapping[str, str] | None, name: str) -> int:
    if row is None:
        return 0
    try:
        return int(row.get(name, '0') or '0')
    except ValueError:
        return 0


def _table_coverage_query() -> str:
    return """
SELECT
  table_name,
  countDistinct(trading_day) AS days,
  min(trading_day) AS first_day,
  max(trading_day) AS last_day,
  sum(rows) AS rows
FROM (
  SELECT
    'ta_signals' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_signals
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
  UNION ALL
  SELECT
    'ta_microbars' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_microbars
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
)
GROUP BY table_name ORDER BY table_name FORMAT TSVWithNames
""".strip()


def _day_gap_query(limit: int) -> str:
    return f"""
SELECT
  trading_day,
  sumIf(rows, table_name = 'ta_signals') AS signal_rows,
  sumIf(rows, table_name = 'ta_microbars') AS microbar_rows
FROM (
  SELECT
    'ta_signals' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_signals
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
  UNION ALL
  SELECT
    'ta_microbars' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_microbars
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
)
GROUP BY trading_day ORDER BY trading_day DESC LIMIT {max(1, int(limit))} FORMAT TSVWithNames
""".strip()


def _load_clickhouse_coverage(args: argparse.Namespace) -> dict[str, Any] | None:
    if not bool(getattr(args, 'check_clickhouse_coverage', False)):
        return None
    password = str(getattr(args, 'clickhouse_password', '') or '')
    if not password:
        password = os.environ.get(
            str(getattr(args, 'clickhouse_password_env', '') or ''), ''
        )
    if not password:
        raise SystemExit(
            f'--check-clickhouse-coverage requires --clickhouse-password or ${args.clickhouse_password_env}'
        )
    query_args = {
        'http_url': str(args.clickhouse_http_url),
        'username': str(args.clickhouse_username),
        'password': password,
        'timeout_seconds': int(args.clickhouse_timeout_seconds),
    }
    table_rows = _parse_tsv_with_names(
        _clickhouse_query(query=_table_coverage_query(), **query_args)
    )
    day_rows = _parse_tsv_with_names(
        _clickhouse_query(
            query=_day_gap_query(int(args.coverage_day_limit)), **query_args
        )
    )
    table_by_name = {row.get('table_name', ''): row for row in table_rows}
    signal_days = _parse_int_field(table_by_name.get('ta_signals'), 'days')
    microbar_days = _parse_int_field(table_by_name.get('ta_microbars'), 'days')
    required_days = max(0, int(args.required_trading_days or 0))
    microbar_only_days = [
        row.get('trading_day', '')
        for row in day_rows
        if _parse_int_field(row, 'signal_rows') <= 0
        and _parse_int_field(row, 'microbar_rows') > 0
    ]
    missing_signal_days = max(0, required_days - signal_days) if required_days else 0
    status = 'ok'
    blockers: list[str] = []
    if missing_signal_days:
        status = 'insufficient_ta_signal_days'
        blockers.append(f'insufficient_ta_signal_days:{signal_days}<{required_days}')
    if microbar_only_days:
        blockers.append(f'microbar_only_days:{len(microbar_only_days)}')
    return {
        'schema_version': 'torghut.ta-replay-coverage-preflight.v1',
        'status': status,
        'blockers': blockers,
        'summary': {
            'required_trading_days': required_days,
            'ta_signals_days': signal_days,
            'ta_microbars_days': microbar_days,
            'missing_signal_days_vs_required': missing_signal_days,
            'microbar_only_day_count': len(microbar_only_days),
            'microbar_only_days': microbar_only_days,
        },
        'tables': table_rows,
        'day_gaps': day_rows,
    }


def _apply_plan(
    state: ReplayState, plan: dict[str, str], namespace: str
) -> ReplayState:
    _require_supported_namespace(namespace)

    configmap_patch = {
        'data': {
            'TA_GROUP_ID': plan['replay_group_id'],
            'TA_AUTO_OFFSET_RESET': plan['ta_auto_offset_reset'],
        },
    }
    _kubectl_merge_patch('configmap', TA_CONFIGMAP, configmap_patch)

    if state.flink_job_state != 'suspended':
        suspend_patch = {
            'spec': {'job': {'state': 'suspended'}},
        }
        _kubectl_merge_patch('flinkdeployment', TA_DEPLOYMENT, suspend_patch)

    resume_patch = {
        'spec': {
            'restartNonce': state.flink_restart_nonce + 1,
            'job': {'state': 'running'},
        },
    }
    _kubectl_merge_patch('flinkdeployment', TA_DEPLOYMENT, resume_patch)

    return _load_state(namespace)


def _verify_state(
    state: ReplayState, plan: dict[str, str], previous_nonce: int
) -> dict[str, bool]:
    checks: dict[str, bool] = {}
    checks['ta_group_id_applied'] = state.ta_group_id == plan['replay_group_id']
    checks['ta_auto_offset_reset_applied'] = (
        state.ta_auto_offset_reset == plan['ta_auto_offset_reset']
    )
    checks['restart_nonce_advanced'] = state.flink_restart_nonce >= previous_nonce + 1
    checks['job_state_not_failed'] = True
    if state.flink_status_state:
        checks['job_state_not_failed'] = (
            state.flink_status_state not in FAILED_RUN_STATES
        )
    checks['spec_job_state_running_or_unknown'] = state.flink_job_state in {
        'running',
        None,
    }
    return checks


def _final_status(checks: dict[str, bool]) -> int:
    if all(checks.values()):
        return 0
    return 1


def _handle_plan_mode(
    *,
    args: argparse.Namespace,
    state: ReplayState,
    plan: dict[str, str],
    warnings: list[str],
) -> int:
    verification = (
        _verify_state(state, plan, state.flink_restart_nonce) if args.verify else None
    )
    coverage = _load_clickhouse_coverage(args)
    report = _build_plan_report(
        namespace=args.namespace,
        mode='plan',
        state=state,
        plan=plan,
        warnings=warnings,
        verify=args.verify,
        verification=verification,
        coverage=coverage,
    )
    if args.json:
        print(json.dumps(report, sort_keys=True, indent=2))
        return _final_status(verification) if verification else 0

    _print_plan_text(
        state, plan, args.namespace, dry_run=True, warnings=warnings, coverage=coverage
    )
    return 0


def _handle_verify_mode(
    *,
    args: argparse.Namespace,
    state: ReplayState,
    plan: dict[str, str],
    warnings: list[str],
) -> int:
    verification = _verify_state(state, plan, state.flink_restart_nonce)
    coverage = _load_clickhouse_coverage(args)
    report = _build_plan_report(
        namespace=args.namespace,
        mode='verify',
        state=state,
        plan=plan,
        warnings=warnings,
        verify=True,
        verification=verification,
        coverage=coverage,
    )
    if args.json:
        print(json.dumps(report, sort_keys=True, indent=2))
        return _final_status(verification)

    _print_plan_text(
        state, plan, args.namespace, dry_run=False, warnings=warnings, coverage=coverage
    )
    print('')
    print('Verify results:')
    for check_name, ok in verification.items():
        print(f'  {check_name}: {"ok" if ok else "fail"}')
    return _final_status(verification)


def _handle_apply_mode(
    *,
    args: argparse.Namespace,
    state: ReplayState,
    plan: dict[str, str],
    warnings: list[str],
) -> int:
    print('Applying plan now...')
    if warnings:
        for warning in warnings:
            print(f'  warning: {warning}')
    previous_nonce = state.flink_restart_nonce
    applied_state = _apply_plan(state, plan, args.namespace)
    verification = (
        _verify_state(applied_state, plan, previous_nonce) if args.verify else None
    )
    coverage = _load_clickhouse_coverage(args)

    report = _build_plan_report(
        namespace=args.namespace,
        mode='apply',
        state=applied_state,
        plan=plan,
        warnings=warnings,
        verify=args.verify,
        verification=verification,
        coverage=coverage,
    )
    if args.json:
        print(json.dumps(report, sort_keys=True, indent=2))
        return _final_status(verification) if verification else 0

    print('Patch complete.')
    _print_plan_text(
        applied_state,
        plan,
        args.namespace,
        dry_run=False,
        warnings=warnings,
        coverage=coverage,
    )
    if args.verify and verification is not None:
        print('Verify results:')
        for check_name, ok in verification.items():
            print(f'  {check_name}: {"ok" if ok else "fail"}')
        return _final_status(verification)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Standardize TA replay rollout actions for torghut.'
    )
    parser.add_argument(
        '--namespace',
        default='torghut',
        help='Kubernetes namespace for torghut resources.',
    )
    parser.add_argument(
        '--replay-id', required=True, help='Replay id used for group-id isolation.'
    )
    parser.add_argument(
        '--group-prefix',
        default='torghut-ta-replay',
        help='Prefix for generated TA_GROUP_ID.',
    )
    parser.add_argument(
        '--auto-offset-reset',
        default='earliest',
        choices=('earliest', 'latest', 'none'),
        help='Target TA_AUTO_OFFSET_RESET value.',
    )
    parser.add_argument(
        '--mode',
        choices=('plan', 'apply', 'verify'),
        default='plan',
        help='Plan only, apply via kubectl patches, or verify current state.',
    )
    parser.add_argument(
        '--confirm',
        default='',
        help=f'Required when --mode=apply. Must be {APPLY_CONFIRMATION_PHRASE}.',
    )
    parser.add_argument(
        '--allow-existing-group-id',
        action='store_true',
        help='Allow apply when TA_GROUP_ID already equals planned replay group.',
    )
    parser.add_argument(
        '--verify',
        action='store_true',
        help='After plan/apply, validate current state against plan assertions and exit non-zero on failure.',
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Emit machine-readable output for automation.',
    )
    parser.add_argument(
        '--check-clickhouse-coverage',
        action='store_true',
        help='Add a read-only ta_signals/ta_microbars coverage preflight to plan/verify/apply reports.',
    )
    parser.add_argument(
        '--clickhouse-http-url',
        default=os.environ.get(
            'TA_CLICKHOUSE_HTTP_URL',
            os.environ.get(
                'CLICKHOUSE_HTTP_URL',
                'http://torghut-clickhouse.torghut.svc.cluster.local:8123',
            ),
        ),
        help='ClickHouse HTTP endpoint used by --check-clickhouse-coverage.',
    )
    parser.add_argument(
        '--clickhouse-username',
        default=os.environ.get(
            'TA_CLICKHOUSE_USERNAME', os.environ.get('CLICKHOUSE_USERNAME', 'torghut')
        ),
        help='ClickHouse username used by --check-clickhouse-coverage.',
    )
    parser.add_argument(
        '--clickhouse-password',
        default='',
        help='ClickHouse password used by --check-clickhouse-coverage. Prefer the env var instead.',
    )
    parser.add_argument(
        '--clickhouse-password-env',
        default='TA_CLICKHOUSE_PASSWORD',
        help='Environment variable containing the ClickHouse password.',
    )
    parser.add_argument(
        '--clickhouse-timeout-seconds',
        type=int,
        default=30,
        help='Timeout for each read-only ClickHouse coverage query.',
    )
    parser.add_argument(
        '--coverage-day-limit',
        type=int,
        default=40,
        help='Number of recent trading days to include in the coverage day-gap report.',
    )
    parser.add_argument(
        '--required-trading-days',
        type=int,
        default=0,
        help='Required replay proof trading-day count used to compute signal-day shortfall.',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _require_kubectl()
    _require_supported_namespace(args.namespace)
    _validate_plan_args(args.replay_id, args.group_prefix)

    if args.mode == 'apply' and args.confirm != APPLY_CONFIRMATION_PHRASE:
        raise SystemExit(f'--mode=apply requires --confirm {APPLY_CONFIRMATION_PHRASE}')

    state = _load_state(args.namespace)
    plan = _plan_command(args.replay_id, args.group_prefix, args.auto_offset_reset)

    warnings = _validate_apply_preconditions(
        state=state,
        plan=plan,
        allow_existing_group=args.allow_existing_group_id,
    )
    if args.mode == 'plan':
        return _handle_plan_mode(args=args, state=state, plan=plan, warnings=warnings)
    if args.mode == 'verify':
        return _handle_verify_mode(args=args, state=state, plan=plan, warnings=warnings)
    return _handle_apply_mode(args=args, state=state, plan=plan, warnings=warnings)


if __name__ == '__main__':
    raise SystemExit(main())

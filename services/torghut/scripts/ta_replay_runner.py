#!/usr/bin/env python3
"""Execute the standardized Torghut TA replay rollout workflow."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
        raise SystemExit(f'unsupported namespace {namespace!r}; only {SUPPORTED_NAMESPACE!r} is allowed')


def _kubectl_variant() -> str:
    if Path('/usr/bin/kubectl').exists():
        return 'usr_bin'
    if Path('/usr/local/bin/kubectl').exists():
        return 'usr_local_bin'
    if Path('/opt/homebrew/bin/kubectl').exists():
        return 'opt_homebrew_bin'
    raise SystemExit('kubectl not found in expected absolute paths')


def _kubectl_get_ta_config_json() -> dict[str, Any]:
    variant = _kubectl_variant()
    if variant == 'usr_bin':
        result = subprocess.run(
            ['/usr/bin/kubectl', '-n', 'torghut', 'get', 'configmap', 'torghut-ta-config', '-o', 'json'],
            check=True,
            text=True,
            capture_output=True,
        )
    elif variant == 'usr_local_bin':
        result = subprocess.run(
            ['/usr/local/bin/kubectl', '-n', 'torghut', 'get', 'configmap', 'torghut-ta-config', '-o', 'json'],
            check=True,
            text=True,
            capture_output=True,
        )
    else:
        result = subprocess.run(
            ['/opt/homebrew/bin/kubectl', '-n', 'torghut', 'get', 'configmap', 'torghut-ta-config', '-o', 'json'],
            check=True,
            text=True,
            capture_output=True,
        )
    return json.loads(result.stdout)


def _kubectl_get_ta_deployment_json() -> dict[str, Any]:
    variant = _kubectl_variant()
    if variant == 'usr_bin':
        result = subprocess.run(
            ['/usr/bin/kubectl', '-n', 'torghut', 'get', 'flinkdeployment', 'torghut-ta', '-o', 'json'],
            check=True,
            text=True,
            capture_output=True,
        )
    elif variant == 'usr_local_bin':
        result = subprocess.run(
            ['/usr/local/bin/kubectl', '-n', 'torghut', 'get', 'flinkdeployment', 'torghut-ta', '-o', 'json'],
            check=True,
            text=True,
            capture_output=True,
        )
    else:
        result = subprocess.run(
            ['/opt/homebrew/bin/kubectl', '-n', 'torghut', 'get', 'flinkdeployment', 'torghut-ta', '-o', 'json'],
            check=True,
            text=True,
            capture_output=True,
        )
    return json.loads(result.stdout)


def _kubectl_apply_manifest(manifest: dict[str, Any]) -> None:
    payload = yaml.safe_dump(manifest)
    variant = _kubectl_variant()
    if variant == 'usr_bin':
        subprocess.run(
            ['/usr/bin/kubectl', 'apply', '-f', '-'],
            check=True,
            text=True,
            capture_output=True,
            input=payload,
        )
        return
    if variant == 'usr_local_bin':
        subprocess.run(
            ['/usr/local/bin/kubectl', 'apply', '-f', '-'],
            check=True,
            text=True,
            capture_output=True,
            input=payload,
        )
        return
    subprocess.run(
        ['/opt/homebrew/bin/kubectl', 'apply', '-f', '-'],
        check=True,
        text=True,
        capture_output=True,
        input=payload,
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


def _plan_command(replay_id: str, group_prefix: str, auto_offset_reset: str) -> dict[str, str]:
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
) -> dict[str, Any]:
    return {
        "status": "ok",
        "mode": mode,
        "namespace": namespace,
        "current": {
            "ta_group_id": state.ta_group_id,
            "ta_auto_offset_reset": state.ta_auto_offset_reset,
            "flink_job_state": state.flink_job_state,
            "flink_restart_nonce": state.flink_restart_nonce,
            "flink_status_state": state.flink_status_state,
        },
        "plan": plan,
        "warnings": warnings,
        "verify": verification,
        "verify_requested": verify,
    }


def _print_plan_text(
    state: ReplayState,
    plan: dict[str, str],
    namespace: str,
    dry_run: bool,
    warnings: list[str],
) -> None:
    print('Current replay state:')
    print(f'  namespace: {namespace}')
    print(f'  TA_GROUP_ID: {state.ta_group_id}')
    print(f'  TA_AUTO_OFFSET_RESET: {state.ta_auto_offset_reset}')
    print(f"  TA job state: {state.flink_job_state or 'unknown'}")
    print(f'  TA restartNonce: {state.flink_restart_nonce}')
    print(f"  TA status state: {state.flink_status_state or 'unknown'}")
    print('')
    print('Planned action:')
    print(f"  replay-group: {plan['replay_group_id']}")
    print(f"  ta-auto-offset-reset: {plan['ta_auto_offset_reset']}")
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
    if dry_run:
        print(f'Use --mode=apply --confirm {APPLY_CONFIRMATION_PHRASE} to execute the plan.')


def _apply_plan(state: ReplayState, plan: dict[str, str], namespace: str) -> ReplayState:
    _require_supported_namespace(namespace)

    configmap_manifest = {
        'apiVersion': 'v1',
        'kind': 'ConfigMap',
        'metadata': {'name': TA_CONFIGMAP, 'namespace': SUPPORTED_NAMESPACE},
        'data': {
            'TA_GROUP_ID': plan['replay_group_id'],
            'TA_AUTO_OFFSET_RESET': plan['ta_auto_offset_reset'],
        },
    }
    _kubectl_apply_manifest(configmap_manifest)

    if state.flink_job_state != 'suspended':
        suspend_manifest = {
            'apiVersion': 'flink.apache.org/v1beta1',
            'kind': 'FlinkDeployment',
            'metadata': {'name': TA_DEPLOYMENT, 'namespace': SUPPORTED_NAMESPACE},
            'spec': {'job': {'state': 'suspended'}},
        }
        _kubectl_apply_manifest(suspend_manifest)

    resume_manifest = {
        'apiVersion': 'flink.apache.org/v1beta1',
        'kind': 'FlinkDeployment',
        'metadata': {'name': TA_DEPLOYMENT, 'namespace': SUPPORTED_NAMESPACE},
        'spec': {
            'restartNonce': state.flink_restart_nonce + 1,
            'job': {'state': 'running'},
        },
    }
    _kubectl_apply_manifest(resume_manifest)

    return _load_state(namespace)


def _verify_state(state: ReplayState, plan: dict[str, str], previous_nonce: int) -> dict[str, bool]:
    checks: dict[str, bool] = {}
    checks['ta_group_id_applied'] = state.ta_group_id == plan['replay_group_id']
    checks['ta_auto_offset_reset_applied'] = (
        state.ta_auto_offset_reset == plan['ta_auto_offset_reset']
    )
    checks['restart_nonce_advanced'] = state.flink_restart_nonce >= previous_nonce + 1
    checks['job_state_not_failed'] = True
    if state.flink_status_state:
        checks['job_state_not_failed'] = state.flink_status_state not in FAILED_RUN_STATES
    checks['spec_job_state_running_or_unknown'] = state.flink_job_state in {'running', None}
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
    verification = _verify_state(state, plan, state.flink_restart_nonce) if args.verify else None
    report = _build_plan_report(
        namespace=args.namespace,
        mode='plan',
        state=state,
        plan=plan,
        warnings=warnings,
        verify=args.verify,
        verification=verification,
    )
    if args.json:
        print(json.dumps(report, sort_keys=True, indent=2))
        return _final_status(verification) if verification else 0

    _print_plan_text(state, plan, args.namespace, dry_run=True, warnings=warnings)
    return 0


def _handle_verify_mode(
    *,
    args: argparse.Namespace,
    state: ReplayState,
    plan: dict[str, str],
    warnings: list[str],
) -> int:
    verification = _verify_state(state, plan, state.flink_restart_nonce)
    report = _build_plan_report(
        namespace=args.namespace,
        mode='verify',
        state=state,
        plan=plan,
        warnings=warnings,
        verify=True,
        verification=verification,
    )
    if args.json:
        print(json.dumps(report, sort_keys=True, indent=2))
        return _final_status(verification)

    _print_plan_text(state, plan, args.namespace, dry_run=False, warnings=warnings)
    print('')
    print('Verify results:')
    for check_name, ok in verification.items():
        print(f"  {check_name}: {'ok' if ok else 'fail'}")
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
    verification = _verify_state(applied_state, plan, previous_nonce) if args.verify else None

    report = _build_plan_report(
        namespace=args.namespace,
        mode='apply',
        state=applied_state,
        plan=plan,
        warnings=warnings,
        verify=args.verify,
        verification=verification,
    )
    if args.json:
        print(json.dumps(report, sort_keys=True, indent=2))
        return _final_status(verification) if verification else 0

    print('Patch complete.')
    _print_plan_text(applied_state, plan, args.namespace, dry_run=False, warnings=warnings)
    if args.verify and verification is not None:
        print('Verify results:')
        for check_name, ok in verification.items():
            print(f"  {check_name}: {'ok' if ok else 'fail'}")
        return _final_status(verification)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Standardize TA replay rollout actions for torghut.')
    parser.add_argument('--namespace', default='torghut', help='Kubernetes namespace for torghut resources.')
    parser.add_argument('--replay-id', required=True, help='Replay id used for group-id isolation.')
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

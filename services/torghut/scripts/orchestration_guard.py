#!/usr/bin/env python3
"""Torghut v3 orchestration guard and retry policy CLI."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import yaml

DEFAULT_POLICY_PATH = (
    Path(__file__).resolve().parent.parent.parent
    .parent
    / 'docs'
    / 'torghut'
    / 'design-system'
    / 'v3'
    / 'full-loop'
    / 'templates'
    / 'orchestration-policy.yaml'
)

ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9-]{5,62}$')
JsonDict = dict[str, Any]


@dataclass(frozen=True)
class RetryPolicy:
    max_retries: int
    initial_backoff_seconds: int
    backoff_multiplier: float
    max_backoff_seconds: int
    autopause_after_failures: int


@dataclass(frozen=True)
class StageDefinition:
    stage: str
    lane: str
    mutable_action: bool
    require_previous_artifact: bool
    require_previous_gate_pass: bool


class GuardError(ValueError):
    """Raised when stage transition or failure policy input is invalid."""


def _parse_json_file(path: Path) -> JsonDict:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise GuardError(f'Expected JSON object in {path}')
    return cast(JsonDict, payload)


def _validate_identifier(name: str, value: str) -> None:
    if not ID_PATTERN.match(value):
        raise GuardError(f'{name} must match {ID_PATTERN.pattern!r}: {value!r}')


def load_policy(path: Path | None = None) -> JsonDict:
    policy_path = path or DEFAULT_POLICY_PATH
    payload = yaml.safe_load(policy_path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise GuardError(f'Invalid policy YAML at {policy_path}')
    return cast(JsonDict, payload)


def _stage_definitions(policy: JsonDict) -> dict[str, StageDefinition]:
    stages_raw = policy.get('stages')
    if not isinstance(stages_raw, list) or not stages_raw:
        raise GuardError('Policy must include non-empty stages list')
    stages = cast(list[object], stages_raw)

    parsed: dict[str, StageDefinition] = {}
    for raw_any in stages:
        if not isinstance(raw_any, dict):
            raise GuardError('Each stage policy must be an object')
        raw = cast(JsonDict, raw_any)
        stage = str(raw.get('stage', '')).strip()
        lane = str(raw.get('lane', '')).strip()
        if not stage or not lane:
            raise GuardError('Each stage policy requires stage and lane')
        parsed[stage] = StageDefinition(
            stage=stage,
            lane=lane,
            mutable_action=bool(raw.get('mutableAction', False)),
            require_previous_artifact=bool(raw.get('requirePreviousArtifact', True)),
            require_previous_gate_pass=bool(raw.get('requirePreviousGatePass', True)),
        )
    return parsed


def _retry_policies(policy: JsonDict) -> dict[str, RetryPolicy]:
    raw_policies_input = policy.get('failurePolicies')
    if not isinstance(raw_policies_input, dict) or not raw_policies_input:
        raise GuardError('Policy must include failurePolicies map')
    raw_policies = cast(dict[object, object], raw_policies_input)

    parsed: dict[str, RetryPolicy] = {}
    for failure_class_any, raw_any in raw_policies.items():
        failure_class = str(failure_class_any)
        if not isinstance(raw_any, dict):
            raise GuardError(f'Failure policy for {failure_class} must be an object')
        raw = cast(JsonDict, raw_any)
        parsed[str(failure_class)] = RetryPolicy(
            max_retries=int(raw.get('maxRetries', 0)),
            initial_backoff_seconds=int(raw.get('initialBackoffSeconds', 0)),
            backoff_multiplier=float(raw.get('backoffMultiplier', 1.0)),
            max_backoff_seconds=int(raw.get('maxBackoffSeconds', 0)),
            autopause_after_failures=int(raw.get('autopauseAfterFailures', 1)),
        )
    return parsed


def _deny(reason: str, next_action: str = 'halt') -> JsonDict:
    return {'allowed': False, 'reason': reason, 'nextAction': next_action}


def _transition_map(policy: JsonDict) -> dict[str, list[str]]:
    transitions = policy.get('transitions')
    if not isinstance(transitions, dict):
        raise GuardError('Policy must include transitions map')
    return cast(dict[str, list[str]], transitions)


def _active_stage_from_state(
    state: JsonDict,
    stage_definitions: dict[str, StageDefinition],
) -> str | None:
    active_stage_raw = state.get('activeStage')
    if not isinstance(active_stage_raw, str):
        return None
    active_stage = active_stage_raw.strip()
    if not active_stage:
        return None
    if active_stage not in stage_definitions:
        raise GuardError(f'Unknown active stage in state: {active_stage}')
    return active_stage


def _state_run_id(state: JsonDict) -> str | None:
    state_run_id_raw = state.get('runId')
    if not isinstance(state_run_id_raw, str):
        state_run_id_raw = state.get('run_id')
    if not isinstance(state_run_id_raw, str):
        return None
    state_run_id = state_run_id_raw.strip()
    return state_run_id or None


def _validate_transition_state(
    *,
    state: JsonDict,
    candidate_id: str,
    run_id: str,
    from_stage: str | None,
    to_stage: str,
    active_stage: str | None,
    transitions_map: dict[str, list[str]],
) -> JsonDict | None:
    if active_stage and from_stage and active_stage != from_stage:
        return _deny(f'active_stage_mismatch:{active_stage}')

    state_run_id = _state_run_id(state)
    if not state_run_id:
        return _deny('missing_run_id')
    if state_run_id != run_id:
        return _deny(f'run_mismatch:{state_run_id}')

    source_stage = from_stage or active_stage
    if not source_stage:
        return _deny('missing_source_stage')

    allowed_targets = transitions_map.get(source_stage, [])
    if to_stage not in allowed_targets:
        return _deny(f'illegal_transition:{source_stage}->{to_stage}')

    if str(state.get('candidateId', candidate_id)) != candidate_id:
        return _deny('candidate_mismatch')
    if bool(state.get('paused', False)):
        return _deny('candidate_paused_for_review', 'human_review')
    return None


def _validate_stage_controls(
    *,
    stage_policy: StageDefinition,
    previous_artifact: Path | None,
    previous_gate_passed: bool,
    risk_controls_passed: bool,
    execution_controls_passed: bool,
) -> JsonDict | None:
    if stage_policy.require_previous_artifact and (previous_artifact is None or not previous_artifact.exists()):
        return _deny('missing_previous_artifact')
    if stage_policy.require_previous_gate_pass and not previous_gate_passed:
        return _deny('previous_gate_failed', 'rollback')
    if not risk_controls_passed:
        return _deny('risk_controls_not_passed', 'rollback')
    if not execution_controls_passed:
        return _deny('execution_controls_not_passed', 'rollback')
    return None


def _validate_mutable_action(
    *,
    stage_policy: StageDefinition,
    mode: str,
    emergency_ticket: str | None,
) -> JsonDict | None:
    if not stage_policy.mutable_action:
        return None
    if mode == 'gitops':
        return None
    if mode == 'emergency' and emergency_ticket:
        return None
    return _deny('mutable_action_requires_gitops_or_ticketed_emergency')


def evaluate_transition(
    *,
    policy: JsonDict,
    state: JsonDict,
    candidate_id: str,
    run_id: str,
    from_stage: str | None,
    to_stage: str,
    previous_artifact: Path | None,
    previous_gate_passed: bool,
    risk_controls_passed: bool,
    execution_controls_passed: bool,
    mode: str,
    emergency_ticket: str | None,
) -> JsonDict:
    _validate_identifier('candidate_id', candidate_id)
    _validate_identifier('run_id', run_id)

    stage_definitions = _stage_definitions(policy)
    if to_stage not in stage_definitions:
        raise GuardError(f'Unknown destination stage: {to_stage}')
    if from_stage and from_stage not in stage_definitions:
        raise GuardError(f'Unknown source stage: {from_stage}')
    transitions_map = _transition_map(policy)
    active_stage = _active_stage_from_state(state, stage_definitions)

    transition_error = _validate_transition_state(
        state=state,
        candidate_id=candidate_id,
        run_id=run_id,
        from_stage=from_stage,
        to_stage=to_stage,
        active_stage=active_stage,
        transitions_map=transitions_map,
    )
    if transition_error:
        return transition_error

    stage_policy = stage_definitions[to_stage]
    controls_error = _validate_stage_controls(
        stage_policy=stage_policy,
        previous_artifact=previous_artifact,
        previous_gate_passed=previous_gate_passed,
        risk_controls_passed=risk_controls_passed,
        execution_controls_passed=execution_controls_passed,
    )
    if controls_error:
        return controls_error

    mutable_error = _validate_mutable_action(
        stage_policy=stage_policy,
        mode=mode,
        emergency_ticket=emergency_ticket,
    )
    if mutable_error:
        return mutable_error

    return {
        'allowed': True,
        'reason': 'transition_allowed',
        'nextAction': 'proceed',
        'lane': stage_policy.lane,
        'toStage': to_stage,
    }


def evaluate_failure(
    *,
    policy: JsonDict,
    state: JsonDict,
    stage: str,
    failure_class: str,
    attempt: int,
) -> JsonDict:
    if attempt < 1:
        raise GuardError('attempt must be >= 1')

    retries = _retry_policies(policy)
    if failure_class not in retries:
        raise GuardError(f'Unknown failure class: {failure_class}')
    retry_policy = retries[failure_class]

    counts_raw = state.get('failureCounts', {})
    counts: JsonDict
    if isinstance(counts_raw, dict):
        counts = cast(JsonDict, counts_raw)
    else:
        counts = {}
    stage_failures = int(counts.get(stage, 0)) + 1

    if failure_class == 'transient' and attempt <= retry_policy.max_retries:
        backoff = retry_policy.initial_backoff_seconds * (retry_policy.backoff_multiplier ** (attempt - 1))
        next_backoff_seconds = int(min(backoff, retry_policy.max_backoff_seconds))
        return {
            'action': 'retry',
            'stage': stage,
            'attempt': attempt,
            'nextBackoffSeconds': next_backoff_seconds,
            'stageFailures': stage_failures,
        }

    if stage_failures >= retry_policy.autopause_after_failures:
        return {
            'action': 'pause_for_review',
            'stage': stage,
            'attempt': attempt,
            'stageFailures': stage_failures,
            'reason': f'{failure_class}_failure_threshold_reached',
        }

    return {
        'action': 'fail',
        'stage': stage,
        'attempt': attempt,
        'stageFailures': stage_failures,
        'reason': f'{failure_class}_non_retryable',
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Torghut v3 orchestration transition guard and retry evaluator.')
    parser.add_argument('--policy', type=Path, default=DEFAULT_POLICY_PATH, help='Path to orchestration policy YAML.')

    subparsers = parser.add_subparsers(dest='command', required=True)

    transition = subparsers.add_parser('check-transition', help='Validate a stage transition request.')
    transition.add_argument('--state', type=Path, required=True, help='Path to candidate state JSON.')
    transition.add_argument('--candidate-id', required=True)
    transition.add_argument('--run-id', required=True)
    transition.add_argument('--from-stage')
    transition.add_argument('--to-stage', required=True)
    transition.add_argument('--previous-artifact', type=Path)
    transition.add_argument('--previous-gate-passed', action='store_true', default=False)
    transition.add_argument('--risk-controls-passed', action='store_true', default=False)
    transition.add_argument('--execution-controls-passed', action='store_true', default=False)
    transition.add_argument('--mode', choices=('gitops', 'emergency'), default='gitops')
    transition.add_argument('--emergency-ticket')

    failure = subparsers.add_parser('evaluate-failure', help='Evaluate failure class retry/pause behavior.')
    failure.add_argument('--state', type=Path, required=True, help='Path to candidate state JSON.')
    failure.add_argument('--stage', required=True)
    failure.add_argument('--failure-class', choices=('transient', 'deterministic', 'spec', 'policy'), required=True)
    failure.add_argument('--attempt', type=int, required=True)

    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    policy = load_policy(args.policy)
    state = _parse_json_file(args.state)

    if args.command == 'check-transition':
        result = evaluate_transition(
            policy=policy,
            state=state,
            candidate_id=args.candidate_id,
            run_id=args.run_id,
            from_stage=args.from_stage,
            to_stage=args.to_stage,
            previous_artifact=args.previous_artifact,
            previous_gate_passed=bool(args.previous_gate_passed),
            risk_controls_passed=bool(args.risk_controls_passed),
            execution_controls_passed=bool(args.execution_controls_passed),
            mode=args.mode,
            emergency_ticket=args.emergency_ticket,
        )
    elif args.command == 'evaluate-failure':
        result = evaluate_failure(
            policy=policy,
            state=state,
            stage=args.stage,
            failure_class=args.failure_class,
            attempt=args.attempt,
        )
    else:
        raise GuardError(f'Unsupported command: {args.command}')

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

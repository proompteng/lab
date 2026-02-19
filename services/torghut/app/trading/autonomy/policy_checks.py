"""Promotion progression and rollback readiness policy checks for Torghut autonomy."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast


@dataclass(frozen=True)
class PromotionPrerequisiteResult:
    allowed: bool
    reasons: list[str]
    required_artifacts: list[str]
    missing_artifacts: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            'allowed': self.allowed,
            'reasons': list(self.reasons),
            'required_artifacts': list(self.required_artifacts),
            'missing_artifacts': list(self.missing_artifacts),
        }


@dataclass(frozen=True)
class RollbackReadinessResult:
    ready: bool
    reasons: list[str]
    required_checks: list[str]
    missing_checks: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            'ready': self.ready,
            'reasons': list(self.reasons),
            'required_checks': list(self.required_checks),
            'missing_checks': list(self.missing_checks),
        }


def evaluate_promotion_prerequisites(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    promotion_target: str,
    artifact_root: Path,
) -> PromotionPrerequisiteResult:
    reasons: list[str] = []
    required_artifacts = _required_artifacts_for_target(policy_payload, promotion_target)
    missing_artifacts = [item for item in required_artifacts if not (artifact_root / item).exists()]

    if missing_artifacts:
        reasons.append('required_artifacts_missing')

    if candidate_state_payload.get('paused', False):
        reasons.append('candidate_paused_for_review')

    if not bool(gate_report_payload.get('promotion_allowed', False)):
        reasons.append('gate_report_not_promotable')

    requested_rank = _promotion_rank(promotion_target)
    recommended_rank = _promotion_rank(str(gate_report_payload.get('recommended_mode', 'shadow')))
    if recommended_rank < requested_rank:
        reasons.append('gate_recommended_mode_below_target')

    gate_index = {str(gate.get('gate_id', '')): gate for gate in _gates(gate_report_payload)}
    for required_gate in ('gate0_data_integrity', 'gate1_statistical_robustness', 'gate2_risk_capacity'):
        status = str(gate_index.get(required_gate, {}).get('status', 'fail'))
        if status != 'pass':
            reasons.append(f'{required_gate}_not_passed')

    if str(candidate_state_payload.get('runId', '')).strip() != str(gate_report_payload.get('run_id', '')).strip():
        # gate report payload may not always include run_id; only enforce when available.
        run_id = str(gate_report_payload.get('run_id', '')).strip()
        if run_id:
            reasons.append('run_id_mismatch_between_state_and_gate_report')

    return PromotionPrerequisiteResult(
        allowed=not reasons,
        reasons=sorted(set(reasons)),
        required_artifacts=required_artifacts,
        missing_artifacts=missing_artifacts,
    )


def evaluate_rollback_readiness(
    *,
    policy_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    now: datetime | None = None,
) -> RollbackReadinessResult:
    reasons: list[str] = []
    required_checks = _required_rollback_checks(policy_payload)
    rollback_raw = candidate_state_payload.get('rollbackReadiness')
    rollback: dict[str, Any]
    if isinstance(rollback_raw, dict):
        rollback = cast(dict[str, Any], rollback_raw)
    else:
        rollback = {}

    missing_checks = [name for name in required_checks if not bool(rollback.get(name, False))]
    if missing_checks:
        reasons.append('rollback_checks_missing_or_failed')

    max_age_hours = int(policy_payload.get('rollback_dry_run_max_age_hours', 72))
    dry_run_completed_at = _parse_datetime(str(rollback.get('dryRunCompletedAt', '')).strip())
    current = now or datetime.now(timezone.utc)
    if dry_run_completed_at is None:
        reasons.append('rollback_dry_run_timestamp_missing')
    else:
        if current - dry_run_completed_at > timedelta(hours=max_age_hours):
            reasons.append('rollback_dry_run_stale')

    if policy_payload.get('rollback_require_human_approval', True) and not bool(rollback.get('humanApproved', False)):
        reasons.append('rollback_human_approval_missing')

    if not str(rollback.get('rollbackTarget', '')).strip():
        reasons.append('rollback_target_missing')

    return RollbackReadinessResult(
        ready=not reasons,
        reasons=sorted(set(reasons)),
        required_checks=required_checks,
        missing_checks=missing_checks,
    )


def _required_artifacts_for_target(policy_payload: dict[str, Any], promotion_target: str) -> list[str]:
    base_raw = policy_payload.get(
        'promotion_required_artifacts',
        ['research/candidate-spec.json', 'backtest/evaluation-report.json', 'gates/gate-evaluation.json'],
    )
    base = _list_from_any(base_raw)
    required = [str(item) for item in base if isinstance(item, str)]
    patch_targets_raw = policy_payload.get('promotion_require_patch_targets', ['paper', 'live'])
    patch_targets = _list_from_any(patch_targets_raw)
    if promotion_target in patch_targets:
        required.append('paper-candidate/strategy-configmap-patch.yaml')
    return sorted(set(required))


def _required_rollback_checks(policy_payload: dict[str, Any]) -> list[str]:
    checks_raw = policy_payload.get(
        'rollback_required_checks',
        ['killSwitchDryRunPassed', 'gitopsRevertDryRunPassed', 'strategyDisableDryRunPassed'],
    )
    checks = _list_from_any(checks_raw)
    return [str(item) for item in checks if isinstance(item, str)]


def _gates(gate_report_payload: dict[str, Any]) -> list[dict[str, Any]]:
    gates_raw = gate_report_payload.get('gates')
    gates_list = _list_from_any(gates_raw)
    gates: list[dict[str, Any]] = []
    for item in gates_list:
        if isinstance(item, dict):
            gates.append(cast(dict[str, Any], item))
    return gates


def _list_from_any(value: Any) -> list[object]:
    if not isinstance(value, list):
        return []
    return cast(list[object], value)


def _promotion_rank(target: str) -> int:
    ranking = {'shadow': 1, 'paper': 2, 'live': 3}
    return ranking.get(target, 0)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


__all__ = [
    'PromotionPrerequisiteResult',
    'RollbackReadinessResult',
    'evaluate_promotion_prerequisites',
    'evaluate_rollback_readiness',
]

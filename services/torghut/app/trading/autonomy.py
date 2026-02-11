"""Autonomous lane helpers for deterministic research->gate->paper flow."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, cast

import yaml


GateStatus = Literal['pass', 'fail']


@dataclass(frozen=True)
class GateResult:
    gate_id: str
    status: GateStatus
    reasons: tuple[str, ...]
    artifact_refs: tuple[str, ...]
    evaluated_at: str
    code_version: str

    def to_payload(self) -> dict[str, Any]:
        return {
            'gate_id': self.gate_id,
            'status': self.status,
            'reasons': list(self.reasons),
            'artifact_refs': list(self.artifact_refs),
            'evaluated_at': self.evaluated_at,
            'code_version': self.code_version,
        }


@dataclass(frozen=True)
class GateReport:
    policy_version: str
    promotion_target: str
    overall_status: GateStatus
    promotion_allowed: bool
    candidate_frozen: bool
    recommended_mode: Literal['shadow', 'paper', 'live']
    gates: tuple[GateResult, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            'policy_version': self.policy_version,
            'promotion_target': self.promotion_target,
            'overall_status': self.overall_status,
            'promotion_allowed': self.promotion_allowed,
            'candidate_frozen': self.candidate_frozen,
            'recommended_mode': self.recommended_mode,
            'gates': [gate.to_payload() for gate in self.gates],
        }


def load_gate_policy(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('gate policy payload must be an object')
    return cast(dict[str, Any], payload)


def evaluate_gate_policy_matrix(
    metrics_bundle: dict[str, Any],
    policy: dict[str, Any],
    *,
    code_version: str,
    promotion_target: Literal['shadow', 'paper', 'live'] = 'paper',
    evaluated_at: datetime | None = None,
) -> GateReport:
    now = evaluated_at or datetime.now(timezone.utc)
    evaluated_iso = now.isoformat()
    gate_results = (
        _gate_zero_data_integrity(metrics_bundle, policy, evaluated_iso, code_version),
        _gate_one_statistical_robustness(metrics_bundle, policy, evaluated_iso, code_version),
        _gate_two_risk_capacity(metrics_bundle, policy, evaluated_iso, code_version),
        _gate_three_execution_quality(metrics_bundle, policy, evaluated_iso, code_version),
        _gate_four_operational_readiness(metrics_bundle, policy, evaluated_iso, code_version),
        _gate_five_live_ramp_readiness(metrics_bundle, policy, evaluated_iso, code_version),
    )
    failures = [result for result in gate_results if result.status == 'fail']
    freeze_threshold = int(policy.get('auto_freeze_failure_count', 3))
    candidate_frozen = len(failures) >= freeze_threshold
    live_requested = promotion_target == 'live'
    allow_live = bool(policy.get('allow_live_promotion', False))
    promotion_allowed = len(failures) == 0 and (not live_requested or allow_live)
    if promotion_allowed and promotion_target == 'live':
        recommended_mode: Literal['shadow', 'paper', 'live'] = 'live'
    elif promotion_allowed:
        recommended_mode = 'paper'
    else:
        recommended_mode = 'shadow'
    return GateReport(
        policy_version=str(policy.get('policy_version', 'v3')),
        promotion_target=promotion_target,
        overall_status='pass' if not failures else 'fail',
        promotion_allowed=promotion_allowed,
        candidate_frozen=candidate_frozen,
        recommended_mode=recommended_mode,
        gates=gate_results,
    )


def derive_deterministic_run_id(candidate_spec: dict[str, Any], context: dict[str, Any]) -> str:
    payload = json.dumps({'candidate_spec': candidate_spec, 'context': context}, sort_keys=True, separators=(',', ':'))
    digest = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    return f'torghut-v3-{digest[:16]}'


def build_research_artifact(candidate_spec: dict[str, Any], *, run_id: str) -> dict[str, Any]:
    payload = {
        'run_id': run_id,
        'candidate_spec': candidate_spec,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'stage': 'research_intake',
    }
    payload['checksum'] = _payload_checksum(payload)
    return payload


def build_metrics_bundle(
    evaluation_report: dict[str, Any],
    *,
    data_integrity: dict[str, Any] | None = None,
    paper_execution: dict[str, Any] | None = None,
    operations: dict[str, Any] | None = None,
    rollout: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        'evaluation_report': evaluation_report,
        'data_integrity': data_integrity
        or {
            'schema_compatible': True,
            'feature_null_rate': 0.0,
            'max_feature_null_rate': 0.05,
            'staleness_seconds': 5,
            'max_staleness_seconds': 30,
            'duplicate_rate': 0.0,
            'max_duplicate_rate': 0.01,
            'symbol_coverage': 1.0,
            'min_symbol_coverage': 0.95,
        },
        'paper_execution': paper_execution
        or {
            'tca_slippage_bps': 6.0,
            'max_tca_slippage_bps': 12.0,
            'execution_policy_stable': True,
            'cancel_replace_ratio': 0.05,
            'max_cancel_replace_ratio': 0.2,
        },
        'operations': operations
        or {
            'runbooks_validated': True,
            'kill_switch_dry_run_passed': True,
            'rollback_dry_run_passed': True,
            'alerts_active': True,
        },
        'rollout': rollout
        or {
            'paper_stability_days': 14,
            'required_paper_stability_days': 14,
            'compliance_evidence_complete': True,
            'approval_token_present': False,
            'config_drift': False,
        },
    }
    payload['checksum'] = _payload_checksum(payload)
    return payload


def build_paper_candidate_patch(
    candidate_spec: dict[str, Any],
    gate_report: GateReport,
    *,
    run_id: str,
) -> dict[str, Any]:
    candidate_id = str(candidate_spec.get('candidate_id') or run_id)
    strategy_name = str(candidate_spec.get('strategy_name', f'{candidate_id}-paper'))
    strategy_payload = {
        'name': strategy_name,
        'description': f'candidate_id={candidate_id},runtime=v3',
        'enabled': gate_report.promotion_allowed,
        'base_timeframe': str(candidate_spec.get('base_timeframe', '1Min')),
        'universe_type': str(candidate_spec.get('strategy_type', 'legacy_macd_rsi')),
        'universe_symbols': candidate_spec.get('universe_symbols', []),
        'max_notional_per_trade': candidate_spec.get('max_notional_per_trade', 2500),
        'max_position_pct_equity': candidate_spec.get('max_position_pct_equity', 0.02),
    }
    patch = {
        'apiVersion': 'v1',
        'kind': 'ConfigMap',
        'metadata': {'name': 'torghut-strategy-config', 'namespace': 'torghut'},
        'data': {
            'strategies.yaml': yaml.safe_dump({'strategies': [strategy_payload]}, sort_keys=False).strip() + '\n',
            'autonomy-candidate.json': json.dumps(
                {
                    'run_id': run_id,
                    'candidate_id': candidate_id,
                    'promotion_allowed': gate_report.promotion_allowed,
                    'recommended_mode': gate_report.recommended_mode,
                    'live_enabled': False,
                },
                sort_keys=True,
            ),
        },
    }
    return patch


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding='utf-8')


def _gate_zero_data_integrity(
    metrics_bundle: dict[str, Any], policy: dict[str, Any], evaluated_at: str, code_version: str
) -> GateResult:
    data = _coerce_map(metrics_bundle.get('data_integrity'))
    reasons: list[str] = []
    if not bool(data.get('schema_compatible', False)):
        reasons.append('schema_mismatch')
    if _float(data.get('feature_null_rate')) > _float(data.get('max_feature_null_rate', 0.05)):
        reasons.append('feature_null_rate_exceeded')
    if _float(data.get('staleness_seconds')) > _float(data.get('max_staleness_seconds', 30)):
        reasons.append('staleness_budget_exceeded')
    if _float(data.get('duplicate_rate')) > _float(data.get('max_duplicate_rate', 0.01)):
        reasons.append('duplicate_rate_exceeded')
    if _float(data.get('symbol_coverage', 0.0)) < _float(data.get('min_symbol_coverage', 0.95)):
        reasons.append('symbol_coverage_below_threshold')
    return GateResult(
        gate_id='gate_0_data_integrity',
        status='pass' if not reasons else 'fail',
        reasons=tuple(reasons),
        artifact_refs=('metrics_bundle.data_integrity',),
        evaluated_at=evaluated_at,
        code_version=code_version,
    )


def _gate_one_statistical_robustness(
    metrics_bundle: dict[str, Any], policy: dict[str, Any], evaluated_at: str, code_version: str
) -> GateResult:
    report = _coerce_map(metrics_bundle.get('evaluation_report'))
    robustness = _coerce_map(report.get('robustness'))
    multiple_testing = _coerce_map(report.get('multiple_testing'))
    reasons: list[str] = []
    negative_fold_count = int(robustness.get('negative_fold_count', 0))
    max_negative_fold_count = int(policy.get('gate_1_max_negative_fold_count', 0))
    if negative_fold_count > max_negative_fold_count:
        reasons.append('negative_fold_count_exceeded')
    if bool(multiple_testing.get('warning_triggered', False)):
        reasons.append('multiple_testing_warning')
    return GateResult(
        gate_id='gate_1_statistical_robustness',
        status='pass' if not reasons else 'fail',
        reasons=tuple(reasons),
        artifact_refs=('evaluation_report.robustness', 'evaluation_report.multiple_testing'),
        evaluated_at=evaluated_at,
        code_version=code_version,
    )


def _gate_two_risk_capacity(
    metrics_bundle: dict[str, Any], policy: dict[str, Any], evaluated_at: str, code_version: str
) -> GateResult:
    report = _coerce_map(metrics_bundle.get('evaluation_report'))
    metrics = _coerce_map(report.get('metrics'))
    reasons: list[str] = []
    max_drawdown = _float(metrics.get('max_drawdown', 0.0))
    turnover_ratio = _float(metrics.get('turnover_ratio', 0.0))
    max_drawdown_threshold = _float(policy.get('gate_2_max_drawdown', 0.35))
    max_turnover_threshold = _float(policy.get('gate_2_max_turnover_ratio', 5.0))
    if max_drawdown > max_drawdown_threshold:
        reasons.append('max_drawdown_exceeded')
    if turnover_ratio > max_turnover_threshold:
        reasons.append('turnover_ratio_exceeded')
    return GateResult(
        gate_id='gate_2_risk_capacity',
        status='pass' if not reasons else 'fail',
        reasons=tuple(reasons),
        artifact_refs=('evaluation_report.metrics',),
        evaluated_at=evaluated_at,
        code_version=code_version,
    )


def _gate_three_execution_quality(
    metrics_bundle: dict[str, Any], policy: dict[str, Any], evaluated_at: str, code_version: str
) -> GateResult:
    execution = _coerce_map(metrics_bundle.get('paper_execution'))
    reasons: list[str] = []
    if _float(execution.get('tca_slippage_bps', 0.0)) > _float(execution.get('max_tca_slippage_bps', 12.0)):
        reasons.append('tca_slippage_degraded')
    if not bool(execution.get('execution_policy_stable', False)):
        reasons.append('execution_policy_unstable')
    if _float(execution.get('cancel_replace_ratio', 0.0)) > _float(execution.get('max_cancel_replace_ratio', 0.2)):
        reasons.append('cancel_replace_ratio_exceeded')
    return GateResult(
        gate_id='gate_3_execution_quality',
        status='pass' if not reasons else 'fail',
        reasons=tuple(reasons),
        artifact_refs=('metrics_bundle.paper_execution',),
        evaluated_at=evaluated_at,
        code_version=code_version,
    )


def _gate_four_operational_readiness(
    metrics_bundle: dict[str, Any], policy: dict[str, Any], evaluated_at: str, code_version: str
) -> GateResult:
    ops = _coerce_map(metrics_bundle.get('operations'))
    reasons: list[str] = []
    if not bool(ops.get('runbooks_validated', False)):
        reasons.append('runbooks_not_validated')
    if not bool(ops.get('kill_switch_dry_run_passed', False)):
        reasons.append('kill_switch_dry_run_failed')
    if not bool(ops.get('rollback_dry_run_passed', False)):
        reasons.append('rollback_dry_run_failed')
    if not bool(ops.get('alerts_active', False)):
        reasons.append('alerts_not_active')
    return GateResult(
        gate_id='gate_4_operational_readiness',
        status='pass' if not reasons else 'fail',
        reasons=tuple(reasons),
        artifact_refs=('metrics_bundle.operations',),
        evaluated_at=evaluated_at,
        code_version=code_version,
    )


def _gate_five_live_ramp_readiness(
    metrics_bundle: dict[str, Any], policy: dict[str, Any], evaluated_at: str, code_version: str
) -> GateResult:
    rollout = _coerce_map(metrics_bundle.get('rollout'))
    reasons: list[str] = []
    paper_days = int(rollout.get('paper_stability_days', 0))
    required_days = int(rollout.get('required_paper_stability_days', policy.get('gate_5_required_paper_days', 14)))
    if paper_days < required_days:
        reasons.append('paper_stability_window_not_met')
    if not bool(rollout.get('compliance_evidence_complete', False)):
        reasons.append('compliance_evidence_incomplete')
    if not bool(rollout.get('approval_token_present', False)):
        reasons.append('approval_token_missing')
    if bool(rollout.get('config_drift', False)):
        reasons.append('config_drift_detected')
    return GateResult(
        gate_id='gate_5_live_ramp_readiness',
        status='pass' if not reasons else 'fail',
        reasons=tuple(reasons),
        artifact_refs=('metrics_bundle.rollout',),
        evaluated_at=evaluated_at,
        code_version=code_version,
    )


def _coerce_map(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _payload_checksum(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()

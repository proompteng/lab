"""Gate policy matrix evaluator for Torghut v3 autonomous lanes."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal


GateStatus = Literal['pass', 'fail']
PromotionTarget = Literal['shadow', 'paper', 'live']


def _empty_str_list() -> list[str]:
    return []


def _empty_artifact_refs() -> list[str]:
    return []


def _empty_dict() -> dict[str, Any]:
    return {}


@dataclass(frozen=True)
class GateResult:
    gate_id: str
    status: GateStatus
    reasons: list[str] = field(default_factory=_empty_str_list)
    artifact_refs: list[str] = field(default_factory=_empty_artifact_refs)

    def to_payload(self) -> dict[str, object]:
        return {
            'gate_id': self.gate_id,
            'status': self.status,
            'reasons': list(self.reasons),
            'artifact_refs': list(self.artifact_refs),
        }


@dataclass(frozen=True)
class GateInputs:
    feature_schema_version: str
    required_feature_null_rate: Decimal
    staleness_ms_p95: int
    symbol_coverage: int
    metrics: dict[str, Any]
    robustness: dict[str, Any]
    llm_metrics: dict[str, Any] = field(default_factory=_empty_dict)
    operational_ready: bool = True
    runbook_validated: bool = True
    kill_switch_dry_run_passed: bool = True
    rollback_dry_run_passed: bool = True
    approval_token: str | None = None


@dataclass(frozen=True)
class GatePolicyMatrix:
    policy_version: str = 'v3-gates-1'
    required_feature_schema_version: str = '3.0.0'
    gate0_max_null_rate: Decimal = Decimal('0.01')
    gate0_max_staleness_ms: int = 120000
    gate0_min_symbol_coverage: int = 1

    gate1_min_decision_count: int = 1
    gate1_min_trade_count: int = 1
    gate1_min_net_pnl: Decimal = Decimal('0')
    gate1_max_negative_fold_ratio: Decimal = Decimal('0.5')
    gate1_max_net_pnl_cv: Decimal = Decimal('2.0')

    gate2_max_drawdown: Decimal = Decimal('250')
    gate2_max_turnover_ratio: Decimal = Decimal('8.0')
    gate2_max_cost_bps: Decimal = Decimal('35')

    gate3_max_llm_error_ratio: Decimal = Decimal('0.10')

    gate5_live_enabled: bool = False
    gate5_require_approval_token: bool = True

    @classmethod
    def from_path(cls, path: Path) -> 'GatePolicyMatrix':
        payload = json.loads(path.read_text(encoding='utf-8'))
        return cls(
            policy_version=str(payload.get('policy_version', 'v3-gates-1')),
            required_feature_schema_version=str(payload.get('required_feature_schema_version', '3.0.0')),
            gate0_max_null_rate=_decimal_or_default(payload.get('gate0_max_null_rate'), Decimal('0.01')),
            gate0_max_staleness_ms=int(payload.get('gate0_max_staleness_ms', 120000)),
            gate0_min_symbol_coverage=int(payload.get('gate0_min_symbol_coverage', 1)),
            gate1_min_decision_count=int(payload.get('gate1_min_decision_count', 1)),
            gate1_min_trade_count=int(payload.get('gate1_min_trade_count', 1)),
            gate1_min_net_pnl=_decimal_or_default(payload.get('gate1_min_net_pnl'), Decimal('0')),
            gate1_max_negative_fold_ratio=_decimal_or_default(
                payload.get('gate1_max_negative_fold_ratio'),
                Decimal('0.5'),
            ),
            gate1_max_net_pnl_cv=_decimal_or_default(payload.get('gate1_max_net_pnl_cv'), Decimal('2.0')),
            gate2_max_drawdown=_decimal_or_default(payload.get('gate2_max_drawdown'), Decimal('250')),
            gate2_max_turnover_ratio=_decimal_or_default(payload.get('gate2_max_turnover_ratio'), Decimal('8.0')),
            gate2_max_cost_bps=_decimal_or_default(payload.get('gate2_max_cost_bps'), Decimal('35')),
            gate3_max_llm_error_ratio=_decimal_or_default(payload.get('gate3_max_llm_error_ratio'), Decimal('0.10')),
            gate5_live_enabled=bool(payload.get('gate5_live_enabled', False)),
            gate5_require_approval_token=bool(payload.get('gate5_require_approval_token', True)),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            'policy_version': self.policy_version,
            'required_feature_schema_version': self.required_feature_schema_version,
            'gate0_max_null_rate': str(self.gate0_max_null_rate),
            'gate0_max_staleness_ms': self.gate0_max_staleness_ms,
            'gate0_min_symbol_coverage': self.gate0_min_symbol_coverage,
            'gate1_min_decision_count': self.gate1_min_decision_count,
            'gate1_min_trade_count': self.gate1_min_trade_count,
            'gate1_min_net_pnl': str(self.gate1_min_net_pnl),
            'gate1_max_negative_fold_ratio': str(self.gate1_max_negative_fold_ratio),
            'gate1_max_net_pnl_cv': str(self.gate1_max_net_pnl_cv),
            'gate2_max_drawdown': str(self.gate2_max_drawdown),
            'gate2_max_turnover_ratio': str(self.gate2_max_turnover_ratio),
            'gate2_max_cost_bps': str(self.gate2_max_cost_bps),
            'gate3_max_llm_error_ratio': str(self.gate3_max_llm_error_ratio),
            'gate5_live_enabled': self.gate5_live_enabled,
            'gate5_require_approval_token': self.gate5_require_approval_token,
        }


@dataclass(frozen=True)
class GateEvaluationReport:
    policy_version: str
    promotion_target: PromotionTarget
    promotion_allowed: bool
    recommended_mode: PromotionTarget
    gates: list[GateResult]
    reasons: list[str]
    evaluated_at: datetime
    code_version: str

    def to_payload(self) -> dict[str, object]:
        return {
            'policy_version': self.policy_version,
            'promotion_target': self.promotion_target,
            'promotion_allowed': self.promotion_allowed,
            'recommended_mode': self.recommended_mode,
            'gates': [item.to_payload() for item in self.gates],
            'reasons': list(self.reasons),
            'evaluated_at': self.evaluated_at.isoformat(),
            'code_version': self.code_version,
        }


def evaluate_gate_matrix(
    inputs: GateInputs,
    *,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
    code_version: str,
    evaluated_at: datetime | None = None,
) -> GateEvaluationReport:
    now = evaluated_at or datetime.now(timezone.utc)
    gates: list[GateResult] = []

    gates.append(_gate0_data_integrity(inputs, policy))
    gates.append(_gate1_statistical_robustness(inputs, policy))
    gates.append(_gate2_risk_and_capacity(inputs, policy))
    gates.append(_gate3_shadow_paper_quality(inputs, policy))
    gates.append(_gate4_operational_readiness(inputs))
    gates.append(_gate5_live_ramp_readiness(inputs, policy, promotion_target))

    all_required_pass = all(gate.status == 'pass' for gate in gates[:5])
    gate5_pass = gates[5].status == 'pass'

    reasons = [reason for gate in gates for reason in gate.reasons]
    recommended_mode: PromotionTarget = 'shadow'
    promotion_allowed = False

    if promotion_target == 'shadow':
        promotion_allowed = all_required_pass
        recommended_mode = 'shadow'
    elif promotion_target == 'paper':
        promotion_allowed = all_required_pass
        recommended_mode = 'paper' if all_required_pass else 'shadow'
    elif promotion_target == 'live':
        promotion_allowed = all_required_pass and gate5_pass
        if promotion_allowed:
            recommended_mode = 'live'
        elif all_required_pass:
            recommended_mode = 'paper'

    return GateEvaluationReport(
        policy_version=policy.policy_version,
        promotion_target=promotion_target,
        promotion_allowed=promotion_allowed,
        recommended_mode=recommended_mode,
        gates=gates,
        reasons=reasons,
        evaluated_at=now,
        code_version=code_version,
    )


def _gate0_data_integrity(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
    reasons: list[str] = []
    if inputs.feature_schema_version != policy.required_feature_schema_version:
        reasons.append('schema_version_incompatible')
    if inputs.required_feature_null_rate > policy.gate0_max_null_rate:
        reasons.append('required_feature_null_rate_exceeds_threshold')
    if inputs.staleness_ms_p95 > policy.gate0_max_staleness_ms:
        reasons.append('feature_staleness_exceeds_budget')
    if inputs.symbol_coverage < policy.gate0_min_symbol_coverage:
        reasons.append('symbol_coverage_below_minimum')
    return GateResult(gate_id='gate0_data_integrity', status='pass' if not reasons else 'fail', reasons=reasons)


def _gate1_statistical_robustness(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
    reasons: list[str] = []
    decision_count = int(inputs.metrics.get('decision_count', 0))
    trade_count = int(inputs.metrics.get('trade_count', 0))
    net_pnl = _decimal(inputs.metrics.get('net_pnl')) or Decimal('0')
    fold_count = int(inputs.robustness.get('fold_count', 0))
    negative_fold_count = int(inputs.robustness.get('negative_fold_count', 0))
    net_pnl_cv = _decimal(inputs.robustness.get('net_pnl_cv'))

    if decision_count < policy.gate1_min_decision_count:
        reasons.append('decision_count_below_minimum')
    if trade_count < policy.gate1_min_trade_count:
        reasons.append('trade_count_below_minimum')
    if net_pnl < policy.gate1_min_net_pnl:
        reasons.append('net_pnl_below_minimum')

    if fold_count > 0:
        negative_ratio = Decimal(negative_fold_count) / Decimal(fold_count)
        if negative_ratio > policy.gate1_max_negative_fold_ratio:
            reasons.append('negative_fold_ratio_exceeds_threshold')
    if net_pnl_cv is not None and net_pnl_cv > policy.gate1_max_net_pnl_cv:
        reasons.append('net_pnl_cv_exceeds_threshold')

    return GateResult(gate_id='gate1_statistical_robustness', status='pass' if not reasons else 'fail', reasons=reasons)


def _gate2_risk_and_capacity(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
    reasons: list[str] = []
    max_drawdown = _decimal(inputs.metrics.get('max_drawdown')) or Decimal('0')
    turnover_ratio = _decimal(inputs.metrics.get('turnover_ratio')) or Decimal('0')
    cost_bps = _decimal(inputs.metrics.get('cost_bps')) or Decimal('0')

    if max_drawdown > policy.gate2_max_drawdown:
        reasons.append('drawdown_exceeds_maximum')
    if turnover_ratio > policy.gate2_max_turnover_ratio:
        reasons.append('turnover_ratio_exceeds_maximum')
    if cost_bps > policy.gate2_max_cost_bps:
        reasons.append('cost_bps_exceeds_maximum')

    return GateResult(gate_id='gate2_risk_capacity', status='pass' if not reasons else 'fail', reasons=reasons)


def _gate3_shadow_paper_quality(inputs: GateInputs, policy: GatePolicyMatrix) -> GateResult:
    reasons: list[str] = []
    llm_error_ratio = _decimal(inputs.llm_metrics.get('error_ratio')) or Decimal('0')
    if llm_error_ratio > policy.gate3_max_llm_error_ratio:
        reasons.append('llm_error_ratio_exceeds_threshold')
    return GateResult(gate_id='gate3_shadow_paper_quality', status='pass' if not reasons else 'fail', reasons=reasons)


def _gate4_operational_readiness(inputs: GateInputs) -> GateResult:
    reasons: list[str] = []
    if not inputs.operational_ready:
        reasons.append('operational_readiness_incomplete')
    if not inputs.runbook_validated:
        reasons.append('runbook_not_validated')
    if not inputs.kill_switch_dry_run_passed:
        reasons.append('kill_switch_dry_run_failed')
    if not inputs.rollback_dry_run_passed:
        reasons.append('rollback_dry_run_failed')
    return GateResult(gate_id='gate4_operational_readiness', status='pass' if not reasons else 'fail', reasons=reasons)


def _gate5_live_ramp_readiness(
    inputs: GateInputs,
    policy: GatePolicyMatrix,
    promotion_target: PromotionTarget,
) -> GateResult:
    reasons: list[str] = []
    if promotion_target != 'live':
        return GateResult(gate_id='gate5_live_ramp_readiness', status='pass', reasons=[])

    if not policy.gate5_live_enabled:
        reasons.append('live_rollout_disabled_by_policy')
    if policy.gate5_require_approval_token and not inputs.approval_token:
        reasons.append('approval_token_missing')

    return GateResult(gate_id='gate5_live_ramp_readiness', status='pass' if not reasons else 'fail', reasons=reasons)


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    parsed = _decimal(value)
    if parsed is None:
        return default
    return parsed


__all__ = [
    'GateEvaluationReport',
    'GateInputs',
    'GatePolicyMatrix',
    'GateResult',
    'PromotionTarget',
    'evaluate_gate_matrix',
]

"""Typed contracts for Torghut autonomy gate evaluation."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

GateStatus = Literal["pass", "fail"]

UncertaintyGateAction = Literal["pass", "degrade", "abstain", "fail"]

PromotionTarget = Literal["shadow", "paper", "live"]


def empty_str_list() -> list[str]:
    return []


def empty_artifact_refs() -> list[str]:
    return []


def empty_dict() -> dict[str, Any]:
    return {}


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    if value is None:
        return default
    try:
        parsed = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return default
    if not parsed.is_finite():
        return default
    return parsed


@dataclass(frozen=True)
class GateResult:
    gate_id: str
    status: GateStatus
    reasons: list[str] = field(default_factory=empty_str_list)
    artifact_refs: list[str] = field(default_factory=empty_artifact_refs)

    def to_payload(self) -> dict[str, object]:
        return {
            "gate_id": self.gate_id,
            "status": self.status,
            "reasons": list(self.reasons),
            "artifact_refs": list(self.artifact_refs),
        }


@dataclass(frozen=True)
class GateInputs:
    feature_schema_version: str
    required_feature_null_rate: Decimal
    staleness_ms_p95: int | None
    symbol_coverage: int
    metrics: dict[str, Any]
    robustness: dict[str, Any]
    tca_metrics: dict[str, Any] = field(default_factory=empty_dict)
    llm_metrics: dict[str, Any] = field(default_factory=empty_dict)
    forecast_metrics: dict[str, Any] = field(default_factory=empty_dict)
    profitability_evidence: dict[str, Any] = field(default_factory=empty_dict)
    fragility_state: str = "elevated"
    fragility_score: Decimal = Decimal("0.5")
    stability_mode_active: bool = False
    fragility_inputs_valid: bool = True
    operational_ready: bool = True
    runbook_validated: bool = True
    kill_switch_dry_run_passed: bool = True
    rollback_dry_run_passed: bool = True
    approval_token: str | None = None


@dataclass(frozen=True)
class GatePolicyMatrix:
    policy_version: str = "v3-gates-1"
    required_feature_schema_version: str = "3.0.0"
    gate0_max_null_rate: Decimal = Decimal("0.01")
    gate0_max_staleness_ms: int = 120000
    gate0_min_symbol_coverage: int = 1

    gate1_min_decision_count: int = 1
    gate1_min_trade_count: int = 1
    gate1_min_net_pnl: Decimal = Decimal("0")
    gate1_max_negative_fold_ratio: Decimal = Decimal("0.5")
    gate1_max_net_pnl_cv: Decimal = Decimal("2.0")

    gate2_max_drawdown: Decimal = Decimal("250")
    gate2_max_turnover_ratio: Decimal = Decimal("8.0")
    gate2_max_cost_bps: Decimal = Decimal("35")
    gate2_max_tca_slippage_bps: Decimal = Decimal("25")
    gate2_max_tca_shortfall_notional: Decimal = Decimal("25")
    gate2_max_tca_churn_ratio: Decimal = Decimal("0.75")
    gate2_max_tca_realized_shortfall_bps: Decimal = Decimal("25")
    gate2_max_tca_divergence_bps: Decimal = Decimal("12")
    gate2_max_tca_calibration_error_bps: Decimal = Decimal("12")
    gate2_min_tca_expected_shortfall_coverage: Decimal = Decimal("0")
    gate2_max_fragility_score: Decimal = Decimal("0.85")
    gate2_max_fragility_state_rank: int = 2
    gate2_require_stability_mode_under_stress: bool = True

    gate3_max_llm_error_ratio: Decimal = Decimal("0.10")
    gate3_max_forecast_fallback_rate: Decimal = Decimal("0.05")
    gate3_max_forecast_latency_ms_p95: int = 200
    gate3_min_forecast_calibration_score: Decimal = Decimal("0.85")
    gate6_require_profitability_evidence: bool = True
    gate6_min_market_net_pnl_delta: Decimal = Decimal("0")
    gate6_min_regime_slice_pass_ratio: Decimal = Decimal("0.50")
    gate6_min_return_over_drawdown: Decimal = Decimal("0")
    gate6_max_cost_bps: Decimal = Decimal("35")
    gate6_max_calibration_error: Decimal = Decimal("0.45")
    gate6_min_reproducibility_hashes: int = 5
    gate6_require_janus_evidence: bool = True
    gate6_min_janus_event_count: int = 1
    gate6_min_janus_reward_count: int = 1
    gate7_target_coverage: Decimal = Decimal("0.90")
    gate7_max_coverage_error_pass: Decimal = Decimal("0.03")
    gate7_max_coverage_error_degrade: Decimal = Decimal("0.05")
    gate7_max_coverage_error_abstain: Decimal = Decimal("0.08")
    gate7_shift_score_degrade: Decimal = Decimal("0.60")
    gate7_shift_score_abstain: Decimal = Decimal("0.80")
    gate7_shift_score_fail: Decimal = Decimal("0.95")
    gate7_max_interval_width_pass: Decimal = Decimal("1.25")
    gate7_max_interval_width_degrade: Decimal = Decimal("1.75")

    gate5_live_enabled: bool = False
    gate5_require_approval_token: bool = True

    @classmethod
    def from_path(cls, path: Path) -> "GatePolicyMatrix":
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            policy_version=str(payload.get("policy_version", "v3-gates-1")),
            required_feature_schema_version=str(
                payload.get("required_feature_schema_version", "3.0.0")
            ),
            gate0_max_null_rate=_decimal_or_default(
                payload.get("gate0_max_null_rate"), Decimal("0.01")
            ),
            gate0_max_staleness_ms=int(payload.get("gate0_max_staleness_ms", 120000)),
            gate0_min_symbol_coverage=int(payload.get("gate0_min_symbol_coverage", 1)),
            gate1_min_decision_count=int(payload.get("gate1_min_decision_count", 1)),
            gate1_min_trade_count=int(payload.get("gate1_min_trade_count", 1)),
            gate1_min_net_pnl=_decimal_or_default(
                payload.get("gate1_min_net_pnl"), Decimal("0")
            ),
            gate1_max_negative_fold_ratio=_decimal_or_default(
                payload.get("gate1_max_negative_fold_ratio"),
                Decimal("0.5"),
            ),
            gate1_max_net_pnl_cv=_decimal_or_default(
                payload.get("gate1_max_net_pnl_cv"), Decimal("2.0")
            ),
            gate2_max_drawdown=_decimal_or_default(
                payload.get("gate2_max_drawdown"), Decimal("250")
            ),
            gate2_max_turnover_ratio=_decimal_or_default(
                payload.get("gate2_max_turnover_ratio"), Decimal("8.0")
            ),
            gate2_max_cost_bps=_decimal_or_default(
                payload.get("gate2_max_cost_bps"), Decimal("35")
            ),
            gate2_max_tca_slippage_bps=_decimal_or_default(
                payload.get("gate2_max_tca_slippage_bps"), Decimal("25")
            ),
            gate2_max_tca_shortfall_notional=_decimal_or_default(
                payload.get("gate2_max_tca_shortfall_notional"),
                Decimal("25"),
            ),
            gate2_max_tca_churn_ratio=_decimal_or_default(
                payload.get("gate2_max_tca_churn_ratio"), Decimal("0.75")
            ),
            gate2_max_tca_realized_shortfall_bps=_decimal_or_default(
                payload.get("gate2_max_tca_realized_shortfall_bps"), Decimal("25")
            ),
            gate2_max_tca_divergence_bps=_decimal_or_default(
                payload.get("gate2_max_tca_divergence_bps"), Decimal("12")
            ),
            gate2_max_tca_calibration_error_bps=_decimal_or_default(
                payload.get("gate2_max_tca_calibration_error_bps"),
                Decimal("12"),
            ),
            gate2_min_tca_expected_shortfall_coverage=_decimal_or_default(
                payload.get("gate2_min_tca_expected_shortfall_coverage"), Decimal("0")
            ),
            gate2_max_fragility_score=_decimal_or_default(
                payload.get("gate2_max_fragility_score"), Decimal("0.85")
            ),
            gate2_max_fragility_state_rank=int(
                payload.get("gate2_max_fragility_state_rank", 2)
            ),
            gate2_require_stability_mode_under_stress=bool(
                payload.get("gate2_require_stability_mode_under_stress", True)
            ),
            gate3_max_llm_error_ratio=_decimal_or_default(
                payload.get("gate3_max_llm_error_ratio"), Decimal("0.10")
            ),
            gate3_max_forecast_fallback_rate=_decimal_or_default(
                payload.get("gate3_max_forecast_fallback_rate"), Decimal("0.05")
            ),
            gate3_max_forecast_latency_ms_p95=int(
                payload.get("gate3_max_forecast_latency_ms_p95", 200)
            ),
            gate3_min_forecast_calibration_score=_decimal_or_default(
                payload.get("gate3_min_forecast_calibration_score"), Decimal("0.85")
            ),
            gate6_require_profitability_evidence=bool(
                payload.get("gate6_require_profitability_evidence", True)
            ),
            gate6_min_market_net_pnl_delta=_decimal_or_default(
                payload.get("gate6_min_market_net_pnl_delta"),
                Decimal("0"),
            ),
            gate6_min_regime_slice_pass_ratio=_decimal_or_default(
                payload.get("gate6_min_regime_slice_pass_ratio"),
                Decimal("0.50"),
            ),
            gate6_min_return_over_drawdown=_decimal_or_default(
                payload.get("gate6_min_return_over_drawdown"),
                Decimal("0"),
            ),
            gate6_max_cost_bps=_decimal_or_default(
                payload.get("gate6_max_cost_bps"), Decimal("35")
            ),
            gate6_max_calibration_error=_decimal_or_default(
                payload.get("gate6_max_calibration_error"),
                Decimal("0.45"),
            ),
            gate6_min_reproducibility_hashes=int(
                payload.get("gate6_min_reproducibility_hashes", 5)
            ),
            gate6_require_janus_evidence=bool(
                payload.get("gate6_require_janus_evidence", True)
            ),
            gate6_min_janus_event_count=int(
                payload.get("gate6_min_janus_event_count", 1)
            ),
            gate6_min_janus_reward_count=int(
                payload.get("gate6_min_janus_reward_count", 1)
            ),
            gate7_target_coverage=_decimal_or_default(
                payload.get("gate7_target_coverage"),
                Decimal("0.90"),
            ),
            gate7_max_coverage_error_pass=_decimal_or_default(
                payload.get("gate7_max_coverage_error_pass"),
                Decimal("0.03"),
            ),
            gate7_max_coverage_error_degrade=_decimal_or_default(
                payload.get("gate7_max_coverage_error_degrade"),
                Decimal("0.05"),
            ),
            gate7_max_coverage_error_abstain=_decimal_or_default(
                payload.get("gate7_max_coverage_error_abstain"),
                Decimal("0.08"),
            ),
            gate7_shift_score_degrade=_decimal_or_default(
                payload.get("gate7_shift_score_degrade"),
                Decimal("0.60"),
            ),
            gate7_shift_score_abstain=_decimal_or_default(
                payload.get("gate7_shift_score_abstain"),
                Decimal("0.80"),
            ),
            gate7_shift_score_fail=_decimal_or_default(
                payload.get("gate7_shift_score_fail"),
                Decimal("0.95"),
            ),
            gate7_max_interval_width_pass=_decimal_or_default(
                payload.get("gate7_max_interval_width_pass"),
                Decimal("1.25"),
            ),
            gate7_max_interval_width_degrade=_decimal_or_default(
                payload.get("gate7_max_interval_width_degrade"),
                Decimal("1.75"),
            ),
            gate5_live_enabled=bool(payload.get("gate5_live_enabled", False)),
            gate5_require_approval_token=bool(
                payload.get("gate5_require_approval_token", True)
            ),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "required_feature_schema_version": self.required_feature_schema_version,
            "gate0_max_null_rate": str(self.gate0_max_null_rate),
            "gate0_max_staleness_ms": self.gate0_max_staleness_ms,
            "gate0_min_symbol_coverage": self.gate0_min_symbol_coverage,
            "gate1_min_decision_count": self.gate1_min_decision_count,
            "gate1_min_trade_count": self.gate1_min_trade_count,
            "gate1_min_net_pnl": str(self.gate1_min_net_pnl),
            "gate1_max_negative_fold_ratio": str(self.gate1_max_negative_fold_ratio),
            "gate1_max_net_pnl_cv": str(self.gate1_max_net_pnl_cv),
            "gate2_max_drawdown": str(self.gate2_max_drawdown),
            "gate2_max_turnover_ratio": str(self.gate2_max_turnover_ratio),
            "gate2_max_cost_bps": str(self.gate2_max_cost_bps),
            "gate2_max_tca_slippage_bps": str(self.gate2_max_tca_slippage_bps),
            "gate2_max_tca_shortfall_notional": str(
                self.gate2_max_tca_shortfall_notional
            ),
            "gate2_max_tca_churn_ratio": str(self.gate2_max_tca_churn_ratio),
            "gate2_max_tca_realized_shortfall_bps": str(
                self.gate2_max_tca_realized_shortfall_bps
            ),
            "gate2_max_tca_divergence_bps": str(self.gate2_max_tca_divergence_bps),
            "gate2_max_tca_calibration_error_bps": str(
                self.gate2_max_tca_calibration_error_bps
            ),
            "gate2_min_tca_expected_shortfall_coverage": str(
                self.gate2_min_tca_expected_shortfall_coverage
            ),
            "gate2_max_fragility_score": str(self.gate2_max_fragility_score),
            "gate2_max_fragility_state_rank": self.gate2_max_fragility_state_rank,
            "gate2_require_stability_mode_under_stress": self.gate2_require_stability_mode_under_stress,
            "gate3_max_llm_error_ratio": str(self.gate3_max_llm_error_ratio),
            "gate3_max_forecast_fallback_rate": str(
                self.gate3_max_forecast_fallback_rate
            ),
            "gate3_max_forecast_latency_ms_p95": self.gate3_max_forecast_latency_ms_p95,
            "gate3_min_forecast_calibration_score": str(
                self.gate3_min_forecast_calibration_score
            ),
            "gate6_require_profitability_evidence": self.gate6_require_profitability_evidence,
            "gate6_min_market_net_pnl_delta": str(self.gate6_min_market_net_pnl_delta),
            "gate6_min_regime_slice_pass_ratio": str(
                self.gate6_min_regime_slice_pass_ratio
            ),
            "gate6_min_return_over_drawdown": str(self.gate6_min_return_over_drawdown),
            "gate6_max_cost_bps": str(self.gate6_max_cost_bps),
            "gate6_max_calibration_error": str(self.gate6_max_calibration_error),
            "gate6_min_reproducibility_hashes": self.gate6_min_reproducibility_hashes,
            "gate6_require_janus_evidence": self.gate6_require_janus_evidence,
            "gate6_min_janus_event_count": self.gate6_min_janus_event_count,
            "gate6_min_janus_reward_count": self.gate6_min_janus_reward_count,
            "gate7_target_coverage": str(self.gate7_target_coverage),
            "gate7_max_coverage_error_pass": str(self.gate7_max_coverage_error_pass),
            "gate7_max_coverage_error_degrade": str(
                self.gate7_max_coverage_error_degrade
            ),
            "gate7_max_coverage_error_abstain": str(
                self.gate7_max_coverage_error_abstain
            ),
            "gate7_shift_score_degrade": str(self.gate7_shift_score_degrade),
            "gate7_shift_score_abstain": str(self.gate7_shift_score_abstain),
            "gate7_shift_score_fail": str(self.gate7_shift_score_fail),
            "gate7_max_interval_width_pass": str(self.gate7_max_interval_width_pass),
            "gate7_max_interval_width_degrade": str(
                self.gate7_max_interval_width_degrade
            ),
            "gate5_live_enabled": self.gate5_live_enabled,
            "gate5_require_approval_token": self.gate5_require_approval_token,
        }


@dataclass(frozen=True)
class GateEvaluationReport:
    policy_version: str
    promotion_target: PromotionTarget
    promotion_allowed: bool
    recommended_mode: PromotionTarget
    gates: list[GateResult]
    reasons: list[str]
    uncertainty_gate_action: UncertaintyGateAction
    coverage_error: str | None
    conformal_interval_width: str | None
    shift_score: str | None
    recalibration_run_id: str | None
    evaluated_at: datetime
    code_version: str
    evidence_collection_allowed: bool = False
    promotion_blockers: list[str] = field(default_factory=empty_str_list)

    def to_payload(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "promotion_target": self.promotion_target,
            "promotion_allowed": self.promotion_allowed,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "evidence_collection_allowed": self.evidence_collection_allowed,
            "bounded_evidence_collection_authorized": self.evidence_collection_allowed,
            "authority_source": "autonomy_gate_status_only",
            "recommended_mode": self.recommended_mode,
            "gates": [item.to_payload() for item in self.gates],
            "reasons": list(self.reasons),
            "promotion_blockers": list(self.promotion_blockers),
            "uncertainty_gate_action": self.uncertainty_gate_action,
            "coverage_error": self.coverage_error,
            "conformal_interval_width": self.conformal_interval_width,
            "shift_score": self.shift_score,
            "recalibration_run_id": self.recalibration_run_id,
            "evaluated_at": self.evaluated_at.isoformat(),
            "code_version": self.code_version,
        }


@dataclass(frozen=True)
class UncertaintyGateOutcome:
    action: UncertaintyGateAction
    coverage_error: Decimal | None
    shift_score: Decimal | None
    avg_interval_width: Decimal | None
    recalibration_run_id: str | None


__all__ = (
    "GateEvaluationReport",
    "GateInputs",
    "GatePolicyMatrix",
    "GateResult",
    "GateStatus",
    "PromotionTarget",
    "UncertaintyGateAction",
    "UncertaintyGateOutcome",
    "empty_artifact_refs",
    "empty_dict",
    "empty_str_list",
)

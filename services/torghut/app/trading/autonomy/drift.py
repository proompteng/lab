"""Deterministic drift governance for autonomous promotion and rollback safety."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, cast

from ..feature_quality import FeatureQualityReport

DriftCategory = str
DriftActionType = str

REASON_DATA_NULL_RATE = "data_required_null_rate_exceeded"
REASON_DATA_STALENESS = "data_staleness_p95_exceeded"
REASON_DATA_DUPLICATE_RATIO = "data_duplicate_ratio_exceeded"
REASON_DATA_SCHEMA_MISMATCH = "data_schema_mismatch_detected"
REASON_MODEL_CALIBRATION_ERROR = "model_calibration_error_exceeded"
REASON_MODEL_LLM_ERROR_RATIO = "model_llm_error_ratio_exceeded"
REASON_PERF_NET_PNL = "performance_net_pnl_below_floor"
REASON_PERF_DRAWDOWN = "performance_drawdown_exceeded"
REASON_PERF_COST_BPS = "performance_cost_bps_exceeded"
REASON_PERF_FALLBACK_RATIO = "performance_execution_fallback_ratio_exceeded"
_EMPTY_MAPPING: Mapping[str, Any] = cast(Mapping[str, Any], {})


@dataclass(frozen=True)
class DriftThresholds:
    max_required_null_rate: Decimal = Decimal("0.02")
    max_staleness_ms_p95: int = 180000
    max_duplicate_ratio: Decimal = Decimal("0.05")
    max_schema_mismatch_total: int = 0
    max_model_calibration_error: Decimal = Decimal("0.45")
    max_model_llm_error_ratio: Decimal = Decimal("0.10")
    min_performance_net_pnl: Decimal = Decimal("0")
    max_performance_drawdown: Decimal = Decimal("0.08")
    max_performance_cost_bps: Decimal = Decimal("35")
    max_execution_fallback_ratio: Decimal = Decimal("0.25")

    def to_payload(self) -> dict[str, Any]:
        return {
            "max_required_null_rate": str(self.max_required_null_rate),
            "max_staleness_ms_p95": self.max_staleness_ms_p95,
            "max_duplicate_ratio": str(self.max_duplicate_ratio),
            "max_schema_mismatch_total": self.max_schema_mismatch_total,
            "max_model_calibration_error": str(self.max_model_calibration_error),
            "max_model_llm_error_ratio": str(self.max_model_llm_error_ratio),
            "min_performance_net_pnl": str(self.min_performance_net_pnl),
            "max_performance_drawdown": str(self.max_performance_drawdown),
            "max_performance_cost_bps": str(self.max_performance_cost_bps),
            "max_execution_fallback_ratio": str(self.max_execution_fallback_ratio),
        }


@dataclass(frozen=True)
class DriftSignal:
    category: DriftCategory
    reason_code: str
    observed: str
    threshold: str
    comparator: str

    def to_payload(self) -> dict[str, str]:
        return {
            "category": self.category,
            "reason_code": self.reason_code,
            "observed": self.observed,
            "threshold": self.threshold,
            "comparator": self.comparator,
        }


@dataclass(frozen=True)
class DriftDetectionReport:
    run_id: str
    detected_at: datetime
    incident_id: str
    drift_detected: bool
    reason_codes: list[str]
    signals: list[DriftSignal]
    thresholds: DriftThresholds

    def to_payload(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "detected_at": self.detected_at.isoformat(),
            "incident_id": self.incident_id,
            "drift_detected": self.drift_detected,
            "reason_codes": list(self.reason_codes),
            "signals": [item.to_payload() for item in self.signals],
            "thresholds": self.thresholds.to_payload(),
        }


@dataclass(frozen=True)
class DriftTriggerPolicy:
    retrain_reason_codes: set[str] = field(
        default_factory=lambda: {
            REASON_DATA_NULL_RATE,
            REASON_DATA_STALENESS,
            REASON_DATA_DUPLICATE_RATIO,
            REASON_DATA_SCHEMA_MISMATCH,
            REASON_MODEL_CALIBRATION_ERROR,
            REASON_MODEL_LLM_ERROR_RATIO,
        }
    )
    reselection_reason_codes: set[str] = field(
        default_factory=lambda: {
            REASON_PERF_NET_PNL,
            REASON_PERF_DRAWDOWN,
            REASON_PERF_COST_BPS,
            REASON_PERF_FALLBACK_RATIO,
        }
    )
    retrain_cooldown_seconds: int = 3600
    reselection_cooldown_seconds: int = 3600

    def to_payload(self) -> dict[str, Any]:
        return {
            "retrain_reason_codes": sorted(self.retrain_reason_codes),
            "reselection_reason_codes": sorted(self.reselection_reason_codes),
            "retrain_cooldown_seconds": self.retrain_cooldown_seconds,
            "reselection_cooldown_seconds": self.reselection_cooldown_seconds,
        }


@dataclass(frozen=True)
class DriftActionDecision:
    action_id: str
    action_type: DriftActionType
    triggered: bool
    cooldown_active: bool
    cooldown_remaining_seconds: int
    reason_codes: list[str]

    def to_payload(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "action_type": self.action_type,
            "triggered": self.triggered,
            "cooldown_active": self.cooldown_active,
            "cooldown_remaining_seconds": self.cooldown_remaining_seconds,
            "reason_codes": list(self.reason_codes),
        }


@dataclass(frozen=True)
class DriftPromotionEvidence:
    checked_at: datetime
    incident_id: str | None
    eligible_for_live_promotion: bool
    reasons: list[str]
    reason_codes: list[str]
    evidence_artifact_refs: list[str]

    def to_payload(self) -> dict[str, Any]:
        return {
            "checked_at": self.checked_at.isoformat(),
            "incident_id": self.incident_id,
            "eligible_for_live_promotion": self.eligible_for_live_promotion,
            "reasons": list(self.reasons),
            "reason_codes": list(self.reason_codes),
            "evidence_artifact_refs": list(self.evidence_artifact_refs),
        }


def detect_drift(
    *,
    run_id: str,
    feature_quality_report: FeatureQualityReport,
    gate_report_payload: Mapping[str, Any],
    fallback_ratio: Decimal,
    thresholds: DriftThresholds,
    detected_at: datetime | None = None,
) -> DriftDetectionReport:
    now = detected_at or datetime.now(timezone.utc)
    signals: list[DriftSignal] = []
    signals.extend(_data_drift_signals(feature_quality_report, thresholds))
    signals.extend(_model_drift_signals(gate_report_payload, thresholds))
    signals.extend(
        _performance_drift_signals(
            gate_report_payload=gate_report_payload,
            fallback_ratio=fallback_ratio,
            thresholds=thresholds,
        )
    )

    reason_codes = sorted({item.reason_code for item in signals})
    incident_id = _stable_digest(
        {
            "run_id": run_id,
            "reason_codes": reason_codes,
            "thresholds": thresholds.to_payload(),
        }
    )
    return DriftDetectionReport(
        run_id=run_id,
        detected_at=now,
        incident_id=incident_id,
        drift_detected=bool(reason_codes),
        reason_codes=reason_codes,
        signals=signals,
        thresholds=thresholds,
    )


def _data_drift_signals(
    feature_quality_report: FeatureQualityReport,
    thresholds: DriftThresholds,
) -> list[DriftSignal]:
    signals: list[DriftSignal] = []
    max_null_rate = max(
        (
            Decimal(str(value))
            for value in feature_quality_report.null_rate_by_field.values()
        ),
        default=Decimal("0"),
    )
    if max_null_rate > thresholds.max_required_null_rate:
        signals.append(
            _drift_signal(
                category="data",
                reason_code=REASON_DATA_NULL_RATE,
                observed=max_null_rate,
                threshold=thresholds.max_required_null_rate,
                comparator=">",
            )
        )

    staleness = int(feature_quality_report.staleness_ms_p95)
    if staleness > thresholds.max_staleness_ms_p95:
        signals.append(
            _drift_signal(
                category="data",
                reason_code=REASON_DATA_STALENESS,
                observed=staleness,
                threshold=thresholds.max_staleness_ms_p95,
                comparator=">",
            )
        )

    duplicate_ratio = Decimal(str(feature_quality_report.duplicate_ratio))
    if duplicate_ratio > thresholds.max_duplicate_ratio:
        signals.append(
            _drift_signal(
                category="data",
                reason_code=REASON_DATA_DUPLICATE_RATIO,
                observed=duplicate_ratio,
                threshold=thresholds.max_duplicate_ratio,
                comparator=">",
            )
        )

    schema_mismatch_total = int(feature_quality_report.schema_mismatch_total)
    if schema_mismatch_total > thresholds.max_schema_mismatch_total:
        signals.append(
            _drift_signal(
                category="data",
                reason_code=REASON_DATA_SCHEMA_MISMATCH,
                observed=feature_quality_report.schema_mismatch_total,
                threshold=thresholds.max_schema_mismatch_total,
                comparator=">",
            )
        )
    return signals


def _model_drift_signals(
    gate_report_payload: Mapping[str, Any],
    thresholds: DriftThresholds,
) -> list[DriftSignal]:
    signals: list[DriftSignal] = []
    llm_payload = _as_mapping(gate_report_payload.get("llm_metrics"))
    profitability_payload = _as_mapping(
        gate_report_payload.get("profitability_evidence")
    )

    calibration = _extract_profitability_decimal(
        profitability_payload, ["confidence_calibration", "calibration_error"]
    )
    if calibration is not None and calibration > thresholds.max_model_calibration_error:
        signals.append(
            _drift_signal(
                category="model",
                reason_code=REASON_MODEL_CALIBRATION_ERROR,
                observed=calibration,
                threshold=thresholds.max_model_calibration_error,
                comparator=">",
            )
        )

    llm_error_ratio = _to_decimal(llm_payload.get("error_ratio"))
    if (
        llm_error_ratio is not None
        and llm_error_ratio > thresholds.max_model_llm_error_ratio
    ):
        signals.append(
            _drift_signal(
                category="model",
                reason_code=REASON_MODEL_LLM_ERROR_RATIO,
                observed=llm_error_ratio,
                threshold=thresholds.max_model_llm_error_ratio,
                comparator=">",
            )
        )
    return signals


def _performance_drift_signals(
    *,
    gate_report_payload: Mapping[str, Any],
    fallback_ratio: Decimal,
    thresholds: DriftThresholds,
) -> list[DriftSignal]:
    signals: list[DriftSignal] = []
    metrics_payload = _as_mapping(gate_report_payload.get("metrics"))

    net_pnl = _to_decimal(metrics_payload.get("net_pnl"))
    if net_pnl is not None and net_pnl < thresholds.min_performance_net_pnl:
        signals.append(
            _drift_signal(
                category="performance",
                reason_code=REASON_PERF_NET_PNL,
                observed=net_pnl,
                threshold=thresholds.min_performance_net_pnl,
                comparator="<",
            )
        )

    max_drawdown = _to_decimal(metrics_payload.get("max_drawdown"))
    if (
        max_drawdown is not None
        and abs(max_drawdown) > thresholds.max_performance_drawdown
    ):
        signals.append(
            _drift_signal(
                category="performance",
                reason_code=REASON_PERF_DRAWDOWN,
                observed=abs(max_drawdown),
                threshold=thresholds.max_performance_drawdown,
                comparator=">",
            )
        )

    cost_bps = _to_decimal(metrics_payload.get("cost_bps"))
    if cost_bps is not None and cost_bps > thresholds.max_performance_cost_bps:
        signals.append(
            _drift_signal(
                category="performance",
                reason_code=REASON_PERF_COST_BPS,
                observed=cost_bps,
                threshold=thresholds.max_performance_cost_bps,
                comparator=">",
            )
        )

    if fallback_ratio > thresholds.max_execution_fallback_ratio:
        signals.append(
            _drift_signal(
                category="performance",
                reason_code=REASON_PERF_FALLBACK_RATIO,
                observed=fallback_ratio,
                threshold=thresholds.max_execution_fallback_ratio,
                comparator=">",
            )
        )
    return signals


def _drift_signal(
    *,
    category: DriftCategory,
    reason_code: str,
    observed: object,
    threshold: object,
    comparator: str,
) -> DriftSignal:
    return DriftSignal(
        category=category,
        reason_code=reason_code,
        observed=str(observed),
        threshold=str(threshold),
        comparator=comparator,
    )


def decide_drift_action(
    *,
    detection: DriftDetectionReport,
    policy: DriftTriggerPolicy,
    last_action_type: str | None,
    last_action_at: datetime | None,
    now: datetime | None = None,
) -> DriftActionDecision:
    current = now or datetime.now(timezone.utc)
    if not detection.drift_detected:
        action_id = _stable_digest(
            {"incident_id": detection.incident_id, "action": "none"}
        )
        return DriftActionDecision(
            action_id=action_id,
            action_type="none",
            triggered=False,
            cooldown_active=False,
            cooldown_remaining_seconds=0,
            reason_codes=[],
        )

    reasons = set(detection.reason_codes)
    if reasons & policy.reselection_reason_codes:
        action_type = "reselection"
        cooldown_seconds = max(0, int(policy.reselection_cooldown_seconds))
    elif reasons & policy.retrain_reason_codes:
        action_type = "retrain"
        cooldown_seconds = max(0, int(policy.retrain_cooldown_seconds))
    else:
        action_type = "retrain"
        cooldown_seconds = max(0, int(policy.retrain_cooldown_seconds))

    cooldown_remaining = 0
    cooldown_active = False
    if last_action_type == action_type and last_action_at is not None:
        elapsed = int((current - last_action_at).total_seconds())
        cooldown_remaining = max(0, cooldown_seconds - max(0, elapsed))
        cooldown_active = cooldown_remaining > 0

    action_id = _stable_digest(
        {
            "incident_id": detection.incident_id,
            "action": action_type,
            "reason_codes": sorted(detection.reason_codes),
        }
    )

    return DriftActionDecision(
        action_id=action_id,
        action_type=action_type,
        triggered=not cooldown_active,
        cooldown_active=cooldown_active,
        cooldown_remaining_seconds=cooldown_remaining,
        reason_codes=sorted(detection.reason_codes),
    )


def evaluate_live_promotion_evidence(
    *,
    detection: DriftDetectionReport,
    action: DriftActionDecision,
    evidence_refs: list[str],
    now: datetime | None = None,
) -> DriftPromotionEvidence:
    checked_at = now or datetime.now(timezone.utc)
    reasons: list[str] = []
    if detection.drift_detected:
        reasons.append("drift_detected")
    if action.cooldown_active:
        reasons.append("drift_action_cooldown_active")
    if action.triggered and action.action_type in {"retrain", "reselection"}:
        reasons.append(f"drift_action_triggered:{action.action_type}")

    return DriftPromotionEvidence(
        checked_at=checked_at,
        incident_id=detection.incident_id if detection.drift_detected else None,
        eligible_for_live_promotion=not reasons,
        reasons=reasons,
        reason_codes=sorted(detection.reason_codes),
        evidence_artifact_refs=sorted(set(evidence_refs)),
    )


def _stable_digest(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _to_decimal(raw: Any) -> Decimal | None:
    if raw is None:
        return None
    try:
        return Decimal(str(raw))
    except Exception:
        return None


def _extract_profitability_decimal(
    payload: Mapping[str, Any], path: list[str]
) -> Decimal | None:
    current: Any = payload
    for key in path:
        if not isinstance(current, Mapping):
            return None
        current = cast(Mapping[str, Any], current).get(key)
    return _to_decimal(current)


def _as_mapping(raw: Any) -> Mapping[str, Any]:
    if isinstance(raw, Mapping):
        return cast(Mapping[str, Any], raw)
    return _EMPTY_MAPPING


__all__ = [
    "DriftActionDecision",
    "DriftPromotionEvidence",
    "DriftSignal",
    "DriftThresholds",
    "DriftTriggerPolicy",
    "DriftDetectionReport",
    "REASON_DATA_NULL_RATE",
    "REASON_DATA_STALENESS",
    "REASON_DATA_DUPLICATE_RATIO",
    "REASON_DATA_SCHEMA_MISMATCH",
    "REASON_MODEL_CALIBRATION_ERROR",
    "REASON_MODEL_LLM_ERROR_RATIO",
    "REASON_PERF_NET_PNL",
    "REASON_PERF_DRAWDOWN",
    "REASON_PERF_COST_BPS",
    "REASON_PERF_FALLBACK_RATIO",
    "decide_drift_action",
    "detect_drift",
    "evaluate_live_promotion_evidence",
]

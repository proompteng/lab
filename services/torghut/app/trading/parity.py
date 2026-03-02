"""Online/offline feature parity checks for FeatureVectorV3."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from .features import (
    FEATURE_VECTOR_V3_VALUE_FIELDS,
    FeatureNormalizationError,
    normalize_feature_vector_v3,
)
from .models import SignalEnvelope


BENCHMARK_PARITY_SCHEMA_VERSION = "benchmark-parity-report-v1"


@dataclass(frozen=True)
class FeatureParityThresholds:
    max_hash_mismatch_ratio: float = 0.0
    max_numeric_drift: float = 1e-9


@dataclass(frozen=True)
class FeatureParityReport:
    checked_rows: int
    missing_online_rows: int
    missing_offline_rows: int
    hash_mismatches: int
    drift_by_field: dict[str, float]
    top_drift_fields: list[dict[str, Any]]
    failing_windows: list[dict[str, Any]]
    accepted: bool
    reasons: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            'checked_rows': self.checked_rows,
            'missing_online_rows': self.missing_online_rows,
            'missing_offline_rows': self.missing_offline_rows,
            'hash_mismatches': self.hash_mismatches,
            'drift_by_field': self.drift_by_field,
            'top_drift_fields': self.top_drift_fields,
            'failing_windows': self.failing_windows,
            'accepted': self.accepted,
            'reasons': self.reasons,
        }


def run_feature_parity(
    online_signals: list[SignalEnvelope],
    offline_signals: list[SignalEnvelope],
    *,
    thresholds: FeatureParityThresholds | None = None,
) -> FeatureParityReport:
    policy = thresholds or FeatureParityThresholds()

    online_vectors = _normalize_indexed(online_signals)
    offline_vectors = _normalize_indexed(offline_signals)

    online_keys = set(online_vectors)
    offline_keys = set(offline_vectors)
    shared_keys = sorted(online_keys & offline_keys)

    missing_online_rows = len(offline_keys - online_keys)
    missing_offline_rows = len(online_keys - offline_keys)

    drift_by_field: dict[str, float] = {field: 0.0 for field in FEATURE_VECTOR_V3_VALUE_FIELDS}
    hash_mismatches = 0
    failing_windows: list[dict[str, Any]] = []

    for key in shared_keys:
        online = online_vectors[key]
        offline = offline_vectors[key]

        if online.normalization_hash != offline.normalization_hash:
            hash_mismatches += 1

        drift_record: dict[str, float] = {}
        for field in FEATURE_VECTOR_V3_VALUE_FIELDS:
            drift = _value_drift(online.values.get(field), offline.values.get(field))
            if drift > drift_by_field[field]:
                drift_by_field[field] = drift
            if drift > policy.max_numeric_drift:
                drift_record[field] = drift

        if drift_record:
            failing_windows.append(
                {
                    'event_ts': online.event_ts.isoformat(),
                    'symbol': online.symbol,
                    'timeframe': online.timeframe,
                    'seq': online.seq,
                    'source': online.source,
                    'drift': drift_record,
                }
            )

    top_drift_fields = [
        {'field': field, 'max_abs_drift': drift}
        for field, drift in sorted(drift_by_field.items(), key=lambda item: item[1], reverse=True)
        if drift > 0
    ][:5]

    checked_rows = len(shared_keys)
    reasons: list[str] = []
    hash_mismatch_ratio = (hash_mismatches / checked_rows) if checked_rows else 0.0
    if hash_mismatch_ratio > policy.max_hash_mismatch_ratio:
        reasons.append('hash_mismatch_ratio_exceeds_threshold')
    if failing_windows:
        reasons.append('numeric_drift_exceeds_threshold')
    if missing_online_rows > 0 or missing_offline_rows > 0:
        reasons.append('coverage_mismatch')

    return FeatureParityReport(
        checked_rows=checked_rows,
        missing_online_rows=missing_online_rows,
        missing_offline_rows=missing_offline_rows,
        hash_mismatches=hash_mismatches,
        drift_by_field=drift_by_field,
        top_drift_fields=top_drift_fields,
        failing_windows=failing_windows,
        accepted=len(reasons) == 0,
        reasons=reasons,
    )


def write_feature_parity_report(report: FeatureParityReport, output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report.to_dict(), indent=2, sort_keys=True), encoding='utf-8')
    return output_path


@dataclass(frozen=True)
class BenchmarkParityRun:
    dataset_ref: str
    window_ref: str
    metrics: dict[str, float | int | str | bool]
    slice_metrics: dict[str, Any]
    policy_violations: list[str]
    run_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "dataset_ref": self.dataset_ref,
            "window_ref": self.window_ref,
            "metrics": dict(self.metrics),
            "slice_metrics": self.slice_metrics,
            "policy_violations": list(self.policy_violations),
            "run_hash": self.run_hash,
        }


@dataclass(frozen=True)
class BenchmarkParityReport:
    candidate_id: str
    baseline_candidate_id: str
    benchmark_runs: dict[str, BenchmarkParityRun]
    scorecards: dict[str, dict[str, Any]]
    overall_parity_status: str
    degradation_summary: dict[str, float]
    artifact_hash: str
    created_at_utc: str
    schema_version: str = BENCHMARK_PARITY_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "candidate_id": self.candidate_id,
            "baseline_candidate_id": self.baseline_candidate_id,
            "benchmark_runs": {
                name: run.to_payload() for name, run in self.benchmark_runs.items()
            },
            "scorecards": {name: dict(value) for name, value in self.scorecards.items()},
            "overall_parity_status": self.overall_parity_status,
            "degradation_summary": self.degradation_summary,
            "artifact_hash": self.artifact_hash,
            "created_at_utc": self.created_at_utc,
        }


def build_benchmark_parity_report_v1(
    *,
    candidate_id: str,
    baseline_candidate_id: str,
    signal_count: int,
    candidate_decision_count: int,
    baseline_decision_count: int,
    candidate_trade_count: int,
    baseline_trade_count: int,
    candidate_confidence_calibration_error: float = 0.0,
    baseline_confidence_calibration_error: float = 0.0,
    candidate_policy_violation_rate: float | None = None,
    baseline_policy_violation_rate: float | None = None,
    fallback_rate: float = 0.0,
    timeout_rate: float = 0.0,
    candidate_adverse_regime_decision_quality_delta: float | None = None,
    candidate_risk_veto_alignment_rate: float = 0.0,
    baseline_risk_veto_alignment_rate: float = 0.0,
    deterministic_gate_compatibility: bool = True,
    dataset_ref: str = "walkforward:autonomy",
    window_ref: str = "run:autonomy-lane",
    created_at: datetime | None = None,
) -> BenchmarkParityReport:
    created_at = created_at or datetime.now(timezone.utc)
    advisory_output_rate = _safe_ratio(candidate_decision_count, signal_count)
    baseline_advisory_output_rate = _safe_ratio(baseline_decision_count, signal_count)

    if candidate_policy_violation_rate is None:
        candidate_policy_violation_rate = _safe_rate(candidate_decision_count - baseline_decision_count)
    if baseline_policy_violation_rate is None:
        baseline_policy_violation_rate = 0.0
    if candidate_adverse_regime_decision_quality_delta is None:
        candidate_adverse_regime_decision_quality_delta = max(
            0.0,
            baseline_advisory_output_rate - advisory_output_rate,
        )

    policy_violation_rate_delta = max(
        candidate_policy_violation_rate - baseline_policy_violation_rate,
        0.0,
    )
    risk_veto_alignment_delta = max(
        baseline_risk_veto_alignment_rate - candidate_risk_veto_alignment_rate,
        0.0,
    )
    confidence_calibration_error_delta = max(
        candidate_confidence_calibration_error - baseline_confidence_calibration_error,
        0.0,
    )

    decision_quality = {
        "advisory_output_rate": advisory_output_rate,
        "baseline_advisory_output_rate": baseline_advisory_output_rate,
        "adverse_regime_decision_quality_delta": candidate_adverse_regime_decision_quality_delta,
    }
    reasoning_quality = {
        "policy_violation_rate": candidate_policy_violation_rate,
        "baseline_policy_violation_rate": baseline_policy_violation_rate,
        "policy_violation_rate_delta": policy_violation_rate_delta,
        "deterministic_gate_compatibility": (
            "pass" if deterministic_gate_compatibility else "fail"
        ),
    }
    event_forecast_quality = {
        "fallback_rate": _safe_rate(fallback_rate),
        "timeout_rate": _safe_rate(timeout_rate),
        "confidence_calibration_error": candidate_confidence_calibration_error,
        "baseline_confidence_calibration_error": baseline_confidence_calibration_error,
        "confidence_calibration_error_delta": confidence_calibration_error_delta,
    }

    runs: dict[str, BenchmarkParityRun] = {
        "ai_trader_like": BenchmarkParityRun(
            dataset_ref=dataset_ref,
            window_ref=window_ref,
            metrics={
                "advisory_output_rate": advisory_output_rate,
                "policy_violation_rate": candidate_policy_violation_rate,
                "baseline_advisory_output_rate": baseline_advisory_output_rate,
                "trade_count": candidate_trade_count,
                "baseline_trade_count": baseline_trade_count,
            },
            slice_metrics={
                "all": {
                    "signal_count": signal_count,
                    "decision_count": candidate_decision_count,
                    "adverse_regime_decision_quality_delta": (
                        candidate_adverse_regime_decision_quality_delta
                    ),
                }
            },
            policy_violations=[],
            run_hash="",
        ),
        "gift_eval_like": BenchmarkParityRun(
            dataset_ref=dataset_ref,
            window_ref=window_ref,
            metrics={
                "policy_violation_rate": candidate_policy_violation_rate,
                "baseline_policy_violation_rate": baseline_policy_violation_rate,
                "policy_violation_rate_delta": policy_violation_rate_delta,
                "deterministic_gate_compatibility": (
                    "pass" if deterministic_gate_compatibility else "fail"
                ),
            },
            slice_metrics={
                "all": {
                    "candidate_risk_veto_alignment_rate": candidate_risk_veto_alignment_rate,
                    "baseline_risk_veto_alignment_rate": baseline_risk_veto_alignment_rate,
                }
            },
            policy_violations=[],
            run_hash="",
        ),
        "fev_bench_like": BenchmarkParityRun(
            dataset_ref=dataset_ref,
            window_ref=window_ref,
            metrics={
                "fallback_rate": _safe_rate(fallback_rate),
                "timeout_rate": _safe_rate(timeout_rate),
                "confidence_calibration_error_delta": confidence_calibration_error_delta,
            },
            slice_metrics={
                "all": {
                    "signal_count": signal_count,
                    "trade_count": candidate_trade_count,
                    "baseline_trade_count": baseline_trade_count,
                    "candidate_adverse_regime_decision_quality_delta": (
                        candidate_adverse_regime_decision_quality_delta
                    ),
                }
            },
            policy_violations=[],
            run_hash="",
        ),
    }

    hashed_runs: dict[str, BenchmarkParityRun] = {}
    for family, run in runs.items():
        run_payload = run.to_payload()
        run_payload.pop("run_hash", None)
        run_payload["baseline_candidate_id"] = baseline_candidate_id
        run_hash = _artifact_hash(run_payload)
        hashed_runs[family] = BenchmarkParityRun(
            dataset_ref=run.dataset_ref,
            window_ref=run.window_ref,
            metrics=run.metrics,
            slice_metrics=run.slice_metrics,
            policy_violations=list(run.policy_violations),
            run_hash=run_hash,
        )

    degradation_summary = {
        "adverse_regime_decision_quality_delta": candidate_adverse_regime_decision_quality_delta,
        "risk_veto_alignment_delta": risk_veto_alignment_delta,
        "confidence_calibration_error_delta": confidence_calibration_error_delta,
        "policy_violation_rate_delta": policy_violation_rate_delta,
    }
    scorecards = {
        "decision_quality": decision_quality,
        "reasoning_quality": reasoning_quality,
        "event_forecast_quality": event_forecast_quality,
    }
    overall_pass = (
        advisory_output_rate >= 0.995
        and deterministic_gate_compatibility
        and policy_violation_rate_delta <= 0.01
        and fallback_rate <= 0.05
        and timeout_rate <= 0.05
        and candidate_adverse_regime_decision_quality_delta <= 0.1
        and risk_veto_alignment_delta <= 0.1
        and confidence_calibration_error_delta <= 0.1
    )

    payload_for_hash = {
        "schema_version": BENCHMARK_PARITY_SCHEMA_VERSION,
        "candidate_id": candidate_id,
        "baseline_candidate_id": baseline_candidate_id,
        "benchmark_runs": {
            name: run.to_payload() for name, run in hashed_runs.items()
        },
        "scorecards": scorecards,
        "overall_parity_status": "pass" if overall_pass else "fail",
        "degradation_summary": degradation_summary,
        "created_at_utc": created_at.isoformat(),
    }
    artifact_hash = _artifact_hash(payload_for_hash)

    return BenchmarkParityReport(
        candidate_id=candidate_id,
        baseline_candidate_id=baseline_candidate_id,
        benchmark_runs=hashed_runs,
        scorecards=scorecards,
        overall_parity_status="pass" if overall_pass else "fail",
        degradation_summary=degradation_summary,
        artifact_hash=artifact_hash,
        created_at_utc=created_at.isoformat(),
    )


def write_benchmark_parity_report_v1(
    report: BenchmarkParityReport,
    output_path: Path,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return output_path


def _normalize_indexed(signals: list[SignalEnvelope]) -> dict[tuple[datetime, str, str, int, str], Any]:
    indexed: dict[tuple[datetime, str, str, int, str], Any] = {}
    for signal in signals:
        try:
            fv = normalize_feature_vector_v3(signal)
        except FeatureNormalizationError:
            continue
        key = (fv.event_ts, fv.symbol, fv.timeframe, fv.seq, fv.source)
        indexed[key] = fv
    return indexed


def _value_drift(lhs: Any, rhs: Any) -> float:
    left = _to_decimal(lhs)
    right = _to_decimal(rhs)
    if left is None or right is None:
        return 0.0 if lhs == rhs else 1.0
    return float(abs(left - right))


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except Exception:
            return None
    return None


def _safe_rate(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float, Decimal)):
        parsed = float(value)
    elif isinstance(value, str):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return 0.0
    else:
        return 0.0
    if not math.isfinite(parsed):
        return 0.0
    if parsed < 0:
        return 0.0
    if parsed > 1:
        return 1.0
    return float(f"{parsed:.6f}")


def _safe_ratio(numerator: int, denominator: int) -> float:
    return _safe_rate(_safe_division(numerator, denominator))


def _safe_division(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return float(numerator) / float(denominator)


def _artifact_hash(payload: dict[str, Any]) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()[:24]


__all__ = [
    'FeatureParityReport',
    'FeatureParityThresholds',
    'run_feature_parity',
    'write_feature_parity_report',
    'BENCHMARK_PARITY_SCHEMA_VERSION',
    'BenchmarkParityReport',
    'BenchmarkParityRun',
    'build_benchmark_parity_report_v1',
    'write_benchmark_parity_report_v1',
]

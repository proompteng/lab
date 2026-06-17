from __future__ import annotations

# ruff: noqa: F401
import os
import json
import tempfile
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.trading.evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from app.trading.parity import (
    BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
    BENCHMARK_PARITY_SCHEMA_VERSION,
    DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION,
    DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS,
    DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS,
    DEEPLOB_BDLOB_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS,
    FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS,
    FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
)
from tests.policy_checks.policy_checks_artifact_support import (
    _build_profitability_stage_manifest_payload,
    _gate_report,
    _sha256_json,
    _sha256_path,
    _write_contamination_registry_artifact,
    _write_janus_artifacts,
    _write_stress_artifacts,
)

from app.trading.autonomy.policy_checks import (
    evaluate_alpha_readiness_summary,
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)

_V6_08_GOVERNING_DESIGN_DOC = "docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md"


class PolicyChecksTestCaseBase(TestCase):
    pass


def _write_minimal_policy_artifacts(
    root: Path,
    gate_report: dict[str, object],
) -> None:
    (root / "research").mkdir(parents=True, exist_ok=True)
    (root / "backtest").mkdir(parents=True, exist_ok=True)
    (root / "gates").mkdir(parents=True, exist_ok=True)
    (root / "research" / "candidate-spec.json").write_text("{}", encoding="utf-8")
    (root / "backtest" / "evaluation-report.json").write_text("{}", encoding="utf-8")
    (root / "gates" / "gate-evaluation.json").write_text(
        json.dumps(gate_report),
        encoding="utf-8",
    )


def _deeplob_bdlob_policy(**overrides: object) -> dict[str, object]:
    policy: dict[str, object] = {
        "promotion_require_patch_targets": [],
        "promotion_require_deeplob_bdlob_contract": True,
        "promotion_deeplob_bdlob_required_targets": ["paper"],
        "promotion_deeplob_bdlob_required_artifacts": [
            "microstructure/deeplob-bdlob-report-v1.json"
        ],
        "promotion_deeplob_bdlob_min_feature_quality_pass_rate": 0.99,
        "promotion_deeplob_bdlob_min_prediction_quality_score": 0.85,
        "promotion_deeplob_bdlob_min_cost_adjusted_edge_bps": 0.0,
        "promotion_deeplob_bdlob_max_slippage_divergence_bps": 1.0,
        "promotion_deeplob_bdlob_min_fallback_reliability": 0.99,
        "promotion_require_foundation_router_parity": False,
        "promotion_require_benchmark_parity": False,
        "promotion_require_contamination_registry": False,
        "promotion_require_stress_evidence": False,
        "promotion_require_hmm_state_posterior": False,
        "promotion_require_expert_router_registry": False,
        "promotion_require_janus_evidence": False,
        "promotion_require_profitability_stage_manifest": False,
        "gate6_require_profitability_evidence": False,
        "gate6_require_janus_evidence": False,
    }
    policy.update(overrides)
    return policy


def _candidate_state() -> dict[str, object]:
    return {
        "candidateId": "cand-test",
        "runId": "run-test",
        "activeStage": "gate-evaluation",
        "paused": False,
        "datasetSnapshotRef": "signals_window",
        "noSignalReason": None,
        "dependencyQuorum": {
            "decision": "allow",
            "reasons": [],
            "message": "Control-plane admission dependencies are healthy.",
        },
        "alphaReadiness": {
            "mode": "candidate_alignment_v1",
            "registry_loaded": True,
            "registry_path": "config/hypotheses",
            "registry_errors": [],
            "strategy_families": ["deterministic"],
            "matched_hypothesis_ids": ["H-TEST-01"],
            "missing_strategy_families": [],
            "promotion_eligible": True,
            "reasons": [],
            "dependency_quorum": {
                "decision": "allow",
                "reasons": [],
                "message": "Control-plane admission dependencies are healthy.",
            },
        },
        "rollbackReadiness": {
            "killSwitchDryRunPassed": True,
            "gitopsRevertDryRunPassed": True,
            "strategyDisableDryRunPassed": True,
            "dryRunCompletedAt": datetime.now(timezone.utc).isoformat(),
            "humanApproved": True,
            "rollbackTarget": "main@a1b2c3d",
        },
    }


def _write_benchmark_parity_payload(
    root: Path,
    *,
    adverse_regime_degradation: float = 0.0,
    risk_veto_degradation: float = 0.0,
    confidence_calibration_error_degradation: float = 0.0,
    forecast_confidence_calibration_error: float = 0.015,
    forecast_confidence_calibration_error_baseline: float = 0.015,
    families: tuple[str, ...] = BENCHMARK_PARITY_REQUIRED_FAMILIES,
    schema_version: str = BENCHMARK_PARITY_SCHEMA_VERSION,
) -> Path:
    payload = _build_benchmark_parity_payload(
        families=families,
        adverse_regime_degradation=adverse_regime_degradation,
        risk_veto_degradation=risk_veto_degradation,
        confidence_calibration_error_degradation=confidence_calibration_error_degradation,
        forecast_confidence_calibration_error=forecast_confidence_calibration_error,
        forecast_confidence_calibration_error_baseline=forecast_confidence_calibration_error_baseline,
        schema_version=schema_version,
    )
    return _write_benchmark_parity_payload_payload(root, payload=payload)


def _write_benchmark_parity_payload_payload(
    root: Path,
    *,
    payload: dict[str, object],
    path: Path | None = None,
) -> Path:
    artifact_path = (
        root / "benchmarks" / "benchmark-parity-report-v1.json"
        if path is None
        else path
    )
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(payload), encoding="utf-8")
    return artifact_path


def _build_benchmark_parity_payload(
    *,
    families: tuple[str, ...] = BENCHMARK_PARITY_REQUIRED_FAMILIES,
    adverse_regime_degradation: float = 0.0,
    risk_veto_degradation: float = 0.0,
    confidence_calibration_error_degradation: float = 0.0,
    forecast_confidence_calibration_error: float = 0.015,
    forecast_confidence_calibration_error_baseline: float = 0.015,
    schema_version: str = BENCHMARK_PARITY_SCHEMA_VERSION,
) -> dict[str, object]:
    payload = {
        "schema_version": schema_version,
        "candidate_id": "cand-test",
        "baseline_candidate_id": "base-test",
        "contract": {
            "schema_version": BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
            "required_families": list(BENCHMARK_PARITY_REQUIRED_FAMILIES),
            "required_scorecards": list(BENCHMARK_PARITY_REQUIRED_SCORECARDS),
            "required_scorecard_fields": {
                name: list(fields)
                for name, fields in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.items()
            },
            "required_run_fields": list(BENCHMARK_PARITY_REQUIRED_RUN_FIELDS),
            "hash_algorithm": "sha256",
            "generation_mode": "deterministic_benchmark_parity_v1",
        },
        "benchmark_runs": [
            _build_test_benchmark_parity_run(family) for family in families
        ],
        "scorecards": {
            "decision_quality": {
                "status": "pass",
                "advisory_output_rate": 0.998,
                "advisory_output_rate_baseline": 0.998,
                "policy_violation_rate": 0.01,
                "policy_violation_rate_baseline": 0.01,
                "deterministic_gate_compatible": True,
                "decision_count": 144,
            },
            "reasoning_quality": {
                "status": "pass",
                "policy_violation_rate": 0.01,
                "policy_violation_rate_baseline": 0.01,
                "advisory_output_rate": 0.997,
                "advisory_output_rate_baseline": 0.997,
                "deterministic_gate_compatible": True,
            },
            "forecast_quality": {
                "status": "pass",
                "confidence_calibration_error": forecast_confidence_calibration_error,
                "confidence_calibration_error_baseline": forecast_confidence_calibration_error_baseline,
                "risk_veto_alignment": 0.95,
                "risk_veto_alignment_baseline": 0.95,
                "policy_violation_rate": 0.01,
                "policy_violation_rate_baseline": 0.01,
                "advisory_output_rate": 0.997,
                "advisory_output_rate_baseline": 0.997,
                "deterministic_gate_compatible": True,
            },
        },
        "overall_parity_status": "pass",
        "degradation_summary": {
            "adverse_regime_decision_quality": {
                "degradation": adverse_regime_degradation,
            },
            "risk_veto_alignment": {
                "degradation": risk_veto_degradation,
            },
            "confidence_calibration_error": {
                "degradation": confidence_calibration_error_degradation,
            },
        },
        "created_at_utc": datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
        "artifact_hash": "",
    }
    _recompute_benchmark_artifact_hash(payload)
    return payload


def _build_test_benchmark_parity_run(
    family: str,
    *,
    run_hash: str = "test-run-hash",
) -> dict[str, object]:
    return {
        "schema_version": BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
        "family": family,
        "dataset_ref": "benchmarks/external-labeled-stream-v1",
        "window_ref": "20260201T000000Z",
        "metrics": {
            "advisory_output_rate": 0.998,
            "risk_veto_alignment": 0.95,
            "confidence_calibration_error": 0.015,
        },
        "slice_metrics": {
            "baseline_regime": {
                "decision_quality": 0.88,
                "policy_violation_rate": 0.01,
            },
            "adverse_regime": {
                "decision_quality": 0.86,
                "policy_violation_rate": 0.01,
            },
        },
        "policy_violations": {
            "deterministic_gate_compatible": True,
            "rate": 0.01,
            "baseline_rate": 0.01,
            "fallback_rate": 0.001,
            "timeout_rate": 0.001,
        },
        "run_hash": run_hash,
    }


def _recompute_benchmark_artifact_hash(payload: dict[str, object]) -> str:
    payload_without_hash = {
        key: value for key, value in payload.items() if key != "artifact_hash"
    }
    artifact_hash = _sha256_json(payload_without_hash)
    payload["artifact_hash"] = artifact_hash
    return artifact_hash


def _write_foundation_router_parity_payload(
    root: Path,
    *,
    schema_version: str = FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
    contract_schema_version: str = FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
    adapters: tuple[str, ...] = FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS,
    required_slice_metrics: tuple[
        str, ...
    ] = FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS,
    fallback_rate: float = 0.01,
    calibration_minimum: float = 0.9,
    drift_max: float = 0.02,
    latency_p95_ms: int = 120,
    overall_status: str = "pass",
) -> Path:
    payload: dict[str, object] = {
        "schema_version": schema_version,
        "candidate_id": "cand-test",
        "router_policy_version": "forecast_router_policy_v1",
        "contract": {
            "schema_version": contract_schema_version,
            "required_adapters": list(adapters),
            "required_slice_metrics": list(required_slice_metrics),
            "hash_algorithm": "sha256",
            "generation_mode": "deterministic_foundation_router_parity_v1",
        },
        "adapters": list(adapters),
        "slice_metrics": {
            "by_symbol": {"AAPL": {"status": "pass"}},
            "by_horizon": {"1m": {"status": "pass"}},
            "by_regime": {"trend": {"status": "pass"}},
        },
        "calibration_metrics": {"minimum": calibration_minimum},
        "latency_metrics": {"p95_ms": latency_p95_ms},
        "fallback_metrics": {"fallback_rate": fallback_rate},
        "drift_metrics": {"max": drift_max},
        "overall_status": overall_status,
        "created_at_utc": datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
        "artifact_hash": "",
    }
    payload["artifact_hash"] = _sha256_json(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    artifact_path = root / "router" / "foundation-router-parity-report-v1.json"
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(payload), encoding="utf-8")
    return artifact_path


def _write_deeplob_bdlob_payload(
    root: Path,
    *,
    schema_version: str = DEEPLOB_BDLOB_SCHEMA_VERSION,
    contract_schema_version: str = DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION,
    supporting_artifacts: tuple[str, ...] = DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS,
    required_summary_fields: tuple[str, ...] = DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS,
    feature_quality_pass_rate: float = 0.995,
    prediction_quality_score: float = 0.9,
    cost_adjusted_edge_bps: float = 0.6,
    slippage_divergence_bps: float = 0.6,
    fallback_reliability: float = 0.995,
    overall_status: str = "pass",
) -> Path:
    payload: dict[str, object] = {
        "schema_version": schema_version,
        "candidate_id": "cand-test",
        "feature_policy_version": "3.0.0",
        "contract": {
            "schema_version": contract_schema_version,
            "required_supporting_artifacts": list(supporting_artifacts),
            "required_summary_fields": list(required_summary_fields),
            "hash_algorithm": "sha256",
            "generation_mode": "deterministic_deeplob_bdlob_contract_v1",
        },
        "supporting_artifacts": list(supporting_artifacts),
        "feature_quality_summary": {
            "pass_rate": feature_quality_pass_rate,
            "status": "pass",
        },
        "prediction_quality_summary": {
            "score": prediction_quality_score,
            "status": "pass",
        },
        "execution_impact_summary": {
            "slippage_divergence_bps": slippage_divergence_bps,
            "deterministic_gate_compatible": True,
            "status": "pass",
        },
        "cost_adjusted_outcomes": {
            "edge_bps": cost_adjusted_edge_bps,
            "status": "pass",
        },
        "fallback_summary": {
            "reliability": fallback_reliability,
            "slo_pass": True,
            "status": "pass",
        },
        "overall_status": overall_status,
        "created_at_utc": datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
    }
    payload["artifact_hash"] = _sha256_json(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    artifact_path = root / "microstructure" / "deeplob-bdlob-report-v1.json"
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(payload), encoding="utf-8")
    return artifact_path


def _write_advisor_fallback_slo_payload(
    root: Path,
    *,
    schema_version: str = "advisor-fallback-slo-report-v1",
    contract_schema_version: str = "advisor-fallback-slo-contract-v1",
    timeout_rate: float = 0.002,
    state_stale_rate: float = 0.003,
    advice_stale_rate: float = 0.003,
    safe_fallback_rate: float = 0.995,
    deterministic_policy_bypass_detected: bool = False,
    overall_status: str = "pass",
) -> Path:
    payload: dict[str, object] = {
        "schema_version": schema_version,
        "candidate_id": "cand-test",
        "advisor_policy_version": "v3-gates-1",
        "contract": {
            "schema_version": contract_schema_version,
            "required_reasons": [
                "advisor_timeout",
                "advisor_state_stale",
                "advisor_advice_stale",
            ],
            "required_summary_fields": [
                "timeout_rate",
                "state_stale_rate",
                "advice_stale_rate",
                "safe_fallback_rate",
                "deterministic_policy_bypass_detected",
                "slo_pass",
            ],
            "hash_algorithm": "sha256",
            "generation_mode": "deterministic_advisor_fallback_slo_v1",
        },
        "evaluated_samples": 600,
        "fallback_reason_counts": {
            "advisor_timeout": 2,
            "advisor_state_stale": 3,
            "advisor_advice_stale": 2,
        },
        "fallback_reason_rates": {
            "timeout_rate": timeout_rate,
            "state_stale_rate": state_stale_rate,
            "advice_stale_rate": advice_stale_rate,
            "safe_fallback_rate": safe_fallback_rate,
            "deterministic_policy_bypass_detected": deterministic_policy_bypass_detected,
            "slo_pass": True,
            "status": "pass",
        },
        "overall_status": overall_status,
        "created_at_utc": datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat(),
    }
    payload["artifact_hash"] = _sha256_json(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    artifact_path = root / "execution" / "advisor-fallback-slo-report-v1.json"
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(json.dumps(payload), encoding="utf-8")
    return artifact_path


__all__ = ("PolicyChecksTestCaseBase",)

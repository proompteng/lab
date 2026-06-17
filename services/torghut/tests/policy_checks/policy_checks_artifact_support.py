from __future__ import annotations

# ruff: noqa: F401
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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

_V6_08_GOVERNING_DESIGN_DOC = "docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md"


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_json(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _build_profitability_stage_manifest_payload(
    *,
    root: Path,
    candidate_spec_path: Path,
    candidate_generation_manifest_path: Path,
    walkforward_results_path: Path,
    baseline_evaluation_report_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    profitability_benchmark_path: Path,
    profitability_evidence_path: Path,
    profitability_validation_path: Path,
    janus_event_car_path: Path,
    janus_hgrm_reward_path: Path,
    recalibration_report_path: Path,
    hmm_state_posterior_path: Path | None = None,
    expert_router_registry_path: Path | None = None,
    rollback_readiness_path: Path | None = None,
    stage_statuses: dict[str, str] | None = None,
    check_status_overrides: dict[tuple[str, str], str] | None = None,
    artifact_path_overrides: dict[tuple[str, str], Path] | None = None,
) -> dict[str, object]:
    def _artifact_authority(check_name: str) -> dict[str, Any] | None:
        if check_name in {
            "hmm_state_posterior_present",
            "expert_router_registry_present",
            "janus_event_car_present",
            "janus_hgrm_reward_present",
        }:
            return evidence_contract_payload(
                provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
                maturity=EvidenceMaturity.STUB,
                authoritative=False,
                placeholder=True,
            )
        if check_name in {
            "evaluation_report_present",
            "walkforward_results_present",
            "profitability_benchmark_present",
            "profitability_evidence_present",
            "profitability_validation_present",
            "gate_evaluation_present",
            "recalibration_report_present",
        }:
            return evidence_contract_payload(
                provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
                maturity=EvidenceMaturity.UNCALIBRATED,
            )
        return None

    def _artifact_sha(payload_path: Path | None) -> str:
        if payload_path is None or not payload_path.exists():
            return "missing"
        return _sha256_path(payload_path)

    def _artifact_path(payload_path: Path | None) -> str:
        if payload_path is None:
            return ""
        try:
            return str(payload_path.relative_to(root))
        except ValueError:
            return str(payload_path)

    rollback_readiness_path = rollback_readiness_path or (
        root / "gates" / "rollback-readiness.json"
    )
    if hmm_state_posterior_path is None:
        hmm_state_posterior_path = root / "gates" / "hmm-state-posterior-v1.json"
    if not hmm_state_posterior_path.exists():
        hmm_state_posterior_path.parent.mkdir(parents=True, exist_ok=True)
        hmm_payload: dict[str, object] = {
            "schema_version": "hmm-state-posterior-v1",
            "run_id": "run-test",
            "candidate_id": "cand-test",
            "generated_at": "2026-03-01T00:00:00+00:00",
            "samples_total": 1,
            "authoritative_samples": 0,
            "authoritative_sample_ratio": "0",
            "transition_shock_samples": 0,
            "stale_or_defensive_samples": 0,
            "regime_counts": {"unknown": 1},
            "entropy_band_counts": {"low": 1},
            "guardrail_reason_counts": {"none": 1},
            "posterior_mass_by_regime": {"unknown": "1"},
            "top_regime_by_posterior_mass": "unknown",
            "source_lineage": {
                "walkforward_results_artifact_ref": "backtest/walkforward-results.json",
                "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                "decision_source": "walkforward_results",
            },
        }
        hmm_payload["artifact_hash"] = _sha256_json(
            {k: v for k, v in hmm_payload.items() if k != "artifact_hash"}
        )
        hmm_state_posterior_path.write_text(
            json.dumps(hmm_payload),
            encoding="utf-8",
        )
    if expert_router_registry_path is None:
        expert_router_registry_path = root / "gates" / "expert-router-registry-v1.json"
    if not expert_router_registry_path.exists():
        expert_router_registry_path.parent.mkdir(parents=True, exist_ok=True)
        expert_router_payload: dict[str, object] = {
            "schema_version": "expert-router-registry-v1",
            "run_id": "run-test",
            "candidate_id": "cand-test",
            "generated_at": "2026-03-01T00:00:00+00:00",
            "router_version": "router-v1",
            "route_count": 1,
            "fallback_count": 0,
            "fallback_rate": "0",
            "max_expert_weight": "0.62",
            "avg_expert_weights": {
                "trend": "0.62",
                "reversal": "0.14",
                "breakout": "0.20",
                "defensive": "0.04",
            },
            "top_expert_counts": {
                "trend": 1,
                "reversal": 0,
                "breakout": 0,
                "defensive": 0,
            },
            "concentration": {
                "dominant_expert": "trend",
                "dominant_expert_count": 1,
                "max_expert_weight": "0.62",
            },
            "slo_feedback": {
                "max_fallback_rate": "0.05",
                "max_expert_concentration": "0.85",
                "fallback_rate": "0",
                "max_observed_expert_weight": "0.62",
                "fallback_slo_pass": True,
                "concentration_slo_pass": True,
                "overall_status": "pass",
                "reasons": [],
            },
            "source_lineage": {
                "walkforward_results_artifact_ref": "backtest/walkforward-results.json",
                "hmm_state_posterior_artifact_ref": "gates/hmm-state-posterior-v1.json",
                "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                "strategy_config_artifact_ref": "research/candidate-spec.json",
            },
        }
        expert_router_payload["artifact_hash"] = _sha256_json(
            {
                key: value
                for key, value in expert_router_payload.items()
                if key != "artifact_hash"
            }
        )
        expert_router_registry_path.write_text(
            json.dumps(expert_router_payload),
            encoding="utf-8",
        )

    stage_owner = {
        "research": "research-orchestrator",
        "validation": "validation-service",
        "execution": "execution-sim",
        "governance": "governance-policy",
    }
    stage_checks: dict[str, list[tuple[str, str, Path]]] = {
        "research": [
            ("candidate_spec_present", "candidate_spec", candidate_spec_path),
            (
                "candidate_generation_manifest_present",
                "candidate_generation_manifest",
                candidate_generation_manifest_path,
            ),
            (
                "walkforward_results_present",
                "walkforward_results",
                walkforward_results_path,
            ),
            (
                "baseline_evaluation_report_present",
                "baseline_evaluation_report",
                baseline_evaluation_report_path,
            ),
        ],
        "validation": [
            ("evaluation_report_present", "evaluation_report", evaluation_report_path),
            (
                "profitability_benchmark_present",
                "profitability_benchmark",
                profitability_benchmark_path,
            ),
            (
                "profitability_evidence_present",
                "profitability_evidence",
                profitability_evidence_path,
            ),
            (
                "profitability_validation_present",
                "profitability_validation",
                profitability_validation_path,
            ),
        ],
        "execution": [
            (
                "walkforward_results_present",
                "walkforward_results",
                walkforward_results_path,
            ),
            ("evaluation_report_present", "evaluation_report", evaluation_report_path),
            ("gate_evaluation_present", "gate_evaluation", gate_report_path),
            (
                "hmm_state_posterior_present",
                "hmm_state_posterior",
                hmm_state_posterior_path,
            ),
            (
                "expert_router_registry_present",
                "expert_router_registry",
                expert_router_registry_path,
            ),
            ("janus_event_car_present", "janus_event_car", janus_event_car_path),
            ("janus_hgrm_reward_present", "janus_hgrm_reward", janus_hgrm_reward_path),
            (
                "recalibration_report_present",
                "recalibration_report",
                recalibration_report_path,
            ),
            ("gate_matrix_approval", "", gate_report_path),
            ("drift_gate_approval", "", gate_report_path),
        ],
        "governance": [
            ("rollback_ready", "", gate_report_path),
            ("gate_report_present", "", gate_report_path),
            ("candidate_spec_present", "candidate_spec", candidate_spec_path),
            (
                "rollback_readiness_present",
                "rollback_readiness",
                rollback_readiness_path,
            ),
            ("risk_controls_attestable", "", candidate_spec_path),
        ],
    }
    resolved_stage_statuses = {
        "research": "pass",
        "validation": "pass",
        "execution": "pass",
        "governance": "pass",
    }
    if stage_statuses:
        resolved_stage_statuses.update(stage_statuses)
    resolved_check_statuses = check_status_overrides or {}
    resolved_artifacts = artifact_path_overrides or {}

    stages: dict[str, object] = {}
    for stage_name in ("research", "validation", "execution", "governance"):
        checks: list[dict[str, str]] = []
        artifacts: dict[str, Any] = {}
        for check_name, artifact_key, default_path in stage_checks[stage_name]:
            check_key = (stage_name, check_name)
            checks.append(
                {
                    "check": check_name,
                    "status": resolved_check_statuses.get(check_key, "pass"),
                }
            )
            artifact_path = resolved_artifacts.get(check_key, default_path)
            if not artifact_key or artifact_path is None:
                continue
            artifacts[artifact_key] = {
                "path": _artifact_path(artifact_path),
                "sha256": _artifact_sha(artifact_path),
                "stage": stage_name,
                "check": check_name,
            }
            authority = _artifact_authority(check_name)
            if authority:
                artifacts[artifact_key]["artifact_authority"] = authority
        stages[stage_name] = {
            "status": resolved_stage_statuses[stage_name],
            "checks": checks,
            "artifacts": artifacts,
            "owner": stage_owner[stage_name],
            "completed_at_utc": "2026-03-01T00:00:00+00:00",
        }
    replay_artifact_hashes: dict[str, str] = {}
    for stage_payload_raw in stages.values():
        if not isinstance(stage_payload_raw, dict):
            continue
        stage_payload = stage_payload_raw
        artifacts_raw = stage_payload.get("artifacts")
        if not isinstance(artifacts_raw, dict):
            continue
        for artifact_payload_raw in artifacts_raw.values():
            if not isinstance(artifact_payload_raw, dict):
                continue
            artifact_payload = artifact_payload_raw
            artifact_ref = str(artifact_payload.get("path", "")).strip()
            artifact_sha = str(artifact_payload.get("sha256", "")).strip()
            if artifact_ref and artifact_sha:
                replay_artifact_hashes[artifact_ref] = artifact_sha
    manifest = {
        "schema_version": "profitability-stage-manifest-v1",
        "candidate_id": "cand-test",
        "strategy_family": "deterministic",
        "llm_artifact_ref": None,
        "router_artifact_ref": "strategy-config",
        "run_context": {
            "repository": "proompteng/lab",
            "base": "main",
            "head": "agentruns/main",
            "artifact_path": str(root),
            "run_id": "run-test",
            "design_doc": _V6_08_GOVERNING_DESIGN_DOC,
        },
        "stages": stages,
        "overall_status": "pass",
        "failure_reasons": [],
        "replay_contract": {
            "artifact_hashes": replay_artifact_hashes,
            "contract_hash": _sha256_json({"artifact_hashes": replay_artifact_hashes}),
            "hash_algorithm": "sha256",
        },
        "rollback_contract_ref": "gates/rollback-readiness.json",
        "created_at_utc": "2026-03-01T00:00:00+00:00",
    }
    manifest["content_hash"] = _sha256_json(
        {k: v for k, v in manifest.items() if k != "content_hash"}
    )
    return manifest


def _write_janus_artifacts(root: Path) -> None:
    (root / "gates" / "janus-event-car-v1.json").write_text(
        json.dumps(
            {
                "schema_version": "janus-event-car-v1",
                "summary": {"event_count": 2},
                "records": [{"event_id": "evt-1"}, {"event_id": "evt-2"}],
            }
        ),
        encoding="utf-8",
    )
    (root / "gates" / "janus-hgrm-reward-v1.json").write_text(
        json.dumps(
            {
                "schema_version": "janus-hgrm-reward-v1",
                "summary": {"reward_count": 2},
                "rewards": [{"reward_id": "rwd-1"}, {"reward_id": "rwd-2"}],
            }
        ),
        encoding="utf-8",
    )


def _write_stress_artifacts(
    root: Path,
    *,
    generated_at: str = "",
    count: int = 4,
) -> None:
    payload = {
        "schema_version": "stress-metrics-v1",
        "count": count,
        "items": [
            {"case": "spread"},
            {"case": "volatility"},
            {"case": "liquidity"},
            {"case": "halt"},
        ],
        "generated_at": generated_at
        or datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat(),
    }
    (root / "gates" / "stress-metrics-v1.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def _write_contamination_registry_artifact(
    root: Path,
    *,
    status: str = "pass",
    leakage_detected: bool = False,
    leakage_rate: float = 0.0,
    check_status_overrides: dict[str, str] | None = None,
) -> None:
    checks = {
        "temporal_ordering": "pass",
        "lineage_complete": "pass",
        "leakage_absent": "pass",
        "embargo_windows_enforced": "pass",
    }
    if check_status_overrides:
        checks.update(check_status_overrides)
    payload: dict[str, object] = {
        "schema_version": "contamination-leakage-report-v1",
        "run_id": "run-test",
        "candidate_id": "cand-test",
        "generated_at": datetime(2026, 3, 3, tzinfo=timezone.utc).isoformat(),
        "status": status,
        "leakage_detected": leakage_detected,
        "leakage_rate": leakage_rate,
        "temporal_integrity": {
            "event_time_ordering_passed": True,
            "embargo_windows_enforced": True,
        },
        "source_lineage": {
            "complete": True,
            "feature_sources": [
                "research/candidate-spec.json",
                "backtest/evaluation-report.json",
            ],
            "prompt_sources": [],
        },
        "checks": [
            {"check": check_name, "status": check_status}
            for check_name, check_status in checks.items()
        ],
        "artifact_refs": [
            "research/candidate-spec.json",
            "backtest/evaluation-report.json",
        ],
    }
    payload["artifact_hash"] = _sha256_json(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    (root / "gates" / "contamination-leakage-report-v1.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def _gate_report() -> dict[str, object]:
    return {
        "run_id": "run-test",
        "promotion_allowed": True,
        "recommended_mode": "paper",
        "dependency_quorum": {
            "decision": "allow",
            "reasons": [],
            "message": "Control-plane admission dependencies are healthy.",
        },
        "alpha_readiness": {
            "mode": "candidate_alignment_v1",
            "registry_loaded": True,
            "registry_path": "config/hypotheses",
            "registry_errors": [],
            "strategy_families": ["deterministic"],
            "matched_hypothesis_ids": ["H-TEST-01"],
            "missing_strategy_families": [],
            "promotion_eligible": True,
            "reasons": [],
        },
        "throughput": {
            "signal_count": 16,
            "decision_count": 12,
            "trade_count": 7,
            "no_signal_window": False,
            "no_signal_reason": None,
        },
        "gates": [
            {"gate_id": "gate0_data_integrity", "status": "pass"},
            {"gate_id": "gate1_statistical_robustness", "status": "pass"},
            {"gate_id": "gate2_risk_capacity", "status": "pass"},
            {"gate_id": "gate7_uncertainty_calibration", "status": "pass"},
        ],
        "promotion_evidence": {
            "fold_metrics": {
                "count": 1,
                "items": [{"fold_name": "fold-1"}],
                "artifact_ref": "gates/stress-metrics-v1.json",
            },
            "stress_metrics": {
                "count": 4,
                "items": [
                    {"case": "spread"},
                    {"case": "volatility"},
                    {"case": "liquidity"},
                    {"case": "halt"},
                ],
                "artifact_ref": "gates/stress-metrics-v1.json",
            },
            "janus_q": {
                "event_car": {
                    "count": 2,
                    "artifact_ref": "gates/janus-event-car-v1.json",
                },
                "hgrm_reward": {
                    "count": 2,
                    "artifact_ref": "gates/janus-hgrm-reward-v1.json",
                },
                "evidence_complete": True,
                "reasons": [],
            },
            "contamination_registry": {
                "artifact_ref": "gates/contamination-leakage-report-v1.json",
                "status": "pass",
                "leakage_detected": False,
                "leakage_rate": 0.0,
            },
            "hmm_state_posterior": {
                "artifact_ref": "gates/hmm-state-posterior-v1.json",
                "schema_version": "hmm-state-posterior-v1",
                "samples_total": 12,
                "authoritative_samples": 8,
                "authoritative_sample_ratio": "0.6667",
                "transition_shock_samples": 0,
                "stale_or_defensive_samples": 0,
            },
            "expert_router_registry": {
                "artifact_ref": "gates/expert-router-registry-v1.json",
                "schema_version": "expert-router-registry-v1",
                "router_version": "router-v1",
                "route_count": 12,
                "fallback_count": 0,
                "fallback_rate": "0",
                "max_expert_weight": "0.62",
            },
            "foundation_router_parity": {
                "artifact_ref": "router/foundation-router-parity-report-v1.json",
            },
            "deeplob_bdlob_contract": {
                "artifact_ref": "microstructure/deeplob-bdlob-report-v1.json",
            },
            "advisor_fallback_slo": {
                "artifact_ref": "execution/advisor-fallback-slo-report-v1.json",
            },
            "promotion_rationale": {
                "requested_target": "paper",
                "gate_recommended_mode": "paper",
                "gate_reasons": ["gate_result_ok"],
            },
        },
        "uncertainty_gate_action": "pass",
        "coverage_error": "0.02",
        "recalibration_run_id": None,
    }


__all__: tuple[str, ...] = ()

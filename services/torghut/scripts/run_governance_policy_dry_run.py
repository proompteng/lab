#!/usr/bin/env python3
"""Execute local dry-run harness for Torghut promotion and rollback policy enforcement."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from tempfile import TemporaryDirectory
from typing import Any, cast

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

def _json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}")
    return cast(dict[str, Any], payload)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run dry-run policy enforcement harness for Torghut governance checks."
    )
    parser.add_argument(
        "--policy", type=Path, required=True, help="Policy JSON (autonomy-gates-v3)."
    )
    parser.add_argument(
        "--gate-report", type=Path, required=True, help="Gate evaluation JSON payload."
    )
    parser.add_argument(
        "--promotion-target", choices=("shadow", "paper", "live"), default="paper"
    )
    parser.add_argument("--output", type=Path, help="Optional output file path.")
    parser.add_argument(
        "--simulate-missing-artifact",
        action="store_true",
        default=False,
        help="Delete paper patch artifact before checks to prove enforcement behavior.",
    )
    parser.add_argument(
        "--simulate-stale-rollback",
        action="store_true",
        default=False,
        help="Use stale rollback dry-run timestamp to trigger readiness failure.",
    )
    parser.add_argument(
        "--simulate-stress-metrics-missing",
        action="store_true",
        default=False,
        help="Delete stress metrics artifact to prove evidence dependency enforcement.",
    )
    parser.add_argument(
        "--simulate-stress-metrics-stale",
        action="store_true",
        default=False,
        help="Force stale stress metrics generated_at to trigger evidence staleness failure.",
    )
    parser.add_argument(
        "--simulate-stress-metrics-untrusted",
        action="store_true",
        default=False,
        help="Use untrusted stress metrics artifact reference to trigger reference enforcement failure.",
    )
    parser.add_argument(
        "--simulate-contamination-missing",
        action="store_true",
        default=False,
        help="Delete contamination registry artifact to prove contamination prerequisite enforcement.",
    )
    parser.add_argument(
        "--simulate-contamination-failed",
        action="store_true",
        default=False,
        help="Mark contamination registry status as failed to prove deterministic block behavior.",
    )
    return parser


def _stable_hash(payload: object) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()


def main() -> int:
    from app.trading.autonomy.policy_checks import (
        evaluate_promotion_prerequisites,
        evaluate_rollback_readiness,
    )

    parser = _build_parser()
    args = parser.parse_args()
    policy = _json(args.policy)
    gate_report = _json(args.gate_report)

    with TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "research").mkdir(parents=True, exist_ok=True)
        (root / "backtest").mkdir(parents=True, exist_ok=True)
        (root / "gates").mkdir(parents=True, exist_ok=True)
        (root / "paper-candidate").mkdir(parents=True, exist_ok=True)

        (root / "research" / "candidate-spec.json").write_text(
            '{"candidate":"ok"}\n', encoding="utf-8"
        )
        (root / "backtest" / "evaluation-report.json").write_text(
            '{"report":"ok"}\n', encoding="utf-8"
        )
        (root / "gates" / "gate-evaluation.json").write_text(
            json.dumps(gate_report, indent=2), encoding="utf-8"
        )
        (root / "gates" / "profitability-evidence-v4.json").write_text(
            '{"schema_version":"profitability-evidence-v4"}\n',
            encoding="utf-8",
        )
        (root / "gates" / "profitability-benchmark-v4.json").write_text(
            '{"schema_version":"profitability-benchmark-v4","slices":[{"slice_type":"regime","slice_key":"regime:neutral"}]}\n',
            encoding="utf-8",
        )
        (root / "gates" / "profitability-evidence-validation.json").write_text(
            '{"passed":true,"reasons":[]}\n',
            encoding="utf-8",
        )
        (root / "gates" / "recalibration-report.json").write_text(
            '{"schema_version":"recalibration_report_v1","status":"not_required","recalibration_run_id":null}\n',
            encoding="utf-8",
        )
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
        (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: dry-run\n",
            encoding="utf-8",
        )
        stress_artifact = {
            "schema_version": "stress-metrics-v1",
            "run_id": str(gate_report.get("run_id", "run-dry-run")),
        }
        promotion_evidence = gate_report.get("promotion_evidence")
        hmm_posterior_payload: dict[str, Any] = {}
        expert_router_payload: dict[str, Any] = {}
        foundation_router_payload: dict[str, Any] = {}
        deeplob_bdlob_payload: dict[str, Any] = {}
        if isinstance(promotion_evidence, dict):
            stress_metrics = promotion_evidence.get("stress_metrics")
            if isinstance(stress_metrics, dict):
                if args.simulate_stress_metrics_untrusted:
                    stress_metrics["artifact_ref"] = str(
                        Path(tempfile.gettempdir())
                        / "torghut-dry-run-stress-metrics-untrusted.json"
                    )
                stress_artifact["count"] = int(stress_metrics.get("count") or 0)
                stress_artifact["items"] = list(stress_metrics.get("items") or [])
                if args.simulate_stress_metrics_stale:
                    stress_artifact["generated_at"] = (
                        datetime.now(timezone.utc) - timedelta(hours=25)
                    ).isoformat()
                elif isinstance(stress_metrics.get("generated_at"), str):
                    stress_artifact["generated_at"] = stress_metrics["generated_at"]
            contamination_registry = promotion_evidence.get("contamination_registry")
            if not isinstance(contamination_registry, dict):
                contamination_registry = {}
                promotion_evidence["contamination_registry"] = contamination_registry
            contamination_registry["artifact_ref"] = "gates/contamination-leakage-report-v1.json"
            hmm_posterior = promotion_evidence.get("hmm_state_posterior")
            if isinstance(hmm_posterior, dict):
                hmm_posterior_payload = {
                    str(key): value for key, value in hmm_posterior.items()
                }
            else:
                promotion_evidence["hmm_state_posterior"] = {
                    "artifact_ref": "gates/hmm-state-posterior-v1.json"
                }
            promotion_evidence["hmm_state_posterior"]["artifact_ref"] = (
                "gates/hmm-state-posterior-v1.json"
            )
            expert_router_registry = promotion_evidence.get("expert_router_registry")
            if isinstance(expert_router_registry, dict):
                expert_router_payload = {
                    str(key): value for key, value in expert_router_registry.items()
                }
            else:
                expert_router_payload = {}
                promotion_evidence["expert_router_registry"] = {
                    "artifact_ref": "gates/expert-router-registry-v1.json"
                }
            promotion_evidence["expert_router_registry"]["artifact_ref"] = (
                "gates/expert-router-registry-v1.json"
            )
            foundation_router_parity = promotion_evidence.get(
                "foundation_router_parity"
            )
            if isinstance(foundation_router_parity, dict):
                foundation_router_payload = {
                    str(key): value
                    for key, value in foundation_router_parity.items()
                }
            else:
                foundation_router_payload = {}
                promotion_evidence["foundation_router_parity"] = {
                    "artifact_ref": "router/foundation-router-parity-report-v1.json"
                }
            promotion_evidence["foundation_router_parity"]["artifact_ref"] = (
                "router/foundation-router-parity-report-v1.json"
            )
            deeplob_bdlob_contract = promotion_evidence.get("deeplob_bdlob_contract")
            if isinstance(deeplob_bdlob_contract, dict):
                deeplob_bdlob_payload = {
                    str(key): value
                    for key, value in deeplob_bdlob_contract.items()
                }
            else:
                deeplob_bdlob_payload = {}
                promotion_evidence["deeplob_bdlob_contract"] = {
                    "artifact_ref": "microstructure/deeplob-bdlob-report-v1.json"
                }
            promotion_evidence["deeplob_bdlob_contract"]["artifact_ref"] = (
                "microstructure/deeplob-bdlob-report-v1.json"
            )
        if "generated_at" not in stress_artifact:
            stress_artifact["generated_at"] = datetime.now(timezone.utc).isoformat()
        (root / "gates" / "stress-metrics-v1.json").write_text(
            json.dumps(stress_artifact, indent=2), encoding="utf-8"
        )
        if args.simulate_stress_metrics_missing:
            stress_path = root / "gates" / "stress-metrics-v1.json"
            if stress_path.exists():
                stress_path.unlink()

        contamination_artifact: dict[str, Any] = {
            "schema_version": "contamination-leakage-report-v1",
            "run_id": str(gate_report.get("run_id", "run-dry-run")),
            "candidate_id": "cand-dry-run",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "status": "pass",
            "leakage_detected": False,
            "leakage_rate": 0.0,
            "temporal_integrity": {
                "event_time_ordering_passed": True,
                "embargo_windows_enforced": True,
            },
            "source_lineage": {
                "complete": True,
                "feature_sources": [
                    "research/candidate-spec.json",
                    "backtest/evaluation-report.json",
                    "gates/profitability-evidence-v4.json",
                ],
                "prompt_sources": [],
            },
            "checks": [
                {"check": "temporal_ordering", "status": "pass"},
                {"check": "lineage_complete", "status": "pass"},
                {"check": "leakage_absent", "status": "pass"},
                {"check": "embargo_windows_enforced", "status": "pass"},
            ],
            "artifact_refs": [
                "research/candidate-spec.json",
                "backtest/evaluation-report.json",
            ],
        }
        if args.simulate_contamination_failed:
            contamination_artifact["status"] = "fail"
            contamination_artifact["leakage_detected"] = True
            contamination_artifact["leakage_rate"] = 0.02
            contamination_artifact["checks"] = [
                {"check": "temporal_ordering", "status": "pass"},
                {"check": "lineage_complete", "status": "pass"},
                {"check": "leakage_absent", "status": "fail"},
                {"check": "embargo_windows_enforced", "status": "pass"},
            ]
        contamination_artifact["artifact_hash"] = _stable_hash(
            {
                key: value
                for key, value in contamination_artifact.items()
                if key != "artifact_hash"
            }
        )
        (root / "gates" / "contamination-leakage-report-v1.json").write_text(
            json.dumps(contamination_artifact, indent=2), encoding="utf-8"
        )
        if args.simulate_contamination_missing:
            contamination_path = root / "gates" / "contamination-leakage-report-v1.json"
            if contamination_path.exists():
                contamination_path.unlink()

        hmm_artifact: dict[str, Any] = {
            "schema_version": "hmm-state-posterior-v1",
            "run_id": str(gate_report.get("run_id", "run-dry-run")),
            "candidate_id": "cand-dry-run",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "samples_total": int(hmm_posterior_payload.get("samples_total") or 10),
            "authoritative_samples": int(
                hmm_posterior_payload.get("authoritative_samples") or 6
            ),
            "authoritative_sample_ratio": str(
                hmm_posterior_payload.get("authoritative_sample_ratio") or "0.6"
            ),
            "transition_shock_samples": int(
                hmm_posterior_payload.get("transition_shock_samples") or 0
            ),
            "stale_or_defensive_samples": int(
                hmm_posterior_payload.get("stale_or_defensive_samples") or 0
            ),
            "regime_counts": {"r2": 10},
            "entropy_band_counts": {"medium": 10},
            "guardrail_reason_counts": {"none": 10},
            "posterior_mass_by_regime": {"r2": "6.0", "r1": "4.0"},
            "top_regime_by_posterior_mass": "r2",
            "source_lineage": {
                "walkforward_results_artifact_ref": "backtest/evaluation-report.json",
                "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                "decision_source": "walkforward_results",
            },
        }
        hmm_artifact["artifact_hash"] = _stable_hash(
            {key: value for key, value in hmm_artifact.items() if key != "artifact_hash"}
        )
        (root / "gates" / "hmm-state-posterior-v1.json").write_text(
            json.dumps(hmm_artifact, indent=2), encoding="utf-8"
        )
        expert_router_artifact: dict[str, Any] = {
            "schema_version": "expert-router-registry-v1",
            "run_id": str(gate_report.get("run_id", "run-dry-run")),
            "candidate_id": "cand-dry-run",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "router_version": str(expert_router_payload.get("router_version") or "router-v1"),
            "route_count": int(expert_router_payload.get("route_count") or 10),
            "fallback_count": int(expert_router_payload.get("fallback_count") or 0),
            "fallback_rate": str(expert_router_payload.get("fallback_rate") or "0"),
            "max_expert_weight": str(expert_router_payload.get("max_expert_weight") or "0.62"),
            "avg_expert_weights": {
                "trend": "0.62",
                "reversal": "0.14",
                "breakout": "0.20",
                "defensive": "0.04",
            },
            "top_expert_counts": {
                "trend": 10,
                "reversal": 0,
                "breakout": 0,
                "defensive": 0,
            },
            "concentration": {
                "dominant_expert": "trend",
                "dominant_expert_count": 10,
                "max_expert_weight": str(
                    expert_router_payload.get("max_expert_weight") or "0.62"
                ),
            },
            "slo_feedback": {
                "max_fallback_rate": str(
                    policy.get("promotion_expert_router_max_fallback_rate", "0.05")
                ),
                "max_expert_concentration": str(
                    policy.get(
                        "promotion_expert_router_max_expert_concentration", "0.85"
                    )
                ),
                "fallback_rate": str(expert_router_payload.get("fallback_rate") or "0"),
                "max_observed_expert_weight": str(
                    expert_router_payload.get("max_expert_weight") or "0.62"
                ),
                "fallback_slo_pass": True,
                "concentration_slo_pass": True,
                "overall_status": "pass",
                "reasons": [],
            },
            "source_lineage": {
                "walkforward_results_artifact_ref": "backtest/evaluation-report.json",
                "hmm_state_posterior_artifact_ref": "gates/hmm-state-posterior-v1.json",
                "gate_policy_artifact_ref": "gates/gate-evaluation.json",
                "strategy_config_artifact_ref": "research/candidate-spec.json",
            },
        }
        expert_router_artifact["artifact_hash"] = _stable_hash(
            {
                key: value
                for key, value in expert_router_artifact.items()
                if key != "artifact_hash"
            }
        )
        (root / "gates" / "expert-router-registry-v1.json").write_text(
            json.dumps(expert_router_artifact, indent=2), encoding="utf-8"
        )
        foundation_router_artifact: dict[str, Any] = {
            "schema_version": "foundation-router-parity-report-v1",
            "candidate_id": "cand-dry-run",
            "router_policy_version": "forecast_router_policy_v1",
            "contract": {
                "schema_version": "foundation-router-parity-contract-v1",
                "required_adapters": ["deterministic", "chronos", "timesfm"],
                "required_slice_metrics": ["by_symbol", "by_horizon", "by_regime"],
                "hash_algorithm": "sha256",
                "generation_mode": "deterministic_foundation_router_parity_v1",
            },
            "adapters": ["deterministic", "chronos", "timesfm"],
            "slice_metrics": {
                "by_symbol": {"AAPL": {"status": "pass"}},
                "by_horizon": {"1m": {"status": "pass"}},
                "by_regime": {"trend": {"status": "pass"}},
            },
            "calibration_metrics": {
                "minimum": float(
                    policy.get("promotion_router_parity_min_calibration_score", 0.9)
                ),
            },
            "latency_metrics": {
                "p95_ms": int(
                    policy.get("promotion_router_parity_max_latency_ms_p95", 200)
                ),
            },
            "fallback_metrics": {
                "fallback_rate": float(
                    policy.get("promotion_router_parity_max_fallback_rate", 0.05)
                )
                / 2.0,
            },
            "drift_metrics": {
                "max": float(policy.get("promotion_router_parity_max_drift", 0.45))
                / 3.0,
            },
            "overall_status": "pass",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        if foundation_router_payload.get("overall_status") is not None:
            foundation_router_artifact["overall_status"] = str(
                foundation_router_payload.get("overall_status")
            )
        foundation_router_artifact["artifact_hash"] = _stable_hash(
            {
                key: value
                for key, value in foundation_router_artifact.items()
                if key != "artifact_hash"
            }
        )
        (root / "router").mkdir(parents=True, exist_ok=True)
        (root / "router" / "foundation-router-parity-report-v1.json").write_text(
            json.dumps(foundation_router_artifact, indent=2), encoding="utf-8"
        )
        (root / "microstructure").mkdir(parents=True, exist_ok=True)
        for supporting_name in (
            "lob-feature-quality-report.json",
            "microstructure-model-metrics.json",
            "tca-divergence-report.json",
            "risk-gate-compatibility-report.json",
        ):
            (root / "microstructure" / supporting_name).write_text(
                json.dumps({"status": "pass"}, indent=2),
                encoding="utf-8",
            )
        deeplob_bdlob_artifact: dict[str, Any] = {
            "schema_version": "deeplob-bdlob-report-v1",
            "candidate_id": "cand-dry-run",
            "feature_policy_version": str(
                policy.get("required_feature_schema_version", "3.0.0")
            ),
            "contract": {
                "schema_version": "deeplob-bdlob-contract-v1",
                "required_supporting_artifacts": [
                    "microstructure/lob-feature-quality-report.json",
                    "microstructure/microstructure-model-metrics.json",
                    "microstructure/tca-divergence-report.json",
                    "microstructure/risk-gate-compatibility-report.json",
                ],
                "required_summary_fields": [
                    "feature_quality_summary",
                    "prediction_quality_summary",
                    "execution_impact_summary",
                    "cost_adjusted_outcomes",
                    "fallback_summary",
                ],
                "hash_algorithm": "sha256",
                "generation_mode": "deterministic_deeplob_bdlob_contract_v1",
            },
            "supporting_artifacts": [
                "microstructure/lob-feature-quality-report.json",
                "microstructure/microstructure-model-metrics.json",
                "microstructure/tca-divergence-report.json",
                "microstructure/risk-gate-compatibility-report.json",
            ],
            "feature_quality_summary": {
                "pass_rate": float(
                    policy.get("promotion_deeplob_bdlob_min_feature_quality_pass_rate", 0.99)
                ),
                "status": "pass",
            },
            "prediction_quality_summary": {
                "score": float(
                    policy.get("promotion_deeplob_bdlob_min_prediction_quality_score", 0.85)
                ),
                "status": "pass",
            },
            "execution_impact_summary": {
                "slippage_divergence_bps": float(
                    policy.get("promotion_deeplob_bdlob_max_slippage_divergence_bps", 1.0)
                )
                / 2.0,
                "deterministic_gate_compatible": True,
                "status": "pass",
            },
            "cost_adjusted_outcomes": {
                "edge_bps": float(
                    policy.get("promotion_deeplob_bdlob_min_cost_adjusted_edge_bps", 0.0)
                )
                + 0.5,
                "status": "pass",
            },
            "fallback_summary": {
                "reliability": float(
                    policy.get("promotion_deeplob_bdlob_min_fallback_reliability", 0.99)
                ),
                "slo_pass": True,
                "status": "pass",
            },
            "overall_status": str(deeplob_bdlob_payload.get("overall_status") or "pass"),
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        deeplob_bdlob_artifact["artifact_hash"] = _stable_hash(
            {
                key: value
                for key, value in deeplob_bdlob_artifact.items()
                if key != "artifact_hash"
            }
        )
        (root / "microstructure" / "deeplob-bdlob-report-v1.json").write_text(
            json.dumps(deeplob_bdlob_artifact, indent=2),
            encoding="utf-8",
        )

        if args.simulate_missing_artifact:
            (root / "paper-candidate" / "strategy-configmap-patch.yaml").unlink()

        stale_ts = "2025-01-01T00:00:00+00:00"
        recent_ts = datetime.now(timezone.utc).isoformat()
        state = {
            "candidateId": "cand-dry-run",
            "runId": str(gate_report.get("run_id", "run-dry-run")),
            "activeStage": "gate-evaluation",
            "paused": False,
            "rollbackReadiness": {
                "killSwitchDryRunPassed": True,
                "gitopsRevertDryRunPassed": True,
                "strategyDisableDryRunPassed": True,
                "dryRunCompletedAt": stale_ts
                if args.simulate_stale_rollback
                else recent_ts,
                "humanApproved": True,
                "rollbackTarget": "main@abcdef0",
            },
        }
        promotion = evaluate_promotion_prerequisites(
            policy_payload=policy,
            gate_report_payload=gate_report,
            candidate_state_payload=state,
            promotion_target=args.promotion_target,
            artifact_root=root,
        )
        rollback = evaluate_rollback_readiness(
            policy_payload=policy, candidate_state_payload=state
        )

        payload = {
            "promotion_target": args.promotion_target,
            "promotion_prerequisites": promotion.to_payload(),
            "rollback_readiness": rollback.to_payload(),
            "promotion_progression_allowed": promotion.allowed and rollback.ready,
            "simulation": {
                "missing_artifact": args.simulate_missing_artifact,
                "stale_rollback": args.simulate_stale_rollback,
                "missing_stress_metrics": args.simulate_stress_metrics_missing,
                "stale_stress_metrics": args.simulate_stress_metrics_stale,
                "untrusted_stress_metrics": args.simulate_stress_metrics_untrusted,
                "missing_contamination_registry": args.simulate_contamination_missing,
                "failed_contamination_registry": args.simulate_contamination_failed,
            },
        }

    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

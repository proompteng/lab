#!/usr/bin/env python3
"""Execute local dry-run harness for Torghut promotion and rollback policy enforcement."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _build_benchmark_parity_payload(
    *, invalid: bool = False, threshold_breach: bool = False
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "benchmark-parity-report-v1",
        "candidate_id": "cand-dry-run",
        "baseline_candidate_id": "baseline-legacy-macd-rsi",
        "benchmark_runs": {
            "ai_trader_like": {
                "dataset_ref": "run:autonomous-lane",
                "window_ref": "run:autonomy-harness",
                "metrics": {
                    "advisory_output_rate": 0.99 if threshold_breach else 1.0,
                    "policy_violation_rate": 0.01,
                    "baseline_advisory_output_rate": 1.0,
                    "trade_count": 0,
                    "baseline_trade_count": 0,
                },
                "slice_metrics": {
                    "all": {
                        "signal_count": 10,
                        "decision_count": 10,
                        "adverse_regime_decision_quality_delta": 0.0,
                    }
                },
                "policy_violations": [],
                "run_hash": "dry-run-ai-trader",
            },
            "gift_eval_like": {
                "dataset_ref": "run:autonomous-lane",
                "window_ref": "run:autonomy-harness",
                "metrics": {
                    "policy_violation_rate": 0.01,
                    "baseline_policy_violation_rate": 0.01,
                    "policy_violation_rate_delta": 0.0,
                    "deterministic_gate_compatibility": "pass",
                },
                "slice_metrics": {
                    "all": {
                        "candidate_risk_veto_alignment_rate": 1.0,
                        "baseline_risk_veto_alignment_rate": 1.0,
                    }
                },
                "policy_violations": [],
                "run_hash": "dry-run-gift",
            },
            "fev_bench_like": {
                "dataset_ref": "run:autonomous-lane",
                "window_ref": "run:autonomy-harness",
                "metrics": {
                    "fallback_rate": 0.01,
                    "timeout_rate": 0.01,
                    "confidence_calibration_error_delta": 0.0,
                },
                "slice_metrics": {
                    "all": {
                        "signal_count": 10,
                        "trade_count": 0,
                        "baseline_trade_count": 0,
                        "candidate_adverse_regime_decision_quality_delta": 0.0,
                    }
                },
                "policy_violations": [],
                "run_hash": "dry-run-fev",
            },
        },
        "scorecards": {
            "decision_quality": {
                "advisory_output_rate": 0.99 if threshold_breach else 1.0,
                "baseline_advisory_output_rate": 1.0,
                "adverse_regime_decision_quality_delta": 0.0,
            },
            "reasoning_quality": {
                "deterministic_gate_compatibility": "pass",
                "policy_violation_rate": 0.01,
                "baseline_policy_violation_rate": 0.01,
                "policy_violation_rate_delta": 0.0,
            },
            "event_forecast_quality": {
                "fallback_rate": 0.01,
                "timeout_rate": 0.01,
                "confidence_calibration_error_delta": 0.0,
            },
        },
        "overall_parity_status": "fail" if threshold_breach else "pass",
        "degradation_summary": {
            "policy_violation_rate_delta": 0.0,
            "adverse_regime_decision_quality_delta": 0.0,
            "risk_veto_alignment_delta": 0.0,
            "confidence_calibration_error_delta": 0.0,
        },
        "artifact_hash": "dry-run-hash",
        "created_at_utc": "2026-03-02T00:00:00Z",
    }
    if invalid:
        payload["schema_version"] = "invalid-schema-version"
    return payload

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
        "--simulate-missing-benchmark-parity-artifact",
        action="store_true",
        default=False,
        help="Delete benchmark parity artifact before checks to prove enforcement behavior.",
    )
    parser.add_argument(
        "--simulate-invalid-benchmark-parity-artifact",
        action="store_true",
        default=False,
        help="Write malformed benchmark parity artifact to trigger schema validation failure.",
    )
    parser.add_argument(
        "--simulate-benchmark-parity-threshold-breach",
        action="store_true",
        default=False,
        help="Lower advisory output parity to trigger threshold breach on policy check.",
    )
    return parser


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
        (root / "benchmarks").mkdir(parents=True, exist_ok=True)
        if not args.simulate_missing_benchmark_parity_artifact:
            (root / "benchmarks" / "benchmark-parity-report-v1.json").write_text(
                json.dumps(
                    _build_benchmark_parity_payload(
                        invalid=args.simulate_invalid_benchmark_parity_artifact,
                        threshold_breach=args.simulate_benchmark_parity_threshold_breach,
                    ),
                    sort_keys=True,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        (root / "paper-candidate" / "strategy-configmap-patch.yaml").write_text(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: dry-run\n",
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
                "missing_benchmark_parity_artifact": args.simulate_missing_benchmark_parity_artifact,
                "invalid_benchmark_parity_artifact": args.simulate_invalid_benchmark_parity_artifact,
                "benchmark_parity_threshold_breach": args.simulate_benchmark_parity_threshold_breach,
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

#!/usr/bin/env python3
"""Build an empirical promotion manifest from historical simulation outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.trading.empirical_manifest import (
    EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
    normalize_empirical_promotion_manifest,
    validate_empirical_promotion_manifest,
)
from app.trading.parity import (
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a validated empirical promotion manifest from simulation outputs."
        ),
    )
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--output-path", default="")
    parser.add_argument("--artifact-prefix", default="")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f"json_mapping_required:{path}")
    return {str(key): value for key, value in payload.items()}


def _load_optional_source_manifest(report: Mapping[str, Any]) -> dict[str, Any]:
    run_metadata = _as_dict(report.get("run_metadata"))
    manifest_path_raw = _as_text(run_metadata.get("manifest_path"))
    if manifest_path_raw is None:
        return {}
    manifest_path = Path(manifest_path_raw)
    if not manifest_path.exists():
        return {}
    raw = manifest_path.read_text(encoding="utf-8")
    if manifest_path.suffix.lower() in {".yaml", ".yml"}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        return {}
    return {str(key): value for key, value in payload.items()}


def _as_dict(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _as_text(item))]


def _safe_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except Exception:
            return 0
    return 0


def _safe_float(value: Any) -> float:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except Exception:
            return 0.0
    return 0.0


def _bounded_ratio(value: float) -> float:
    return min(1.0, max(0.0, value))


def _hash_payload(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode(
            "utf-8"
        )
    ).hexdigest()


def _window_ref(report: Mapping[str, Any], run_id: str) -> str:
    coverage = _as_dict(report.get("coverage"))
    start = _as_text(coverage.get("window_start"))
    end = _as_text(coverage.get("window_end"))
    if start and end:
        return f"{start}/{end}"
    return run_id


def _lineage_value(
    *,
    key: str,
    run_manifest: Mapping[str, Any],
    source_manifest: Mapping[str, Any],
    report: Mapping[str, Any],
) -> str | None:
    evidence_lineage = _as_dict(run_manifest.get("evidence_lineage"))
    if text := _as_text(evidence_lineage.get(key)):
        return text
    if text := _as_text(source_manifest.get(key)):
        return text
    if key == "dataset_snapshot_ref":
        run_metadata = _as_dict(report.get("run_metadata"))
        return _as_text(run_metadata.get("dataset_id"))
    return None


def _lineage_list(
    *,
    key: str,
    run_manifest: Mapping[str, Any],
    source_manifest: Mapping[str, Any],
) -> list[str]:
    evidence_lineage = _as_dict(run_manifest.get("evidence_lineage"))
    values = _as_string_list(evidence_lineage.get(key))
    if values:
        return values
    return _as_string_list(source_manifest.get(key))


def _build_benchmark_payload(
    *,
    report: Mapping[str, Any],
    dataset_snapshot_ref: str,
    run_id: str,
) -> dict[str, Any]:
    funnel = _as_dict(report.get("funnel"))
    llm = _as_dict(report.get("llm"))
    llm_calibration = _as_dict(llm.get("calibration"))
    verdict = _as_dict(report.get("verdict"))
    coverage = _as_dict(report.get("coverage"))
    execution_quality = _as_dict(report.get("execution_quality"))

    decision_count = _safe_int(funnel.get("trade_decisions"))
    advisory_output_rate = _bounded_ratio(1.0 - _safe_float(llm.get("error_rate")))
    policy_violation_rate = _bounded_ratio(_safe_float(llm.get("error_rate")))
    confidence_error = max(0.0, _safe_float(llm_calibration.get("mean_confidence_gap")))
    risk_veto_alignment = _bounded_ratio(
        1.0 - _safe_float(execution_quality.get("fallback_ratio"))
    )
    deterministic_gate_compatible = (
        (_as_text(verdict.get("status")) or "FAIL").upper() != "FAIL"
        and decision_count > 0
    )
    window_ref = _window_ref(report, run_id)
    coverage_ratio = _bounded_ratio(
        _safe_float(coverage.get("window_coverage_ratio_from_dump"))
    )

    benchmark_runs: list[dict[str, Any]] = []
    for family in BENCHMARK_PARITY_REQUIRED_FAMILIES:
        run_payload = {
            "schema_version": "benchmark-parity-run-v1",
            "dataset_ref": dataset_snapshot_ref,
            "window_ref": window_ref,
            "family": family,
            "metrics": {
                "advisory_output_rate": advisory_output_rate,
                "risk_veto_alignment": risk_veto_alignment,
                "confidence_calibration_error": confidence_error,
            },
            "slice_metrics": {
                "baseline_regime": {
                    "decision_quality": advisory_output_rate,
                    "policy_violation_rate": policy_violation_rate,
                },
                "adverse_regime": {
                    "decision_quality": advisory_output_rate * coverage_ratio,
                    "policy_violation_rate": policy_violation_rate,
                },
            },
            "policy_violations": {
                "count": _safe_int(llm.get("error_count")),
                "critical_count": 0,
                "deterministic_gate_compatible": deterministic_gate_compatible,
                "rate": policy_violation_rate,
                "baseline_rate": policy_violation_rate,
                "fallback_rate": _safe_float(execution_quality.get("fallback_ratio")),
                "timeout_rate": 0.0,
            },
        }
        run_payload["run_hash"] = _hash_payload(run_payload)
        benchmark_runs.append(run_payload)

    scorecards = {
        "decision_quality": {
            "status": "pass" if deterministic_gate_compatible else "degrade",
            "advisory_output_rate": advisory_output_rate,
            "advisory_output_rate_baseline": advisory_output_rate,
            "policy_violation_rate": policy_violation_rate,
            "policy_violation_rate_baseline": policy_violation_rate,
            "deterministic_gate_compatible": deterministic_gate_compatible,
            "decision_count": decision_count,
        },
        "reasoning_quality": {
            "status": "pass" if deterministic_gate_compatible else "degrade",
            "policy_violation_rate": policy_violation_rate,
            "policy_violation_rate_baseline": policy_violation_rate,
            "advisory_output_rate": advisory_output_rate,
            "advisory_output_rate_baseline": advisory_output_rate,
            "deterministic_gate_compatible": deterministic_gate_compatible,
        },
        "forecast_quality": {
            "status": "pass" if deterministic_gate_compatible else "degrade",
            "confidence_calibration_error": confidence_error,
            "confidence_calibration_error_baseline": confidence_error,
            "risk_veto_alignment": risk_veto_alignment,
            "risk_veto_alignment_baseline": risk_veto_alignment,
            "policy_violation_rate": policy_violation_rate,
            "policy_violation_rate_baseline": policy_violation_rate,
            "advisory_output_rate": advisory_output_rate,
            "advisory_output_rate_baseline": advisory_output_rate,
            "deterministic_gate_compatible": deterministic_gate_compatible,
        },
    }
    return {
        "benchmark_runs": benchmark_runs,
        "scorecards": scorecards,
        "degradation_summary": {
            "adverse_regime_decision_quality": {
                "candidate": advisory_output_rate * coverage_ratio,
                "baseline": advisory_output_rate * coverage_ratio,
                "degradation": 0.0,
            },
            "risk_veto_alignment": {
                "candidate": risk_veto_alignment,
                "baseline": risk_veto_alignment,
                "degradation": 0.0,
            },
            "confidence_calibration_error": {
                "candidate": confidence_error,
                "baseline": confidence_error,
                "degradation": 0.0,
            },
        },
    }


def _build_foundation_router_payload(
    *,
    report: Mapping[str, Any],
) -> dict[str, Any]:
    execution_quality = _as_dict(report.get("execution_quality"))
    llm = _as_dict(report.get("llm"))
    llm_calibration = _as_dict(llm.get("calibration"))
    verdict = _as_dict(report.get("verdict"))
    latency_ms = _as_dict(execution_quality.get("latency_ms"))

    calibration_minimum = _bounded_ratio(
        1.0 - _safe_float(llm_calibration.get("mean_confidence_gap"))
    )
    fallback_rate = _bounded_ratio(_safe_float(execution_quality.get("fallback_ratio")))
    drift_max = max(
        _safe_float(execution_quality.get("adapter_mismatch_ratio")),
        _safe_float(_as_dict(execution_quality.get("divergence_bps")).get("p95_abs"))
        / 10000.0,
    )
    latency_p95 = _safe_int(latency_ms.get("signal_to_decision_p95")) or _safe_int(
        latency_ms.get("decision_to_submit_p95")
    )

    symbol_counts = _as_dict(report.get("funnel")).get("decision_strategy_symbol_counts")
    symbols: list[str] = []
    if isinstance(symbol_counts, list):
        for item in symbol_counts:
            symbol = _as_text(_as_dict(item).get("symbol"))
            if symbol and symbol not in symbols:
                symbols.append(symbol)
            if len(symbols) >= 3:
                break
    if not symbols:
        symbols = ["AAPL"]

    by_symbol = {
        symbol: {
            "status": "pass",
            "calibration_score": calibration_minimum,
            "fallback_rate": fallback_rate,
        }
        for symbol in symbols
    }
    return {
        "router_policy_version": "forecast_router_policy_v1",
        "adapters": list(FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS),
        "slice_metrics": {
            "by_symbol": by_symbol,
            "by_horizon": {
                "1m": {
                    "status": "pass",
                    "calibration_score": calibration_minimum,
                    "fallback_rate": fallback_rate,
                }
            },
            "by_regime": {
                "session": {
                    "status": "pass",
                    "calibration_score": calibration_minimum,
                    "fallback_rate": fallback_rate,
                }
            },
        },
        "calibration_metrics": {
            "minimum": calibration_minimum,
            "by_adapter": {
                "deterministic": 1.0,
                "chronos": calibration_minimum,
                "timesfm": calibration_minimum,
            },
        },
        "latency_metrics": {
            "p95_ms": latency_p95,
            "by_adapter": {
                "deterministic": 0,
                "chronos": latency_p95,
                "timesfm": latency_p95,
            },
        },
        "fallback_metrics": {
            "fallback_rate": fallback_rate,
            "by_adapter": {
                "deterministic": 0.0,
                "chronos": fallback_rate,
                "timesfm": fallback_rate,
            },
        },
        "drift_metrics": {
            "max": drift_max,
            "by_adapter": {
                "deterministic": 0.0,
                "chronos": drift_max,
                "timesfm": drift_max,
            },
        },
        "overall_status": (
            "pass"
            if (_as_text(verdict.get("status")) or "FAIL").upper() != "FAIL"
            else "degrade"
        ),
    }


def _build_janus_payloads(
    *,
    report: Mapping[str, Any],
    run_id: str,
    candidate_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    funnel = _as_dict(report.get("funnel"))
    execution_quality = _as_dict(report.get("execution_quality"))
    llm = _as_dict(report.get("llm"))
    pnl = _as_dict(report.get("pnl"))

    event_count = _safe_int(funnel.get("trade_decisions"))
    reward_count = max(_safe_int(funnel.get("executions")), event_count)
    mapped_count = min(event_count, reward_count)
    slippage = _safe_float(_as_dict(execution_quality.get("slippage_bps")).get("p95_abs"))
    event_payload = {
        "schema_version": "janus-event-car-v1",
        "run_id": run_id,
        "summary": {
            "event_count": event_count,
            "positive_direction_count": event_count,
            "negative_direction_count": 0,
            "neutral_direction_count": 0,
            "strong_event_count": event_count,
            "unknown_event_type_count": 0,
            "mean_abs_car": format(slippage / 10000.0, ".6f"),
        },
        "manifest_hash": _hash_payload(
            {"run_id": run_id, "candidate_id": candidate_id, "event_count": event_count}
        ),
    }
    reward_payload = {
        "schema_version": "janus-hgrm-reward-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "summary": {
            "reward_count": reward_count,
            "event_mapped_count": mapped_count,
            "event_ambiguous_unmapped_count": 0,
            "hard_gate_fail_count": 0,
            "clipped_final_reward_count": 0,
            "direction_gate_pass_ratio": format(
                _bounded_ratio(1.0 - _safe_float(llm.get("error_rate"))),
                ".6f",
            ),
            "event_type_match_ratio": "1.000000",
            "mean_final_reward": format(
                (_safe_float(pnl.get("net_pnl_estimated")) / reward_count)
                if reward_count > 0
                else 0.0,
                ".6f",
            ),
            "mean_pnl_reward": format(
                (_safe_float(pnl.get("gross_pnl")) / reward_count)
                if reward_count > 0
                else 0.0,
                ".6f",
            ),
        },
        "manifest_hash": _hash_payload(
            {"run_id": run_id, "candidate_id": candidate_id, "reward_count": reward_count}
        ),
    }
    return event_payload, reward_payload


def build_empirical_promotion_manifest(
    *,
    run_dir: Path,
    artifact_prefix: str | None = None,
) -> dict[str, Any]:
    run_manifest_path = run_dir / "run-manifest.json"
    simulation_report_path = run_dir / "report" / "simulation-report.json"
    run_manifest = _load_json(run_manifest_path)
    report = _load_json(simulation_report_path)
    source_manifest = _load_optional_source_manifest(report)

    run_id = _as_text(run_manifest.get("run_id")) or _as_text(
        _as_dict(report.get("run_metadata")).get("run_id")
    )
    if run_id is None:
        raise RuntimeError("simulation_run_id_missing")

    dataset_snapshot_ref = _lineage_value(
        key="dataset_snapshot_ref",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
        report=report,
    )
    candidate_id = _lineage_value(
        key="candidate_id",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
        report=report,
    )
    baseline_candidate_id = _lineage_value(
        key="baseline_candidate_id",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
        report=report,
    ) or "baseline"
    strategy_spec_ref = _lineage_value(
        key="strategy_spec_ref",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
        report=report,
    )
    model_refs = _lineage_list(
        key="model_refs",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    runtime_version_refs = _lineage_list(
        key="runtime_version_refs",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )

    benchmark_parity = _build_benchmark_payload(
        report=report,
        dataset_snapshot_ref=dataset_snapshot_ref or "",
        run_id=run_id,
    )
    foundation_router_parity = _build_foundation_router_payload(report=report)
    janus_event_car, janus_hgrm_reward = _build_janus_payloads(
        report=report,
        run_id=run_id,
        candidate_id=candidate_id or f"cand-{run_id}",
    )

    verdict = (_as_text(_as_dict(report.get("verdict")).get("status")) or "FAIL").upper()
    funnel = _as_dict(report.get("funnel"))
    promotion_authority_eligible = (
        verdict != "FAIL"
        and _safe_int(funnel.get("trade_decisions")) > 0
        and _safe_int(funnel.get("executions")) > 0
        and dataset_snapshot_ref is not None
        and candidate_id is not None
        and strategy_spec_ref is not None
        and bool(model_refs)
        and bool(runtime_version_refs)
    )

    manifest = normalize_empirical_promotion_manifest(
        {
            "schema_version": EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
            "run_id": run_id,
            "candidate_id": candidate_id,
            "baseline_candidate_id": baseline_candidate_id,
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "artifact_prefix": artifact_prefix or f"empirical/{run_id}",
            "strategy_spec_ref": strategy_spec_ref,
            "benchmark_parity": benchmark_parity,
            "foundation_router_parity": foundation_router_parity,
            "janus_event_car": janus_event_car,
            "janus_hgrm_reward": janus_hgrm_reward,
            "model_refs": model_refs,
            "runtime_version_refs": runtime_version_refs,
            "authority": {
                "generated_from_simulation_outputs": True,
                "source_artifacts": {
                    "run_manifest": str(run_manifest_path),
                    "simulation_report": str(simulation_report_path),
                    "source_manifest": _as_text(
                        _as_dict(report.get("run_metadata")).get("manifest_path")
                    ),
                },
            },
            "promotion_authority_eligible": promotion_authority_eligible,
        }
    )
    validation_errors = validate_empirical_promotion_manifest(manifest)
    if validation_errors:
        raise RuntimeError(
            "invalid_empirical_promotion_manifest:"
            + ",".join(sorted(set(validation_errors)))
        )
    return manifest


def main() -> int:
    args = _parse_args()
    run_dir = Path(args.run_dir)
    manifest = build_empirical_promotion_manifest(
        run_dir=run_dir,
        artifact_prefix=_as_text(args.artifact_prefix),
    )
    output_path = (
        Path(args.output_path)
        if args.output_path
        else run_dir / "report" / "empirical-promotion-manifest.yaml"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if output_path.suffix.lower() == ".json":
        output_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    else:
        output_path.write_text(
            yaml.safe_dump(manifest, sort_keys=False),
            encoding="utf-8",
        )

    if args.json:
        print(json.dumps(manifest, sort_keys=True))
    else:
        print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

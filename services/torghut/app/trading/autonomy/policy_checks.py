"""Promotion progression and rollback readiness policy checks for Torghut autonomy."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Any, cast


@dataclass(frozen=True)
class PromotionPrerequisiteResult:
    allowed: bool
    reasons: list[str]
    required_artifacts: list[str]
    missing_artifacts: list[str]
    reason_details: list[dict[str, object]]
    artifact_refs: list[str]
    required_throughput: dict[str, int]
    observed_throughput: dict[str, int | bool | str | None]

    def to_payload(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "reasons": list(self.reasons),
            "required_artifacts": list(self.required_artifacts),
            "missing_artifacts": list(self.missing_artifacts),
            "reason_details": [dict(item) for item in self.reason_details],
            "artifact_refs": list(self.artifact_refs),
            "required_throughput": dict(self.required_throughput),
            "observed_throughput": dict(self.observed_throughput),
        }


@dataclass(frozen=True)
class RollbackReadinessResult:
    ready: bool
    reasons: list[str]
    required_checks: list[str]
    missing_checks: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "ready": self.ready,
            "reasons": list(self.reasons),
            "required_checks": list(self.required_checks),
            "missing_checks": list(self.missing_checks),
        }


def evaluate_promotion_prerequisites(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    promotion_target: str,
    artifact_root: Path,
) -> PromotionPrerequisiteResult:
    reasons: list[str] = []
    reason_details: list[dict[str, object]] = []
    profitability_required = _requires_profitability_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    required_artifacts = _required_artifacts_for_target(
        policy_payload,
        promotion_target,
        include_profitability_artifacts=profitability_required,
    )
    missing_artifacts = [
        item for item in required_artifacts if not (artifact_root / item).exists()
    ]
    artifact_refs = [str(artifact_root / item) for item in required_artifacts]
    throughput_requirements = _required_throughput(policy_payload)
    throughput_observed = _observed_throughput(
        gate_report_payload=gate_report_payload,
        candidate_state_payload=candidate_state_payload,
    )

    if missing_artifacts:
        reasons.append("required_artifacts_missing")
        reason_details.append(
            {
                "reason": "required_artifacts_missing",
                "missing_artifacts": list(missing_artifacts),
            }
        )

    if candidate_state_payload.get("paused", False):
        reasons.append("candidate_paused_for_review")
        reason_details.append({"reason": "candidate_paused_for_review"})

    if not bool(gate_report_payload.get("promotion_allowed", False)):
        reasons.append("gate_report_not_promotable")
        reason_details.append({"reason": "gate_report_not_promotable"})

    requested_rank = _promotion_rank(promotion_target)
    recommended_rank = _promotion_rank(
        str(gate_report_payload.get("recommended_mode", "shadow"))
    )
    if recommended_rank < requested_rank:
        reasons.append("gate_recommended_mode_below_target")
        reason_details.append(
            {
                "reason": "gate_recommended_mode_below_target",
                "requested_target": promotion_target,
                "recommended_mode": str(
                    gate_report_payload.get("recommended_mode", "shadow")
                ),
            }
        )

    gate_index = {
        str(gate.get("gate_id", "")): gate for gate in _gates(gate_report_payload)
    }
    required_gates = [
        "gate0_data_integrity",
        "gate1_statistical_robustness",
        "gate2_risk_capacity",
    ]
    if promotion_target != "shadow":
        required_gates.append("gate7_uncertainty_calibration")
    for required_gate in required_gates:
        status = str(gate_index.get(required_gate, {}).get("status", "fail"))
        if status != "pass":
            reasons.append(f"{required_gate}_not_passed")
            reason_details.append(
                {
                    "reason": f"{required_gate}_not_passed",
                    "gate_id": required_gate,
                    "status": status,
                }
            )

    if promotion_target != "shadow":
        uncertainty_action = str(
            gate_report_payload.get("uncertainty_gate_action", "abstain")
        ).strip()
        if uncertainty_action != "pass":
            reasons.append("uncertainty_gate_not_pass")
            reason_details.append(
                {
                    "reason": "uncertainty_gate_not_pass",
                    "uncertainty_gate_action": uncertainty_action,
                }
            )

        max_coverage_error = _float_or_default(
            policy_payload.get("promotion_uncertainty_max_coverage_error"),
            0.03,
        )
        coverage_error = _float_or_default(
            gate_report_payload.get("coverage_error"), 1.0
        )
        if coverage_error > max_coverage_error:
            reasons.append("uncertainty_calibration_slo_failed")
            reason_details.append(
                {
                    "reason": "uncertainty_calibration_slo_failed",
                    "coverage_error": coverage_error,
                    "maximum": max_coverage_error,
                }
            )

        recalibration_run_id = str(
            gate_report_payload.get("recalibration_run_id", "")
        ).strip()
        if (
            uncertainty_action in {"degrade", "abstain", "fail"}
            and not recalibration_run_id
        ):
            reasons.append("uncertainty_recalibration_run_missing")
            reason_details.append({"reason": "uncertainty_recalibration_run_missing"})

    if bool(throughput_observed.get("no_signal_window", False)):
        reasons.append("no_signal_window_detected")
        reason_details.append(
            {
                "reason": "no_signal_window_detected",
                "no_signal_reason": throughput_observed.get("no_signal_reason"),
            }
        )

    has_explicit_throughput = bool(
        throughput_observed.get("has_explicit_throughput", False)
    )
    if has_explicit_throughput:
        signal_count = _int_or_default(throughput_observed.get("signal_count"), 0)
        if signal_count < throughput_requirements["min_signal_count"]:
            reasons.append("signal_count_below_minimum_for_progression")
            reason_details.append(
                {
                    "reason": "signal_count_below_minimum_for_progression",
                    "signal_count": signal_count,
                    "minimum_signal_count": throughput_requirements["min_signal_count"],
                }
            )

        decision_count = _int_or_default(throughput_observed.get("decision_count"), 0)
        if decision_count < throughput_requirements["min_decision_count"]:
            reasons.append("decision_count_below_minimum_for_progression")
            reason_details.append(
                {
                    "reason": "decision_count_below_minimum_for_progression",
                    "decision_count": decision_count,
                    "minimum_decision_count": throughput_requirements[
                        "min_decision_count"
                    ],
                }
            )

        trade_count = _int_or_default(throughput_observed.get("trade_count"), 0)
        if trade_count < throughput_requirements["min_trade_count"]:
            reasons.append("trade_count_below_minimum_for_progression")
            reason_details.append(
                {
                    "reason": "trade_count_below_minimum_for_progression",
                    "trade_count": trade_count,
                    "minimum_trade_count": throughput_requirements["min_trade_count"],
                }
            )

    if (
        str(candidate_state_payload.get("runId", "")).strip()
        != str(gate_report_payload.get("run_id", "")).strip()
    ):
        # gate report payload may not always include run_id; only enforce when available.
        run_id = str(gate_report_payload.get("run_id", "")).strip()
        if run_id:
            reasons.append("run_id_mismatch_between_state_and_gate_report")
            reason_details.append(
                {
                    "reason": "run_id_mismatch_between_state_and_gate_report",
                    "candidate_run_id": str(
                        candidate_state_payload.get("runId", "")
                    ).strip(),
                    "gate_report_run_id": run_id,
                }
            )

    if profitability_required:
        evidence_validation_relpath = str(
            policy_payload.get(
                "promotion_profitability_validation_artifact",
                "gates/profitability-evidence-validation.json",
            )
        )
        evidence_validation_path = artifact_root / evidence_validation_relpath
        evidence_validation_payload = _load_json_if_exists(evidence_validation_path)
        if evidence_validation_payload is None:
            reasons.append("profitability_evidence_validation_missing")
            reason_details.append(
                {
                    "reason": "profitability_evidence_validation_missing",
                    "artifact_ref": str(evidence_validation_path),
                }
            )
        elif not bool(evidence_validation_payload.get("passed", False)):
            reasons.append("profitability_evidence_validation_failed")
            reason_details.append(
                {
                    "reason": "profitability_evidence_validation_failed",
                    "artifact_ref": str(evidence_validation_path),
                    "validation_reasons": _list_of_strings(
                        evidence_validation_payload.get("reasons")
                    ),
                }
            )

        benchmark_relpath = str(
            policy_payload.get(
                "promotion_profitability_benchmark_artifact",
                "gates/profitability-benchmark-v4.json",
            )
        )
        benchmark_path = artifact_root / benchmark_relpath
        benchmark_payload = _load_json_if_exists(benchmark_path)
        minimum_regime_slices = int(
            policy_payload.get("promotion_profitability_min_regime_slices", 1)
        )
        if benchmark_payload is None:
            reasons.append("profitability_benchmark_missing")
            reason_details.append(
                {
                    "reason": "profitability_benchmark_missing",
                    "artifact_ref": str(benchmark_path),
                }
            )
        else:
            regime_slices = 0
            for item in _list_from_any(benchmark_payload.get("slices")):
                if isinstance(item, dict):
                    payload = cast(dict[str, Any], item)
                    if str(payload.get("slice_type", "")).strip() == "regime":
                        regime_slices += 1
            if regime_slices < minimum_regime_slices:
                reasons.append("profitability_benchmark_regime_coverage_insufficient")
                reason_details.append(
                    {
                        "reason": "profitability_benchmark_regime_coverage_insufficient",
                        "artifact_ref": str(benchmark_path),
                        "actual_regime_slices": regime_slices,
                        "minimum_regime_slices": minimum_regime_slices,
                    }
                )

    evidence_reasons, evidence_details, evidence_refs = _evaluate_promotion_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        promotion_target=promotion_target,
    )
    if evidence_reasons:
        reasons.extend(evidence_reasons)
    if evidence_details:
        reason_details.extend(evidence_details)
    if evidence_refs:
        artifact_refs.extend(evidence_refs)

    return PromotionPrerequisiteResult(
        allowed=not reasons,
        reasons=sorted(set(reasons)),
        required_artifacts=required_artifacts,
        missing_artifacts=missing_artifacts,
        reason_details=reason_details,
        artifact_refs=sorted(set(artifact_refs)),
        required_throughput=throughput_requirements,
        observed_throughput=throughput_observed,
    )


def evaluate_rollback_readiness(
    *,
    policy_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
    now: datetime | None = None,
) -> RollbackReadinessResult:
    reasons: list[str] = []
    required_checks = _required_rollback_checks(policy_payload)
    rollback_raw = candidate_state_payload.get("rollbackReadiness")
    rollback: dict[str, Any]
    if isinstance(rollback_raw, dict):
        rollback = cast(dict[str, Any], rollback_raw)
    else:
        rollback = {}

    missing_checks = [
        name for name in required_checks if not bool(rollback.get(name, False))
    ]
    if missing_checks:
        reasons.append("rollback_checks_missing_or_failed")

    max_age_hours = int(policy_payload.get("rollback_dry_run_max_age_hours", 72))
    dry_run_completed_at = _parse_datetime(
        str(rollback.get("dryRunCompletedAt", "")).strip()
    )
    current = now or datetime.now(timezone.utc)
    if dry_run_completed_at is None:
        reasons.append("rollback_dry_run_timestamp_missing")
    else:
        if current - dry_run_completed_at > timedelta(hours=max_age_hours):
            reasons.append("rollback_dry_run_stale")

    if policy_payload.get("rollback_require_human_approval", True) and not bool(
        rollback.get("humanApproved", False)
    ):
        reasons.append("rollback_human_approval_missing")

    if not str(rollback.get("rollbackTarget", "")).strip():
        reasons.append("rollback_target_missing")

    return RollbackReadinessResult(
        ready=not reasons,
        reasons=sorted(set(reasons)),
        required_checks=required_checks,
        missing_checks=missing_checks,
    )


def _required_artifacts_for_target(
    policy_payload: dict[str, Any],
    promotion_target: str,
    *,
    include_profitability_artifacts: bool,
) -> list[str]:
    base_raw = policy_payload.get(
        "promotion_required_artifacts",
        [
            "research/candidate-spec.json",
            "backtest/evaluation-report.json",
            "gates/gate-evaluation.json",
        ],
    )
    base = _list_from_any(base_raw)
    required = [str(item) for item in base if isinstance(item, str)]
    patch_targets_raw = policy_payload.get(
        "promotion_require_patch_targets", ["paper", "live"]
    )
    patch_targets = _list_from_any(patch_targets_raw)
    if promotion_target in patch_targets:
        required.append("paper-candidate/strategy-configmap-patch.yaml")
    if include_profitability_artifacts:
        profitability_artifacts_raw = policy_payload.get(
            "promotion_profitability_required_artifacts",
            [
                "gates/profitability-evidence-v4.json",
                "gates/profitability-benchmark-v4.json",
                "gates/profitability-evidence-validation.json",
                "gates/recalibration-report.json",
            ],
        )
        profitability_artifacts = _list_from_any(profitability_artifacts_raw)
        for artifact in profitability_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    return sorted(set(required))


def _requires_profitability_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("gate6_require_profitability_evidence", True)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_profitability_required_targets", ["paper", "live"]
    )
    required_targets = [
        str(target)
        for target in _list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def _required_rollback_checks(policy_payload: dict[str, Any]) -> list[str]:
    checks_raw = policy_payload.get(
        "rollback_required_checks",
        [
            "killSwitchDryRunPassed",
            "gitopsRevertDryRunPassed",
            "strategyDisableDryRunPassed",
        ],
    )
    checks = _list_from_any(checks_raw)
    return [str(item) for item in checks if isinstance(item, str)]


def _required_throughput(policy_payload: dict[str, Any]) -> dict[str, int]:
    return {
        "min_signal_count": max(
            1, _int_or_default(policy_payload.get("promotion_min_signal_count"), 1)
        ),
        "min_decision_count": max(
            1, _int_or_default(policy_payload.get("promotion_min_decision_count"), 1)
        ),
        "min_trade_count": max(
            0, _int_or_default(policy_payload.get("promotion_min_trade_count"), 0)
        ),
    }


def _evaluate_promotion_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    if promotion_target == "shadow":
        return reasons, details, refs

    evidence_raw = gate_report_payload.get("promotion_evidence")
    evidence = (
        cast(dict[str, Any], evidence_raw) if isinstance(evidence_raw, dict) else {}
    )
    fold_raw = evidence.get("fold_metrics")
    fold_metrics = cast(dict[str, Any], fold_raw) if isinstance(fold_raw, dict) else {}
    fold_count = _int_or_default(fold_metrics.get("count"), 0)
    min_fold_count = max(
        1,
        _int_or_default(policy_payload.get("promotion_min_fold_metrics_count"), 1),
    )
    if fold_count < min_fold_count:
        reasons.append("fold_metrics_evidence_insufficient")
        details.append(
            {
                "reason": "fold_metrics_evidence_insufficient",
                "actual_fold_count": fold_count,
                "minimum_fold_count": min_fold_count,
            }
        )
    fold_ref = str(fold_metrics.get("artifact_ref") or "").strip()
    if fold_ref:
        refs.append(fold_ref)

    stress_raw = evidence.get("stress_metrics")
    stress_metrics = (
        cast(dict[str, Any], stress_raw) if isinstance(stress_raw, dict) else {}
    )
    stress_count = _int_or_default(stress_metrics.get("count"), 0)
    min_stress_count = max(
        1,
        _int_or_default(policy_payload.get("promotion_min_stress_case_count"), 4),
    )
    if stress_count < min_stress_count:
        reasons.append("stress_metrics_evidence_insufficient")
        details.append(
            {
                "reason": "stress_metrics_evidence_insufficient",
                "actual_stress_case_count": stress_count,
                "minimum_stress_case_count": min_stress_count,
            }
        )
    stress_ref = str(stress_metrics.get("artifact_ref") or "").strip()
    if stress_ref:
        refs.append(stress_ref)

    if bool(policy_payload.get("promotion_require_rationale", True)):
        rationale_raw = evidence.get("promotion_rationale")
        rationale = (
            cast(dict[str, Any], rationale_raw)
            if isinstance(rationale_raw, dict)
            else {}
        )
        reason_codes = _list_of_strings(rationale.get("reason_codes"))
        if not reason_codes:
            reason_codes = _list_of_strings(rationale.get("gate_reasons"))
        rationale_text = str(rationale.get("rationale_text") or "").strip()
        if not rationale:
            reasons.append("promotion_rationale_missing")
            details.append({"reason": "promotion_rationale_missing"})
        requested_target = str(rationale.get("requested_target") or "").strip()
        if requested_target and requested_target != promotion_target:
            reasons.append("promotion_rationale_target_mismatch")
            details.append(
                {
                    "reason": "promotion_rationale_target_mismatch",
                    "requested_target": promotion_target,
                    "rationale_target": requested_target,
                }
            )
        recommended_mode = str(rationale.get("recommended_mode") or "").strip()
        if not recommended_mode:
            recommended_mode = str(rationale.get("gate_recommended_mode") or "").strip()
        gate_recommended_mode = str(
            gate_report_payload.get("recommended_mode", "")
        ).strip()
        if (
            recommended_mode
            and gate_recommended_mode
            and recommended_mode != gate_recommended_mode
        ):
            reasons.append("promotion_rationale_recommended_mode_mismatch")
            details.append(
                {
                    "reason": "promotion_rationale_recommended_mode_mismatch",
                    "rationale_recommended_mode": recommended_mode,
                    "gate_recommended_mode": gate_recommended_mode,
                }
            )
        if not reason_codes and not rationale_text:
            reasons.append("promotion_rationale_missing")
            details.append({"reason": "promotion_rationale_missing"})

    return sorted(set(reasons)), details, sorted(set(refs))


def _observed_throughput(
    *,
    gate_report_payload: dict[str, Any],
    candidate_state_payload: dict[str, Any],
) -> dict[str, int | bool | str | None]:
    throughput_raw = gate_report_payload.get("throughput")
    throughput = (
        cast(dict[str, Any], throughput_raw) if isinstance(throughput_raw, dict) else {}
    )
    metrics_raw = gate_report_payload.get("metrics")
    metrics = cast(dict[str, Any], metrics_raw) if isinstance(metrics_raw, dict) else {}

    signal_count = _int_or_default(throughput.get("signal_count"), 0)
    decision_count = _int_or_default(
        throughput.get("decision_count", metrics.get("decision_count")), 0
    )
    trade_count = _int_or_default(
        throughput.get("trade_count", metrics.get("trade_count")), 0
    )

    no_signal_reason = str(
        candidate_state_payload.get("noSignalReason")
        or throughput.get("no_signal_reason")
        or ""
    ).strip()
    no_signal_from_snapshot = (
        str(candidate_state_payload.get("datasetSnapshotRef") or "").strip()
        == "no_signal_window"
    )
    no_signal_window = no_signal_from_snapshot or bool(
        throughput.get("no_signal_window", False)
    )
    if no_signal_reason:
        no_signal_window = True

    return {
        "has_explicit_throughput": bool(throughput),
        "signal_count": signal_count,
        "decision_count": decision_count,
        "trade_count": trade_count,
        "no_signal_window": no_signal_window,
        "no_signal_reason": no_signal_reason or None,
    }


def _gates(gate_report_payload: dict[str, Any]) -> list[dict[str, Any]]:
    gates_raw = gate_report_payload.get("gates")
    gates_list = _list_from_any(gates_raw)
    gates: list[dict[str, Any]] = []
    for item in gates_list:
        if isinstance(item, dict):
            gates.append(cast(dict[str, Any], item))
    return gates


def _list_from_any(value: Any) -> list[object]:
    if not isinstance(value, list):
        return []
    return cast(list[object], value)


def _list_of_strings(value: Any) -> list[str]:
    raw = _list_from_any(value)
    return [str(item) for item in raw if isinstance(item, str)]


def _load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return cast(dict[str, Any], payload)


def _int_or_default(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return default
    return default


def _float_or_default(value: Any, default: float) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return float(stripped)
            except ValueError:
                return default
    return default


def _promotion_rank(target: str) -> int:
    ranking = {"shadow": 1, "paper": 2, "live": 3}
    return ranking.get(target, 0)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


__all__ = [
    "PromotionPrerequisiteResult",
    "RollbackReadinessResult",
    "evaluate_promotion_prerequisites",
    "evaluate_rollback_readiness",
]

"""Target requirements, artifact references, coercion, and parsing helpers."""

from __future__ import annotations

from .common import (
    Any,
    Path,
    Sequence,
    cast,
    datetime,
    hashlib,
    json,
    math,
    timezone,
)


def append_policy_issue(
    reasons: list[str],
    details: list[dict[str, object]],
    reason: str,
    **fields: object,
) -> None:
    reasons.append(reason)
    details.append({"reason": reason, **fields})


def regime_slice_count(benchmark_payload: dict[str, Any]) -> int:
    regime_slices = 0
    for item in list_from_any(benchmark_payload.get("slices")):
        if not isinstance(item, dict):
            continue
        payload = cast(dict[str, Any], item)
        if str(payload.get("slice_type", "")).strip() == "regime":
            regime_slices += 1
    return regime_slices


def _required_artifacts_for_target(
    policy_payload: dict[str, Any],
    promotion_target: str,
    *,
    include_profitability_artifacts: bool,
    include_janus_artifacts: bool,
    include_benchmark_parity_artifacts: bool,
    include_foundation_router_parity_artifacts: bool,
    include_deeplob_bdlob_artifacts: bool,
    include_advisor_fallback_slo_artifacts: bool,
    include_contamination_artifacts: bool,
    include_stress_artifacts: bool,
    include_simulation_calibration_artifacts: bool,
    include_shadow_live_deviation_artifacts: bool,
    include_hmm_state_posterior_artifacts: bool,
    include_expert_router_artifacts: bool,
    require_profitability_manifest: bool,
) -> list[str]:
    base_raw = policy_payload.get(
        "promotion_required_artifacts",
        [
            "research/candidate-spec.json",
            "backtest/evaluation-report.json",
            "gates/gate-evaluation.json",
        ],
    )
    base = list_from_any(base_raw)
    required = [str(item) for item in base if isinstance(item, str)]
    patch_targets_raw = policy_payload.get(
        "promotion_require_patch_targets", ["paper", "live"]
    )
    patch_targets = list_from_any(patch_targets_raw)
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
        profitability_artifacts = list_from_any(profitability_artifacts_raw)
        for artifact in profitability_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    if require_profitability_manifest:
        required.append(
            str(
                policy_payload.get(
                    "promotion_profitability_stage_manifest_artifact",
                    "profitability/profitability-stage-manifest-v1.json",
                )
            )
        )
    if bool(
        policy_payload.get("promotion_require_portfolio_optimizer_evidence", False)
    ):
        required.append(
            str(
                policy_payload.get(
                    "promotion_portfolio_optimizer_evidence_artifact",
                    "promotion/portfolio-optimizer-evidence.json",
                )
            )
        )
    if include_janus_artifacts:
        janus_artifacts_raw = policy_payload.get(
            "promotion_janus_required_artifacts",
            [
                "gates/janus-event-car-v1.json",
                "gates/janus-hgrm-reward-v1.json",
            ],
        )
        janus_artifacts = list_from_any(janus_artifacts_raw)
        for artifact in janus_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    if include_benchmark_parity_artifacts:
        benchmark_artifacts = _benchmark_parity_required_artifact_refs(policy_payload)
        for artifact in benchmark_artifacts:
            required.append(artifact)
    if include_foundation_router_parity_artifacts:
        foundation_router_artifacts = foundation_router_required_artifact_refs(
            policy_payload
        )
        for artifact in foundation_router_artifacts:
            required.append(artifact)
    if include_deeplob_bdlob_artifacts:
        deeplob_bdlob_artifacts = deeplob_bdlob_required_artifact_refs(policy_payload)
        for artifact in deeplob_bdlob_artifacts:
            required.append(artifact)
    if include_advisor_fallback_slo_artifacts:
        advisor_fallback_artifacts = advisor_fallback_slo_required_artifact_refs(
            policy_payload
        )
        for artifact in advisor_fallback_artifacts:
            required.append(artifact)
    if include_contamination_artifacts:
        contamination_artifacts = contamination_registry_required_artifact_refs(
            policy_payload
        )
        for artifact in contamination_artifacts:
            required.append(artifact)
    if include_stress_artifacts:
        stress_artifacts_raw = policy_payload.get(
            "promotion_stress_required_artifacts",
            ["gates/stress-metrics-v1.json"],
        )
        stress_artifacts = list_from_any(stress_artifacts_raw)
        for artifact in stress_artifacts:
            if isinstance(artifact, str):
                required.append(artifact)
    if include_simulation_calibration_artifacts:
        simulation_calibration_artifacts = (
            simulation_calibration_required_artifact_refs(policy_payload)
        )
        for artifact in simulation_calibration_artifacts:
            required.append(artifact)
    if include_shadow_live_deviation_artifacts:
        shadow_live_deviation_artifacts = shadow_live_deviation_required_artifact_refs(
            policy_payload
        )
        for artifact in shadow_live_deviation_artifacts:
            required.append(artifact)
    if include_hmm_state_posterior_artifacts:
        hmm_artifacts = hmm_state_posterior_required_artifact_refs(policy_payload)
        for artifact in hmm_artifacts:
            required.append(artifact)
    if include_expert_router_artifacts:
        expert_router_artifacts = expert_router_required_artifact_refs(policy_payload)
        for artifact in expert_router_artifacts:
            required.append(artifact)
    return sorted(set(required))


def _benchmark_parity_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    benchmark_artifacts_raw = policy_payload.get(
        "promotion_benchmark_required_artifacts",
        ["gates/benchmark-parity-report-v1.json"],
    )
    benchmark_artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(benchmark_artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if benchmark_artifacts:
        return benchmark_artifacts

    legacy_artifact_raw = policy_payload.get("promotion_benchmark_parity_artifact", "")
    legacy_artifact = (
        legacy_artifact_raw.strip() if isinstance(legacy_artifact_raw, str) else ""
    )
    if legacy_artifact:
        return [legacy_artifact]

    return ["gates/benchmark-parity-report-v1.json"]


def benchmark_parity_artifact_reference(
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
) -> str:
    evidence = as_dict(gate_report_payload.get("promotion_evidence"))
    benchmark_payload = as_dict(evidence.get("benchmark_parity"))
    evidence_ref = str(benchmark_payload.get("artifact_ref") or "").strip()
    if evidence_ref:
        return evidence_ref

    required_artifacts = _benchmark_parity_required_artifact_refs(policy_payload)
    return required_artifacts[0]


def benchmark_parity_artifact_candidates(
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
) -> list[str]:
    evidence = as_dict(
        as_dict(gate_report_payload.get("promotion_evidence")).get("benchmark_parity")
    )
    evidence_ref = str(evidence.get("artifact_ref") or "").strip()
    candidates: list[str] = []
    if evidence_ref:
        candidates.append(evidence_ref)
    for artifact_ref in _benchmark_parity_required_artifact_refs(policy_payload):
        if artifact_ref not in candidates:
            candidates.append(artifact_ref)
    legacy_artifact = "benchmarks/benchmark-parity-report-v1.json"
    if legacy_artifact not in candidates:
        candidates.append(legacy_artifact)
    return candidates


def first_existing_artifact_path(
    artifact_refs: Sequence[str],
    *,
    artifact_root: Path,
) -> Path | None:
    for artifact_ref in artifact_refs:
        artifact_path = normalize_artifact_path(
            artifact_ref, artifact_root=artifact_root
        )
        if artifact_path is not None and artifact_path.exists():
            return artifact_path
    return None


def foundation_router_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    foundation_artifacts_raw = policy_payload.get(
        "promotion_foundation_router_required_artifacts",
        ["router/foundation-router-parity-report-v1.json"],
    )
    foundation_artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(foundation_artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if foundation_artifacts:
        return foundation_artifacts

    legacy_artifact = str(
        policy_payload.get("promotion_foundation_router_parity_artifact", "").strip()
    )
    if legacy_artifact:
        return [legacy_artifact]
    return ["router/foundation-router-parity-report-v1.json"]


def deeplob_bdlob_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_deeplob_bdlob_required_artifacts",
        ["microstructure/deeplob-bdlob-report-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["microstructure/deeplob-bdlob-report-v1.json"]


def advisor_fallback_slo_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_advisor_fallback_required_artifacts",
        ["execution/advisor-fallback-slo-report-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["execution/advisor-fallback-slo-report-v1.json"]


def contamination_registry_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    contamination_artifacts_raw = policy_payload.get(
        "promotion_contamination_required_artifacts",
        ["gates/contamination-leakage-report-v1.json"],
    )
    contamination_artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(contamination_artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if contamination_artifacts:
        return contamination_artifacts

    legacy_artifact = str(
        policy_payload.get("promotion_contamination_artifact", "").strip()
    )
    if legacy_artifact:
        return [legacy_artifact]
    return ["gates/contamination-leakage-report-v1.json"]


def hmm_state_posterior_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_hmm_required_artifacts",
        ["gates/hmm-state-posterior-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["gates/hmm-state-posterior-v1.json"]


def expert_router_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_expert_router_required_artifacts",
        ["gates/expert-router-registry-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["gates/expert-router-registry-v1.json"]


def simulation_calibration_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_simulation_calibration_required_artifacts",
        ["gates/simulation-calibration-report-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["gates/simulation-calibration-report-v1.json"]


def shadow_live_deviation_required_artifact_refs(
    policy_payload: dict[str, Any],
) -> list[str]:
    artifacts_raw = policy_payload.get(
        "promotion_shadow_live_deviation_required_artifacts",
        ["gates/shadow-live-deviation-report-v1.json"],
    )
    artifacts = [
        str(artifact).strip()
        for artifact in list_from_any(artifacts_raw)
        if isinstance(artifact, str) and artifact.strip()
    ]
    if artifacts:
        return artifacts
    return ["gates/shadow-live-deviation-report-v1.json"]


def requires_jangar_dependency_quorum(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(
        policy_payload.get("promotion_require_jangar_dependency_quorum", False)
    ):
        return False
    required_targets = list_of_strings(
        policy_payload.get(
            "promotion_jangar_dependency_quorum_required_targets",
            ["paper", "live"],
        )
    )
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_alpha_readiness_contract(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(
        policy_payload.get("promotion_require_alpha_readiness_contract", False)
    ):
        return False
    required_targets = list_of_strings(
        policy_payload.get(
            "promotion_alpha_readiness_required_targets",
            ["paper", "live"],
        )
    )
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_hmm_state_posterior(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_hmm_state_posterior", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_hmm_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_expert_router_registry(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_expert_router_registry", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_expert_router_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_profitability_evidence(
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
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_janus_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("gate6_require_janus_evidence", True)):
        return False
    if not bool(policy_payload.get("promotion_require_janus_evidence", True)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_janus_required_targets", ["paper", "live"]
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_stress_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_stress_evidence", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_stress_required_targets", ["paper", "live"]
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_simulation_calibration(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_simulation_calibration", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_simulation_calibration_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_shadow_live_deviation(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_shadow_live_deviation", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_shadow_live_deviation_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_contamination_registry(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_contamination_registry", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_contamination_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_fold_evidence(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_fold_evidence", True)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_fold_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def required_rollback_checks(policy_payload: dict[str, Any]) -> list[str]:
    checks_raw = policy_payload.get(
        "rollback_required_checks",
        [
            "killSwitchDryRunPassed",
            "gitopsRevertDryRunPassed",
            "strategyDisableDryRunPassed",
        ],
    )
    checks = list_from_any(checks_raw)
    return [str(item) for item in checks if isinstance(item, str)]


def normalize_artifact_path(artifact_ref: str, *, artifact_root: Path) -> Path | None:
    normalized_ref = str(artifact_ref).strip()
    if not normalized_ref:
        return None
    if "://" in normalized_ref and not normalized_ref.startswith("file://"):
        return None
    normalized_ref = normalized_ref.removeprefix("file://")

    candidate = Path(normalized_ref)
    if not candidate.is_absolute():
        candidate = artifact_root / candidate
    try:
        normalized_candidate = candidate.resolve()
    except OSError:
        return None
    try:
        normalized_root = artifact_root.resolve()
    except OSError:
        normalized_root = artifact_root
    if not normalized_candidate.is_relative_to(normalized_root):
        return None
    return normalized_candidate


def required_throughput(policy_payload: dict[str, Any]) -> dict[str, int]:
    return {
        "min_signal_count": max(
            1, int_or_default(policy_payload.get("promotion_min_signal_count"), 1)
        ),
        "min_decision_count": max(
            1, int_or_default(policy_payload.get("promotion_min_decision_count"), 1)
        ),
        "min_trade_count": max(
            0, int_or_default(policy_payload.get("promotion_min_trade_count"), 0)
        ),
    }


def requires_foundation_router_parity(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(
        policy_payload.get("promotion_require_foundation_router_parity", False)
    ):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_foundation_router_parity_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_deeplob_bdlob_contract(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_deeplob_bdlob_contract", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_deeplob_bdlob_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_advisor_fallback_slo(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_advisor_fallback_slo", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_advisor_fallback_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def requires_benchmark_parity(
    *, policy_payload: dict[str, Any], promotion_target: str
) -> bool:
    if promotion_target == "shadow":
        return False
    if not bool(policy_payload.get("promotion_require_benchmark_parity", False)):
        return False
    required_targets_raw = policy_payload.get(
        "promotion_benchmark_parity_required_targets",
        ["paper", "live"],
    )
    required_targets = [
        str(target)
        for target in list_from_any(required_targets_raw)
        if isinstance(target, str)
    ]
    if not required_targets:
        return False
    return promotion_target in required_targets


def observed_throughput(
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

    signal_count = int_or_default(throughput.get("signal_count"), 0)
    decision_count = int_or_default(
        throughput.get("decision_count", metrics.get("decision_count")), 0
    )
    trade_count = int_or_default(
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


def gates(gate_report_payload: dict[str, Any]) -> list[dict[str, Any]]:
    gates_raw = gate_report_payload.get("gates")
    gates_list = list_from_any(gates_raw)
    gates: list[dict[str, Any]] = []
    for item in gates_list:
        if isinstance(item, dict):
            gates.append(cast(dict[str, Any], item))
    return gates


def list_from_any(value: Any) -> list[object]:
    if not isinstance(value, list):
        return []
    return cast(list[object], value)


def as_list_of_dicts(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    values = cast(list[object], value)
    result: list[dict[str, Any]] = []
    for item in values:
        if isinstance(item, dict):
            result.append(cast(dict[str, Any], item))
    return result


def list_count(value: Any) -> int:
    if not isinstance(value, list):
        return 0
    return len(cast(list[object], value))


def as_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def list_of_strings(value: Any) -> list[str]:
    raw = list_from_any(value)
    return [str(item) for item in raw if isinstance(item, str)]


def load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return cast(dict[str, Any], payload)


def sha256_path(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def sha256_json(payload: object) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()


def int_or_default(value: Any, default: int) -> int:
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


def int_or_none(value: Any) -> int | None:
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
                return None
    return None


def _coerce_evidence_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        return value != 0
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off", ""}:
        return False
    return None


def float_or_default(value: Any, default: float) -> float:
    parsed = float_or_none(value)
    if parsed is None:
        return default
    return parsed


def float_or_none(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        parsed = float(value)
        if math.isfinite(parsed):
            return parsed
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                parsed = float(stripped)
            except ValueError:
                return None
            if math.isfinite(parsed):
                return parsed
            return None
    return None


def promotion_rank(target: str) -> int:
    ranking = {"shadow": 1, "paper": 2, "live": 3}
    return ranking.get(target, 0)


def parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


coerce_evidence_bool = _coerce_evidence_bool
required_artifacts_for_target = _required_artifacts_for_target

"""Deterministic DSPy eval artifact builder for Torghut eval lanes."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast
from urllib.parse import unquote, urlsplit

import yaml

from .hashing import canonical_json, hash_payload
from .schemas import DSPyCompileResult, DSPyEvalReport
from .workflow import build_eval_report

DEFAULT_EVAL_REPORT_NAME = "dspy-eval-report.json"


@dataclass(frozen=True)
class DSPyEvalArtifactResult:
    """Result bundle for eval lane artifact generation."""

    eval_report: DSPyEvalReport
    eval_report_path: Path
    compile_result_path: Path
    gate_policy_path: Path


@dataclass(frozen=True)
class _ObservedMetrics:
    schema_valid_rate: float
    veto_alignment_rate: float
    false_veto_rate: float
    latency_p95_ms: int
    fallback_rate: float
    missing_metric_keys: tuple[str, ...]


def evaluate_dspy_compile_artifact(
    *,
    repository: str,
    base: str,
    head: str,
    artifact_path: Path | str,
    compile_result_ref: str,
    gate_policy_ref: str,
    eval_report_name: str = DEFAULT_EVAL_REPORT_NAME,
    created_at: datetime | None = None,
) -> DSPyEvalArtifactResult:
    """Evaluate compile artifact and emit deterministic dspy-eval-report.json."""

    normalized_repository = _require_value(repository, "repository")
    normalized_base = _require_value(base, "base")
    normalized_head = _require_value(head, "head")
    normalized_artifact_path = _require_value(str(artifact_path), "artifact_path")
    normalized_compile_result_ref = _require_value(
        compile_result_ref, "compile_result_ref"
    )
    normalized_gate_policy_ref = _require_value(gate_policy_ref, "gate_policy_ref")
    normalized_eval_report_name = _require_value(eval_report_name, "eval_report_name")

    compile_result_path = _resolve_local_ref_path(
        normalized_compile_result_ref, field_name="compile_result_ref"
    )
    gate_policy_path = _resolve_local_ref_path(
        normalized_gate_policy_ref, field_name="gate_policy_ref"
    )

    compile_result_payload = _load_json_mapping(
        compile_result_path, field_name="compile_result_ref"
    )
    compile_result = DSPyCompileResult.model_validate(compile_result_payload)

    gate_policy_payload = _load_yaml_mapping(
        gate_policy_path, field_name="gate_policy_ref"
    )
    policy = cast(dict[str, Any], gate_policy_payload.get("policy") or {})

    observed = _extract_observed_metrics(compile_result.metric_bundle)
    threshold_checks, threshold_snapshot, threshold_failures = _evaluate_threshold_checks(
        policy=policy,
        observed=observed,
    )
    deterministic_compatibility = _evaluate_deterministic_compatibility(
        compile_result=compile_result,
        policy=policy,
    )

    gate_checks = {
        **threshold_checks,
        "deterministicCompatibility": deterministic_compatibility["passed"],
    }
    gate_failures = sorted(
        [
            *threshold_failures,
            *cast(list[str], deterministic_compatibility["failures"]),
        ]
    )
    gate_compatibility = "pass" if all(gate_checks.values()) else "fail"
    promotion_recommendation = _resolve_promotion_recommendation(
        gate_compatibility=gate_compatibility,
        policy=policy,
    )

    eval_metric_bundle: dict[str, Any] = {
        "repository": normalized_repository,
        "base": normalized_base,
        "head": normalized_head,
        "compileResultRef": normalized_compile_result_ref,
        "gatePolicyRef": normalized_gate_policy_ref,
        "compileMetricBundleHash": hash_payload(compile_result.metric_bundle),
        "observed": {
            "schemaValidRate": observed.schema_valid_rate,
            "vetoAlignmentRate": observed.veto_alignment_rate,
            "falseVetoRate": observed.false_veto_rate,
            "latencyP95Ms": observed.latency_p95_ms,
            "fallbackRate": observed.fallback_rate,
            "missingMetricKeys": list(observed.missing_metric_keys),
        },
        "thresholds": threshold_snapshot,
        "gateChecks": gate_checks,
        "gateFailures": gate_failures,
        "deterministicCompatibility": deterministic_compatibility,
        "gatePolicySchemaVersion": str(gate_policy_payload.get("schemaVersion") or ""),
    }

    eval_report = build_eval_report(
        compile_result=compile_result,
        schema_valid_rate=observed.schema_valid_rate,
        veto_alignment_rate=observed.veto_alignment_rate,
        false_veto_rate=observed.false_veto_rate,
        latency_p95_ms=observed.latency_p95_ms,
        gate_compatibility=cast(Any, gate_compatibility),
        promotion_recommendation=cast(Any, promotion_recommendation),
        metric_bundle=eval_metric_bundle,
        created_at=created_at or datetime.now(timezone.utc),
    )

    output_dir = Path(normalized_artifact_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    eval_report_path = output_dir / normalized_eval_report_name
    _write_canonical_json(
        eval_report_path, eval_report.model_dump(mode="json", by_alias=True)
    )

    return DSPyEvalArtifactResult(
        eval_report=eval_report,
        eval_report_path=eval_report_path,
        compile_result_path=compile_result_path,
        gate_policy_path=gate_policy_path,
    )


def _extract_observed_metrics(metric_bundle: Mapping[str, Any]) -> _ObservedMetrics:
    flattened = _flatten_mapping(metric_bundle)

    missing_metric_keys: list[str] = []

    schema_valid_rate = _find_numeric_value(
        flattened,
        [
            "schemaValidRate",
            "schema_valid_rate",
            "schemaValidityRate",
            "schema_validity_rate",
        ],
    )
    if schema_valid_rate is None:
        schema_valid_rate = 0.0
        missing_metric_keys.append("schemaValidRate")
    else:
        schema_valid_rate = _clamp(schema_valid_rate, minimum=0.0, maximum=1.0)

    veto_alignment_rate = _find_numeric_value(
        flattened,
        [
            "vetoAlignmentRate",
            "veto_alignment_rate",
            "alignmentRate",
            "alignment_rate",
        ],
    )
    if veto_alignment_rate is None:
        veto_alignment_rate = 0.0
        missing_metric_keys.append("vetoAlignmentRate")
    else:
        veto_alignment_rate = _clamp(veto_alignment_rate, minimum=0.0, maximum=1.0)

    false_veto_rate = _find_numeric_value(
        flattened,
        [
            "falseVetoRate",
            "false_veto_rate",
            "fallbackRate",
            "fallback_rate",
            "routeFallbackRate",
            "route_fallback_rate",
        ],
    )
    if false_veto_rate is None:
        false_veto_rate = 1.0
        missing_metric_keys.append("falseVetoRate")
    else:
        false_veto_rate = _clamp(false_veto_rate, minimum=0.0, maximum=1.0)

    fallback_rate = _find_numeric_value(
        flattened,
        [
            "fallbackRate",
            "fallback_rate",
            "routeFallbackRate",
            "route_fallback_rate",
            "falseVetoRate",
            "false_veto_rate",
        ],
    )
    if fallback_rate is None:
        fallback_rate = false_veto_rate
        missing_metric_keys.append("fallbackRate")
    else:
        fallback_rate = _clamp(fallback_rate, minimum=0.0, maximum=1.0)

    latency_p95_raw = _find_numeric_value(
        flattened,
        [
            "latencyP95Ms",
            "latency_p95_ms",
            "inferenceLatencyMsP95",
            "inference_latency_ms_p95",
        ],
    )
    if latency_p95_raw is None:
        latency_p95_ms = 2**31 - 1
        missing_metric_keys.append("latencyP95Ms")
    else:
        latency_p95_ms = max(int(round(latency_p95_raw)), 0)

    return _ObservedMetrics(
        schema_valid_rate=schema_valid_rate,
        veto_alignment_rate=veto_alignment_rate,
        false_veto_rate=false_veto_rate,
        latency_p95_ms=latency_p95_ms,
        fallback_rate=fallback_rate,
        missing_metric_keys=tuple(sorted(set(missing_metric_keys))),
    )


def _evaluate_threshold_checks(
    *,
    policy: Mapping[str, Any],
    observed: _ObservedMetrics,
) -> tuple[dict[str, bool], dict[str, Any], list[str]]:
    flattened_policy = _flatten_mapping(policy)

    schema_valid_rate_min = _find_numeric_value(
        flattened_policy, ["schemaValidRateMin", "schema_valid_rate_min"]
    )
    veto_alignment_rate_min = _find_numeric_value(
        flattened_policy, ["vetoAlignmentRateMin", "veto_alignment_rate_min"]
    )
    veto_alignment_rate_min_delta = _find_numeric_value(
        flattened_policy,
        ["vetoAlignmentRateMinDelta", "veto_alignment_rate_min_delta"],
    )
    baseline_veto_alignment_rate = _find_numeric_value(
        _flatten_mapping(policy),
        ["baselineVetoAlignmentRate", "baseline_veto_alignment_rate"],
    )
    if veto_alignment_rate_min is None and veto_alignment_rate_min_delta is not None:
        baseline = baseline_veto_alignment_rate or 0.0
        veto_alignment_rate_min = _clamp(
            baseline + veto_alignment_rate_min_delta, minimum=0.0, maximum=1.0
        )

    false_veto_rate_max = _find_numeric_value(
        flattened_policy, ["falseVetoRateMax", "false_veto_rate_max"]
    )
    latency_p95_ms_max_raw = _find_numeric_value(
        flattened_policy, ["latencyP95MsMax", "latency_p95_ms_max"]
    )
    latency_p95_ms_max = (
        max(int(round(latency_p95_ms_max_raw)), 0)
        if latency_p95_ms_max_raw is not None
        else None
    )
    fallback_rate_max = _find_numeric_value(
        flattened_policy,
        [
            "fallbackRateMax",
            "fallback_rate_max",
            "routeFallbackRateMax",
            "route_fallback_rate_max",
            "maxFallbackRate",
            "max_fallback_rate",
        ],
    )
    if fallback_rate_max is None:
        fallback_rate_max = false_veto_rate_max

    checks: dict[str, bool] = {}
    failures: list[str] = []

    checks["schemaValidRate"] = _check_threshold(
        value=observed.schema_valid_rate,
        threshold=schema_valid_rate_min,
        comparator=">=",
        failure_name="schema_valid_rate_below_min",
        missing_failure_name="schema_valid_rate_threshold_missing",
        failures=failures,
    )
    checks["vetoAlignmentRate"] = _check_threshold(
        value=observed.veto_alignment_rate,
        threshold=veto_alignment_rate_min,
        comparator=">=",
        failure_name="veto_alignment_rate_below_min",
        missing_failure_name="veto_alignment_rate_threshold_missing",
        failures=failures,
    )
    checks["falseVetoRate"] = _check_threshold(
        value=observed.false_veto_rate,
        threshold=false_veto_rate_max,
        comparator="<=",
        failure_name="false_veto_rate_above_max",
        missing_failure_name="false_veto_rate_threshold_missing",
        failures=failures,
    )
    checks["latencyP95Ms"] = _check_threshold(
        value=float(observed.latency_p95_ms),
        threshold=(
            float(latency_p95_ms_max) if latency_p95_ms_max is not None else None
        ),
        comparator="<=",
        failure_name="latency_p95_ms_above_max",
        missing_failure_name="latency_p95_ms_threshold_missing",
        failures=failures,
    )
    checks["fallbackRate"] = _check_threshold(
        value=observed.fallback_rate,
        threshold=fallback_rate_max,
        comparator="<=",
        failure_name="fallback_rate_above_max",
        missing_failure_name="fallback_rate_threshold_missing",
        failures=failures,
    )

    threshold_snapshot = {
        "schemaValidRateMin": schema_valid_rate_min,
        "vetoAlignmentRateMin": veto_alignment_rate_min,
        "vetoAlignmentRateMinDelta": veto_alignment_rate_min_delta,
        "falseVetoRateMax": false_veto_rate_max,
        "latencyP95MsMax": latency_p95_ms_max,
        "fallbackRateMax": fallback_rate_max,
    }
    return checks, threshold_snapshot, sorted(set(failures))


def _evaluate_deterministic_compatibility(
    *,
    compile_result: DSPyCompileResult,
    policy: Mapping[str, Any],
) -> dict[str, Any]:
    required_keys_raw = (
        cast(dict[str, Any], policy.get("reproducibility") or {}).get("requiredKeys")
    )
    required_keys = _normalize_required_keys(required_keys_raw)

    missing_keys = sorted(
        key
        for key in required_keys
        if not _required_key_present(key=key, compile_result=compile_result)
    )

    recomputed_artifact_hash = hash_payload(
        {
            "program_name": compile_result.program_name,
            "signature_versions": dict(compile_result.signature_versions),
            "optimizer": compile_result.optimizer,
            "dataset_hash": compile_result.dataset_hash,
            "compiled_prompt_hash": compile_result.compiled_prompt_hash,
            "compiled_artifact_uri": compile_result.compiled_artifact_uri,
            "reproducibility_hash": compile_result.reproducibility_hash,
        }
    )
    artifact_hash_matches = recomputed_artifact_hash == compile_result.artifact_hash

    failures: list[str] = []
    if missing_keys:
        failures.append("deterministic_required_keys_missing")
    if not artifact_hash_matches:
        failures.append("deterministic_artifact_hash_mismatch")

    return {
        "passed": not failures,
        "requiredKeys": required_keys,
        "missingKeys": missing_keys,
        "recomputedArtifactHash": recomputed_artifact_hash,
        "artifactHashMatches": artifact_hash_matches,
        "failures": failures,
    }


def _normalize_required_keys(value: Any) -> list[str]:
    if not isinstance(value, list):
        return [
            "dataset_hash",
            "compiled_prompt_hash",
            "artifact_hash",
            "reproducibility_hash",
        ]
    required_keys: list[str] = []
    for item in cast(list[Any], value):
        normalized = str(item).strip()
        if normalized:
            required_keys.append(normalized)
    if not required_keys:
        return [
            "dataset_hash",
            "compiled_prompt_hash",
            "artifact_hash",
            "reproducibility_hash",
        ]
    return required_keys


def _required_key_present(*, key: str, compile_result: DSPyCompileResult) -> bool:
    key_normalized = key.strip().lower().replace("-", "_")
    direct_values: dict[str, Any] = {
        "program_name": compile_result.program_name,
        "signature_versions": dict(compile_result.signature_versions),
        "optimizer": compile_result.optimizer,
        "dataset_hash": compile_result.dataset_hash,
        "compiled_prompt_hash": compile_result.compiled_prompt_hash,
        "compiled_artifact_uri": compile_result.compiled_artifact_uri,
        "artifact_hash": compile_result.artifact_hash,
        "reproducibility_hash": compile_result.reproducibility_hash,
    }
    if key_normalized in direct_values:
        return _value_present(direct_values[key_normalized])
    return False


def _value_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Mapping):
        return bool(cast(Mapping[Any, Any], value))
    if isinstance(value, list):
        return bool(cast(list[Any], value))
    return True


def _resolve_promotion_recommendation(
    *,
    gate_compatibility: str,
    policy: Mapping[str, Any],
) -> str:
    if gate_compatibility != "pass":
        return "hold"

    promotion_policy = cast(dict[str, Any], policy.get("promotion") or {})
    default_recommendation = str(
        promotion_policy.get("defaultRecommendation") or "hold"
    ).strip()
    allowed_targets_raw = promotion_policy.get("allowedTargets")
    allowed_targets: set[str] = {"paper", "shadow", "constrained_live", "scaled_live"}
    if isinstance(allowed_targets_raw, list):
        filtered = {
            str(item).strip()
            for item in cast(list[Any], allowed_targets_raw)
            if str(item).strip()
        }
        if filtered:
            allowed_targets = filtered

    if default_recommendation == "hold":
        return "hold"
    if default_recommendation in allowed_targets:
        return default_recommendation
    return "hold"


def _check_threshold(
    *,
    value: float,
    threshold: float | None,
    comparator: str,
    failure_name: str,
    missing_failure_name: str,
    failures: list[str],
) -> bool:
    if threshold is None:
        failures.append(missing_failure_name)
        return False
    passed = value >= threshold if comparator == ">=" else value <= threshold
    if not passed:
        failures.append(failure_name)
    return passed


def _flatten_mapping(mapping: Mapping[str, Any]) -> dict[str, float]:
    flattened: dict[str, float] = {}

    def visit(node: Any) -> None:
        if not isinstance(node, Mapping):
            return
        mapping_node = cast(Mapping[str, Any], node)
        for key in sorted(mapping_node.keys()):
            item = mapping_node[key]
            key_normalized = _normalize_key(str(key))
            if key_normalized and key_normalized not in flattened:
                number = _parse_number(item)
                if number is not None:
                    flattened[key_normalized] = number
            if isinstance(item, Mapping):
                visit(cast(Mapping[str, Any], item))

    visit(mapping)
    return flattened


def _find_numeric_value(
    flattened_mapping: Mapping[str, float], candidate_keys: list[str]
) -> float | None:
    for key in candidate_keys:
        normalized = _normalize_key(key)
        if normalized in flattened_mapping:
            return float(flattened_mapping[normalized])
    return None


def _normalize_key(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def _parse_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            number = float(stripped)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(number):
        return None
    return number


def _clamp(value: float, *, minimum: float, maximum: float) -> float:
    return max(min(value, maximum), minimum)


def _require_value(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name}_required")
    return normalized


def _resolve_local_ref_path(ref: str, *, field_name: str) -> Path:
    parsed = urlsplit(ref)
    if parsed.scheme not in {"", "file"}:
        raise ValueError(f"{field_name}_must_be_local_path")

    if parsed.scheme == "file":
        candidate = Path(unquote(parsed.path))
    else:
        candidate = Path(ref)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    if not candidate.exists() or not candidate.is_file():
        raise ValueError(f"{field_name}_not_found")
    return candidate


def _load_json_mapping(path: Path, *, field_name: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name}_invalid_json") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{field_name}_must_be_json_object")
    return _to_json_mapping(cast(dict[Any, Any], payload))


def _load_yaml_mapping(path: Path, *, field_name: str) -> dict[str, Any]:
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ValueError(f"{field_name}_invalid_yaml") from exc
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ValueError(f"{field_name}_must_be_yaml_object")
    return _to_json_mapping(cast(dict[Any, Any], payload))


def _to_json_mapping(value: Mapping[Any, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, item in value.items():
        payload[str(key)] = _to_json_value(item)
    return payload


def _to_json_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return _to_json_mapping(cast(Mapping[Any, Any], value))
    if isinstance(value, list):
        return [_to_json_value(item) for item in cast(list[Any], value)]
    if isinstance(value, tuple):
        return [_to_json_value(item) for item in cast(tuple[Any, ...], value)]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _write_canonical_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.write_text(canonical_json(payload) + "\n", encoding="utf-8")


__all__ = [
    "DEFAULT_EVAL_REPORT_NAME",
    "DSPyEvalArtifactResult",
    "evaluate_dspy_compile_artifact",
]

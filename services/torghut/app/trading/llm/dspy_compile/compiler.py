"""Deterministic DSPy compile artifact builder for Torghut compile lanes."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast
from urllib.parse import unquote, urlsplit

import yaml

from ..schema import LLMReviewResponse
from .hashing import canonical_json, hash_payload
from .schemas import DSPyCompileResult
from .workflow import build_compile_result

COMPILED_ARTIFACT_SCHEMA_VERSION = "torghut.dspy.compiled-program.v1"
COMPILE_METRICS_SCHEMA_VERSION = "torghut.dspy.compile-metrics.v1"
DEFAULT_COMPILE_SEED = "torghut-dspy-compile-seed-v1"
DEFAULT_PROGRAM_NAME = "trade-review-committee-v1"
DEFAULT_SIGNATURE_VERSION = "v1"
DEFAULT_COMPILED_ARTIFACT_NAME = "dspy-compiled-program.json"
DEFAULT_COMPILE_RESULT_NAME = "dspy-compile-result.json"
DEFAULT_COMPILE_METRICS_NAME = "dspy-compile-metrics.json"
_MIPRO_OPTIMIZERS = {
    "mipro",
    "mipro-v2",
    "mipro_v2",
    "miprov2",
}
_DERIVED_METRICS_SCHEMA_VERSION = "torghut.dspy.observed-metrics.v1"
_FALSE_VETO_EXECUTED_STATUSES = {"executed", "filled"}


@dataclass(frozen=True)
class DSPyCompileArtifactResult:
    """Result bundle for compile lane artifact generation."""

    compile_result: DSPyCompileResult
    compile_result_path: Path
    compiled_artifact_path: Path
    compiled_artifact_uri: str
    compile_metrics_path: Path
    metric_bundle_hash: str


def compile_dspy_program_artifacts(
    *,
    repository: str,
    base: str,
    head: str,
    artifact_path: Path | str,
    dataset_ref: str,
    metric_policy_ref: str,
    optimizer: str,
    program_name: str = DEFAULT_PROGRAM_NAME,
    signature_version: str = DEFAULT_SIGNATURE_VERSION,
    seed: str = DEFAULT_COMPILE_SEED,
    compiled_artifact_name: str = DEFAULT_COMPILED_ARTIFACT_NAME,
    compile_result_name: str = DEFAULT_COMPILE_RESULT_NAME,
    compile_metrics_name: str = DEFAULT_COMPILE_METRICS_NAME,
    schema_valid_rate: float | None = None,
    veto_alignment_rate: float | None = None,
    false_veto_rate: float | None = None,
    fallback_rate: float | None = None,
    latency_p95_ms: int | None = None,
    created_at: datetime | None = None,
) -> DSPyCompileArtifactResult:
    """Compile Torghut DSPy program artifacts from deterministic local refs only."""

    normalized_repository = _require_value(repository, "repository")
    normalized_base = _require_value(base, "base")
    normalized_head = _require_value(head, "head")
    normalized_optimizer = _normalize_optimizer(optimizer)
    normalized_program_name = _require_value(program_name, "program_name")
    normalized_signature_version = _require_value(
        signature_version, "signature_version"
    )
    normalized_seed = _require_value(seed, "seed")
    normalized_artifact_ref = _require_value(str(artifact_path), "artifact_path")
    normalized_dataset_ref = _require_value(dataset_ref, "dataset_ref")
    normalized_metric_policy_ref = _require_value(metric_policy_ref, "metric_policy_ref")
    normalized_compiled_artifact_name = _normalize_artifact_file_name(
        compiled_artifact_name, "compiled_artifact_name"
    )
    normalized_compile_result_name = _normalize_artifact_file_name(
        compile_result_name, "compile_result_name"
    )
    normalized_compile_metrics_name = _normalize_artifact_file_name(
        compile_metrics_name, "compile_metrics_name"
    )

    dataset_path = _resolve_local_ref_path(
        normalized_dataset_ref, field_name="dataset_ref"
    )
    metric_policy_path = _resolve_local_ref_path(
        normalized_metric_policy_ref, field_name="metric_policy_ref"
    )
    canonical_dataset_ref = _canonical_local_ref(dataset_path)
    canonical_metric_policy_ref = _canonical_local_ref(metric_policy_path)

    canonical_dataset_ref = str(dataset_path)
    canonical_metric_policy_ref = str(metric_policy_path)

    dataset_payload = _load_json_mapping(dataset_path, field_name="dataset_ref")
    metric_policy_payload = _load_yaml_mapping(
        metric_policy_path, field_name="metric_policy_ref"
    )

    output_dir = Path(normalized_artifact_ref).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    compiled_artifact_uri = _build_artifact_uri(
        artifact_path=str(output_dir),
        artifact_name=normalized_compiled_artifact_name,
    )
    compiled_artifact_path = output_dir / normalized_compiled_artifact_name

    signature_versions = {"trade_review": normalized_signature_version}
    dataset_hash = hash_payload(dataset_payload)
    metric_policy_hash = hash_payload(metric_policy_payload)
    row_counts_by_split = _count_rows_by_split(dataset_payload.get("rows"))
    dataset_rows = sum(row_counts_by_split.values())

    metric_bundle: dict[str, Any] = {
        "datasetRef": canonical_dataset_ref,
        "datasetHash": dataset_hash,
        "datasetRows": dataset_rows,
        "rowCountsBySplit": row_counts_by_split,
        "metricPolicyRef": canonical_metric_policy_ref,
        "metricPolicyHash": metric_policy_hash,
        "optimizer": normalized_optimizer,
        "policy": cast(dict[str, Any], metric_policy_payload.get("policy") or {}),
    }
    observed_metrics = _build_observed_metrics(
        dataset_payload=dataset_payload,
        schema_valid_rate=schema_valid_rate,
        veto_alignment_rate=veto_alignment_rate,
        false_veto_rate=false_veto_rate,
        fallback_rate=fallback_rate,
        latency_p95_ms=latency_p95_ms,
    )
    metric_bundle.update(observed_metrics)
    metric_bundle_hash = hash_payload(metric_bundle)

    compiled_artifact_payload: dict[str, Any] = {
        "schemaVersion": COMPILED_ARTIFACT_SCHEMA_VERSION,
        "repository": normalized_repository,
        "base": normalized_base,
        "head": normalized_head,
        "programName": normalized_program_name,
        "signatureVersions": signature_versions,
        "optimizer": normalized_optimizer,
        "seed": normalized_seed,
        "datasetRef": canonical_dataset_ref,
        "datasetHash": dataset_hash,
        "metricPolicyRef": canonical_metric_policy_ref,
        "metricPolicyHash": metric_policy_hash,
        "compileMetrics": metric_bundle,
        "compiledPrompt": {
            "promptTemplate": "torghut.dspy.trade-review.v1",
            "systemInstruction": "Return only schema-valid Torghut advisory JSON.",
            "safetyMode": "deterministic_fail_closed",
        },
    }
    _write_canonical_json(compiled_artifact_path, compiled_artifact_payload)

    compile_result = build_compile_result(
        program_name=normalized_program_name,
        signature_versions=signature_versions,
        optimizer=normalized_optimizer,
        dataset_payload=dataset_payload,
        metric_bundle=metric_bundle,
        compiled_prompt_payload=compiled_artifact_payload,
        compiled_artifact_uri=compiled_artifact_uri,
        seed=normalized_seed,
        created_at=created_at or datetime.now(timezone.utc),
    )

    compile_result_path = output_dir / normalized_compile_result_name
    _write_canonical_json(
        compile_result_path,
        compile_result.model_dump(mode="json", by_alias=True),
    )

    compile_metrics_path = output_dir / normalized_compile_metrics_name
    compile_metrics_payload: dict[str, Any] = {
        "schemaVersion": COMPILE_METRICS_SCHEMA_VERSION,
        "programName": normalized_program_name,
        "optimizer": normalized_optimizer,
        "compiledArtifactUri": compiled_artifact_uri,
        "artifactHash": compile_result.artifact_hash,
        "reproducibilityHash": compile_result.reproducibility_hash,
        "metricBundleHash": metric_bundle_hash,
        "metricBundle": metric_bundle,
    }
    _write_canonical_json(
        compile_metrics_path,
        compile_metrics_payload,
    )

    return DSPyCompileArtifactResult(
        compile_result=compile_result,
        compile_result_path=compile_result_path,
        compiled_artifact_path=compiled_artifact_path,
        compiled_artifact_uri=compiled_artifact_uri,
        compile_metrics_path=compile_metrics_path,
        metric_bundle_hash=metric_bundle_hash,
    )


def _require_value(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name}_required")
    return normalized


def _normalize_optimizer(optimizer: str) -> str:
    normalized = _require_value(optimizer, "optimizer").lower()
    if normalized not in _MIPRO_OPTIMIZERS:
        raise ValueError("optimizer_must_be_mipro")
    if normalized in {"mipro-v2", "mipro_v2"}:
        return "miprov2"
    return normalized


def _normalize_artifact_file_name(file_name: str, field_name: str) -> str:
    normalized = _require_value(file_name, field_name)
    if "/" in normalized or "\\" in normalized:
        raise ValueError(f"{field_name}_must_be_file_name")
    if normalized in {".", ".."}:
        raise ValueError(f"{field_name}_must_be_file_name")
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
    return candidate.resolve()


def _canonical_local_ref(path: Path) -> str:
    return path.resolve().as_uri()


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


def _count_rows_by_split(rows: Any) -> dict[str, int]:
    counts: dict[str, int] = {"train": 0, "eval": 0, "test": 0}
    if not isinstance(rows, list):
        return counts
    for item in cast(list[Any], rows):
        if not isinstance(item, dict):
            continue
        row = cast(dict[str, Any], item)
        split = str(row.get("split") or "").strip().lower()
        if not split:
            continue
        counts[split] = counts.get(split, 0) + 1
    return {key: counts[key] for key in sorted(counts)}


def _build_observed_metrics(
    *,
    dataset_payload: Mapping[str, Any],
    schema_valid_rate: float | None,
    veto_alignment_rate: float | None,
    false_veto_rate: float | None,
    fallback_rate: float | None,
    latency_p95_ms: int | None,
) -> dict[str, Any]:
    observed = {
        "schemaValidRate": schema_valid_rate,
        "vetoAlignmentRate": veto_alignment_rate,
        "falseVetoRate": false_veto_rate,
        "fallbackRate": fallback_rate,
        "latencyP95Ms": latency_p95_ms,
    }
    provided_count = sum(1 for value in observed.values() if value is not None)
    if provided_count == 0:
        return _derive_observed_metrics_from_dataset(dataset_payload)
    if provided_count != len(observed):
        raise ValueError("observed_metrics_incomplete")

    return {
        "schemaValidRate": _normalize_rate(
            cast(float, observed["schemaValidRate"]), field_name="schema_valid_rate"
        ),
        "vetoAlignmentRate": _normalize_rate(
            cast(float, observed["vetoAlignmentRate"]),
            field_name="veto_alignment_rate",
        ),
        "falseVetoRate": _normalize_rate(
            cast(float, observed["falseVetoRate"]), field_name="false_veto_rate"
        ),
        "fallbackRate": _normalize_rate(
            cast(float, observed["fallbackRate"]), field_name="fallback_rate"
        ),
        "latencyP95Ms": _normalize_non_negative_int(
            cast(int, observed["latencyP95Ms"]), field_name="latency_p95_ms"
        ),
    }


def _derive_observed_metrics_from_dataset(
    dataset_payload: Mapping[str, Any],
) -> dict[str, Any]:
    rows_raw = dataset_payload.get("rows")
    rows = cast(list[Any], rows_raw) if isinstance(rows_raw, list) else []
    total_rows = len(rows)
    if total_rows <= 0:
        return {
            "schemaValidRate": 0.0,
            "vetoAlignmentRate": 0.0,
            "falseVetoRate": 1.0,
            "fallbackRate": 1.0,
            "latencyP95Ms": 2**31 - 1,
            "observedMetricsSource": _DERIVED_METRICS_SCHEMA_VERSION,
            "observedMetricsRows": 0,
            "observedMetricsSchemaValidRows": 0,
            "observedMetricsLatencyRows": 0,
            "observedMetricsFallbackRows": 0,
            "observedMetricsVetoRows": 0,
            "observedMetricsFalseVetoRows": 0,
        }

    schema_valid_rows = 0
    veto_alignment_rows = 0
    fallback_rows = 0
    veto_rows = 0
    false_veto_rows = 0
    latency_values: list[int] = []

    for row_raw in rows:
        if not isinstance(row_raw, Mapping):
            continue
        row = cast(Mapping[str, Any], row_raw)
        label_raw = row.get("label")
        label: dict[str, Any] = _mapping_to_dict(label_raw)
        response_raw = label.get("responseJson")
        response_payload: dict[str, Any] = _mapping_to_dict(response_raw)
        decision_raw = row.get("decision")
        decision: dict[str, Any] = _mapping_to_dict(decision_raw)
        label_verdict = str(label.get("verdict") or "").strip().lower()

        if _row_indicates_fallback(response_payload):
            fallback_rows += 1

        latency_ms = _extract_latency_ms(response_payload)
        if latency_ms is not None:
            latency_values.append(latency_ms)

        try:
            parsed_response = LLMReviewResponse.model_validate(dict(response_payload))
        except Exception:
            continue

        schema_valid_rows += 1
        parsed_verdict = parsed_response.verdict.strip().lower()
        if parsed_verdict == label_verdict:
            veto_alignment_rows += 1
        if parsed_verdict == "veto":
            veto_rows += 1
            if _decision_was_executed(decision):
                false_veto_rows += 1

    schema_valid_rate = schema_valid_rows / total_rows
    veto_alignment_rate = (
        veto_alignment_rows / schema_valid_rows if schema_valid_rows > 0 else 0.0
    )
    false_veto_rate = false_veto_rows / veto_rows if veto_rows > 0 else 0.0
    fallback_rate = fallback_rows / total_rows
    latency_p95_ms = (
        _percentile_disc(latency_values, percentile=0.95)
        if latency_values
        else 2**31 - 1
    )

    return {
        "schemaValidRate": schema_valid_rate,
        "vetoAlignmentRate": veto_alignment_rate,
        "falseVetoRate": false_veto_rate,
        "fallbackRate": fallback_rate,
        "latencyP95Ms": latency_p95_ms,
        "observedMetricsSource": _DERIVED_METRICS_SCHEMA_VERSION,
        "observedMetricsRows": total_rows,
        "observedMetricsSchemaValidRows": schema_valid_rows,
        "observedMetricsLatencyRows": len(latency_values),
        "observedMetricsFallbackRows": fallback_rows,
        "observedMetricsVetoRows": veto_rows,
        "observedMetricsFalseVetoRows": false_veto_rows,
    }


def _row_indicates_fallback(response_payload: Mapping[str, Any]) -> bool:
    direct_fallback = response_payload.get("fallback")
    if isinstance(direct_fallback, bool):
        return direct_fallback
    if isinstance(direct_fallback, str) and direct_fallback.strip():
        return True

    dspy_raw = response_payload.get("dspy")
    if not isinstance(dspy_raw, Mapping):
        return False
    dspy_payload = cast(Mapping[str, Any], dspy_raw)
    dspy_fallback = dspy_payload.get("fallback")
    if isinstance(dspy_fallback, bool):
        return dspy_fallback
    if isinstance(dspy_fallback, str):
        return dspy_fallback.strip().lower() not in {"", "false", "0", "no"}
    return False


def _extract_latency_ms(response_payload: Mapping[str, Any]) -> int | None:
    dspy_raw = response_payload.get("dspy")
    if isinstance(dspy_raw, Mapping):
        dspy_payload = cast(Mapping[str, Any], dspy_raw)
        latency_candidate = dspy_payload.get("latency_ms")
        if latency_candidate is None:
            latency_candidate = dspy_payload.get("latencyMs")
        normalized = _normalize_optional_non_negative_int(latency_candidate)
        if normalized is not None:
            return normalized

    latency_candidate = response_payload.get("latency_ms")
    if latency_candidate is None:
        latency_candidate = response_payload.get("latencyMs")
    return _normalize_optional_non_negative_int(latency_candidate)


def _normalize_optional_non_negative_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        normalized = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    if normalized < 0:
        return None
    return normalized


def _decision_was_executed(decision: Mapping[str, Any]) -> bool:
    executed_at = decision.get("executedAt")
    if isinstance(executed_at, str) and executed_at.strip():
        return True
    status = str(decision.get("status") or "").strip().lower()
    return status in _FALSE_VETO_EXECUTED_STATUSES


def _percentile_disc(values: list[int], *, percentile: float) -> int:
    if not values:
        raise ValueError("percentile_values_required")
    normalized = min(max(float(percentile), 0.0), 1.0)
    ordered = sorted(values)
    index = max(int((len(ordered) - 1) * normalized), 0)
    return ordered[index]


def _mapping_to_dict(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def _normalize_rate(value: float, *, field_name: str) -> float:
    normalized = float(value)
    if normalized < 0.0 or normalized > 1.0:
        raise ValueError(f"{field_name}_out_of_range")
    return normalized


def _normalize_non_negative_int(value: int, *, field_name: str) -> int:
    normalized = int(value)
    if normalized < 0:
        raise ValueError(f"{field_name}_must_be_non_negative")
    return normalized


def _build_artifact_uri(*, artifact_path: str, artifact_name: str) -> str:
    base = artifact_path.rstrip("/")
    if not base:
        return artifact_name
    return f"{base}/{artifact_name}"


def _write_canonical_json(path: Path, payload: Any) -> None:
    path.write_text(canonical_json(payload) + "\n", encoding="utf-8")


__all__ = [
    "COMPILED_ARTIFACT_SCHEMA_VERSION",
    "COMPILE_METRICS_SCHEMA_VERSION",
    "DEFAULT_COMPILE_SEED",
    "DEFAULT_COMPILE_RESULT_NAME",
    "DEFAULT_COMPILE_METRICS_NAME",
    "DEFAULT_COMPILED_ARTIFACT_NAME",
    "DEFAULT_PROGRAM_NAME",
    "DEFAULT_SIGNATURE_VERSION",
    "DSPyCompileArtifactResult",
    "compile_dspy_program_artifacts",
]

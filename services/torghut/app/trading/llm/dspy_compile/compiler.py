"""Deterministic DSPy compile artifact builder for Torghut compile lanes."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast
from urllib.parse import unquote, urlsplit

import yaml

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
    created_at: datetime | None = None,
) -> DSPyCompileArtifactResult:
    """Compile Torghut DSPy program artifacts from deterministic local refs only."""

    normalized_repository = _require_value(repository, "repository")
    normalized_base = _require_value(base, "base")
    normalized_head = _require_value(head, "head")
    normalized_optimizer = _require_value(optimizer, "optimizer").lower()
    normalized_program_name = _require_value(program_name, "program_name")
    normalized_signature_version = _require_value(
        signature_version, "signature_version"
    )
    normalized_seed = _require_value(seed, "seed")
    normalized_artifact_ref = _require_value(str(artifact_path), "artifact_path")
    normalized_dataset_ref = _require_value(dataset_ref, "dataset_ref")
    normalized_metric_policy_ref = _require_value(metric_policy_ref, "metric_policy_ref")
    normalized_compiled_artifact_name = _require_value(
        compiled_artifact_name, "compiled_artifact_name"
    )
    normalized_compile_result_name = _require_value(
        compile_result_name, "compile_result_name"
    )
    normalized_compile_metrics_name = _require_value(
        compile_metrics_name, "compile_metrics_name"
    )

    dataset_path = _resolve_local_ref_path(normalized_dataset_ref, field_name="dataset_ref")
    metric_policy_path = _resolve_local_ref_path(
        normalized_metric_policy_ref, field_name="metric_policy_ref"
    )

    dataset_payload = _load_json_mapping(dataset_path, field_name="dataset_ref")
    metric_policy_payload = _load_yaml_mapping(
        metric_policy_path, field_name="metric_policy_ref"
    )

    output_dir = Path(normalized_artifact_ref)
    output_dir.mkdir(parents=True, exist_ok=True)

    compiled_artifact_uri = _build_artifact_uri(
        artifact_path=normalized_artifact_ref,
        artifact_name=normalized_compiled_artifact_name,
    )
    compiled_artifact_path = output_dir / normalized_compiled_artifact_name

    signature_versions = {"trade_review": normalized_signature_version}
    dataset_hash = hash_payload(dataset_payload)
    metric_policy_hash = hash_payload(metric_policy_payload)
    row_counts_by_split = _count_rows_by_split(dataset_payload.get("rows"))
    dataset_rows = sum(row_counts_by_split.values())

    metric_bundle: dict[str, Any] = {
        "datasetRef": normalized_dataset_ref,
        "datasetHash": dataset_hash,
        "datasetRows": dataset_rows,
        "rowCountsBySplit": row_counts_by_split,
        "metricPolicyRef": normalized_metric_policy_ref,
        "metricPolicyHash": metric_policy_hash,
        "optimizer": normalized_optimizer,
        "policy": cast(dict[str, Any], metric_policy_payload.get("policy") or {}),
    }
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
        "datasetRef": normalized_dataset_ref,
        "datasetHash": dataset_hash,
        "metricPolicyRef": normalized_metric_policy_ref,
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
    _write_canonical_json(
        compile_metrics_path,
        {
            "schemaVersion": COMPILE_METRICS_SCHEMA_VERSION,
            "programName": normalized_program_name,
            "optimizer": normalized_optimizer,
            "metricBundleHash": metric_bundle_hash,
            "metricBundle": metric_bundle,
        },
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

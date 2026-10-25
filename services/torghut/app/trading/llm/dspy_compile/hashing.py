"""Deterministic canonical hashing utilities for DSPy artifact workflows."""

from __future__ import annotations

import hashlib
import json
from typing import Mapping
from urllib.parse import unquote, urlsplit


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_payload(value: object) -> str:
    return sha256_hex(canonical_json(value))


def canonical_metric_bundle_for_hash(
    metric_bundle: Mapping[str, object],
) -> dict[str, object]:
    """Replace checkout-local references with their content-addressed identities."""
    normalized = dict(metric_bundle)
    dataset_hash = normalized.get("datasetHash")
    if isinstance(dataset_hash, str) and dataset_hash.strip():
        normalized["datasetRef"] = f"sha256:{dataset_hash.strip().lower()}"
    metric_policy_hash = normalized.get("metricPolicyHash")
    if isinstance(metric_policy_hash, str) and metric_policy_hash.strip():
        normalized["metricPolicyRef"] = f"sha256:{metric_policy_hash.strip().lower()}"
    return normalized


def canonical_artifact_uri_for_hash(artifact_uri: str) -> str:
    """Normalize local artifact locations while preserving remote object identity."""
    normalized = artifact_uri.strip()
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"", "file"}:
        return normalized
    local_path = unquote(parsed.path) if parsed.scheme == "file" else normalized
    artifact_name = local_path.replace("\\", "/").rstrip("/").split("/")[-1]
    return f"artifact:///{artifact_name}" if artifact_name else "artifact:///"


__all__ = [
    "canonical_artifact_uri_for_hash",
    "canonical_json",
    "canonical_metric_bundle_for_hash",
    "hash_payload",
    "sha256_hex",
]

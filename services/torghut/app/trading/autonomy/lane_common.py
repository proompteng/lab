"""Shared autonomy lane contracts and scalar helpers."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast

from .phase_manifest_contract import AUTONOMY_PHASE_ORDER


LANE_AUTONOMY_PHASE_ORDER: tuple[str, ...] = AUTONOMY_PHASE_ORDER


ACTUATION_INTENT_SCHEMA_VERSION = "torghut.autonomy.actuation-intent.v1"
ACTUATION_CONFIRMATION_PHRASE = "ACTUATE_TORGHUT"
ACTUATION_INTENT_PATH = "gates/actuation-intent.json"
AUTONOMY_LANE_SCHEMA_VERSION = "torghut-autonomy-stage-manifest-v1"
PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION = "profitability-stage-manifest-v1"
PROFITABILITY_STAGE_MANIFEST_PATH = "profitability/profitability-stage-manifest-v1.json"
STAGE_CANDIDATE_GENERATION = "candidate-generation"
STAGE_EVALUATION = "evaluation"
STAGE_RECOMMENDATION = "promotion-recommendation"
STRESS_METRICS_ARTIFACT_PATH = "stress-metrics-v1.json"
CONTAMINATION_REGISTRY_ARTIFACT_PATH = "contamination-leakage-report-v1.json"
HMM_STATE_POSTERIOR_ARTIFACT_PATH = "gates/hmm-state-posterior-v1.json"
EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH = "gates/expert-router-registry-v1.json"
FOLD_METRICS_ARTIFACT_PATH = "fold-metrics-v1.json"
STRESS_METRICS_CASES = ("spread", "volatility", "liquidity", "halt")
BENCHMARK_PARITY_REPORT_PATH = "gates/benchmark-parity-report-v1.json"
FOUNDATION_ROUTER_PARITY_REPORT_PATH = "router/foundation-router-parity-report-v1.json"
DEEPLOB_BDLOB_REPORT_PATH = "microstructure/deeplob-bdlob-report-v1.json"
ADVISOR_FALLBACK_SLO_REPORT_PATH = "execution/advisor-fallback-slo-report-v1.json"
STAGE_PROFITABILITY = "profitability_stage_manifest"
V6_08_GOVERNING_DESIGN_DOC = "docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md"

_AUTONOMY_PHASE_ORDER = LANE_AUTONOMY_PHASE_ORDER
_ACTUATION_INTENT_SCHEMA_VERSION = ACTUATION_INTENT_SCHEMA_VERSION
_ACTUATION_CONFIRMATION_PHRASE = ACTUATION_CONFIRMATION_PHRASE
_ACTUATION_INTENT_PATH = ACTUATION_INTENT_PATH
_AUTONOMY_LANE_SCHEMA_VERSION = AUTONOMY_LANE_SCHEMA_VERSION
_PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION = (
    PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION
)
_PROFITABILITY_STAGE_MANIFEST_PATH = PROFITABILITY_STAGE_MANIFEST_PATH
_STAGE_CANDIDATE_GENERATION = STAGE_CANDIDATE_GENERATION
_STAGE_EVALUATION = STAGE_EVALUATION
_STAGE_RECOMMENDATION = STAGE_RECOMMENDATION
_STRESS_METRICS_ARTIFACT_PATH = STRESS_METRICS_ARTIFACT_PATH
_CONTAMINATION_REGISTRY_ARTIFACT_PATH = CONTAMINATION_REGISTRY_ARTIFACT_PATH
_HMM_STATE_POSTERIOR_ARTIFACT_PATH = HMM_STATE_POSTERIOR_ARTIFACT_PATH
_EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH = EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH
_FOLD_METRICS_ARTIFACT_PATH = FOLD_METRICS_ARTIFACT_PATH
_STRESS_METRICS_CASES = STRESS_METRICS_CASES
_BENCHMARK_PARITY_REPORT_PATH = BENCHMARK_PARITY_REPORT_PATH
_FOUNDATION_ROUTER_PARITY_REPORT_PATH = FOUNDATION_ROUTER_PARITY_REPORT_PATH
_DEEPLOB_BDLOB_REPORT_PATH = DEEPLOB_BDLOB_REPORT_PATH
_ADVISOR_FALLBACK_SLO_REPORT_PATH = ADVISOR_FALLBACK_SLO_REPORT_PATH
_STAGE_PROFITABILITY = STAGE_PROFITABILITY
_V6_08_GOVERNING_DESIGN_DOC = V6_08_GOVERNING_DESIGN_DOC


@dataclass(frozen=True)
class _StageManifestRecord:
    stage: str
    stage_index: int
    stage_trace_id: str
    lineage_hash: str
    artifact_hashes: dict[str, str]
    stage_payload_hash: str
    created_at: str
    created_by: str = "run_autonomous_lane"
    parent_lineage_hash: str | None = None
    parent_stage: str | None = None
    inputs: dict[str, str] = field(default_factory=lambda: cast(dict[str, str], {}))


def _coerce_evidence_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
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


@dataclass(frozen=True)
class AutonomousLaneResult:
    run_id: str
    candidate_id: str
    output_dir: Path
    gate_report_path: Path
    actuation_intent_path: Path | None
    paper_patch_path: Path | None
    phase_manifest_path: Path
    benchmark_parity_path: Path
    foundation_router_parity_path: Path
    gate_report_trace_id: str
    recommendation_trace_id: str
    recommendation_artifact_path: Path
    candidate_spec_path: Path
    candidate_generation_manifest_path: Path
    evaluation_manifest_path: Path
    recommendation_manifest_path: Path
    profitability_manifest_path: Path
    stage_trace_ids: dict[str, str] = field(
        default_factory=lambda: cast(dict[str, str], {})
    )
    stage_lineage_root: str | None = None


def _ensure_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_object_dict(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[object, object], value)
    return {str(key): item for key, item in mapping.items()}


def _stable_hash(payload: object) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _default_strategy_configmap_path() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "argocd").is_dir() and (parent / "services" / "torghut").is_dir():
            return (
                parent
                / "argocd"
                / "applications"
                / "torghut"
                / "strategy-configmap.yaml"
            )
    return (
        Path(__file__).resolve().parents[6]
        / "argocd"
        / "applications"
        / "torghut"
        / "strategy-configmap.yaml"
    )


StageManifestRecord = _StageManifestRecord
coerce_evidence_bool = _coerce_evidence_bool
ensure_utc = _ensure_utc
safe_int = _safe_int
as_object_dict = _as_object_dict
stable_hash = _stable_hash
sha256_path = _sha256_path
default_strategy_configmap_path = _default_strategy_configmap_path

__all__ = [
    "StageManifestRecord",
    "coerce_evidence_bool",
    "AutonomousLaneResult",
    "ensure_utc",
    "safe_int",
    "as_object_dict",
    "stable_hash",
    "sha256_path",
    "default_strategy_configmap_path",
    "LANE_AUTONOMY_PHASE_ORDER",
    "ACTUATION_INTENT_SCHEMA_VERSION",
    "ACTUATION_CONFIRMATION_PHRASE",
    "ACTUATION_INTENT_PATH",
    "AUTONOMY_LANE_SCHEMA_VERSION",
    "PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION",
    "PROFITABILITY_STAGE_MANIFEST_PATH",
    "STAGE_CANDIDATE_GENERATION",
    "STAGE_EVALUATION",
    "STAGE_RECOMMENDATION",
    "STRESS_METRICS_ARTIFACT_PATH",
    "CONTAMINATION_REGISTRY_ARTIFACT_PATH",
    "HMM_STATE_POSTERIOR_ARTIFACT_PATH",
    "EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH",
    "FOLD_METRICS_ARTIFACT_PATH",
    "STRESS_METRICS_CASES",
    "BENCHMARK_PARITY_REPORT_PATH",
    "FOUNDATION_ROUTER_PARITY_REPORT_PATH",
    "DEEPLOB_BDLOB_REPORT_PATH",
    "ADVISOR_FALLBACK_SLO_REPORT_PATH",
    "STAGE_PROFITABILITY",
    "V6_08_GOVERNING_DESIGN_DOC",
]

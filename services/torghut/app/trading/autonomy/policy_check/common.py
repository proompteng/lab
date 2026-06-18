"""Shared imports, constants, and result payloads for policy checks."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
import math
from pathlib import Path
from typing import Any, Sequence, cast
from urllib.parse import urlparse

from ...evidence_contracts import (
    NON_AUTHORITATIVE_PROVENANCE,
    contract_from_artifact_payload,
    parse_evidence_contract,
)
from ...parity import (
    ADVISOR_FALLBACK_SLO_CONTRACT_SCHEMA_VERSION,
    ADVISOR_FALLBACK_SLO_REQUIRED_REASONS,
    ADVISOR_FALLBACK_SLO_REQUIRED_SUMMARY_FIELDS,
    ADVISOR_FALLBACK_SLO_SCHEMA_VERSION,
    BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
    BENCHMARK_PARITY_SCHEMA_VERSION,
    DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION,
    DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS,
    DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS,
    DEEPLOB_BDLOB_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION,
    FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS,
    FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS,
    FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION,
)


_PROFITABILITY_STAGE_ORDER: tuple[str, ...] = (
    "research",
    "validation",
    "execution",
    "governance",
)

_PROFITABILITY_STAGE_REQUIRED_CHECKS: dict[str, tuple[str, ...]] = {
    "research": (
        "candidate_spec_present",
        "candidate_generation_manifest_present",
        "walkforward_results_present",
        "baseline_evaluation_report_present",
    ),
    "validation": (
        "evaluation_report_present",
        "profitability_benchmark_present",
        "profitability_evidence_present",
        "profitability_validation_present",
    ),
    "execution": (
        "walkforward_results_present",
        "evaluation_report_present",
        "gate_evaluation_present",
        "hmm_state_posterior_present",
        "expert_router_registry_present",
        "advisor_fallback_slo_present",
        "janus_event_car_present",
        "janus_hgrm_reward_present",
        "recalibration_report_present",
        "gate_matrix_approval",
        "drift_gate_approval",
    ),
    "governance": (
        "rollback_ready",
        "gate_report_present",
        "candidate_spec_present",
        "rollback_readiness_present",
        "risk_controls_attestable",
    ),
}


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


@dataclass(frozen=True)
class _BenchmarkParityThresholds:
    min_advisory_output_rate: float
    max_policy_violation_degradation: float
    max_fallback_rate: float
    max_timeout_rate: float
    max_adverse_regime_degradation: float
    max_risk_veto_degradation: float
    max_confidence_degradation: float
    max_scorecard_confidence_drift: float
    min_family_coverage_ratio: float


@dataclass(frozen=True)
class _DeeplobBdlobThresholds:
    min_feature_quality_pass_rate: float
    min_prediction_quality_score: float
    min_cost_adjusted_edge_bps: float
    max_slippage_divergence_bps: float
    min_fallback_reliability: float


__all__ = (
    "PromotionPrerequisiteResult",
    "RollbackReadinessResult",
)

# Public aliases used by split modules.
BenchmarkParityThresholds = _BenchmarkParityThresholds
DeeplobBdlobThresholds = _DeeplobBdlobThresholds
PROFITABILITY_STAGE_ORDER = _PROFITABILITY_STAGE_ORDER
PROFITABILITY_STAGE_REQUIRED_CHECKS = _PROFITABILITY_STAGE_REQUIRED_CHECKS


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ADVISOR_FALLBACK_SLO_CONTRACT_SCHEMA_VERSION",
    "ADVISOR_FALLBACK_SLO_REQUIRED_REASONS",
    "ADVISOR_FALLBACK_SLO_REQUIRED_SUMMARY_FIELDS",
    "ADVISOR_FALLBACK_SLO_SCHEMA_VERSION",
    "Any",
    "BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION",
    "BENCHMARK_PARITY_REQUIRED_FAMILIES",
    "BENCHMARK_PARITY_REQUIRED_RUN_FIELDS",
    "BENCHMARK_PARITY_REQUIRED_SCORECARDS",
    "BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS",
    "BENCHMARK_PARITY_RUN_SCHEMA_VERSION",
    "BENCHMARK_PARITY_SCHEMA_VERSION",
    "BenchmarkParityThresholds",
    "DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION",
    "DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS",
    "DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS",
    "DEEPLOB_BDLOB_SCHEMA_VERSION",
    "DeeplobBdlobThresholds",
    "FOUNDATION_ROUTER_PARITY_CONTRACT_SCHEMA_VERSION",
    "FOUNDATION_ROUTER_PARITY_REQUIRED_ADAPTERS",
    "FOUNDATION_ROUTER_PARITY_REQUIRED_SLICE_METRICS",
    "FOUNDATION_ROUTER_PARITY_SCHEMA_VERSION",
    "NON_AUTHORITATIVE_PROVENANCE",
    "PROFITABILITY_STAGE_ORDER",
    "PROFITABILITY_STAGE_REQUIRED_CHECKS",
    "Path",
    "PromotionPrerequisiteResult",
    "RollbackReadinessResult",
    "Sequence",
    "_BenchmarkParityThresholds",
    "_DeeplobBdlobThresholds",
    "_PROFITABILITY_STAGE_ORDER",
    "_PROFITABILITY_STAGE_REQUIRED_CHECKS",
    "annotations",
    "cast",
    "contract_from_artifact_payload",
    "dataclass",
    "datetime",
    "hashlib",
    "json",
    "math",
    "os",
    "parse_evidence_contract",
    "timedelta",
    "timezone",
    "urlparse",
)

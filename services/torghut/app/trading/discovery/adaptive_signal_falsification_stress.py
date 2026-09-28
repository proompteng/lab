"""Research-only adaptive signal falsification stress artifacts.

This module turns the 2026 spurious-predictability warning into deterministic
candidate-side evidence artifacts.  It can help a replay candidate materialize
negative-control, label/placebo permutation, leakage-probe, and multiplicity
adjustment fields, but it never simulates fills, writes ledgers, authorizes
promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from math import isfinite
from statistics import median, quantiles
from typing import Any, cast

from app.trading.models import SignalEnvelope

ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SCHEMA_VERSION = (
    "torghut.adaptive-signal-falsification-stress.v1"
)
ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.adaptive-signal-falsification-stress-contract.v1"
)
ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_PROOF_SEMANTICS_LABEL = (
    "adaptive_signal_falsification_research_only_exact_replay_route_tca_"
    "runtime_ledger_required"
)
ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2604.15531",
        "url": "https://arxiv.org/abs/2604.15531",
        "title": "Spurious Predictability in Financial Machine Learning",
        "date": "2026-04-16",
        "mechanism": "adaptive_specification_search_falsification_against_zero_predictability_reference_classes_effective_multiplicity_adjustment",
    },
    {
        "source_id": "arxiv-2605.05580",
        "url": "https://arxiv.org/abs/2605.05580",
        "title": "AlphaCrafter: A Full-Stack Multi-Agent Framework for Cross-Sectional Quantitative Trading",
        "date": "2026-05-07",
        "mechanism": "continuous_adaptive_factor_mining_requires_regime_screening_and_risk_constrained_execution_validation",
    },
)
ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SOURCE_MARKERS: tuple[str, ...] = (
    "spurious_predictability_arxiv_2604_15531_2026",
    "adaptive_factor_to_execution_alphacrafter_arxiv_2605_05580_2026",
)

_RETURN_FIELDS = (
    "post_cost_net_return",
    "post_cost_return",
    "net_return",
    "port_ret_net",
    "daily_return",
    "return",
    "ret",
    "post_cost_net_pnl_per_day",
    "net_pnl_per_day",
    "pnl_per_day",
    "pnl",
)
_MIN_WALK_FORWARD_SAMPLE_COUNT = 3


@dataclass(frozen=True)
class AdaptiveSignalFalsificationStressSummary:
    candidate_id: str
    artifact_ref: str
    candidate_sample_count: int
    incumbent_sample_count: int
    null_model_sample_count: int
    effective_test_count: int
    required_min_null_model_sample_count: int
    required_max_effective_multiplicity_adjusted_p_value: float
    candidate_total_return: float
    incumbent_total_return: float
    median_null_total_return: float
    p95_null_total_return: float
    candidate_vs_null_return_delta: float
    candidate_vs_incumbent_return_delta: float
    empirical_p_value: float
    effective_multiplicity_adjusted_p_value: float
    baseline_outperformed: bool
    negative_control_passed: bool
    placebo_label_test_passed: bool
    label_permutation_test_passed: bool
    feature_permutation_stability_passed: bool
    leakage_probe_passed: bool
    walk_forward_falsification_passed: bool
    adaptive_signal_falsification_passed: bool
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        scorecard_patch = {
            "requires_adaptive_signal_falsification": True,
            "required_adaptive_signal_falsification": True,
            "requires_negative_control_falsification": True,
            "required_negative_control_falsification": True,
            "requires_label_permutation_test": True,
            "required_label_permutation_test": True,
            "requires_leakage_probe": True,
            "required_leakage_probe": True,
            "requires_effective_multiplicity_adjustment": True,
            "required_effective_multiplicity_adjustment": True,
            "rejects_adaptive_specification_search_as_profit_proof": True,
            "rejects_in_sample_factor_generation_without_falsification": True,
            "required_min_null_model_sample_count": self.required_min_null_model_sample_count,
            "required_max_effective_multiplicity_adjusted_p_value": _stable_float(
                self.required_max_effective_multiplicity_adjusted_p_value
            ),
            "adaptive_signal_falsification_passed": self.adaptive_signal_falsification_passed,
            "adaptive_signal_falsification_artifact_ref": self.artifact_ref,
            "negative_control_passed": self.negative_control_passed,
            "placebo_label_test_passed": self.placebo_label_test_passed,
            "label_permutation_test_passed": self.label_permutation_test_passed,
            "feature_permutation_stability_passed": self.feature_permutation_stability_passed,
            "leakage_probe_passed": self.leakage_probe_passed,
            "walk_forward_falsification_passed": self.walk_forward_falsification_passed,
            "null_model_sample_count": self.null_model_sample_count,
            "effective_multiplicity_adjusted_p_value": _stable_float(
                self.effective_multiplicity_adjusted_p_value
            ),
            "candidate_vs_null_return_delta": _stable_float(
                self.candidate_vs_null_return_delta
            ),
            "candidate_vs_incumbent_return_delta": _stable_float(
                self.candidate_vs_incumbent_return_delta
            ),
            "adaptive_signal_falsification_source_markers": list(
                ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SOURCE_MARKERS
            ),
        }
        null_comparator_patch = {
            "schema_version": "adaptive-signal-null-comparator-v1",
            "baseline_outperformed": self.baseline_outperformed,
            "candidate_vs_null_return_delta": _stable_float(
                self.candidate_vs_null_return_delta
            ),
            "candidate_vs_incumbent_return_delta": _stable_float(
                self.candidate_vs_incumbent_return_delta
            ),
            "candidate_total_return": _stable_float(self.candidate_total_return),
            "median_null_total_return": _stable_float(self.median_null_total_return),
            "p95_null_total_return": _stable_float(self.p95_null_total_return),
            "incumbent_total_return": _stable_float(self.incumbent_total_return),
            "null_model_sample_count": self.null_model_sample_count,
            "empirical_p_value": _stable_float(self.empirical_p_value),
            "effective_multiplicity_adjusted_p_value": _stable_float(
                self.effective_multiplicity_adjusted_p_value
            ),
        }
        return {
            "schema_version": ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "research_only_adaptive_signal_falsification_evidence_collection",
            "candidate_id": self.candidate_id,
            "artifact_ref": self.artifact_ref,
            "source_papers": [
                dict(item)
                for item in ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_PRIMARY_SOURCES
            ],
            "source_markers": list(ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SOURCE_MARKERS),
            "candidate_sample_count": self.candidate_sample_count,
            "incumbent_sample_count": self.incumbent_sample_count,
            "null_model_sample_count": self.null_model_sample_count,
            "effective_test_count": self.effective_test_count,
            "candidate_total_return": _stable_float(self.candidate_total_return),
            "incumbent_total_return": _stable_float(self.incumbent_total_return),
            "median_null_total_return": _stable_float(self.median_null_total_return),
            "p95_null_total_return": _stable_float(self.p95_null_total_return),
            "candidate_vs_null_return_delta": _stable_float(
                self.candidate_vs_null_return_delta
            ),
            "candidate_vs_incumbent_return_delta": _stable_float(
                self.candidate_vs_incumbent_return_delta
            ),
            "empirical_p_value": _stable_float(self.empirical_p_value),
            "effective_multiplicity_adjusted_p_value": _stable_float(
                self.effective_multiplicity_adjusted_p_value
            ),
            "required_min_null_model_sample_count": self.required_min_null_model_sample_count,
            "required_max_effective_multiplicity_adjusted_p_value": _stable_float(
                self.required_max_effective_multiplicity_adjusted_p_value
            ),
            "baseline_outperformed": self.baseline_outperformed,
            "negative_control_passed": self.negative_control_passed,
            "placebo_label_test_passed": self.placebo_label_test_passed,
            "label_permutation_test_passed": self.label_permutation_test_passed,
            "feature_permutation_stability_passed": self.feature_permutation_stability_passed,
            "leakage_probe_passed": self.leakage_probe_passed,
            "walk_forward_falsification_passed": self.walk_forward_falsification_passed,
            "adaptive_signal_falsification_passed": self.adaptive_signal_falsification_passed,
            "warnings": list(self.warnings),
            "objective_scorecard_patch": scorecard_patch,
            "null_comparator_patch": null_comparator_patch,
            "resource_scope": "local_replay_rows_and_explicit_negative_control_reference_returns_only",
            "research_ranking_only": True,
            "evidence_collection_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def adaptive_signal_falsification_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_PRIMARY_SOURCES
        ],
        "source_markers": list(ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SOURCE_MARKERS),
        "stress_policy": "adaptive_signal_negative_control_label_permutation_leakage_probe_effective_multiplicity_falsification",
        "stress_components": [
            "null_reference_class_empirical_p_value",
            "effective_multiplicity_adjustment",
            "candidate_vs_null_return_delta",
            "candidate_vs_incumbent_return_delta",
            "negative_control_passed",
            "placebo_label_test_passed",
            "label_permutation_test_passed",
            "feature_permutation_stability_passed",
            "leakage_probe_passed",
            "walk_forward_falsification_passed",
        ],
        "output_scope": "research_evidence_collection_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "evidence_collection_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_adaptive_specification_search_as_profit_proof": True,
            "rejects_in_sample_factor_generation_without_falsification": True,
            "rejects_falsification_artifact_as_authoritative_pnl": True,
        },
    }


def build_adaptive_signal_falsification_stress_schema_hash() -> str:
    return _stable_hash(adaptive_signal_falsification_stress_contract())


def extract_adaptive_signal_falsification_stress(
    candidate_records: Sequence[Any],
    *,
    null_model_record_sets: Sequence[Sequence[Any]],
    incumbent_records: Sequence[Any] = (),
    candidate_id: str = "adaptive-signal-candidate",
    artifact_ref: str | None = None,
    return_fields: Sequence[str] = _RETURN_FIELDS,
    min_null_model_sample_count: int = 30,
    max_effective_multiplicity_adjusted_p_value: float = 0.05,
    effective_test_count: int | None = None,
    leakage_probe_passed: bool = False,
) -> AdaptiveSignalFalsificationStressSummary:
    """Build a deterministic, research-only adaptive-signal falsification artifact.

    ``null_model_record_sets`` must contain explicit negative-control, placebo-label,
    or label/feature permutation returns.  The function does not synthesize returns
    or fills; if the reference class or leakage probe is missing, the artifact fails
    closed and only provides blockers/evidence-collection fields.
    """

    candidate_returns = _return_series(candidate_records, return_fields=return_fields)
    incumbent_returns = _return_series(incumbent_records, return_fields=return_fields)
    null_totals = tuple(
        _total_return(_return_series(rows, return_fields=return_fields))
        for rows in null_model_record_sets
    )
    candidate_total = _total_return(candidate_returns)
    incumbent_total = _total_return(incumbent_returns)
    null_count = len(null_totals)
    warnings: list[str] = []
    if not candidate_returns:
        warnings.append("candidate_returns_missing")
    if null_count < min_null_model_sample_count:
        warnings.append("null_model_sample_count_below_min")
    if not leakage_probe_passed:
        warnings.append("leakage_probe_missing_or_failed")
    if len(candidate_returns) < _MIN_WALK_FORWARD_SAMPLE_COUNT:
        warnings.append("walk_forward_sample_count_below_min")
    if not incumbent_returns:
        warnings.append("incumbent_returns_missing_zero_baseline_used")

    median_null_total = float(median(null_totals)) if null_totals else 0.0
    p95_null_total = _upper_quantile(null_totals, default=median_null_total)
    empirical_p_value = _empirical_p_value(
        candidate_total=candidate_total,
        null_totals=null_totals,
    )
    resolved_effective_test_count = int(
        max(effective_test_count or max(null_count, 1), 1)
    )
    adjusted_p_value = min(1.0, empirical_p_value * resolved_effective_test_count)
    candidate_vs_null_delta = candidate_total - median_null_total
    candidate_vs_incumbent_delta = candidate_total - incumbent_total
    baseline_outperformed = (
        candidate_vs_null_delta > 0.0 and candidate_vs_incumbent_delta >= 0.0
    )
    negative_control_passed = (
        null_count >= min_null_model_sample_count
        and candidate_vs_null_delta > 0.0
        and adjusted_p_value <= max_effective_multiplicity_adjusted_p_value
    )
    placebo_label_test_passed = (
        negative_control_passed and candidate_total > p95_null_total
    )
    label_permutation_test_passed = negative_control_passed
    feature_permutation_stability_passed = placebo_label_test_passed
    walk_forward_falsification_passed = (
        len(candidate_returns) >= _MIN_WALK_FORWARD_SAMPLE_COUNT
        and candidate_vs_null_delta > 0.0
        and candidate_vs_incumbent_delta >= 0.0
    )
    passed = all(
        (
            baseline_outperformed,
            negative_control_passed,
            placebo_label_test_passed,
            label_permutation_test_passed,
            feature_permutation_stability_passed,
            leakage_probe_passed,
            walk_forward_falsification_passed,
        )
    )
    if not passed:
        warnings.append("adaptive_signal_falsification_failed_or_incomplete")

    resolved_artifact_ref = artifact_ref or _artifact_ref(
        {
            "candidate_id": candidate_id,
            "candidate_total_return": candidate_total,
            "null_totals": null_totals,
            "incumbent_total_return": incumbent_total,
            "effective_test_count": resolved_effective_test_count,
        }
    )
    return AdaptiveSignalFalsificationStressSummary(
        candidate_id=str(candidate_id),
        artifact_ref=resolved_artifact_ref,
        candidate_sample_count=len(candidate_returns),
        incumbent_sample_count=len(incumbent_returns),
        null_model_sample_count=null_count,
        effective_test_count=resolved_effective_test_count,
        required_min_null_model_sample_count=int(min_null_model_sample_count),
        required_max_effective_multiplicity_adjusted_p_value=float(
            max_effective_multiplicity_adjusted_p_value
        ),
        candidate_total_return=candidate_total,
        incumbent_total_return=incumbent_total,
        median_null_total_return=median_null_total,
        p95_null_total_return=p95_null_total,
        candidate_vs_null_return_delta=candidate_vs_null_delta,
        candidate_vs_incumbent_return_delta=candidate_vs_incumbent_delta,
        empirical_p_value=empirical_p_value,
        effective_multiplicity_adjusted_p_value=adjusted_p_value,
        baseline_outperformed=baseline_outperformed,
        negative_control_passed=negative_control_passed,
        placebo_label_test_passed=placebo_label_test_passed,
        label_permutation_test_passed=label_permutation_test_passed,
        feature_permutation_stability_passed=feature_permutation_stability_passed,
        leakage_probe_passed=bool(leakage_probe_passed),
        walk_forward_falsification_passed=walk_forward_falsification_passed,
        adaptive_signal_falsification_passed=passed,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_adaptive_signal_falsification_stress_schema_hash(),
    )


def _return_series(
    records: Sequence[Any], *, return_fields: Sequence[str]
) -> tuple[float, ...]:
    values: list[float] = []
    for record in records:
        value = _return_value(record, return_fields=return_fields)
        if value is not None:
            values.append(value)
    return tuple(values)


def _return_value(record: Any, *, return_fields: Sequence[str]) -> float | None:
    if isinstance(record, int | float | Decimal):
        return _finite_float(record)
    payload: Mapping[str, Any]
    if isinstance(record, SignalEnvelope):
        payload = record.payload
    elif isinstance(record, Mapping):
        payload = cast(Mapping[str, Any], record)
    else:
        return None
    for field in return_fields:
        if field not in payload:
            continue
        value = _finite_float(payload.get(field))
        if value is not None:
            return value
    nested_payload = payload.get("payload")
    if isinstance(nested_payload, Mapping):
        return _return_value(nested_payload, return_fields=return_fields)
    return None


def _finite_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        resolved = float(Decimal(str(value)))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return resolved if isfinite(resolved) else None


def _total_return(values: Sequence[float]) -> float:
    return float(sum(values))


def _upper_quantile(values: Sequence[float], *, default: float) -> float:
    if not values:
        return default
    if len(values) < 2:
        return float(values[0])
    try:
        return float(quantiles(values, n=20, method="inclusive")[-1])
    except (ValueError, TypeError):
        return default


def _empirical_p_value(
    *, candidate_total: float, null_totals: Sequence[float]
) -> float:
    if not null_totals:
        return 1.0
    exceed_count = sum(1 for value in null_totals if value >= candidate_total)
    return float((exceed_count + 1.0) / (len(null_totals) + 1.0))


def _stable_float(value: float) -> float:
    return float(f"{float(value):.12g}")


def _stable_hash(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _artifact_ref(payload: object) -> str:
    return f"artifact://adaptive-signal-falsification/{_stable_hash(payload)[:24]}"


__all__ = [
    "ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_PRIMARY_SOURCES",
    "ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SCHEMA_VERSION",
    "ADAPTIVE_SIGNAL_FALSIFICATION_STRESS_SOURCE_MARKERS",
    "AdaptiveSignalFalsificationStressSummary",
    "adaptive_signal_falsification_stress_contract",
    "build_adaptive_signal_falsification_stress_schema_hash",
    "extract_adaptive_signal_falsification_stress",
]

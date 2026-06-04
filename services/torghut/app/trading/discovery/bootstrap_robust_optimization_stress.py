"""Preview-only bootstrap robust optimization stress for replay ranking.

This module actualizes recent 2025-2026 robustness and falsification papers
into deterministic, executable replay-ranking inputs.  It never rewrites PnL,
creates synthetic profit evidence, authorizes promotion, or enables live
capital; exact replay, route TCA, order lifecycle evidence, and runtime-ledger
proof remain mandatory.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log1p, sqrt
from statistics import median
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.models import SignalEnvelope

BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_SCHEMA_VERSION = (
    "torghut.bootstrap-robust-optimization-stress.v1"
)
BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.bootstrap-robust-optimization-stress-contract.v1"
)
BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_PROOF_SEMANTICS_LABEL = (
    "bootstrap_robust_optimization_stress_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2510.12725",
        "url": "https://arxiv.org/abs/2510.12725",
        "title": "(Non-Parametric) Bootstrap Robust Optimization for Portfolios and Trading Strategies",
        "date": "2025-10-14",
        "mechanism": "nonparametric_resampling_confidence_intervals_percentile_utility_selection_bias_stress",
    },
    {
        "source_id": "arxiv-2604.15531",
        "url": "https://arxiv.org/abs/2604.15531",
        "title": "Spurious Predictability in Financial Machine Learning",
        "date": "2026-04-16",
        "mechanism": "adaptive_specification_search_falsification_effective_multiplicity_and_walk_forward_inflation_gap_stress",
    },
)

_POST_COST_UTILITY_BPS_FIELDS = (
    "post_cost_utility_bps",
    "post_cost_return_bps",
    "post_cost_net_pnl_bps",
    "net_pnl_bps",
    "realized_net_bps",
    "cost_stressed_net_expectancy_bps",
)
_FOLD_FIELDS = (
    "walk_forward_fold_id",
    "walk_forward_fold",
    "oos_fold_id",
    "validation_fold",
    "fold_id",
    "test_fold_id",
    "sliding_window_id",
)
_PARAMETER_SET_FIELDS = (
    "parameter_set_id",
    "strategy_params_hash",
    "candidate_variant_id",
    "hyperparameter_id",
    "parameter_hash",
    "optimization_trial_id",
)
_TRIAL_COUNT_FIELDS = (
    "effective_trial_count",
    "candidate_search_count",
    "tested_candidate_count",
    "optimization_trial_count",
    "parameter_sweep_count",
)
_SELECTION_RANK_FIELDS = (
    "selection_rank",
    "optimized_rank",
    "candidate_rank",
    "search_rank",
)


@dataclass(frozen=True)
class BootstrapRobustOptimizationStressSummary:
    row_count: int
    utility_observation_count: int
    fold_observation_count: int
    distinct_walk_forward_fold_count: int
    parameter_set_observation_count: int
    distinct_parameter_set_count: int
    effective_trial_count: int
    median_post_cost_utility_bps: float
    lower_percentile_post_cost_utility_bps: float
    stationary_block_bootstrap_utility_p20_bps: float
    robust_utility_for_ranking_bps: float
    downside_tail_bps: float
    parameter_instability_score: float
    walk_forward_coverage_score: float
    selection_bias_stress_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_bootstrap_robust_optimization_stress_ranking",
            "source_papers": [
                dict(item)
                for item in BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "utility_observation_count": self.utility_observation_count,
            "fold_observation_count": self.fold_observation_count,
            "distinct_walk_forward_fold_count": self.distinct_walk_forward_fold_count,
            "parameter_set_observation_count": self.parameter_set_observation_count,
            "distinct_parameter_set_count": self.distinct_parameter_set_count,
            "effective_trial_count": self.effective_trial_count,
            "median_post_cost_utility_bps": _stable_float(
                self.median_post_cost_utility_bps
            ),
            "lower_percentile_post_cost_utility_bps": _stable_float(
                self.lower_percentile_post_cost_utility_bps
            ),
            "stationary_block_bootstrap_utility_p20_bps": _stable_float(
                self.stationary_block_bootstrap_utility_p20_bps
            ),
            "robust_utility_for_ranking_bps": _stable_float(
                self.robust_utility_for_ranking_bps
            ),
            "downside_tail_bps": _stable_float(self.downside_tail_bps),
            "parameter_instability_score": _stable_float(
                self.parameter_instability_score
            ),
            "walk_forward_coverage_score": _stable_float(
                self.walk_forward_coverage_score
            ),
            "selection_bias_stress_score": _stable_float(
                self.selection_bias_stress_score
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "stationary_block_bootstrap_utility_p20_bps": _stable_float(
                    self.stationary_block_bootstrap_utility_p20_bps
                ),
                "robust_utility_for_ranking_bps": _stable_float(
                    self.robust_utility_for_ranking_bps
                ),
                "downside_tail_bps": _stable_float(self.downside_tail_bps),
                "parameter_instability_score": _stable_float(
                    self.parameter_instability_score
                ),
                "walk_forward_coverage_score": _stable_float(
                    self.walk_forward_coverage_score
                ),
                "selection_bias_stress_score": _stable_float(
                    self.selection_bias_stress_score
                ),
                "effective_trial_count": self.effective_trial_count,
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "stationary_block_bootstrap_preview": True,
            "utility_percentile_optimization_preview": True,
            "selection_bias_falsification_preview": True,
            "parameter_instability_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def bootstrap_robust_optimization_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "stationary_block_bootstrap_percentile_utility_and_selection_bias_replay_ranking",
        "stress_components": [
            "stationary_block_bootstrap_utility_p20_bps",
            "robust_utility_for_ranking_bps",
            "downside_tail_bps",
            "parameter_instability_score",
            "walk_forward_coverage_score",
            "selection_bias_stress_score",
        ],
        "post_cost_utility_fields": list(_POST_COST_UTILITY_BPS_FIELDS),
        "fold_fields": list(_FOLD_FIELDS),
        "parameter_set_fields": list(_PARAMETER_SET_FIELDS),
        "trial_count_fields": list(_TRIAL_COUNT_FIELDS),
        "selection_rank_fields": list(_SELECTION_RANK_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_bootstrap_percentile_utility_as_pnl_proof": True,
            "rejects_selection_bias_falsification_preview_as_promotion_authority": True,
            "rejects_synthetic_reference_class_as_runtime_ledger_authority": True,
        },
        "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
    }


def build_bootstrap_robust_optimization_stress_schema_hash() -> str:
    return _stable_hash(bootstrap_robust_optimization_stress_contract())


def extract_bootstrap_robust_optimization_stress(
    records: Sequence[SignalEnvelope | Mapping[str, Any]],
    *,
    post_cost_utilities_bps: Sequence[float] | NDArray[np.float64] | None = None,
    candidate_count: int | None = None,
) -> BootstrapRobustOptimizationStressSummary:
    rows = tuple(records)
    payloads = tuple(_payload(record) for record in rows)
    utilities = _utility_array(payloads, override=post_cost_utilities_bps)
    folds = _observed_labels(payloads, _FOLD_FIELDS)
    parameter_sets = _observed_labels(payloads, _PARAMETER_SET_FIELDS)
    effective_trial_count = _effective_trial_count(
        payloads,
        parameter_set_count=len(set(parameter_sets)),
        candidate_count=candidate_count,
    )
    warnings: list[str] = []
    if utilities.size == 0:
        warnings.append("missing_post_cost_utility_inputs")
    if not folds:
        warnings.append("missing_walk_forward_fold_inputs")
    if len(set(folds)) < 2:
        warnings.append("insufficient_distinct_walk_forward_folds")
    if not parameter_sets:
        warnings.append("missing_parameter_set_inputs")
    if effective_trial_count <= 1:
        warnings.append("missing_effective_trial_count_inputs")

    median_utility = _percentile(utilities, 50.0)
    lower_percentile = _percentile(utilities, 20.0 if utilities.size >= 5 else 10.0)
    stationary_bootstrap = _stationary_block_bootstrap_p20(utilities)
    downside_tail = max(0.0, median_utility - _percentile(utilities, 10.0))
    parameter_instability = _parameter_instability_score(payloads, utilities)
    walk_forward_coverage = min(1.0, len(set(folds)) / 3.0) if folds else 0.0
    selection_bias = _selection_bias_stress_score(
        payloads,
        effective_trial_count=effective_trial_count,
        robust_utility=min(lower_percentile, stationary_bootstrap),
    )
    missing_input_penalty = 0.0
    if utilities.size == 0:
        missing_input_penalty += 12.0
    if not folds:
        missing_input_penalty += 6.0
    if not parameter_sets:
        missing_input_penalty += 3.0
    if effective_trial_count <= 1:
        missing_input_penalty += 3.0
    robust_utility_for_ranking = min(lower_percentile, stationary_bootstrap) - (
        downside_tail * 0.15 + parameter_instability * 4.0 + selection_bias * 5.0
    )
    replay_rank_penalty = min(
        250.0,
        missing_input_penalty
        + downside_tail * 0.20
        + parameter_instability * 8.0
        + selection_bias * 10.0
        + (1.0 - walk_forward_coverage) * 4.0,
    )

    return BootstrapRobustOptimizationStressSummary(
        row_count=len(rows),
        utility_observation_count=int(utilities.size),
        fold_observation_count=len(folds),
        distinct_walk_forward_fold_count=len(set(folds)),
        parameter_set_observation_count=len(parameter_sets),
        distinct_parameter_set_count=len(set(parameter_sets)),
        effective_trial_count=effective_trial_count,
        median_post_cost_utility_bps=median_utility,
        lower_percentile_post_cost_utility_bps=lower_percentile,
        stationary_block_bootstrap_utility_p20_bps=stationary_bootstrap,
        robust_utility_for_ranking_bps=robust_utility_for_ranking,
        downside_tail_bps=downside_tail,
        parameter_instability_score=parameter_instability,
        walk_forward_coverage_score=walk_forward_coverage,
        selection_bias_stress_score=selection_bias,
        replay_rank_penalty_bps=replay_rank_penalty,
        warnings=tuple(sorted(set(warnings))),
        feature_schema_hash=build_bootstrap_robust_optimization_stress_schema_hash(),
    )


def _payload(record: SignalEnvelope | Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(record, SignalEnvelope):
        return record.payload
    return record


def _utility_array(
    payloads: Sequence[Mapping[str, Any]],
    *,
    override: Sequence[float] | NDArray[np.float64] | None,
) -> NDArray[np.float64]:
    if override is not None:
        return np.asarray(
            [
                _stable_float(value)
                for value in override
                if isfinite(_stable_float(value))
            ],
            dtype=np.float64,
        )
    values: list[float] = []
    for payload in payloads:
        value = _first_float(payload, _POST_COST_UTILITY_BPS_FIELDS)
        if value is not None:
            values.append(value)
    return np.asarray(values, dtype=np.float64)


def _observed_labels(
    payloads: Sequence[Mapping[str, Any]], fields: Sequence[str]
) -> tuple[str, ...]:
    labels: list[str] = []
    for payload in payloads:
        for field in fields:
            value = payload.get(field)
            if value is None:
                continue
            label = str(value).strip()
            if label:
                labels.append(label)
                break
    return tuple(labels)


def _effective_trial_count(
    payloads: Sequence[Mapping[str, Any]],
    *,
    parameter_set_count: int,
    candidate_count: int | None,
) -> int:
    counts = [max(1, parameter_set_count)]
    if candidate_count is not None:
        counts.append(max(1, int(candidate_count)))
    for payload in payloads:
        value = _first_float(payload, _TRIAL_COUNT_FIELDS)
        if value is not None:
            counts.append(max(1, int(value)))
    return max(counts) if counts else 1


def _selection_bias_stress_score(
    payloads: Sequence[Mapping[str, Any]],
    *,
    effective_trial_count: int,
    robust_utility: float,
) -> float:
    multiplicity = min(1.0, log1p(max(0, effective_trial_count - 1)) / log1p(100.0))
    ranks = [
        value
        for payload in payloads
        if (value := _first_float(payload, _SELECTION_RANK_FIELDS)) is not None
    ]
    selected_top_rank = min(ranks) <= 3 if ranks else False
    weak_utility = robust_utility <= 0.0
    top_rank_bonus = 0.20 if selected_top_rank else 0.0
    weak_bonus = 0.25 if weak_utility else 0.0
    return min(1.0, multiplicity * 0.65 + top_rank_bonus + weak_bonus)


def _parameter_instability_score(
    payloads: Sequence[Mapping[str, Any]], utilities: NDArray[np.float64]
) -> float:
    if utilities.size == 0:
        return 1.0
    labels = _observed_labels(payloads, _PARAMETER_SET_FIELDS)
    if not labels:
        return 0.75
    grouped: dict[str, list[float]] = {}
    for index, value in enumerate(utilities):
        if index >= len(payloads):
            break
        label = _first_label(payloads[index], _PARAMETER_SET_FIELDS)
        if not label:
            continue
        grouped.setdefault(label, []).append(float(value))
    if len(grouped) < 2:
        return 0.25
    means = [sum(values) / len(values) for values in grouped.values() if values]
    if len(means) < 2:
        return 0.25
    spread = max(means) - min(means)
    scale = max(1.0, abs(median(means)))
    return min(1.0, max(0.0, spread / (scale * 4.0)))


def _stationary_block_bootstrap_p20(values: NDArray[np.float64]) -> float:
    if values.size == 0:
        return 0.0
    if values.size == 1:
        return float(values[0])
    sample_count = int(values.size)
    block_length = max(1, int(round(sqrt(sample_count))))
    replicate_means: list[float] = []
    for start in range(sample_count):
        sample = [
            float(values[(start + offset) % sample_count])
            for offset in range(block_length)
        ]
        replicate_means.append(sum(sample) / len(sample))
    return _percentile(np.asarray(replicate_means, dtype=np.float64), 20.0)


def _percentile(values: NDArray[np.float64], percentile: float) -> float:
    if values.size == 0:
        return 0.0
    return float(np.percentile(values, percentile))


def _first_float(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = _float_or_none(payload.get(field))
        if value is not None:
            return value
    return None


def _first_label(payload: Mapping[str, Any], fields: Sequence[str]) -> str | None:
    for field in fields:
        value = payload.get(field)
        if value is None:
            continue
        label = str(value).strip()
        if label:
            return label
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        resolved = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(resolved):
        return None
    return resolved


def _stable_float(value: Any) -> float:
    try:
        resolved = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not isfinite(resolved):
        return 0.0
    return round(resolved, 8)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        return {
            str(key): _json_ready(item)
            for key, item in sorted(mapping.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    if isinstance(value, float):
        return _stable_float(value)
    return value


__all__ = [
    "BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_PRIMARY_SOURCES",
    "BOOTSTRAP_ROBUST_OPTIMIZATION_STRESS_SCHEMA_VERSION",
    "BootstrapRobustOptimizationStressSummary",
    "bootstrap_robust_optimization_stress_contract",
    "build_bootstrap_robust_optimization_stress_schema_hash",
    "extract_bootstrap_robust_optimization_stress",
]

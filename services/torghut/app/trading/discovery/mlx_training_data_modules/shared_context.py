# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Training-row and ranker helpers for the MLX autoresearch proposal model."""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.capital_budget import estimate_capital_budget
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)

# ruff: noqa: F401


MLX_RANKER_SCHEMA_VERSION = "torghut.mlx-ranker.v7"

_MECHANISM_OVERLAY_IDS = (
    "cluster_lob_event_clustering",
    "mixed_market_limit_execution_policy",
    "queue_position_survival_fill_curve",
    "mpc_dynamic_execution_schedule",
    "alpha_decay_predictability_stress",
    "friction_aware_regime_conditioned_policy",
    "adaptive_factor_to_execution_loop",
    "regime_weighted_conformal_cost_buffer",
    "risk_aware_trading_portfolio_optimization",
    "double_selection_factor_screen",
    "bootstrap_robust_optimization_stability",
    "crumbling_quote_liquidity_erosion",
    "nonlinear_market_impact_tca",
    "simulation_reality_gap_implementation_risk",
    "implementation_risk_backtest_stability",
    "replay_paper_live_semantic_parity",
    "intraday_volume_periodicity_execution",
    "macro_announcement_dvar_momentum",
    "ofi_lob_continuation_response",
    "order_flow_filtration_parent_trade_obi",
    "rejected_signal_outcome_calibration",
    "delay_adjusted_depth_stress",
    "ohlcv_only_falsification",
)

_MECHANISM_OVERLAY_FEATURE_NAMES = tuple(
    f"paper_overlay_{overlay_id}" for overlay_id in _MECHANISM_OVERLAY_IDS
)

_PAPER_CONTRACT_FEATURE_NAMES = (
    "paper_source_claim_count",
    "paper_signal_claim_count",
    "paper_execution_claim_count",
    "paper_validation_claim_count",
    "paper_risk_claim_count",
    "paper_avg_claim_confidence",
    "paper_source_data_requirement_count",
    "paper_validation_requirement_count",
    "paper_validation_data_requirement_count",
    "paper_mechanism_overlay_count",
    "paper_mechanism_required_evidence_count",
    "paper_requires_route_tca",
    "paper_requires_live_paper_parity",
    "paper_requires_lob_event_stream",
    "paper_requires_fill_outcomes",
    "paper_requires_execution_shortfall",
    "paper_requires_implementation_uncertainty",
    "paper_requires_rejected_signal_labels",
    "paper_requires_executable_quote",
    "paper_requires_conformal_tail_risk",
    "paper_requires_regime_tail_exceedance",
    "paper_requires_breakeven_cost_buffer",
    "paper_requires_seed_model_family_robustness",
    "paper_requires_regime_conditioning",
    "paper_requires_trade_space_trust_region",
    "paper_requires_turnover_budget",
    "paper_requires_cost_misspecification_stress",
    "paper_requires_liquidity_proxy_cost_calibration",
    "paper_requires_scenario_level_inference",
    "paper_requires_adaptive_factor_screener",
    "paper_requires_continuous_factor_mining",
    "paper_requires_risk_constrained_execution_loop",
    "paper_requires_portfolio_replay",
    "paper_requires_market_risk_var",
    "paper_requires_market_sensitivity_constraints",
    "paper_requires_capital_charge_stress",
    "paper_requires_risk_limit_compliance",
    "paper_requires_factor_rank_panel",
    "paper_requires_train_holdout_split",
    "paper_requires_multiple_testing_controls",
    "paper_requires_bootstrap_confidence_interval",
    "paper_requires_utility_percentile_optimization",
    "paper_requires_selection_bias_stress",
    "paper_requires_parameter_instability_stress",
    "paper_requires_crumbling_quote_probability",
    "paper_requires_mechanical_liquidity_erosion",
    "paper_promotion_requires_count",
    "paper_promotion_rejects_count",
)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _format_float(value: float) -> str:
    return format(value, ".12g")


class _TorchArrayBackend:
    float32: Any

    def __init__(self, torch_module: Any, *, device: str) -> None:
        self._torch = torch_module
        self._device = device
        self.float32 = torch_module.float32

    def array(self, value: Any, *, dtype: Any | None = None) -> Any:
        return self._torch.tensor(value, dtype=dtype, device=self._device)

    def zeros(self, shape: Any, *, dtype: Any | None = None) -> Any:
        return self._torch.zeros(shape, dtype=dtype, device=self._device)


def _import_torch_array_backend(preference: str) -> tuple[str, Any] | None:
    try:
        torch_module = importlib.import_module("torch")
    except ModuleNotFoundError:
        return None
    cuda = getattr(torch_module, "cuda", None)
    cuda_available_fn = getattr(cuda, "is_available", None)
    cuda_available = bool(callable(cuda_available_fn) and cuda_available_fn())
    if preference in {"cuda", "torch-cuda"}:
        if not cuda_available:
            return None
        return "torch-cuda", _TorchArrayBackend(torch_module, device="cuda")
    if preference == "torch":
        device = "cuda" if cuda_available else "cpu"
        backend = "torch-cuda" if cuda_available else "torch"
        return backend, _TorchArrayBackend(torch_module, device=device)
    return None


def _import_array_backend(preference: str) -> tuple[str, Any]:
    normalized = preference.strip().lower()
    if normalized in {"numpy", "numpy-fallback"}:
        import numpy as np

        return "numpy-fallback", np
    if normalized in {"cuda", "torch", "torch-cuda"}:
        torch_backend = _import_torch_array_backend(normalized)
        if torch_backend is not None:
            return torch_backend
        import numpy as np

        return "numpy-fallback", np
    if normalized == "mlx":
        try:
            import mlx.core as mx  # type: ignore[import-not-found]

            return "mlx", mx
        except ModuleNotFoundError:
            import numpy as np

            return "numpy-fallback", np
    try:
        import mlx.core as mx  # type: ignore[import-not-found]

        return "mlx", mx
    except ModuleNotFoundError:
        import numpy as np

        return "numpy-fallback", np


@dataclass(frozen=True)
class MlxTrainingRow:
    candidate_spec_id: str
    feature_names: tuple[str, ...]
    feature_values: tuple[float, ...]
    target: float

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_spec_id": self.candidate_spec_id,
            "features": dict(zip(self.feature_names, self.feature_values, strict=True)),
            "target": self.target,
        }


@dataclass(frozen=True)
class MlxRankerModel:
    schema_version: str
    model_id: str
    backend: str
    feature_names: tuple[str, ...]
    feature_means: tuple[float, ...]
    feature_scales: tuple[float, ...]
    target_mean: float
    target_scale: float
    weights: tuple[float, ...]
    bias: float
    row_count: int
    training_loss: float
    trained_at: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "model_id": self.model_id,
            "backend": self.backend,
            "feature_names": list(self.feature_names),
            "feature_means": list(self.feature_means),
            "feature_scales": list(self.feature_scales),
            "target_mean": self.target_mean,
            "target_scale": self.target_scale,
            "weights": list(self.weights),
            "bias": self.bias,
            "row_count": self.row_count,
            "training_loss": self.training_loss,
            "trained_at": self.trained_at,
        }


@dataclass(frozen=True)
class MlxRankedCandidate:
    candidate_spec_id: str
    score: float
    rank: int
    model_id: str
    backend: str
    feature_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_spec_id": self.candidate_spec_id,
            "score": self.score,
            "rank": self.rank,
            "model_id": self.model_id,
            "backend": self.backend,
            "feature_hash": self.feature_hash,
        }


@dataclass(frozen=True)
class MlxRankBucketLift:
    metric_name: str
    top_bucket_mean: float
    bottom_bucket_mean: float
    lift: float
    status: str = "computed"

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            f"top_bucket_mean_{self.metric_name}": _format_float(self.top_bucket_mean),
            f"bottom_bucket_mean_{self.metric_name}": _format_float(
                self.bottom_bucket_mean
            ),
            f"lift_{self.metric_name}": _format_float(self.lift),
        }


@dataclass(frozen=True)
class MlxRankedRowsPolicyResult:
    ranked_rows: tuple[MlxRankedCandidate, ...]
    rank_bucket_lift: MlxRankBucketLift
    model_status: str
    selection_reason: str


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _mapping_sequence(value: Any) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    return tuple(
        cast(Mapping[str, Any], item)
        for item in cast(Sequence[Any], value)
        if isinstance(item, Mapping)
    )


def _positive_or_default(value: float, default: float) -> float:
    return value if value > 0.0 else default


def _sequence_length(value: Any) -> float:
    if isinstance(value, Sequence) and not isinstance(value, str):
        return float(len(cast(Sequence[Any], value)))
    return 0.0


def _params(spec: CandidateSpec) -> Mapping[str, Any]:
    overrides = _mapping(spec.strategy_overrides)
    return _mapping(overrides.get("params"))


def _strategy_universe_size(spec: CandidateSpec) -> float:
    overrides = _mapping(spec.strategy_overrides)
    return _sequence_length(overrides.get("universe_symbols"))


def _bool_feature(value: Any, expected: str) -> float:
    return 1.0 if str(value or "").strip().lower() == expected else 0.0


def _truthy_feature(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    normalized = str(value or "").strip().lower()
    return 1.0 if normalized in {"1", "true", "yes", "pass", "passed"} else 0.0


def _artifact_present(
    scorecard: Mapping[str, Any], *, singular: str, plural: str
) -> float:
    if str(scorecard.get(singular) or "").strip():
        return 1.0
    return 1.0 if _sequence_length(scorecard.get(plural)) > 0.0 else 0.0


def _hard_veto_count(scorecard: Mapping[str, Any]) -> float:
    raw_vetoes = scorecard.get("hard_vetoes") or scorecard.get("veto_reasons")
    if isinstance(raw_vetoes, str):
        return 1.0 if raw_vetoes.strip() else 0.0
    return _sequence_length(raw_vetoes)


def _daily_target_shortfall(
    scorecard: Mapping[str, Any], *, target_net_pnl_per_day: float
) -> float:
    raw_daily = scorecard.get("daily_net")
    if not isinstance(raw_daily, Mapping):
        return max(
            0.0, target_net_pnl_per_day - _float(scorecard.get("net_pnl_per_day"))
        )
    shortfalls = [
        max(0.0, target_net_pnl_per_day - _float(value))
        for value in cast(Mapping[Any, Any], raw_daily).values()
    ]
    return _mean(shortfalls)


def _sequence_strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    return tuple(
        str(item).strip() for item in cast(Sequence[Any], value) if str(item).strip()
    )


def _strings(value: Any) -> tuple[str, ...]:
    if isinstance(value, (str, bytes, bytearray)):
        normalized = str(value).strip()
        return (normalized,) if normalized else ()
    if isinstance(value, Sequence):
        return tuple(
            str(item).strip()
            for item in cast(Sequence[Any], value)
            if str(item).strip()
        )
    return ()


def _unique_string_count(items: Sequence[Mapping[str, Any]], key: str) -> float:
    values: set[str] = set()
    for item in items:
        values.update(_strings(item.get(key)))
    return float(len(values))


def _unique_strings(items: Sequence[Mapping[str, Any]], key: str) -> set[str]:
    values: set[str] = set()
    for mapping_item in items:
        values.update(value.lower() for value in _strings(mapping_item.get(key)))
    return values


def _claim_type_count(
    claims: Sequence[Mapping[str, Any]], claim_types: set[str]
) -> float:
    return float(
        sum(
            1
            for item in claims
            if str(item.get("claim_type") or "").strip().lower() in claim_types
        )
    )


def _average_claim_confidence(claims: Sequence[Mapping[str, Any]]) -> float:
    values = [
        _float(item.get("confidence"))
        for item in claims
        if _float(item.get("confidence")) > 0.0
    ]
    return _mean(values)


def _truthy_contract_key_count(contract: Mapping[str, Any], prefix: str) -> float:
    return float(
        sum(
            1
            for key, value in contract.items()
            if str(key).startswith(prefix) and _truthy_feature(value) > 0.0
        )
    )


def _requirement_present(requirements: set[str], tokens: Sequence[str]) -> float:
    return 1.0 if any(token in requirements for token in tokens) else 0.0


def _mechanism_overlay_ids(spec: CandidateSpec) -> set[str]:
    overlay_ids = set(_strings(spec.parameter_space.get("mechanism_overlay_ids")))
    for contract in _mapping_sequence(spec.feature_contract.get("mechanism_overlays")):
        overlay_ids.update(_strings(contract.get("overlay_id")))
    return overlay_ids


# Public aliases used by split-module consumers.
MECHANISM_OVERLAY_FEATURE_NAMES = _MECHANISM_OVERLAY_FEATURE_NAMES
MECHANISM_OVERLAY_IDS = _MECHANISM_OVERLAY_IDS
PAPER_CONTRACT_FEATURE_NAMES = _PAPER_CONTRACT_FEATURE_NAMES
TorchArrayBackend = _TorchArrayBackend
artifact_present = _artifact_present
average_claim_confidence = _average_claim_confidence
bool_feature = _bool_feature
claim_type_count = _claim_type_count
daily_target_shortfall = _daily_target_shortfall
float_value = _float
format_float = _format_float
hard_veto_count = _hard_veto_count
import_array_backend = _import_array_backend
import_torch_array_backend = _import_torch_array_backend
mapping = _mapping
mapping_sequence = _mapping_sequence
mean = _mean
mechanism_overlay_ids = _mechanism_overlay_ids
params = _params
positive_or_default = _positive_or_default
requirement_present = _requirement_present
sequence_length = _sequence_length
sequence_strings = _sequence_strings
stable_hash = _stable_hash
strategy_universe_size = _strategy_universe_size
strings = _strings
truthy_contract_key_count = _truthy_contract_key_count
truthy_feature = _truthy_feature
unique_string_count = _unique_string_count
unique_strings = _unique_strings
__all__ = (
    "MLX_RANKER_SCHEMA_VERSION",
    "MlxTrainingRow",
    "MlxRankerModel",
    "MlxRankedCandidate",
    "MlxRankBucketLift",
    "MlxRankedRowsPolicyResult",
    "MECHANISM_OVERLAY_FEATURE_NAMES",
    "MECHANISM_OVERLAY_IDS",
    "PAPER_CONTRACT_FEATURE_NAMES",
    "TorchArrayBackend",
    "artifact_present",
    "average_claim_confidence",
    "bool_feature",
    "claim_type_count",
    "daily_target_shortfall",
    "float_value",
    "format_float",
    "hard_veto_count",
    "import_array_backend",
    "import_torch_array_backend",
    "mapping",
    "mapping_sequence",
    "mean",
    "mechanism_overlay_ids",
    "params",
    "positive_or_default",
    "requirement_present",
    "sequence_length",
    "sequence_strings",
    "stable_hash",
    "strategy_universe_size",
    "strings",
    "truthy_contract_key_count",
    "truthy_feature",
    "unique_string_count",
    "unique_strings",
)

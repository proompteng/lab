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


def _paper_contract_feature_values(spec: CandidateSpec) -> Mapping[str, float]:
    source_claims = _mapping_sequence(spec.feature_contract.get("source_claims"))
    validation_requirements = _mapping_sequence(
        spec.feature_contract.get("validation_requirements")
    )
    mechanism_overlays = _mapping_sequence(
        spec.feature_contract.get("mechanism_overlays")
    )
    overlay_ids = _mechanism_overlay_ids(spec)
    contract_requirements = (
        _unique_strings(source_claims, "data_requirements")
        | _unique_strings(validation_requirements, "data_requirements")
        | _unique_strings(mechanism_overlays, "required_evidence")
    )
    mechanism_required_evidence_count = _unique_string_count(
        mechanism_overlays, "required_evidence"
    )
    feature_values = {
        "paper_source_claim_count": float(len(source_claims)),
        "paper_signal_claim_count": _claim_type_count(
            source_claims,
            {
                "feature_recipe",
                "signal_mechanism",
                "strategy_mechanism",
                "portfolio_construction",
            },
        ),
        "paper_execution_claim_count": _claim_type_count(
            source_claims, {"execution_assumption"}
        ),
        "paper_validation_claim_count": _claim_type_count(
            source_claims, {"validation_requirement"}
        ),
        "paper_risk_claim_count": _claim_type_count(
            source_claims, {"risk_constraint", "market_regime"}
        ),
        "paper_avg_claim_confidence": _average_claim_confidence(source_claims),
        "paper_source_data_requirement_count": _unique_string_count(
            source_claims, "data_requirements"
        ),
        "paper_validation_requirement_count": float(len(validation_requirements)),
        "paper_validation_data_requirement_count": _unique_string_count(
            validation_requirements, "data_requirements"
        ),
        "paper_mechanism_overlay_count": float(len(overlay_ids)),
        "paper_mechanism_required_evidence_count": mechanism_required_evidence_count,
        "paper_requires_route_tca": _requirement_present(
            contract_requirements, ("route_tca",)
        ),
        "paper_requires_live_paper_parity": _requirement_present(
            contract_requirements, ("live_paper_parity",)
        ),
        "paper_requires_lob_event_stream": _requirement_present(
            contract_requirements,
            ("lob_event_stream", "lob_events", "clustered_order_events"),
        ),
        "paper_requires_fill_outcomes": _requirement_present(
            contract_requirements,
            ("fill_outcomes", "order_lifecycle_fill_evidence"),
        ),
        "paper_requires_execution_shortfall": _requirement_present(
            contract_requirements, ("execution_shortfall",)
        ),
        "paper_requires_implementation_uncertainty": _requirement_present(
            contract_requirements,
            (
                "implementation_uncertainty_interval",
                "implementation_uncertainty_stability",
                "multi_engine_replay",
            ),
        ),
        "paper_requires_rejected_signal_labels": _requirement_present(
            contract_requirements,
            ("rejected_signal_log", "outcome_labels", "counterfactual_return"),
        ),
        "paper_requires_executable_quote": _requirement_present(
            contract_requirements,
            ("executable_quote", "executable_quote_evidence"),
        ),
        "paper_requires_conformal_tail_risk": _requirement_present(
            contract_requirements,
            (
                "conformal_tail_risk",
                "conformal_var",
                "conformal_risk_control",
                "regime_weighted_conformal_var",
            ),
        ),
        "paper_requires_regime_tail_exceedance": _requirement_present(
            contract_requirements,
            (
                "regime_tail_exceedance",
                "tail_exceedance",
                "regime_similarity_weights",
            ),
        ),
        "paper_requires_breakeven_cost_buffer": _requirement_present(
            contract_requirements,
            (
                "breakeven_transaction_cost_buffer",
                "breakeven_cost_buffer",
                "transaction_cost_buffer",
                "cost_buffer",
            ),
        ),
        "paper_requires_seed_model_family_robustness": _requirement_present(
            contract_requirements,
            (
                "seed_robustness",
                "multi_seed_replay",
                "model_family_robustness",
                "seed_model_family_robustness",
            ),
        ),
        "paper_requires_regime_conditioning": _requirement_present(
            contract_requirements,
            (
                "regime_state",
                "regime_conditioned_policy",
                "regime_conditioning",
                "volatility_liquidity_regime",
            ),
        ),
        "paper_requires_trade_space_trust_region": _requirement_present(
            contract_requirements,
            (
                "trade_space_trust_region",
                "inventory_flow_trust_region",
                "kl_trust_region",
            ),
        ),
        "paper_requires_turnover_budget": _requirement_present(
            contract_requirements,
            ("turnover_budget", "turnover_bounds", "inaction_bands"),
        ),
        "paper_requires_cost_misspecification_stress": _requirement_present(
            contract_requirements,
            (
                "cost_misspecification_stress",
                "cost_level_grid",
                "transaction_cost_stress",
            ),
        ),
        "paper_requires_liquidity_proxy_cost_calibration": _requirement_present(
            contract_requirements,
            (
                "liquidity_proxy_cost_calibration",
                "liquidity_proxy",
                "proportional_cost_model",
                "impact_cost_model",
            ),
        ),
        "paper_requires_scenario_level_inference": _requirement_present(
            contract_requirements,
            (
                "scenario_level_inference",
                "multiple_testing_correction",
                "bootstrap_confidence_interval",
            ),
        ),
        "paper_requires_adaptive_factor_screener": _requirement_present(
            contract_requirements,
            (
                "adaptive_factor_screener",
                "regime_adaptive_factor_ensemble",
                "factor_pool_expansion",
            ),
        ),
        "paper_requires_continuous_factor_mining": _requirement_present(
            contract_requirements,
            (
                "continuous_factor_mining",
                "factor_pool_expansion",
                "continuous_candidate_refresh",
            ),
        ),
        "paper_requires_risk_constrained_execution_loop": _requirement_present(
            contract_requirements,
            (
                "risk_constrained_execution",
                "adaptive_factor_to_execution_loop",
                "factor_to_execution_loop",
            ),
        ),
        "paper_requires_portfolio_replay": _requirement_present(
            contract_requirements,
            (
                "portfolio_replay",
                "portfolio_weight_trace",
                "eligible_optimization_strategy",
            ),
        ),
        "paper_requires_market_risk_var": _requirement_present(
            contract_requirements,
            (
                "market_risk_var",
                "portfolio_var",
                "var_forecast_error",
            ),
        ),
        "paper_requires_market_sensitivity_constraints": _requirement_present(
            contract_requirements,
            (
                "market_sensitivity_constraints",
                "market_sensitivities",
                "risk_limit_compliance",
            ),
        ),
        "paper_requires_capital_charge_stress": _requirement_present(
            contract_requirements,
            (
                "capital_charge_stress",
                "capital_charge",
                "economic_capital_stress",
            ),
        ),
        "paper_requires_risk_limit_compliance": _requirement_present(
            contract_requirements,
            (
                "risk_limit_compliance",
                "market_sensitivity_constraints",
                "capital_charge_stress",
            ),
        ),
        "paper_requires_factor_rank_panel": _requirement_present(
            contract_requirements,
            (
                "factor_rank_panel",
                "cross_sectional_ranks",
                "short_term_trading_factors",
            ),
        ),
        "paper_requires_train_holdout_split": _requirement_present(
            contract_requirements,
            (
                "train_holdout_split",
                "walk_forward_replay",
                "out_of_sample_generalization",
            ),
        ),
        "paper_requires_multiple_testing_controls": _requirement_present(
            contract_requirements,
            (
                "multiple_testing_controls",
                "multiple_testing_correction",
                "selection_bias_stress",
            ),
        ),
        "paper_requires_bootstrap_confidence_interval": _requirement_present(
            contract_requirements,
            (
                "bootstrap_confidence_interval",
                "bootstrap_confidence_intervals",
                "resampled_confidence_interval",
            ),
        ),
        "paper_requires_utility_percentile_optimization": _requirement_present(
            contract_requirements,
            (
                "utility_percentile",
                "percentile_based_optimization",
                "utility_percentile_optimization",
            ),
        ),
        "paper_requires_selection_bias_stress": _requirement_present(
            contract_requirements,
            (
                "selection_bias_stress",
                "selection_bias",
                "overfitting_stress",
            ),
        ),
        "paper_requires_parameter_instability_stress": _requirement_present(
            contract_requirements,
            (
                "parameter_instability_stress",
                "parameter_instability",
                "model_misspecification_stress",
            ),
        ),
        "paper_requires_crumbling_quote_probability": _requirement_present(
            contract_requirements,
            (
                "crumbling_quote_probability",
                "quote_crumble_probability",
                "crumbling_quote_calibration",
            ),
        ),
        "paper_requires_mechanical_liquidity_erosion": _requirement_present(
            contract_requirements,
            (
                "mechanical_liquidity_erosion",
                "mechanical_liquidity_withdrawal",
                "liquidity_withdrawal_probability",
            ),
        ),
        "paper_promotion_requires_count": _truthy_contract_key_count(
            spec.promotion_contract, "requires_"
        ),
        "paper_promotion_rejects_count": _truthy_contract_key_count(
            spec.promotion_contract, "rejects_"
        ),
    }
    for overlay_id, feature_name in zip(
        _MECHANISM_OVERLAY_IDS,
        _MECHANISM_OVERLAY_FEATURE_NAMES,
        strict=True,
    ):
        feature_values[feature_name] = 1.0 if overlay_id in overlay_ids else 0.0
    return feature_values


def _capital_rank_count_floor(
    *, strategy_overrides: Mapping[str, Any], params: Mapping[str, Any]
) -> int:
    for key in (
        "max_concurrent_positions",
        "max_pair_legs",
        "top_n",
        "rank_count",
    ):
        if _float(params.get(key)) > 0:
            return 1
    if _float(params.get("max_entries_per_session")) > 0:
        return 1
    return max(1, len(_sequence_strings(strategy_overrides.get("universe_symbols"))))


def candidate_spec_capital_features(spec: CandidateSpec) -> Mapping[str, float]:
    overrides = _mapping(spec.strategy_overrides)
    params = _mapping(overrides.get("params"))
    rank_count_floor = _capital_rank_count_floor(
        strategy_overrides=overrides,
        params=params,
    )
    features = estimate_capital_budget(
        strategy_overrides=overrides,
        params=params,
        rank_count_floor=rank_count_floor,
    ).to_feature_payload()
    features["max_entries_per_session"] = _positive_or_default(
        _float(params.get("max_entries_per_session")),
        1.0,
    )
    entry_notional_multiplier = _positive_or_default(
        _float(features.get("entry_notional_max_multiplier")),
        1.0,
    )
    features["inferred_universe_slot_floor"] = float(rank_count_floor)
    features["configured_daily_notional_capacity"] = (
        _float(features.get("max_notional_per_trade"))
        * features["max_entries_per_session"]
        * entry_notional_multiplier
        * float(rank_count_floor)
    )
    return features


def capital_budget_penalty(features: Mapping[str, float]) -> float:
    return (
        _float(features.get("capital_budget_overage_ratio")) * 125.0
        + max(0.0, _float(features.get("max_position_pct_equity")) - 1.0) * 35.0
        + max(0.0, _float(features.get("max_notional_pct_start_equity")) - 1.0) * 35.0
    )


def configured_daily_notional_capacity_penalty(
    *, configured_daily_notional_required_ratio: float
) -> float:
    if configured_daily_notional_required_ratio <= 0.0:
        return 750.0
    return max(0.0, 1.0 - configured_daily_notional_required_ratio) * 750.0


def observed_capital_penalty(scorecard: Mapping[str, Any]) -> float:
    return (
        max(0.0, _float(scorecard.get("max_gross_exposure_pct_equity")) - 1.0) * 500.0
        + max(0.0, -_float(scorecard.get("min_cash"))) / 100.0
        + _float(scorecard.get("negative_cash_observation_count")) * 20.0
    )


def _observed_replay_viability_penalty(
    scorecard: Mapping[str, Any],
    *,
    required_min_daily_notional: float,
    target_net_pnl_per_day: float,
) -> float:
    if not scorecard:
        return 0.0

    active_day_ratio = _float(scorecard.get("active_day_ratio"))
    positive_day_ratio = _float(scorecard.get("positive_day_ratio"))
    has_filled_notional = "avg_filled_notional_per_day" in scorecard
    avg_filled_notional_per_day = _float(scorecard.get("avg_filled_notional_per_day"))
    net_pnl_per_day = _float(scorecard.get("net_pnl_per_day"))
    no_activity_penalty = (
        500.0
        if active_day_ratio <= 0.0
        and has_filled_notional
        and avg_filled_notional_per_day <= 0.0
        else 0.0
    )
    notional_shortfall_ratio = 0.0
    if required_min_daily_notional > 0.0 and has_filled_notional:
        notional_shortfall_ratio = max(
            0.0,
            (required_min_daily_notional - avg_filled_notional_per_day)
            / required_min_daily_notional,
        )
    elif (
        active_day_ratio <= 0.0
        and has_filled_notional
        and avg_filled_notional_per_day <= 0.0
    ):
        notional_shortfall_ratio = 1.0

    return (
        no_activity_penalty
        + max(0.0, 1.0 - active_day_ratio) * 600.0
        + max(0.0, 1.0 - positive_day_ratio) * 450.0
        + notional_shortfall_ratio * 500.0
        + _float(scorecard.get("negative_day_count")) * 125.0
        + max(0.0, target_net_pnl_per_day - net_pnl_per_day) * 0.20
    )


def _net_pnl_per_100k_filled_notional(scorecard: Mapping[str, Any]) -> float:
    avg_filled_notional_per_day = _float(scorecard.get("avg_filled_notional_per_day"))
    if avg_filled_notional_per_day <= 0.0:
        return 0.0
    return (
        _float(scorecard.get("net_pnl_per_day"))
        / avg_filled_notional_per_day
        * 100_000.0
    )


def _post_cost_efficiency_penalty(scorecard: Mapping[str, Any]) -> float:
    if not scorecard:
        return 0.0
    avg_filled_notional_per_day = _float(scorecard.get("avg_filled_notional_per_day"))
    if avg_filled_notional_per_day <= 0.0:
        return 0.0
    net_pnl_per_day = _float(scorecard.get("net_pnl_per_day"))
    net_pnl_per_100k = _net_pnl_per_100k_filled_notional(scorecard)
    if net_pnl_per_day <= 0.0:
        return min(5_000.0, 250.0 + abs(net_pnl_per_100k) * 2.0)
    return max(0.0, 1.0 - net_pnl_per_100k) * 25.0


def _proof_target_shortfall(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: float,
    keys: Sequence[str],
) -> float:
    observed = [_float(scorecard.get(key)) for key in keys if key in scorecard]
    if not observed:
        return target_net_pnl_per_day if scorecard else 0.0
    return max(0.0, target_net_pnl_per_day - min(observed))


def _deployable_lower_bound_net_pnl_per_day(scorecard: Mapping[str, Any]) -> float:
    value = deployable_lower_bound_net_pnl_per_day(scorecard)
    return float(value) if value is not None else 0.0


def _deployable_lower_bound_missing_count(scorecard: Mapping[str, Any]) -> float:
    return float(deployable_lower_bound_missing_count(scorecard))


def _deployable_lower_bound_failed_gate_count(scorecard: Mapping[str, Any]) -> float:
    return float(deployable_proof_failed_gate_count(scorecard))


def _deployable_lower_bound_target_shortfall(
    scorecard: Mapping[str, Any], *, target_net_pnl_per_day: float
) -> float:
    if not scorecard:
        return 0.0
    return max(
        0.0,
        target_net_pnl_per_day - _deployable_lower_bound_net_pnl_per_day(scorecard),
    )


def _deployable_lower_bound_proof_penalty(scorecard: Mapping[str, Any]) -> float:
    if not scorecard:
        return 0.0
    return (
        _deployable_lower_bound_missing_count(scorecard) * 1_000.0
        + _deployable_lower_bound_failed_gate_count(scorecard) * 1_000.0
    )


def _historical_proof_penalty(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: float,
) -> float:
    if not scorecard:
        return 0.0

    market_impact_shortfall = _proof_target_shortfall(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        keys=("market_impact_stress_net_pnl_per_day",),
    )
    delay_depth_shortfall = _proof_target_shortfall(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        keys=("delay_adjusted_depth_stress_net_pnl_per_day",),
    )
    double_oos_shortfall = _proof_target_shortfall(
        scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        keys=("double_oos_cost_shock_net_pnl_per_day", "double_oos_net_pnl_per_day"),
    )
    delay_fillable_notional = _float(
        scorecard.get("delay_adjusted_depth_fillable_notional_per_day")
    )

    return (
        (1.0 - _truthy_feature(scorecard.get("market_impact_stress_passed"))) * 500.0
        + (
            1.0
            - _artifact_present(
                scorecard,
                singular="market_impact_stress_artifact_ref",
                plural="market_impact_stress_artifact_refs",
            )
        )
        * 250.0
        + (
            1.0
            - _truthy_feature(scorecard.get("market_impact_liquidity_evidence_present"))
        )
        * 250.0
        + market_impact_shortfall * 0.15
        + (1.0 - _truthy_feature(scorecard.get("delay_adjusted_depth_stress_passed")))
        * 500.0
        + (
            1.0
            - _artifact_present(
                scorecard,
                singular="delay_adjusted_depth_stress_artifact_ref",
                plural="delay_adjusted_depth_stress_artifact_refs",
            )
        )
        * 250.0
        + (500.0 if delay_fillable_notional <= 0.0 else 0.0)
        + delay_depth_shortfall * 0.15
        + (1.0 - _truthy_feature(scorecard.get("double_oos_passed"))) * 500.0
        + (
            1.0
            - _artifact_present(
                scorecard,
                singular="double_oos_artifact_ref",
                plural="double_oos_artifact_refs",
            )
        )
        * 250.0
        + max(0.0, 2.0 - _float(scorecard.get("double_oos_independent_window_count")))
        * 250.0
        + max(0.0, 1.0 - _float(scorecard.get("double_oos_pass_rate"))) * 500.0
        + double_oos_shortfall * 0.15
    )


def _format_float(value: float) -> str:
    return format(value, ".12g")


def _family_code(family_template_id: str) -> float:
    families = {
        "breakout_reclaim_v2": 1.0,
        "washout_rebound_v2": 2.0,
        "momentum_pullback_v1": 3.0,
        "mean_reversion_rebound_v1": 4.0,
        "microbar_cross_sectional_pairs_v1": 5.0,
        "microstructure_continuation_matched_filter_v1": 6.0,
        "opening_drive_leader_reclaim_v1": 7.0,
        "intraday_tsmom_v2": 8.0,
        "late_day_continuation_v1": 9.0,
        "end_of_day_reversal_v1": 10.0,
        "mean_reversion_exhaustion_short_v1": 11.0,
    }
    return families.get(family_template_id, 0.0)


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _std(values: Sequence[float], *, mean: float) -> float:
    if len(values) < 2:
        return 1.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    scale = variance**0.5
    return scale if scale > 1e-9 else 1.0


def _scalar_float(value: Any) -> float:
    item_method = getattr(value, "item", None)
    if callable(item_method):
        item_value = cast(Any, item_method())
        return float(item_value)
    return float(value)


def build_mlx_training_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[MlxTrainingRow]:
    evidence_by_spec = {item.candidate_spec_id: item for item in evidence_bundles}
    rows: list[MlxTrainingRow] = []
    for spec in candidate_specs:
        evidence = evidence_by_spec.get(spec.candidate_spec_id)
        scorecard: Mapping[str, Any] = (
            evidence.objective_scorecard if evidence is not None else {}
        )
        feature_names = (
            "family_code",
            "required_feature_count",
            "failure_mode_count",
            "target_net_pnl_per_day",
            "required_min_daily_notional",
            "entry_minute_after_open",
            "exit_minute_after_open",
            "max_hold_seconds",
            "entry_cooldown_seconds",
            "stop_loss_bps",
            "trailing_activation_profit_bps",
            "trailing_drawdown_bps",
            "rank_count",
            "entry_order_type_prefer_limit",
            "market_order_spread_bps_max",
            "universe_size",
            "selection_mode_reversal",
            "selection_mode_continuation",
            "selection_mode_momentum",
            "selection_mode_pullback",
            "signal_motif_open_window_reversal",
            "signal_motif_open_window_continuation",
            "signal_motif_late_day",
            "signal_motif_washout",
            "max_notional_per_trade",
            "max_notional_pct_start_equity",
            "max_position_pct_equity",
            "configured_max_gross_exposure_pct_equity",
            "estimated_max_gross_exposure_pct_equity",
            "max_entries_per_session",
            "configured_daily_notional_capacity",
            "configured_daily_notional_required_ratio",
            "capital_budget_overage_ratio",
            "capital_feasible_flag",
            "history_net_pnl_per_day",
            "history_active_day_ratio",
            "history_positive_day_ratio",
            "history_max_gross_exposure_pct_equity",
            "history_min_cash",
            "history_negative_cash_observation_count",
            "history_negative_day_count",
            "history_best_day_share",
            "history_worst_day_loss",
            "history_max_drawdown",
            "history_avg_filled_notional_per_day",
            "history_avg_filled_notional_required_ratio",
            "history_net_pnl_per_100k_filled_notional",
            "history_post_cost_efficiency_penalty",
            "history_hard_veto_count",
            "history_daily_target_shortfall",
            "history_observed_replay_viability_penalty",
            "history_market_impact_stress_passed",
            "history_market_impact_stress_artifact_present",
            "history_market_impact_stress_cost_bps",
            "history_market_impact_liquidity_evidence_present",
            "history_market_impact_stress_net_pnl_per_day",
            "history_market_impact_target_shortfall",
            "history_delay_adjusted_depth_stress_passed",
            "history_delay_adjusted_depth_stress_artifact_present",
            "history_delay_adjusted_depth_stress_ms",
            "history_delay_adjusted_depth_fillable_notional_per_day",
            "history_delay_adjusted_depth_stress_net_pnl_per_day",
            "history_delay_adjusted_depth_target_shortfall",
            "history_double_oos_passed",
            "history_double_oos_artifact_present",
            "history_double_oos_independent_window_count",
            "history_double_oos_pass_rate",
            "history_double_oos_net_pnl_per_day",
            "history_double_oos_cost_shock_net_pnl_per_day",
            "history_double_oos_target_shortfall",
            "history_implementation_uncertainty_stability_passed",
            "history_implementation_uncertainty_lower_net_pnl_per_day",
            "history_deployable_lower_bound_net_pnl_per_day",
            "history_deployable_lower_bound_target_shortfall",
            "history_deployable_lower_bound_missing_count",
            "history_deployable_lower_bound_failed_gate_count",
            "history_conformal_tail_risk_required",
            "history_conformal_tail_risk_passed",
            "history_conformal_tail_risk_sample_count",
            "history_conformal_tail_risk_buffer_per_day",
            "history_conformal_tail_risk_adjusted_net_pnl_per_day",
            "history_conformal_tail_risk_target_shortfall",
            *_PAPER_CONTRACT_FEATURE_NAMES,
            *_MECHANISM_OVERLAY_FEATURE_NAMES,
        )
        paper_contract_features = _paper_contract_feature_values(spec)
        capital_features = candidate_spec_capital_features(spec)
        params = _params(spec)
        target_net_pnl_per_day = _float(spec.objective.get("target_net_pnl_per_day"))
        required_min_daily_notional = _float(
            spec.hard_vetoes.get("required_min_daily_notional")
            or spec.objective.get("min_avg_filled_notional_per_day")
        )
        avg_filled_notional_per_day = _float(
            scorecard.get("avg_filled_notional_per_day")
        )
        avg_filled_notional_required_ratio = (
            avg_filled_notional_per_day / required_min_daily_notional
            if required_min_daily_notional > 0.0
            else 0.0
        )
        configured_daily_notional_capacity = _float(
            capital_features.get("configured_daily_notional_capacity")
        )
        configured_daily_notional_required_ratio = (
            configured_daily_notional_capacity / required_min_daily_notional
            if required_min_daily_notional > 0.0
            else 0.0
        )
        observed_replay_penalty = _observed_replay_viability_penalty(
            scorecard,
            required_min_daily_notional=required_min_daily_notional,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
        market_impact_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=("market_impact_stress_net_pnl_per_day",),
        )
        delay_depth_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=("delay_adjusted_depth_stress_net_pnl_per_day",),
        )
        conformal_tail_risk_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=("conformal_tail_risk_adjusted_net_pnl_per_day",),
        )
        double_oos_target_shortfall = _proof_target_shortfall(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            keys=(
                "double_oos_cost_shock_net_pnl_per_day",
                "double_oos_net_pnl_per_day",
            ),
        )
        historical_proof_penalty = _historical_proof_penalty(
            scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
        deployable_lower_bound_net_pnl_per_day = (
            _deployable_lower_bound_net_pnl_per_day(scorecard)
        )
        deployable_lower_bound_target_shortfall = (
            _deployable_lower_bound_target_shortfall(
                scorecard,
                target_net_pnl_per_day=target_net_pnl_per_day,
            )
        )
        deployable_lower_bound_missing_count = _deployable_lower_bound_missing_count(
            scorecard
        )
        deployable_lower_bound_failed_gate_count = (
            _deployable_lower_bound_failed_gate_count(scorecard)
        )
        deployable_lower_bound_proof_penalty = _deployable_lower_bound_proof_penalty(
            scorecard
        )
        post_cost_efficiency_penalty = _post_cost_efficiency_penalty(scorecard)
        selection_mode = params.get("selection_mode")
        signal_motif = params.get("signal_motif")
        stop_loss_bps = _float(
            params.get("long_stop_loss_bps")
            or params.get("short_stop_loss_bps")
            or params.get("stop_loss_bps")
        )
        feature_values = (
            _family_code(spec.family_template_id),
            float(len(spec.feature_contract.get("required_features") or [])),
            float(len(spec.expected_failure_modes)),
            target_net_pnl_per_day,
            required_min_daily_notional,
            _float(params.get("entry_minute_after_open")),
            _float(params.get("exit_minute_after_open")),
            _float(params.get("max_hold_seconds")),
            _float(params.get("entry_cooldown_seconds")),
            stop_loss_bps,
            _float(
                params.get("long_trailing_stop_activation_profit_bps")
                or params.get("short_trailing_stop_activation_profit_bps")
            ),
            _float(
                params.get("long_trailing_stop_drawdown_bps")
                or params.get("short_trailing_stop_drawdown_bps")
            ),
            _positive_or_default(
                _float(params.get("top_n") or params.get("rank_count")),
                _positive_or_default(_float(params.get("max_pair_legs")), 1.0),
            ),
            _bool_feature(params.get("entry_order_type"), "prefer_limit"),
            _float(params.get("market_order_spread_bps_max") or 12),
            _strategy_universe_size(spec),
            _bool_feature(selection_mode, "reversal"),
            _bool_feature(selection_mode, "continuation"),
            _bool_feature(selection_mode, "momentum"),
            _bool_feature(selection_mode, "pullback"),
            _bool_feature(signal_motif, "open_window_reversal"),
            _bool_feature(signal_motif, "open_window_continuation"),
            _bool_feature(signal_motif, "late_day_continuation"),
            _bool_feature(signal_motif, "washout_rebound"),
            _float(capital_features.get("max_notional_per_trade")),
            _float(capital_features.get("max_notional_pct_start_equity")),
            _float(capital_features.get("max_position_pct_equity")),
            _float(capital_features.get("configured_max_gross_exposure_pct_equity")),
            _float(capital_features.get("estimated_max_gross_exposure_pct_equity")),
            _float(capital_features.get("max_entries_per_session")),
            configured_daily_notional_capacity,
            configured_daily_notional_required_ratio,
            _float(capital_features.get("capital_budget_overage_ratio")),
            _float(capital_features.get("capital_feasible_flag")),
            _float(scorecard.get("net_pnl_per_day")),
            _float(scorecard.get("active_day_ratio")),
            _float(scorecard.get("positive_day_ratio")),
            _float(scorecard.get("max_gross_exposure_pct_equity")),
            _float(scorecard.get("min_cash")),
            _float(scorecard.get("negative_cash_observation_count")),
            _float(scorecard.get("negative_day_count")),
            _float(scorecard.get("best_day_share")),
            _float(scorecard.get("worst_day_loss")),
            _float(scorecard.get("max_drawdown")),
            avg_filled_notional_per_day,
            avg_filled_notional_required_ratio,
            _net_pnl_per_100k_filled_notional(scorecard),
            post_cost_efficiency_penalty,
            _hard_veto_count(scorecard),
            _daily_target_shortfall(
                scorecard, target_net_pnl_per_day=target_net_pnl_per_day
            ),
            observed_replay_penalty,
            _truthy_feature(scorecard.get("market_impact_stress_passed")),
            _artifact_present(
                scorecard,
                singular="market_impact_stress_artifact_ref",
                plural="market_impact_stress_artifact_refs",
            ),
            _float(scorecard.get("market_impact_stress_cost_bps")),
            _truthy_feature(scorecard.get("market_impact_liquidity_evidence_present")),
            _float(scorecard.get("market_impact_stress_net_pnl_per_day")),
            market_impact_target_shortfall,
            _truthy_feature(scorecard.get("delay_adjusted_depth_stress_passed")),
            _artifact_present(
                scorecard,
                singular="delay_adjusted_depth_stress_artifact_ref",
                plural="delay_adjusted_depth_stress_artifact_refs",
            ),
            _float(scorecard.get("delay_adjusted_depth_stress_ms")),
            _float(scorecard.get("delay_adjusted_depth_fillable_notional_per_day")),
            _float(scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")),
            delay_depth_target_shortfall,
            _truthy_feature(scorecard.get("double_oos_passed")),
            _artifact_present(
                scorecard,
                singular="double_oos_artifact_ref",
                plural="double_oos_artifact_refs",
            ),
            _float(scorecard.get("double_oos_independent_window_count")),
            _float(scorecard.get("double_oos_pass_rate")),
            _float(scorecard.get("double_oos_net_pnl_per_day")),
            _float(scorecard.get("double_oos_cost_shock_net_pnl_per_day")),
            double_oos_target_shortfall,
            _truthy_feature(
                scorecard.get("implementation_uncertainty_stability_passed")
            ),
            _float(scorecard.get("implementation_uncertainty_lower_net_pnl_per_day")),
            deployable_lower_bound_net_pnl_per_day,
            deployable_lower_bound_target_shortfall,
            deployable_lower_bound_missing_count,
            deployable_lower_bound_failed_gate_count,
            _truthy_feature(scorecard.get("conformal_tail_risk_required")),
            _truthy_feature(scorecard.get("conformal_tail_risk_passed")),
            _float(scorecard.get("conformal_tail_risk_sample_count")),
            _float(scorecard.get("conformal_tail_risk_buffer_per_day")),
            _float(scorecard.get("conformal_tail_risk_adjusted_net_pnl_per_day")),
            conformal_tail_risk_target_shortfall,
            *(
                _float(paper_contract_features.get(feature_name))
                for feature_name in _PAPER_CONTRACT_FEATURE_NAMES
            ),
            *(
                _float(paper_contract_features.get(feature_name))
                for feature_name in _MECHANISM_OVERLAY_FEATURE_NAMES
            ),
        )
        target = (
            deployable_lower_bound_net_pnl_per_day
            + (_float(scorecard.get("active_day_ratio")) * 100.0)
            + (_float(scorecard.get("positive_day_ratio")) * 100.0)
            - (_float(scorecard.get("negative_day_count")) * 100.0)
            - (_float(scorecard.get("best_day_share")) * 200.0)
            - (_float(scorecard.get("worst_day_loss")) * 0.50)
            - (_float(scorecard.get("max_drawdown")) * 0.10)
            - (_hard_veto_count(scorecard) * 250.0)
            - (
                _daily_target_shortfall(
                    scorecard, target_net_pnl_per_day=target_net_pnl_per_day
                )
                * 0.10
            )
            - (deployable_lower_bound_target_shortfall * 0.25)
            - deployable_lower_bound_proof_penalty
            - observed_replay_penalty
            - post_cost_efficiency_penalty
            - historical_proof_penalty
            - capital_budget_penalty(capital_features)
            - configured_daily_notional_capacity_penalty(
                configured_daily_notional_required_ratio=configured_daily_notional_required_ratio
            )
            - observed_capital_penalty(scorecard)
        )
        rows.append(
            MlxTrainingRow(
                candidate_spec_id=spec.candidate_spec_id,
                feature_names=feature_names,
                feature_values=feature_values,
                target=target,
            )
        )
    return rows


def _normalize_matrix(
    rows: Sequence[MlxTrainingRow],
) -> tuple[list[list[float]], tuple[str, ...], tuple[float, ...], tuple[float, ...]]:
    if not rows:
        return [], (), (), ()
    feature_names = rows[0].feature_names
    columns = list(zip(*(row.feature_values for row in rows), strict=True))
    means = tuple(_mean(column) for column in columns)
    scales = tuple(
        _std(column, mean=mean) for column, mean in zip(columns, means, strict=True)
    )
    matrix = [
        [
            (value - mean) / scale
            for value, mean, scale in zip(
                row.feature_values, means, scales, strict=True
            )
        ]
        for row in rows
    ]
    return matrix, feature_names, means, scales


def train_mlx_ranker(
    rows: Sequence[MlxTrainingRow],
    *,
    backend_preference: str = "mlx",
    learning_rate: float = 0.01,
    steps: int = 256,
    l2_penalty: float = 0.001,
) -> MlxRankerModel:
    if not rows:
        raise ValueError("mlx_ranker_training_rows_required")
    matrix, feature_names, feature_means, feature_scales = _normalize_matrix(rows)
    targets = [row.target for row in rows]
    target_mean = _mean(targets)
    target_scale = _std(targets, mean=target_mean)
    normalized_targets = [(target - target_mean) / target_scale for target in targets]
    backend, xp = _import_array_backend(backend_preference)
    dtype = getattr(xp, "float32", None)
    x = (
        xp.array(matrix, dtype=dtype)
        if dtype is not None
        else xp.array(matrix, dtype=float)
    )
    y = (
        xp.array(normalized_targets, dtype=dtype)
        if dtype is not None
        else xp.array(normalized_targets, dtype=float)
    )
    feature_count = len(feature_names)
    weights = (
        xp.zeros((feature_count,), dtype=dtype)
        if dtype is not None
        else xp.zeros((feature_count,))
    )
    bias = xp.array(0.0, dtype=dtype) if dtype is not None else 0.0
    row_count = max(1, len(rows))
    for _ in range(max(1, steps)):
        predictions = x @ weights + bias
        errors = predictions - y
        gradient_w = ((x.T @ errors) * (2.0 / row_count)) + (weights * l2_penalty)
        gradient_b = errors.mean() * 2.0
        weights = weights - (gradient_w * learning_rate)
        bias = bias - (gradient_b * learning_rate)
    predictions = x @ weights + bias
    errors = predictions - y
    loss = _scalar_float((errors * errors).mean())
    weights_list = tuple(float(item) for item in cast(Sequence[Any], weights.tolist()))
    bias_value = _scalar_float(bias)
    model_seed = {
        "schema_version": MLX_RANKER_SCHEMA_VERSION,
        "feature_names": list(feature_names),
        "weights": list(weights_list),
        "bias": bias_value,
        "row_count": len(rows),
        "backend": backend,
    }
    return MlxRankerModel(
        schema_version=MLX_RANKER_SCHEMA_VERSION,
        model_id=f"mlx-ranker-v2-{_stable_hash(model_seed)[:16]}",
        backend=backend,
        feature_names=feature_names,
        feature_means=feature_means,
        feature_scales=feature_scales,
        target_mean=target_mean,
        target_scale=target_scale,
        weights=weights_list,
        bias=bias_value,
        row_count=len(rows),
        training_loss=loss,
        trained_at=datetime.now(UTC).isoformat(),
    )


def rank_training_rows(
    *,
    model: MlxRankerModel,
    rows: Sequence[MlxTrainingRow],
) -> list[MlxRankedCandidate]:
    scored: list[tuple[MlxTrainingRow, float, str]] = []
    for row in rows:
        normalized = [
            (value - mean) / scale
            for value, mean, scale in zip(
                row.feature_values,
                model.feature_means,
                model.feature_scales,
                strict=True,
            )
        ]
        normalized_score = (
            sum(
                (
                    value * weight
                    for value, weight in zip(normalized, model.weights, strict=True)
                ),
                0.0,
            )
            + model.bias
        )
        score = (normalized_score * model.target_scale) + model.target_mean
        feature_hash = _stable_hash({"features": row.to_payload()["features"]})
        scored.append((row, score, feature_hash))
    ordered = sorted(
        scored, key=lambda item: (item[1], item[0].candidate_spec_id), reverse=True
    )
    return [
        MlxRankedCandidate(
            candidate_spec_id=row.candidate_spec_id,
            score=score,
            rank=index,
            model_id=model.model_id,
            backend=model.backend,
            feature_hash=feature_hash,
        )
        for index, (row, score, feature_hash) in enumerate(ordered, start=1)
    ]


def compute_rank_bucket_lift(
    *,
    ranked_rows: Sequence[MlxRankedCandidate],
    rows: Sequence[MlxTrainingRow],
    metric_name: str = "replay_target",
    outcome_by_spec: Mapping[str, Any] | None = None,
) -> MlxRankBucketLift:
    if not ranked_rows:
        return MlxRankBucketLift(
            metric_name=metric_name,
            top_bucket_mean=0.0,
            bottom_bucket_mean=0.0,
            lift=0.0,
            status="no_ranked_rows",
        )
    row_target_by_spec = {row.candidate_spec_id: row.target for row in rows}
    outcomes = [
        _float(
            outcome_by_spec.get(item.candidate_spec_id)
            if outcome_by_spec is not None
            else row_target_by_spec.get(item.candidate_spec_id, 0.0)
        )
        for item in ranked_rows
    ]
    split_index = max(1, len(outcomes) // 2)
    top_bucket = outcomes[:split_index]
    bottom_bucket = outcomes[split_index:] or [0.0]
    top_mean = _mean(top_bucket)
    bottom_mean = _mean(bottom_bucket)
    return MlxRankBucketLift(
        metric_name=metric_name,
        top_bucket_mean=top_mean,
        bottom_bucket_mean=bottom_mean,
        lift=top_mean - bottom_mean,
    )


def rank_training_rows_with_lift_policy(
    *,
    model: MlxRankerModel,
    rows: Sequence[MlxTrainingRow],
    metric_name: str = "replay_target",
    outcome_by_spec: Mapping[str, Any] | None = None,
) -> MlxRankedRowsPolicyResult:
    ranked_rows = rank_training_rows(model=model, rows=rows)
    rank_lift = compute_rank_bucket_lift(
        ranked_rows=ranked_rows,
        rows=rows,
        metric_name=metric_name,
        outcome_by_spec=outcome_by_spec,
    )
    if rank_lift.lift >= 0:
        return MlxRankedRowsPolicyResult(
            ranked_rows=tuple(ranked_rows),
            rank_bucket_lift=rank_lift,
            model_status="active",
            selection_reason="exploitation",
        )

    feature_hash_by_spec = {
        item.candidate_spec_id: item.feature_hash for item in ranked_rows
    }
    ranked_by_fallback = sorted(
        rows,
        key=lambda row: (
            _float(
                outcome_by_spec.get(row.candidate_spec_id)
                if outcome_by_spec is not None
                else row.target
            ),
            row.candidate_spec_id,
        ),
        reverse=True,
    )
    fallback_rows = tuple(
        MlxRankedCandidate(
            candidate_spec_id=row.candidate_spec_id,
            score=_float(
                outcome_by_spec.get(row.candidate_spec_id)
                if outcome_by_spec is not None
                else row.target
            ),
            rank=index,
            model_id=model.model_id,
            backend=model.backend,
            feature_hash=feature_hash_by_spec.get(
                row.candidate_spec_id,
                _stable_hash({"features": row.to_payload()["features"]}),
            ),
        )
        for index, row in enumerate(ranked_by_fallback, start=1)
    )
    return MlxRankedRowsPolicyResult(
        ranked_rows=fallback_rows,
        rank_bucket_lift=rank_lift,
        model_status="demoted_to_heuristic",
        selection_reason="heuristic_negative_lift_fallback",
    )


def mlx_ranker_model_from_payload(payload: Mapping[str, Any]) -> MlxRankerModel:
    schema_version = str(payload.get("schema_version") or "").strip()
    if schema_version != MLX_RANKER_SCHEMA_VERSION:
        raise ValueError(f"mlx_ranker_schema_invalid:{schema_version}")
    return MlxRankerModel(
        schema_version=MLX_RANKER_SCHEMA_VERSION,
        model_id=str(payload.get("model_id") or "").strip(),
        backend=str(payload.get("backend") or "").strip(),
        feature_names=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("feature_names") or [])
        ),
        feature_means=tuple(
            float(item)
            for item in cast(Sequence[Any], payload.get("feature_means") or [])
        ),
        feature_scales=tuple(
            float(item)
            for item in cast(Sequence[Any], payload.get("feature_scales") or [])
        ),
        target_mean=float(payload.get("target_mean") or 0.0),
        target_scale=float(payload.get("target_scale") or 1.0),
        weights=tuple(
            float(item) for item in cast(Sequence[Any], payload.get("weights") or [])
        ),
        bias=float(payload.get("bias") or 0.0),
        row_count=int(payload.get("row_count") or 0),
        training_loss=float(payload.get("training_loss") or 0.0),
        trained_at=str(payload.get("trained_at") or "").strip(),
    )

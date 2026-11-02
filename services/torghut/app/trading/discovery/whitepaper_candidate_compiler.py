"""Compile whitepaper hypothesis cards into executable Torghut candidate specs."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml

from app.trading.discovery.candidate_specs import CandidateSpec, compile_candidate_specs
from app.trading.discovery.hypothesis_cards import (
    HypothesisCard,
    build_hypothesis_cards,
)


EXECUTABLE_FAMILY_IDS = {
    "breakout_reclaim_v2",
    "washout_rebound_v2",
    "momentum_pullback_v1",
    "mean_reversion_rebound_v1",
    "mean_reversion_exhaustion_short_v1",
    "microbar_cross_sectional_pairs_v1",
    "microstructure_continuation_matched_filter_v1",
    "opening_drive_leader_reclaim_v1",
    "intraday_tsmom_v2",
    "late_day_continuation_v1",
    "end_of_day_reversal_v1",
}

FEATURE_ALIASES = {
    "trade_flow": "order_flow_imbalance",
    "relative_volume": "turnover",
    "clustered_order_events": "order_flow_imbalance",
    "depth_proxy": "quote_quality",
    "depth_state": "quote_quality",
    "execution_shortfall": "transaction_cost_stress",
    "order_arrival_clustering": "information_arrival_rate",
    "order_arrival_intensity": "information_arrival_rate",
    "volatility_state": "realized_volatility",
    "spread_bps": "max_spread_bps",
    "executed_trade_obi": "order_flow_imbalance",
    "signed_trade_volume": "order_flow_imbalance",
    "weighted_microprice_momentum": "order_flow_imbalance",
    "multi_level_order_book": "order_flow_imbalance",
    "model_family_robustness": "transaction_cost_stress",
    "macro_announcement_window": "information_arrival_rate",
    "dvar": "realized_volatility",
    "adaptive_threshold": "information_arrival_rate",
    "adaptive_factor_screener": "cross_section_continuation_breadth",
    "adaptive_factor_to_execution_loop": "transaction_cost_stress",
    "adverse_selection_stress": "transaction_cost_stress",
    "algo_activity_proxy": "information_arrival_rate",
    "append_only_experiment_trace": "transaction_cost_stress",
    "attention_factor_exposures": "cross_section_continuation_breadth",
    "bid_side_absorption": "quote_quality",
    "broker_route": "transaction_cost_stress",
    "common_factor_neutral_ofi": "order_flow_imbalance",
    "counterfactual_return": "transaction_cost_stress",
    "core_flow_persistence": "information_arrival_rate",
    "breakeven_transaction_cost_buffer": "transaction_cost_stress",
    "cross_sectional_ranks": "cross_section_continuation_breadth",
    "bootstrap_confidence_interval": "transaction_cost_stress",
    "bootstrap_confidence_intervals": "transaction_cost_stress",
    "resampled_confidence_interval": "transaction_cost_stress",
    "resampled_confidence_intervals": "transaction_cost_stress",
    "conformal_tail_risk": "volatility_shock_veto",
    "continuous_factor_mining": "cross_section_continuation_breadth",
    "continuous_candidate_refresh": "information_arrival_rate",
    "cross_asset_stress": "transaction_cost_stress",
    "cross_sectional_flow": "cross_section_continuation_breadth",
    "cross_sectional_similarity_graph": "market_neutral_pairing",
    "drawdown_validation": "volatility_shock_veto",
    "executable_quote": "quote_quality",
    "closing_auction_clearing_price": "quote_quality",
    "closing_auction_projection": "information_arrival_rate",
    "crumbling_quote_probability": "quote_quality",
    "quote_crumble_probability": "quote_quality",
    "mechanical_liquidity_erosion": "quote_quality",
    "mechanical_liquidity_withdrawal": "quote_quality",
    "liquidity_withdrawal_probability": "quote_quality",
    "transient_liquidity_erosion": "quote_quality",
    "execution_delay": "transaction_cost_stress",
    "execution_replay": "transaction_cost_stress",
    "factor_dsl": "cross_section_continuation_breadth",
    "factor_neutral_residual": "market_neutral_pairing",
    "factor_pool_expansion": "cross_section_continuation_breadth",
    "factor_rank_panel": "cross_section_continuation_breadth",
    "factor_program": "cross_section_continuation_breadth",
    "factor_to_execution_loop": "transaction_cost_stress",
    "fill_model": "transaction_cost_stress",
    "fill_outcomes": "transaction_cost_stress",
    "fill_side_vector": "order_flow_imbalance",
    "firm_characteristic_embeddings": "cross_section_continuation_breadth",
    "gamma_exposure": "realized_volatility",
    "gap_velocity": "opening_drive_bps",
    "hazard_rate": "information_arrival_rate",
    "historical_replay": "transaction_cost_stress",
    "hurst_regime": "realized_volatility",
    "impact_lambda_estimate": "transaction_cost_stress",
    "informed_flow_score": "order_flow_imbalance",
    "ingestion_delay": "transaction_cost_stress",
    "engine_sensitivity": "transaction_cost_stress",
    "execution_schedule_trace": "transaction_cost_stress",
    "implementation_uncertainty_interval": "transaction_cost_stress",
    "conclusion_stability": "transaction_cost_stress",
    "closed_round_trip_ledger": "transaction_cost_stress",
    "divergence_amplification": "transaction_cost_stress",
    "multi_engine_replay": "transaction_cost_stress",
    "model_misspecification_stress": "transaction_cost_stress",
    "multiple_testing_controls": "transaction_cost_stress",
    "multiple_testing_correction": "transaction_cost_stress",
    "inventory_path": "transaction_cost_stress",
    "kyle_lambda": "transaction_cost_stress",
    "latency_stress": "transaction_cost_stress",
    "forecast_horizon": "information_arrival_rate",
    "latent_build_up_state": "realized_volatility",
    "liquidity_forecast": "quote_quality",
    "liquidity_state_fragility": "quote_quality",
    "lineage_hash": "transaction_cost_stress",
    "limit_fill_probability": "quote_quality",
    "live_paper_parity": "transaction_cost_stress",
    "replay_paper_live_semantic_parity": "transaction_cost_stress",
    "signal_payload_parity": "transaction_cost_stress",
    "order_sizing_parity": "transaction_cost_stress",
    "route_constraint_parity": "transaction_cost_stress",
    "broker_execution_semantics": "transaction_cost_stress",
    "portfolio_weight_trace": "turnover",
    "portfolio_risk_overlay_parity": "volatility_shock_veto",
    "lob_event_stream": "order_flow_imbalance",
    "lob_diffusion_event_stream": "order_flow_imbalance",
    "logistic_normal_execution_policy": "transaction_cost_stress",
    "maker_taker_fill_assumption": "transaction_cost_stress",
    "market_limit_order_mix": "transaction_cost_stress",
    "market_depth": "quote_quality",
    "market_factor_flow": "cross_section_continuation_breadth",
    "market_impact_stress": "transaction_cost_stress",
    "market_risk_var": "volatility_shock_veto",
    "market_sensitivities": "volatility_shock_veto",
    "market_sensitivity_constraints": "volatility_shock_veto",
    "neural_hawkes_event_stream": "information_arrival_rate",
    "notional_tier": "turnover",
    "option_flow": "information_arrival_rate",
    "ofi_memory_state": "information_arrival_rate",
    "opportunity_cost": "transaction_cost_stress",
    "order_type_ablation": "transaction_cost_stress",
    "order_lifetime_filter": "quote_quality",
    "order_modification_count": "quote_quality",
    "order_flow_entropy": "realized_volatility",
    "orderbook_imbalance": "order_flow_imbalance",
    "orderbook_slope": "order_flow_imbalance",
    "outcome_labels": "transaction_cost_stress",
    "out_of_sample_generalization": "transaction_cost_stress",
    "passive_buy_toxicity": "transaction_cost_stress",
    "parent_order_trade_linkage": "order_flow_imbalance",
    "pair_relative_return": "cross_section_rank",
    "post_cost_net_pnl": "transaction_cost_stress",
    "portfolio_replay": "transaction_cost_stress",
    "portfolio_var": "volatility_shock_veto",
    "price_improvement": "transaction_cost_stress",
    "parameter_instability_stress": "transaction_cost_stress",
    "percentile_based_optimization": "transaction_cost_stress",
    "price_flow_impact": "order_flow_imbalance",
    "flow_impact_decay": "information_arrival_rate",
    "filtered_orderbook_imbalance": "order_flow_imbalance",
    "event_time_excitation": "information_arrival_rate",
    "price_flow_covariance": "order_flow_imbalance",
    "portable_lob_feature_stability": "cross_section_continuation_breadth",
    "put_call_disparity": "realized_volatility",
    "quote_attribution_quality": "quote_quality",
    "regime_weighted_conformal_var": "volatility_shock_veto",
    "regime_similarity_weights": "realized_volatility",
    "regime_state": "realized_volatility",
    "regime_adaptive_factor_ensemble": "realized_volatility",
    "risk_constrained_execution": "transaction_cost_stress",
    "regime_shift_validation": "realized_volatility",
    "regime_tail_exceedance": "volatility_shock_veto",
    "rejected_signal_log": "transaction_cost_stress",
    "response_ratio": "transaction_cost_stress",
    "residual_portfolio_returns": "cross_section_rank",
    "residual_return_sequence": "intraday_momentum_rank",
    "residual_spread_zscore": "cross_section_reversal_rank",
    "risk_aware_trading_portfolio_optimization": "transaction_cost_stress",
    "risk_limit_compliance": "volatility_shock_veto",
    "route_tca": "transaction_cost_stress",
    "resampled_strategy_optimization": "transaction_cost_stress",
    "rising_edge_detector": "information_arrival_rate",
    "runtime_ledger_profit_proof": "transaction_cost_stress",
    "seed_robustness": "transaction_cost_stress",
    "selection_bias_stress": "transaction_cost_stress",
    "simulation_parity": "transaction_cost_stress",
    "signed_order_flow": "order_flow_imbalance",
    "skip_step_sampling": "transaction_cost_stress",
    "state_dependent_hawkes_intensity": "information_arrival_rate",
    "short_term_trading_factors": "cross_section_continuation_breadth",
    "symbol_flow": "order_flow_imbalance",
    "nonlinear_impact_curve": "transaction_cost_stress",
    "synthetic_lob_fill_parity": "transaction_cost_stress",
    "terminal_inventory_path": "transaction_cost_stress",
    "time_event_joint_distribution": "information_arrival_rate",
    "trade_frequency_tier": "information_arrival_rate",
    "trade_imbalance": "order_flow_imbalance",
    "trade_sign_markov_state": "information_arrival_rate",
    "train_holdout_split": "transaction_cost_stress",
    "transaction_cost_buffer": "transaction_cost_stress",
    "transaction_cost_model": "transaction_cost_stress",
    "eligible_instrument_universe": "turnover",
    "eligible_optimization_strategy": "turnover",
    "unique_eligible_instruments": "turnover",
    "capital_charge": "volatility_shock_veto",
    "capital_charge_stress": "volatility_shock_veto",
    "economic_capital_stress": "volatility_shock_veto",
    "pnl_objective": "transaction_cost_stress",
    "particle_swarm_optimizer_trace": "transaction_cost_stress",
    "utility_percentile": "transaction_cost_stress",
    "utility_percentile_optimization": "transaction_cost_stress",
    "var_forecast_error": "volatility_shock_veto",
    "vpin": "transaction_cost_stress",
    "volatility_regime": "realized_volatility",
    "volatility_signature": "realized_volatility",
    "volume_regime": "turnover",
    "wash_trade_share": "quote_quality",
    "weekly_option_availability": "information_arrival_rate",
    "walk_forward_replay": "transaction_cost_stress",
}


@dataclass(frozen=True)
class CandidateCompilationBlocker:
    candidate_spec_id: str
    reason: str
    detail: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_spec_id": self.candidate_spec_id,
            "reason": self.reason,
            "detail": dict(self.detail),
        }


@dataclass(frozen=True)
class WhitepaperCandidateCompilation:
    candidate_specs: tuple[CandidateSpec, ...]
    executable_specs: tuple[CandidateSpec, ...]
    blocked_specs: tuple[CandidateSpec, ...]
    blockers: tuple[CandidateCompilationBlocker, ...]
    whitepaper_experiment_payloads: tuple[Mapping[str, Any], ...]
    vnext_experiment_payloads: tuple[Mapping[str, Any], ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_specs": [item.to_payload() for item in self.candidate_specs],
            "executable_candidate_spec_ids": [
                item.candidate_spec_id for item in self.executable_specs
            ],
            "blocked_candidate_spec_ids": [
                item.candidate_spec_id for item in self.blocked_specs
            ],
            "blockers": [item.to_payload() for item in self.blockers],
            "whitepaper_experiment_payloads": [
                dict(item) for item in self.whitepaper_experiment_payloads
            ],
            "vnext_experiment_payloads": [
                dict(item) for item in self.vnext_experiment_payloads
            ],
        }


def _load_family_template(
    family_template_id: str,
    *,
    family_template_dir: Path | None,
) -> Mapping[str, Any]:
    if family_template_dir is None:
        return {}
    path = family_template_dir / f"{family_template_id}.yaml"
    if not path.exists():
        return {}
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], payload).items()}


def _family_template_catalog(
    family_template_dir: Path | None,
) -> dict[str, Mapping[str, Any]]:
    if family_template_dir is None or not family_template_dir.exists():
        return {}
    templates: dict[str, Mapping[str, Any]] = {}
    for path in family_template_dir.glob("*.yaml"):
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            continue
        templates[path.stem] = {
            str(key): item for key, item in cast(Mapping[Any, Any], payload).items()
        }
    return templates


def _family_feature_catalog_from_templates(
    family_templates: Mapping[str, Mapping[str, Any]],
) -> set[str]:
    features: set[str] = set()
    for family_payload in family_templates.values():
        features.update(_sequence_strings(family_payload.get("required_features")))
        features.update(_sequence_strings(family_payload.get("risk_controls")))
        liquidity = family_payload.get("liquidity_assumptions")
        if isinstance(liquidity, Mapping):
            features.update(str(key) for key in cast(Mapping[Any, Any], liquidity))
        else:
            features.update(_sequence_strings(liquidity))
    return features


def _family_feature_catalog(family_template_dir: Path | None) -> set[str]:
    return _family_feature_catalog_from_templates(
        _family_template_catalog(family_template_dir)
    )


def _seed_sweep_family_ids(seed_sweep_dir: Path | None) -> set[str]:
    if seed_sweep_dir is None or not seed_sweep_dir.exists():
        return set()
    family_ids: set[str] = set()
    for path in sorted(seed_sweep_dir.glob("profitability-frontier-*.yaml")):
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            continue
        family_template_id = str(
            cast(Mapping[Any, Any], payload).get("family_template_id") or ""
        ).strip()
        if family_template_id:
            family_ids.add(family_template_id)
    return family_ids


def _seed_sweep_config_path(
    family_template_id: str,
    *,
    seed_sweep_dir: Path | None,
) -> Path | None:
    if seed_sweep_dir is None or not seed_sweep_dir.exists():
        return None
    for path in sorted(seed_sweep_dir.glob("profitability-frontier-*.yaml")):
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            continue
        sweep_payload = {
            str(key): item for key, item in cast(Mapping[Any, Any], payload).items()
        }
        if (
            str(sweep_payload.get("family_template_id") or "").strip()
            == family_template_id
        ):
            return path
    return None


def _sequence_strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    rows = cast(Sequence[Any], value)
    return tuple(str(item) for item in rows if str(item).strip())


def _mapping_sequence(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    resolved: list[dict[str, Any]] = []
    for item in cast(Sequence[Any], value):
        if not isinstance(item, Mapping):
            continue
        resolved.append(
            {str(key): row for key, row in cast(Mapping[Any, Any], item).items()}
        )
    return tuple(resolved)


def _source_claims_by_id(spec: CandidateSpec) -> dict[str, dict[str, Any]]:
    claims = _mapping_sequence(spec.feature_contract.get("source_claims"))
    return {str(claim.get("claim_id") or ""): claim for claim in claims}


def _claim_type(claim: Mapping[str, Any] | None) -> str:
    if not claim:
        return ""
    return str(claim.get("claim_type") or "").strip().lower()


def _claim_haystack(*claims: Mapping[str, Any] | None) -> str:
    chunks: list[str] = []
    for claim in claims:
        if not claim:
            continue
        chunks.extend(
            [
                str(claim.get("claim_id") or ""),
                str(claim.get("claim_type") or ""),
                str(claim.get("claim_text") or ""),
                " ".join(_sequence_strings(claim.get("data_requirements"))),
                str(claim.get("asset_scope") or ""),
                str(claim.get("horizon_scope") or ""),
            ]
        )
    return " ".join(chunks).lower()


def _is_simulation_reality_gap_validation_relation(
    relation: Mapping[str, Any], spec: CandidateSpec
) -> bool:
    if str(relation.get("relation_type") or "").strip().lower() != "invalidates":
        return False
    claims_by_id = _source_claims_by_id(spec)
    source_claim = claims_by_id.get(str(relation.get("source_claim_id") or ""))
    target_claim = claims_by_id.get(str(relation.get("target_claim_id") or ""))
    source_type = _claim_type(source_claim)
    target_type = _claim_type(target_claim)
    if source_type not in {
        "execution_assumption",
        "market_regime",
        "risk_constraint",
        "validation_requirement",
    }:
        return False
    if target_type not in {
        "feature_recipe",
        "normalization_rule",
        "signal_mechanism",
    }:
        return False
    haystack = " ".join(
        (
            _claim_haystack(source_claim, target_claim),
            str(relation.get("relation_id") or ""),
            str(relation.get("rationale") or ""),
            " ".join(
                str(item)
                for item in spec.parameter_space.get("mechanism_overlay_ids", [])
            ),
        )
    ).lower()
    return any(
        token in haystack
        for token in (
            "reality gap",
            "simulation reality",
            "sim-to-live",
            "simulation-to-live",
            "simulation parity",
            "simulation_parity",
            "synthetic lob",
            "lob simulation",
            "limit-order-book simulation",
            "limit order book simulation",
            "fill outcomes",
            "fill_outcomes",
            "adverse-selection",
            "adverse selection",
            "simulation_reality_gap_implementation_risk",
        )
    )


def _blockers_for_spec(
    spec: CandidateSpec,
    *,
    family_template_dir: Path | None,
    seed_sweep_dir: Path | None,
    family_templates: Mapping[str, Mapping[str, Any]] | None = None,
    feature_catalog: set[str] | None = None,
    seed_sweep_family_ids: set[str] | None = None,
) -> tuple[CandidateCompilationBlocker, ...]:
    blockers: list[CandidateCompilationBlocker] = []
    claim_relation_blockers = _mapping_sequence(
        spec.feature_contract.get("claim_relation_blockers")
    )
    claim_relation_blockers = tuple(
        relation
        for relation in claim_relation_blockers
        if not _is_simulation_reality_gap_validation_relation(relation, spec)
    )
    if claim_relation_blockers:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="contradictory_claim_relation",
                detail={"claim_relation_blockers": list(claim_relation_blockers)},
            )
        )
    if spec.family_template_id not in EXECUTABLE_FAMILY_IDS:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="family_not_in_production_grammar",
                detail={"family_template_id": spec.family_template_id},
            )
        )
    if not spec.runtime_family or not spec.runtime_strategy_name:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="runtime_harness_missing",
                detail={
                    "runtime_family": spec.runtime_family,
                    "runtime_strategy_name": spec.runtime_strategy_name,
                },
            )
        )

    family_template = (
        family_templates.get(spec.family_template_id, {})
        if family_templates is not None
        else _load_family_template(
            spec.family_template_id, family_template_dir=family_template_dir
        )
    )
    if family_template_dir is not None and not family_template:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="family_template_missing",
                detail={"family_template_id": spec.family_template_id},
            )
        )
    runtime_harness = family_template.get("runtime_harness")
    if family_template and not isinstance(runtime_harness, Mapping):
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="family_runtime_harness_missing",
                detail={"family_template_id": spec.family_template_id},
            )
        )
    seed_sweep_present = (
        spec.family_template_id in seed_sweep_family_ids
        if seed_sweep_family_ids is not None
        else _seed_sweep_config_path(
            spec.family_template_id, seed_sweep_dir=seed_sweep_dir
        )
        is not None
    )
    if seed_sweep_dir is not None and not seed_sweep_present:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="seed_sweep_missing",
                detail={
                    "family_template_id": spec.family_template_id,
                    "seed_sweep_dir": str(seed_sweep_dir),
                },
            )
        )

    required_features = {
        FEATURE_ALIASES.get(feature, feature)
        for feature in _sequence_strings(spec.feature_contract.get("required_features"))
    }
    resolved_feature_catalog = (
        feature_catalog
        if feature_catalog is not None
        else _family_feature_catalog(family_template_dir)
    )
    missing_features = sorted(required_features - resolved_feature_catalog)
    if family_template_dir is not None and missing_features:
        blockers.append(
            CandidateCompilationBlocker(
                candidate_spec_id=spec.candidate_spec_id,
                reason="required_features_missing_from_family_template",
                detail={
                    "family_template_id": spec.family_template_id,
                    "missing_features": missing_features,
                },
            )
        )
    return tuple(blockers)


def whitepaper_experiment_payload_for_candidate(spec: CandidateSpec) -> dict[str, Any]:
    vnext_payload = spec.to_vnext_experiment_payload()
    return {
        "experiment_id": vnext_payload["experiment_id"],
        "family_template_id": spec.family_template_id,
        "template_id": spec.family_template_id,
        "hypothesis": vnext_payload.get("hypothesis"),
        "paper_claim_links": vnext_payload.get("paper_claim_links", []),
        "dataset_snapshot_policy": vnext_payload["dataset_snapshot_policy"],
        "template_overrides": vnext_payload["template_overrides"],
        "feature_variants": vnext_payload["feature_variants"],
        "veto_controller_variants": vnext_payload["veto_controller_variants"],
        "selection_objectives": vnext_payload["selection_objectives"],
        "hard_vetoes": vnext_payload["hard_vetoes"],
        "expected_failure_modes": vnext_payload["expected_failure_modes"],
        "promotion_contract": vnext_payload["promotion_contract"],
        "candidate_spec": vnext_payload["candidate_spec"],
    }


def compile_whitepaper_candidate_specs(
    *,
    hypothesis_cards: Sequence[HypothesisCard],
    target_net_pnl_per_day: Decimal = Decimal("300"),
    family_template_dir: Path | None = None,
    seed_sweep_dir: Path | None = None,
    universe_symbols: Sequence[str] = (),
) -> WhitepaperCandidateCompilation:
    candidate_specs = tuple(
        compile_candidate_specs(
            hypothesis_cards=hypothesis_cards,
            target_net_pnl_per_day=target_net_pnl_per_day,
            universe_symbols=universe_symbols,
        )
    )
    blockers: list[CandidateCompilationBlocker] = []
    executable_specs: list[CandidateSpec] = []
    blocked_specs: list[CandidateSpec] = []
    family_templates = _family_template_catalog(family_template_dir)
    feature_catalog = _family_feature_catalog_from_templates(family_templates)
    seed_sweep_family_ids = _seed_sweep_family_ids(seed_sweep_dir)
    for spec in candidate_specs:
        spec_blockers = _blockers_for_spec(
            spec,
            family_template_dir=family_template_dir,
            seed_sweep_dir=seed_sweep_dir,
            family_templates=family_templates,
            feature_catalog=feature_catalog,
            seed_sweep_family_ids=seed_sweep_family_ids,
        )
        blockers.extend(spec_blockers)
        if spec_blockers:
            blocked_specs.append(spec)
        else:
            executable_specs.append(spec)
    return WhitepaperCandidateCompilation(
        candidate_specs=candidate_specs,
        executable_specs=tuple(executable_specs),
        blocked_specs=tuple(blocked_specs),
        blockers=tuple(blockers),
        whitepaper_experiment_payloads=tuple(
            whitepaper_experiment_payload_for_candidate(spec)
            for spec in executable_specs
        ),
        vnext_experiment_payloads=tuple(
            spec.to_vnext_experiment_payload() for spec in executable_specs
        ),
    )


def compile_claim_payloads_to_whitepaper_experiments(
    *,
    run_id: str,
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]] = (),
    target_net_pnl_per_day: Decimal = Decimal("300"),
    family_template_dir: Path | None = None,
    seed_sweep_dir: Path | None = None,
    universe_symbols: Sequence[str] = (),
) -> WhitepaperCandidateCompilation:
    cards = build_hypothesis_cards(
        source_run_id=run_id,
        claims=claims,
        relations=relations,
    )
    return compile_whitepaper_candidate_specs(
        hypothesis_cards=cards,
        target_net_pnl_per_day=target_net_pnl_per_day,
        family_template_dir=family_template_dir,
        seed_sweep_dir=seed_sweep_dir,
        universe_symbols=universe_symbols,
    )

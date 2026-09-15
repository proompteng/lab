"""Candidate mechanism overlay orchestration."""

from __future__ import annotations

from typing import Any, Mapping

from app.trading.discovery.hypothesis_cards import HypothesisCard

from .candidate_spec_common import mapping, string_sequence
from .candidate_spec_execution_research_overlays import (
    apply_execution_research_mechanism_overlays,
)
from .candidate_spec_hypothesis_policy import paper_mechanism_haystack
from .candidate_spec_mechanism_overlay_state import MechanismOverlayState
from .candidate_spec_microstructure_overlays import (
    apply_microstructure_mechanism_overlays,
)
from .candidate_spec_replay_validation_overlays import (
    apply_replay_validation_mechanism_overlays,
)
from .candidate_spec_stat_arb_impact_overlays import (
    apply_stat_arb_impact_mechanism_overlays,
)


def mechanism_overlays_for_card(card: HypothesisCard) -> dict[str, Any]:
    state = MechanismOverlayState(haystack=paper_mechanism_haystack(card))
    apply_microstructure_mechanism_overlays(state)
    apply_execution_research_mechanism_overlays(state)
    apply_stat_arb_impact_mechanism_overlays(state)
    apply_replay_validation_mechanism_overlays(state)

    if not state.overlay_ids:
        return {}
    parameter_space_payload = dict(state.parameter_space)
    parameter_space_payload["mechanism_overlay_ids"] = state.overlay_ids
    return {
        "feature_contract": {
            "mechanism_overlays": state.overlay_contracts,
        },
        "parameter_space": parameter_space_payload,
        "hard_vetoes": state.hard_vetoes,
        "promotion_contract": state.promotion_contract,
    }


def apply_mechanism_overlay_strategy_params(
    strategy_overrides: Mapping[str, Any],
    mechanism_overlays: Mapping[str, Any],
) -> dict[str, Any]:
    overlay_ids = set(
        string_sequence(
            mapping(mechanism_overlays.get("parameter_space")).get(
                "mechanism_overlay_ids"
            )
        )
    )
    if not (
        {
            "mixed_market_limit_execution_policy",
            "crumbling_quote_liquidity_erosion",
            "latent_crumbling_quote_regime_grid",
            "friction_aware_regime_conditioned_policy",
            "multi_asset_cross_impact_execution_grid",
            "attention_factor_stat_arb_pairs_grid",
        }
        & overlay_ids
    ):
        return dict(strategy_overrides)
    next_overrides = dict(strategy_overrides)
    params = mapping(next_overrides.get("params"))
    if "mixed_market_limit_execution_policy" in overlay_ids:
        params.setdefault("entry_order_type", "prefer_limit")
        params.setdefault("market_order_spread_bps_max", "6")
    if "crumbling_quote_liquidity_erosion" in overlay_ids:
        params.setdefault("entry_order_type", "prefer_limit")
        params.setdefault("market_order_spread_bps_max", "6")
        params.setdefault("max_recent_quote_invalid_ratio", "0.12")
        params.setdefault("max_recent_quote_jump_bps", "40")
    if "latent_crumbling_quote_regime_grid" in overlay_ids:
        params.setdefault(
            "microstructure_stress_veto_profile", "latent_crumbling_quote"
        )
        params.setdefault("crumbling_quote_live_authority", "disabled_candidate_only")
    if "friction_aware_regime_conditioned_policy" in overlay_ids:
        params.setdefault("cost_model_profile", "proportional_plus_impact")
        params.setdefault("turnover_budget_profile", "trade_space_trust_region")
        params.setdefault("regime_conditioning_profile", "volatility_liquidity")
    if "multi_asset_cross_impact_execution_grid" in overlay_ids:
        params.setdefault(
            "cross_impact_stress_profile", "multi_asset_matrix_resilience"
        )
        params.setdefault("cross_impact_search_scope", "pair_leg_execution_cost")
        params.setdefault("cross_hedge_live_authority", "disabled_candidate_only")
    if "attention_factor_stat_arb_pairs_grid" in overlay_ids:
        params.setdefault("stat_arb_factor_profile", "attention_factor_residual")
        params.setdefault("pair_selection_scope", "candidate_replay_only")
        params.setdefault("llm_pair_selection_authority", "disabled_candidate_only")
    next_overrides["params"] = params
    return next_overrides


__all__ = [
    "mechanism_overlays_for_card",
    "apply_mechanism_overlay_strategy_params",
]

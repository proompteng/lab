"""Candidate spec compilation from typed whitepaper hypotheses."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.replay_tape import (
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    build_hpairs_replay_tape_feature_schema_hash,
    hpairs_replay_tape_feature_versions,
)
from .candidate_spec_profiles import (
    AI_ACCELERATOR_UNIVERSE_PROFILE as _AI_ACCELERATOR_UNIVERSE_PROFILE,
    BASE_FAMILY_EXECUTION_PROFILES as _BASE_FAMILY_EXECUTION_PROFILES,
    BREAKOUT_UNIVERSE_PROFILES as _BREAKOUT_UNIVERSE_PROFILES,
    BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE as _BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
    DEFAULT_PROFILE_COUNT as _DEFAULT_PROFILE_COUNT,
    FAMILY_EXECUTION_PROFILES as _FAMILY_EXECUTION_PROFILES,
    FAMILY_RUNTIME as _FAMILY_RUNTIME,
    FAMILY_TIEBREAK as _FAMILY_TIEBREAK,
    H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES as _H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES,
    LARGE_CAP_UNIVERSE_PROFILES as _LARGE_CAP_UNIVERSE_PROFILES,
    LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE as _LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE,
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    MAX_FAMILIES_PER_HYPOTHESIS as _MAX_FAMILIES_PER_HYPOTHESIS,
    PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES as _PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES,
    PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_SLEEVE_FAMILY_ORDER as _PORTFOLIO_SLEEVE_FAMILY_ORDER,
    PORTFOLIO_SLEEVE_FAMILY_TARGET as _PORTFOLIO_SLEEVE_FAMILY_TARGET,
    PORTFOLIO_TARGET_NET_PNL_PER_DAY as _PORTFOLIO_TARGET_NET_PNL_PER_DAY,
    REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES as _REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES,
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE,
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE_PROFILE as _RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE,
    REVERSAL_UNIVERSE_PROFILES as _REVERSAL_UNIVERSE_PROFILES,
    TSMOM_UNIVERSE_PROFILES as _TSMOM_UNIVERSE_PROFILES,
)
from .candidate_spec_common import (
    mapping as _mapping,
    stable_hash as _stable_hash,
    stable_int as _stable_int,
    string as _string,
    string_sequence as _string_sequence,
)
from .candidate_spec_family_selection import (
    families_for_hypothesis as _families_for_hypothesis,
    family_scores_for_hypothesis as _family_scores_for_hypothesis,
)
from .candidate_spec_hypothesis_policy import (
    apply_factor_acceptance_harness as _apply_factor_acceptance_harness,
    has_rejected_signal_outcome_calibration as _has_rejected_signal_outcome_calibration,
    hypothesis_haystack as _hypothesis_haystack,
    is_validation_or_execution_constraint_only as _is_validation_or_execution_constraint_only,
    list_of_mappings as _list_of_mappings,
    normalization_candidates_for_card as _normalization_candidates_for_card,
    paper_mechanism_haystack as _paper_mechanism_haystack,
    requires_factor_acceptance_harness as _requires_factor_acceptance_harness,
    requires_synthetic_validation_only_policy as _requires_synthetic_validation_only_policy,
    factor_acceptance_dependencies as _factor_acceptance_dependencies,
    factor_acceptance_expression as _factor_acceptance_expression,
)
from .candidate_spec_mechanism_overlays import (
    apply_mechanism_overlay_strategy_params as _apply_mechanism_overlay_strategy_params,
    mechanism_overlays_for_card as _mechanism_overlays_for_card,
)
from .candidate_spec_profile_variants import (
    adverse_selection_feedback_escape_profile as _adverse_selection_feedback_escape_profile,
    capital_constrained_execution_profiles as _capital_constrained_execution_profiles,
    capital_limited_profile_values as _capital_limited_profile_values,
    cash_constrain_profile as _cash_constrain_profile,
    clamped_profile_decimal as _clamped_profile_decimal,
    consistency_guard_feedback_escape_profile as _consistency_guard_feedback_escape_profile,
    daily_coverage_feedback_escape_profile as _daily_coverage_feedback_escape_profile,
    decimal_profile_param as _decimal_profile_param,
    drop_fragile_prev_close_positive_gate as _drop_fragile_prev_close_positive_gate,
    execution_profile_id as _execution_profile_id,
    execution_profile_index as _execution_profile_index,
    execution_profile_indexes as _execution_profile_indexes,
    execution_profiles_for_target as _execution_profiles_for_target,
    format_profile_budget as _format_profile_budget,
    int_profile_param as _int_profile_param,
    notional_throughput_feedback_escape_profile as _notional_throughput_feedback_escape_profile,
    portfolio_feedback_escape_execution_profiles as _portfolio_feedback_escape_execution_profiles,
    profile_rank_count_floor as _profile_rank_count_floor,
    strategy_overrides_for_profile as _strategy_overrides_for_profile,
    symbol_diversification_feedback_escape_profile as _symbol_diversification_feedback_escape_profile,
    turnover_coverage_feedback_escape_profile as _turnover_coverage_feedback_escape_profile,
)


CANDIDATE_SPEC_SCHEMA_VERSION = "torghut.candidate-spec.v1"


def _universe_symbol_override(symbols: Sequence[str]) -> tuple[str, ...]:
    cleaned: list[str] = []
    seen: set[str] = set()
    allowed = set(_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)
    for symbol in symbols:
        normalized = str(symbol).strip().upper()
        if not normalized or normalized in seen or normalized not in allowed:
            continue
        cleaned.append(normalized)
        seen.add(normalized)
    return tuple(cleaned)


@dataclass(frozen=True)
class CandidateSpec:
    schema_version: Literal["torghut.candidate-spec.v1"]
    candidate_spec_id: str
    hypothesis_id: str
    family_template_id: str
    candidate_kind: Literal[
        "family", "sleeve", "portfolio", "algorithm", "configuration"
    ]
    runtime_family: str
    runtime_strategy_name: str
    feature_contract: Mapping[str, Any]
    parameter_space: Mapping[str, Any]
    strategy_overrides: Mapping[str, Any]
    objective: Mapping[str, Any]
    hard_vetoes: Mapping[str, Any]
    expected_failure_modes: tuple[str, ...]
    promotion_contract: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "candidate_spec_id": self.candidate_spec_id,
            "hypothesis_id": self.hypothesis_id,
            "family_template_id": self.family_template_id,
            "candidate_kind": self.candidate_kind,
            "runtime_family": self.runtime_family,
            "runtime_strategy_name": self.runtime_strategy_name,
            "feature_contract": dict(self.feature_contract),
            "parameter_space": dict(self.parameter_space),
            "strategy_overrides": dict(self.strategy_overrides),
            "objective": dict(self.objective),
            "hard_vetoes": dict(self.hard_vetoes),
            "expected_failure_modes": list(self.expected_failure_modes),
            "promotion_contract": dict(self.promotion_contract),
            "candidate_authority": "discovery_probation_input_only",
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        }

    def to_vnext_experiment_payload(
        self, *, experiment_id: str | None = None
    ) -> dict[str, Any]:
        return {
            "experiment_id": experiment_id or f"{self.candidate_spec_id}-exp",
            "family_template_id": self.family_template_id,
            "hypothesis": self.feature_contract.get("mechanism"),
            "paper_claim_links": list(
                cast(Sequence[str], self.feature_contract.get("source_claim_ids") or [])
            ),
            "dataset_snapshot_policy": {
                "source": "historical_market_replay",
                "window_size": "PT1S",
            },
            "template_overrides": dict(self.strategy_overrides),
            "feature_variants": list(
                cast(
                    Sequence[str],
                    self.feature_contract.get("normalization_candidates") or [],
                )
            ),
            "veto_controller_variants": [],
            "selection_objectives": dict(self.objective),
            "hard_vetoes": dict(self.hard_vetoes),
            "expected_failure_modes": list(self.expected_failure_modes),
            "promotion_contract": dict(self.promotion_contract),
            "candidate_spec": self.to_payload(),
        }


def candidate_spec_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"spec-{_stable_hash(payload)[:24]}"


def compile_candidate_specs(
    *,
    hypothesis_cards: Sequence[HypothesisCard],
    target_net_pnl_per_day: Decimal = Decimal("300"),
    universe_symbols: Sequence[str] = (),
) -> list[CandidateSpec]:
    specs: list[CandidateSpec] = []
    explicit_universe_symbols = _universe_symbol_override(universe_symbols)
    for card in hypothesis_cards:
        include_false_negative_rescue = _has_rejected_signal_outcome_calibration(card)
        for family_rank, (
            family_template_id,
            family_score,
            family_reasons,
        ) in enumerate(
            _families_for_hypothesis(
                card, target_net_pnl_per_day=target_net_pnl_per_day
            ),
            start=1,
        ):
            runtime_family, runtime_strategy_name = _FAMILY_RUNTIME[family_template_id]
            for execution_profile_index in _execution_profile_indexes(
                card=card,
                family_template_id=family_template_id,
                family_rank=family_rank,
                target_net_pnl_per_day=target_net_pnl_per_day,
                include_false_negative_rescue=include_false_negative_rescue,
            ):
                execution_profile_id = _execution_profile_id(
                    family_template_id=family_template_id,
                    profile_index=execution_profile_index,
                )
                strategy_overrides = _strategy_overrides_for_profile(
                    family_template_id=family_template_id,
                    profile_index=execution_profile_index,
                    target_net_pnl_per_day=target_net_pnl_per_day,
                    include_false_negative_rescue=include_false_negative_rescue,
                )
                if explicit_universe_symbols:
                    strategy_overrides = {
                        **strategy_overrides,
                        "universe_symbols": list(explicit_universe_symbols),
                    }
                feature_contract: dict[str, Any] = {
                    "source_run_id": card.source_run_id,
                    "source_claim_ids": list(card.source_claim_ids),
                    "mechanism": card.mechanism,
                    "asset_scope": card.asset_scope,
                    "horizon_scope": card.horizon_scope,
                    "expected_direction": card.expected_direction,
                    "required_features": list(card.required_features),
                    "entry_motifs": list(card.entry_motifs),
                    "exit_motifs": list(card.exit_motifs),
                    "expected_regimes": list(card.expected_regimes),
                    "normalization_candidates": list(
                        _normalization_candidates_for_card(card)
                    ),
                    "family_selection": {
                        "rank": family_rank,
                        "score": family_score,
                        "reasons": list(family_reasons),
                    },
                    "execution_profile": {
                        "profile_id": execution_profile_id,
                        "profile_index": execution_profile_index,
                    },
                }
                claim_relation_blockers = _list_of_mappings(
                    card.implementation_constraints.get("claim_relation_blockers")
                )
                if claim_relation_blockers:
                    feature_contract["claim_relation_blockers"] = [
                        dict(item) for item in claim_relation_blockers
                    ]
                validation_requirements = _list_of_mappings(
                    card.implementation_constraints.get("validation_requirements")
                )
                if validation_requirements:
                    feature_contract["validation_requirements"] = [
                        dict(item) for item in validation_requirements
                    ]
                source_claims = _list_of_mappings(
                    card.implementation_constraints.get("source_claims")
                )
                if source_claims:
                    feature_contract["source_claims"] = [
                        dict(item) for item in source_claims
                    ]
                objective = {
                    "target_net_pnl_per_day": str(target_net_pnl_per_day),
                    "require_positive_day_ratio": "0.60",
                }
                hard_vetoes = {
                    "required_min_active_day_ratio": "0.90",
                    "required_min_daily_notional": "300000",
                    "required_max_best_day_share": "0.25",
                    "required_max_worst_day_loss": "350",
                    "required_max_drawdown": "900",
                    "required_min_regime_slice_pass_rate": "0.45",
                }
                parameter_space: dict[str, Any] = {
                    "mode": "bounded_grid",
                    "source": "whitepaper_autoresearch",
                    "family_selection_rank": family_rank,
                    "execution_profile_id": execution_profile_id,
                    "execution_profile_index": execution_profile_index,
                    "parameter_override_keys": sorted(
                        str(key)
                        for key in _mapping(strategy_overrides.get("params")).keys()
                    ),
                }
                promotion_contract: dict[str, Any] = {
                    "source": "whitepaper_autoresearch_profit_target",
                    "target_net_pnl_per_day": str(target_net_pnl_per_day),
                    "requires_scheduler_v3_parity_replay": True,
                    "requires_scheduler_v3_approval_replay": True,
                    "requires_shadow_validation": True,
                    "promotion_policy": "research_only",
                }
                if family_template_id == "microbar_cross_sectional_pairs_v1":
                    feature_contract["hpairs_microstructure_prefilter_contract"] = {
                        "schema_version": "torghut.hpairs-microstructure-prefilter-contract.v1",
                        "clusterlob_adapter": "consume_lob_or_microbar_order_flow_fields_only",
                        "fallback_policy": (
                            "deterministic_microbar_order_flow_fallback_with_explicit_blockers"
                        ),
                        "horizon_ofi_microbars": [3, 12, 36],
                        "macro_window_concentration_metadata": True,
                        "impact_capacity_lineage": (
                            "square_root_power_law_prefilter_only_requires_source_backed_adv"
                        ),
                        "ranking_authority": "candidate_discovery_prefilter_only",
                    }
                    feature_contract["hpairs_replay_tape_feature_contract"] = {
                        "schema_version": "torghut.hpairs-replay-tape-candidate-contract.v1",
                        "feature_schema_version": HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
                        "feature_schema_hash": build_hpairs_replay_tape_feature_schema_hash(),
                        "feature_versions": hpairs_replay_tape_feature_versions(),
                        "clusterlob_buckets": (
                            "deterministic_clustered_event_quote_behavior_metadata"
                        ),
                        "ofi_memory_regime_slices": [
                            "instant",
                            "short",
                            "medium",
                            "long",
                        ],
                        "ranking_authority": "candidate_discovery_prefilter_only",
                        "promotion_authority": False,
                        "runtime_ledger_authority": False,
                    }
                    parameter_space["hpairs_microstructure_prefilter"] = {
                        "enabled": True,
                        "bounded_frontier_handoff": True,
                        "proof_source": "prefilter_only",
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                    promotion_contract.update(
                        {
                            "hpairs_microstructure_prefilter_is_not_promotion_proof": True,
                            "hpairs_microstructure_prefilter_requires_exact_replay": True,
                            "hpairs_microstructure_prefilter_requires_runtime_ledger": True,
                        }
                    )
                if validation_requirements:
                    promotion_contract["validation_requirement_claim_ids"] = [
                        str(item.get("claim_id"))
                        for item in validation_requirements
                        if str(item.get("claim_id") or "").strip()
                    ]
                if _requires_synthetic_validation_only_policy(card):
                    promotion_contract.update(
                        {
                            "requires_historical_replay": True,
                            "requires_live_paper_parity": True,
                            "synthetic_evidence_policy": (
                                "validation_only_not_promotion_proof"
                            ),
                        }
                    )
                mechanism_overlays = _mechanism_overlays_for_card(card)
                strategy_overrides = _apply_mechanism_overlay_strategy_params(
                    strategy_overrides,
                    mechanism_overlays,
                )
                feature_contract.update(
                    _mapping(mechanism_overlays.get("feature_contract"))
                )
                parameter_space.update(
                    _mapping(mechanism_overlays.get("parameter_space"))
                )
                hard_vetoes.update(_mapping(mechanism_overlays.get("hard_vetoes")))
                promotion_contract.update(
                    _mapping(mechanism_overlays.get("promotion_contract"))
                )
                _apply_factor_acceptance_harness(
                    card=card,
                    feature_contract=feature_contract,
                    parameter_space=parameter_space,
                    strategy_overrides=strategy_overrides,
                    hard_vetoes=hard_vetoes,
                    promotion_contract=promotion_contract,
                )
                replay_guidance_profile = _string(
                    _mapping(strategy_overrides.get("params")).get(
                        "replay_ledger_guidance_profile"
                    )
                )
                if replay_guidance_profile:
                    parameter_space.update(
                        {
                            "replay_ledger_guided_candidate_expansion": True,
                            "replay_ledger_guidance_profile": replay_guidance_profile,
                        }
                    )
                    promotion_contract.update(
                        {
                            "requires_runtime_ledger_profit_proof": True,
                            "requires_source_backed_runtime_ledger": True,
                            "replay_ledger_guided_search_is_not_promotion_proof": True,
                        }
                    )
                base_payload = {
                    "hypothesis_id": card.hypothesis_id,
                    "family_template_id": family_template_id,
                    "feature_contract": feature_contract,
                    "parameter_space": parameter_space,
                    "strategy_overrides": strategy_overrides,
                    "objective": objective,
                }
                specs.append(
                    CandidateSpec(
                        schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
                        candidate_spec_id=candidate_spec_id_for_payload(base_payload),
                        hypothesis_id=card.hypothesis_id,
                        family_template_id=family_template_id,
                        candidate_kind="sleeve",
                        runtime_family=runtime_family,
                        runtime_strategy_name=runtime_strategy_name,
                        feature_contract=feature_contract,
                        parameter_space=parameter_space,
                        strategy_overrides=strategy_overrides,
                        objective=objective,
                        hard_vetoes=hard_vetoes,
                        expected_failure_modes=card.failure_modes,
                        promotion_contract=promotion_contract,
                    )
                )
    return specs


def candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != CANDIDATE_SPEC_SCHEMA_VERSION:
        raise ValueError(f"candidate_spec_schema_invalid:{schema_version}")
    return CandidateSpec(
        schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        hypothesis_id=_string(payload.get("hypothesis_id")),
        family_template_id=_string(payload.get("family_template_id")),
        candidate_kind=cast(Any, _string(payload.get("candidate_kind")) or "sleeve"),
        runtime_family=_string(payload.get("runtime_family")),
        runtime_strategy_name=_string(payload.get("runtime_strategy_name")),
        feature_contract=_mapping(payload.get("feature_contract")),
        parameter_space=_mapping(payload.get("parameter_space")),
        strategy_overrides=_mapping(payload.get("strategy_overrides")),
        objective=_mapping(payload.get("objective")),
        hard_vetoes=_mapping(payload.get("hard_vetoes")),
        expected_failure_modes=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("expected_failure_modes") or [])
        ),
        promotion_contract=_mapping(payload.get("promotion_contract")),
    )


__all__ = [
    "annotations",
    "json",
    "dataclass",
    "Decimal",
    "Any",
    "Literal",
    "Mapping",
    "Sequence",
    "cast",
    "HypothesisCard",
    "HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION",
    "build_hpairs_replay_tape_feature_schema_hash",
    "hpairs_replay_tape_feature_versions",
    "LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE",
    "RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE",
    "CANDIDATE_SPEC_SCHEMA_VERSION",
    "_FAMILY_RUNTIME",
    "_FAMILY_TIEBREAK",
    "_MAX_FAMILIES_PER_HYPOTHESIS",
    "_PORTFOLIO_TARGET_NET_PNL_PER_DAY",
    "_PORTFOLIO_SLEEVE_FAMILY_TARGET",
    "_PORTFOLIO_SLEEVE_FAMILY_ORDER",
    "_DEFAULT_PROFILE_COUNT",
    "_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE",
    "_AI_ACCELERATOR_UNIVERSE_PROFILE",
    "_LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE",
    "_BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE",
    "_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE",
    "_PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE",
    "_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE",
    "_LARGE_CAP_UNIVERSE_PROFILES",
    "_BREAKOUT_UNIVERSE_PROFILES",
    "_REVERSAL_UNIVERSE_PROFILES",
    "_TSMOM_UNIVERSE_PROFILES",
    "_FAMILY_EXECUTION_PROFILES",
    "_BASE_FAMILY_EXECUTION_PROFILES",
    "_REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES",
    "_PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES",
    "_H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES",
    "_stable_hash",
    "_stable_int",
    "_string",
    "_mapping",
    "_string_sequence",
    "_format_profile_budget",
    "_profile_rank_count_floor",
    "_capital_limited_profile_values",
    "_decimal_profile_param",
    "_int_profile_param",
    "_clamped_profile_decimal",
    "_cash_constrain_profile",
    "_drop_fragile_prev_close_positive_gate",
    "_daily_coverage_feedback_escape_profile",
    "_consistency_guard_feedback_escape_profile",
    "_turnover_coverage_feedback_escape_profile",
    "_notional_throughput_feedback_escape_profile",
    "_adverse_selection_feedback_escape_profile",
    "_symbol_diversification_feedback_escape_profile",
    "_portfolio_feedback_escape_execution_profiles",
    "_capital_constrained_execution_profiles",
    "_universe_symbol_override",
    "_list_of_mappings",
    "_hypothesis_haystack",
    "_has_rejected_signal_outcome_calibration",
    "_normalization_candidates_for_card",
    "_requires_synthetic_validation_only_policy",
    "_is_validation_or_execution_constraint_only",
    "_paper_mechanism_haystack",
    "_requires_factor_acceptance_harness",
    "_factor_acceptance_dependencies",
    "_factor_acceptance_expression",
    "_apply_factor_acceptance_harness",
    "_mechanism_overlays_for_card",
    "_apply_mechanism_overlay_strategy_params",
    "_family_scores_for_hypothesis",
    "_families_for_hypothesis",
    "_execution_profile_index",
    "_execution_profile_indexes",
    "_execution_profile_id",
    "_execution_profiles_for_target",
    "_strategy_overrides_for_profile",
    "CandidateSpec",
    "candidate_spec_id_for_payload",
    "compile_candidate_specs",
    "candidate_spec_from_payload",
]

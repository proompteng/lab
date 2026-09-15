"""Hypothesis policy helpers for candidate spec compilation."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.factor_acceptance import build_factor_acceptance_artifact
from app.trading.discovery.hypothesis_cards import HypothesisCard

from .candidate_spec_common import mapping, string, string_sequence


def list_of_mappings(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    return tuple(mapping(item) for item in cast(Sequence[Any], value) if mapping(item))


def hypothesis_haystack(card: HypothesisCard) -> str:
    return " ".join(
        [
            card.mechanism,
            card.asset_scope,
            card.horizon_scope,
            " ".join(card.required_features),
            " ".join(card.entry_motifs),
            " ".join(card.exit_motifs),
            " ".join(card.expected_regimes),
            " ".join(card.failure_modes),
            " ".join(card.source_claim_ids),
        ]
    ).lower()


def has_rejected_signal_outcome_calibration(card: HypothesisCard) -> bool:
    haystack = hypothesis_haystack(card)
    return any(
        token in haystack
        for token in (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
        )
    )


def normalization_candidates_for_card(card: HypothesisCard) -> tuple[str, ...]:
    haystack = hypothesis_haystack(card)
    candidates = ["price_scaled", "trading_value_scaled"]
    if any(
        token in haystack
        for token in (
            "market cap",
            "market-cap",
            "market_cap",
            "matched filter",
            "matched-filter",
            "matched_filter",
            "scale-invariant",
            "scale invariant",
        )
    ):
        candidates.append("market_cap_scaled")
    if any(
        token in haystack
        for token in (
            "opening",
            "session segment",
            "session_segment",
            "timezone",
            "time-of-day",
            "time of day",
        )
    ):
        candidates.append("opening_window_scaled")
    return tuple(dict.fromkeys(candidates))


def requires_synthetic_validation_only_policy(card: HypothesisCard) -> bool:
    validation_requirements = list_of_mappings(
        card.implementation_constraints.get("validation_requirements")
    )
    haystack = " ".join(
        " ".join(
            (
                str(item.get("claim_type") or ""),
                str(item.get("claim_text") or ""),
                " ".join(string_sequence(item.get("data_requirements"))),
            )
        ).lower()
        for item in validation_requirements
    )
    return any(
        token in haystack
        for token in (
            "synthetic",
            "generated",
            "simulation",
            "simulated",
            "stress",
            "live_paper_parity",
        )
    )


def is_validation_or_execution_constraint_only(card: HypothesisCard) -> bool:
    source_claims = list_of_mappings(
        card.implementation_constraints.get("source_claims")
    )
    claim_types = {
        str(item.get("claim_type") or "").strip().lower()
        for item in source_claims
        if str(item.get("claim_type") or "").strip()
    }
    if not claim_types:
        return False
    signal_claim_types = {
        "feature_recipe",
        "signal_mechanism",
        "strategy_mechanism",
        "portfolio_construction",
    }
    if claim_types & signal_claim_types:
        return False
    return claim_types <= {
        "execution_assumption",
        "market_regime",
        "risk_constraint",
        "validation_requirement",
    }


def paper_mechanism_haystack(card: HypothesisCard) -> str:
    validation_requirements = list_of_mappings(
        card.implementation_constraints.get("validation_requirements")
    )
    validation_text = " ".join(
        " ".join(
            (
                str(item.get("claim_id") or ""),
                str(item.get("claim_type") or ""),
                str(item.get("claim_text") or ""),
                " ".join(string_sequence(item.get("data_requirements"))),
            )
        )
        for item in validation_requirements
    )
    return f"{hypothesis_haystack(card)} {validation_text}".lower()


def requires_factor_acceptance_harness(card: HypothesisCard) -> bool:
    haystack = paper_mechanism_haystack(card)
    return any(
        token in haystack
        for token in (
            "rankic",
            "rank ic",
            "rank-ir",
            "rank ir",
            "information coefficient",
            "factor mining",
            "factor discovery",
            "factor screener",
            "alpha factor",
            "signal discovery",
            "llm signal",
            "quantitative signal discovery",
            "adaptive factor",
            "chain-of-alpha",
            "alphacrafter",
            "alpha-r1",
            "r&d-agent-quant",
            "rd-agent-quant",
            "factorminer",
        )
    )


def factor_acceptance_dependencies(
    card: HypothesisCard, strategy_overrides: Mapping[str, Any]
) -> tuple[str, ...]:
    params = mapping(strategy_overrides.get("params"))
    dependencies: list[str] = []
    for key in ("rank_feature", "gate_feature"):
        value = string(params.get(key))
        if value:
            dependencies.append(value)
    dependencies.extend(card.required_features)
    return tuple(dict.fromkeys(item for item in dependencies if item))


def factor_acceptance_expression(strategy_overrides: Mapping[str, Any]) -> str:
    params = mapping(strategy_overrides.get("params"))
    rank_feature = string(params.get("rank_feature"))
    gate_feature = string(params.get("gate_feature"))
    if rank_feature and gate_feature:
        return f"{rank_feature}|gated_by:{gate_feature}"
    if rank_feature:
        return rank_feature
    return "candidate_family_score"


def apply_factor_acceptance_harness(
    *,
    card: HypothesisCard,
    feature_contract: dict[str, Any],
    parameter_space: dict[str, Any],
    strategy_overrides: Mapping[str, Any],
    hard_vetoes: dict[str, Any],
    promotion_contract: dict[str, Any],
) -> None:
    if not requires_factor_acceptance_harness(card):
        return
    artifact = build_factor_acceptance_artifact(
        factor_expression=factor_acceptance_expression(strategy_overrides),
        source_idea="2025_2026_signal_discovery_rankic_acceptance_harness",
        allowed_feature_dependencies=factor_acceptance_dependencies(
            card, strategy_overrides
        ),
        train_window={"source": "runtime_replay_required"},
        test_window={"source": "holdout_or_live_paper_required"},
        sample_count=0,
        candidate_count=1,
    )
    feature_contract["factor_acceptance_artifact"] = artifact
    feature_contract["factor_acceptance_policy"] = (
        "deterministic_rankic_rankir_cost_stress_fail_closed"
    )
    overlay_ids = [
        str(item)
        for item in cast(
            Sequence[Any], parameter_space.get("mechanism_overlay_ids") or []
        )
    ]
    if "rankic_factor_acceptance_harness" not in overlay_ids:
        overlay_ids.append("rankic_factor_acceptance_harness")
    parameter_space["mechanism_overlay_ids"] = overlay_ids
    hard_vetoes.update(
        {
            "required_factor_acceptance_artifact": True,
            "required_factor_acceptance_status": "accepted",
            "required_factor_acceptance_min_rank_ic": artifact["thresholds"][
                "min_rank_ic"
            ],
            "required_factor_acceptance_min_rank_ir": artifact["thresholds"][
                "min_rank_ir"
            ],
            "required_factor_acceptance_max_deflated_p_value": artifact["thresholds"][
                "max_deflated_p_value"
            ],
            "required_factor_acceptance_min_sample_count": artifact["thresholds"][
                "min_sample_count"
            ],
            "required_factor_acceptance_cost_stressed_positive": True,
        }
    )
    promotion_contract.update(
        {
            "requires_factor_acceptance_artifact": True,
            "requires_feature_dependency_parity": True,
            "requires_rankic_rankir_holdout_acceptance": True,
            "requires_multiple_testing_penalty": True,
            "requires_cost_stressed_factor_expectancy": True,
            "rejects_llm_generated_factor_without_deterministic_acceptance": True,
            "rejects_factor_acceptance_as_live_promotion_proof": True,
        }
    )


__all__ = [
    "list_of_mappings",
    "hypothesis_haystack",
    "has_rejected_signal_outcome_calibration",
    "normalization_candidates_for_card",
    "requires_synthetic_validation_only_policy",
    "is_validation_or_execution_constraint_only",
    "paper_mechanism_haystack",
    "requires_factor_acceptance_harness",
    "factor_acceptance_dependencies",
    "factor_acceptance_expression",
    "apply_factor_acceptance_harness",
]

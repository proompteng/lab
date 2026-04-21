"""Candidate spec compilation from typed whitepaper hypotheses."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import HypothesisCard


CANDIDATE_SPEC_SCHEMA_VERSION = "torghut.candidate-spec.v1"

_FAMILY_RUNTIME = {
    "breakout_reclaim_v2": (
        "breakout_continuation_consistent",
        "breakout-continuation-long-v1",
    ),
    "washout_rebound_v2": ("washout_rebound_consistent", "washout-rebound-long-v1"),
    "momentum_pullback_v1": (
        "momentum_pullback_consistent",
        "momentum-pullback-long-v1",
    ),
    "mean_reversion_rebound_v1": (
        "mean_reversion_rebound_consistent",
        "mean-reversion-rebound-long-v1",
    ),
    "microbar_cross_sectional_pairs_v1": (
        "microbar_cross_sectional_pairs",
        "microbar-cross-sectional-pairs-v1",
    ),
    "microstructure_continuation_matched_filter_v1": (
        "breakout_continuation_consistent",
        "breakout-continuation-long-v1",
    ),
    "intraday_tsmom_v2": ("intraday_tsmom_consistent", "intraday-tsmom-profit-v3"),
}

_FAMILY_TIEBREAK = {
    family_template_id: index
    for index, family_template_id in enumerate(
        (
            "microstructure_continuation_matched_filter_v1",
            "microbar_cross_sectional_pairs_v1",
            "intraday_tsmom_v2",
            "momentum_pullback_v1",
            "breakout_reclaim_v2",
            "washout_rebound_v2",
            "mean_reversion_rebound_v1",
        )
    )
}
_MAX_FAMILIES_PER_HYPOTHESIS = 3


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _string(value: Any) -> str:
    return str(value or "").strip()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _hypothesis_haystack(card: HypothesisCard) -> str:
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


def _family_scores_for_hypothesis(
    card: HypothesisCard,
) -> list[tuple[str, int, tuple[str, ...]]]:
    haystack = _hypothesis_haystack(card)
    scores = {family_template_id: 0 for family_template_id in _FAMILY_RUNTIME}
    reasons: dict[str, list[str]] = {
        family_template_id: [] for family_template_id in _FAMILY_RUNTIME
    }

    def bump(family_template_id: str, score: int, reason: str) -> None:
        scores[family_template_id] += score
        if reason not in reasons[family_template_id]:
            reasons[family_template_id].append(reason)

    def has_any(tokens: Sequence[str]) -> bool:
        return any(token in haystack for token in tokens)

    if has_any(
        (
            "scale-invariant",
            "normalization",
            "matched-filter",
            "matched_filter",
            "representation",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "representation_or_normalization",
        )
        bump("microbar_cross_sectional_pairs_v1", 2, "microstructure_representation")
    if has_any(
        (
            "order flow",
            "order-flow",
            "order_flow",
            "trade-flow",
            "trade flow",
            "ofi",
            "imbalance",
            "lob",
            "limit order book",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "order_flow_or_lob_signal")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "order_flow_or_lob_signal",
        )
    if has_any(
        (
            "cluster",
            "clustered",
            "self-exciting",
            "hawkes",
            "order arrival",
            "arrival clustering",
        )
    ):
        bump("intraday_tsmom_v2", 5, "clustered_arrival_regime")
        bump(
            "microstructure_continuation_matched_filter_v1",
            3,
            "clustered_arrival_regime",
        )
        bump("microbar_cross_sectional_pairs_v1", 2, "clustered_arrival_regime")
    if has_any(
        (
            "liquidity",
            "execution",
            "shortfall",
            "spread",
            "market-maker",
            "market maker",
        )
    ):
        bump("mean_reversion_rebound_v1", 4, "liquidity_response_or_execution_stress")
        bump("washout_rebound_v2", 3, "liquidity_response_or_execution_stress")
        bump(
            "microstructure_continuation_matched_filter_v1",
            3,
            "liquidity_response_or_execution_stress",
        )
    if has_any(("volatility", "regime", "stress window", "nearly unstable")):
        bump("intraday_tsmom_v2", 4, "volatility_or_regime_state")
        bump("momentum_pullback_v1", 2, "volatility_or_regime_state")
    if has_any(("momentum", "trend", "pullback", "trend persistence")):
        bump("momentum_pullback_v1", 5, "momentum_or_pullback")
        bump("intraday_tsmom_v2", 4, "momentum_or_pullback")
    if has_any(("breakout", "continuation", "reclaim", "leader")):
        bump("breakout_reclaim_v2", 5, "continuation_or_reclaim")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "continuation_or_reclaim",
        )
    if has_any(("washout", "reversal", "rebound", "mean reversion", "dislocation")):
        bump("washout_rebound_v2", 5, "reversal_or_rebound")
        bump("mean_reversion_rebound_v1", 5, "reversal_or_rebound")
    if has_any(("relative_volume", "relative volume", "turnover")):
        bump("intraday_tsmom_v2", 2, "relative_volume_or_turnover")
        bump("breakout_reclaim_v2", 2, "relative_volume_or_turnover")

    if not any(scores.values()):
        bump("microbar_cross_sectional_pairs_v1", 1, "default_executable_microbar")

    return sorted(
        (
            (family_template_id, score, tuple(reasons[family_template_id]))
            for family_template_id, score in scores.items()
            if score > 0
        ),
        key=lambda item: (-item[1], _FAMILY_TIEBREAK.get(item[0], 10**6), item[0]),
    )


def _families_for_hypothesis(
    card: HypothesisCard,
) -> tuple[tuple[str, int, tuple[str, ...]], ...]:
    return tuple(_family_scores_for_hypothesis(card)[:_MAX_FAMILIES_PER_HYPOTHESIS])


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
    target_net_pnl_per_day: Decimal = Decimal("500"),
) -> list[CandidateSpec]:
    specs: list[CandidateSpec] = []
    for card in hypothesis_cards:
        for family_rank, (
            family_template_id,
            family_score,
            family_reasons,
        ) in enumerate(_families_for_hypothesis(card), start=1):
            runtime_family, runtime_strategy_name = _FAMILY_RUNTIME[family_template_id]
            feature_contract = {
                "source_run_id": card.source_run_id,
                "source_claim_ids": list(card.source_claim_ids),
                "mechanism": card.mechanism,
                "required_features": list(card.required_features),
                "entry_motifs": list(card.entry_motifs),
                "exit_motifs": list(card.exit_motifs),
                "expected_regimes": list(card.expected_regimes),
                "normalization_candidates": ["price_scaled", "trading_value_scaled"],
                "family_selection": {
                    "rank": family_rank,
                    "score": family_score,
                    "reasons": list(family_reasons),
                },
            }
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
            strategy_overrides: dict[str, Any] = {
                "max_notional_per_trade": "50000",
            }
            parameter_space = {
                "mode": "bounded_grid",
                "source": "whitepaper_autoresearch",
                "family_selection_rank": family_rank,
            }
            promotion_contract = {
                "source": "whitepaper_autoresearch_profit_target",
                "target_net_pnl_per_day": str(target_net_pnl_per_day),
                "requires_scheduler_v3_parity_replay": True,
                "requires_scheduler_v3_approval_replay": True,
                "requires_shadow_validation": True,
                "promotion_policy": "research_only",
            }
            base_payload = {
                "hypothesis_id": card.hypothesis_id,
                "family_template_id": family_template_id,
                "feature_contract": feature_contract,
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

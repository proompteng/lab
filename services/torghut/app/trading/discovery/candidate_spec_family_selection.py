"""Candidate family selection scoring."""

from __future__ import annotations

from decimal import Decimal
from typing import Sequence

from app.trading.discovery.hypothesis_cards import HypothesisCard

from .candidate_spec_hypothesis_policy import (
    has_rejected_signal_outcome_calibration,
    hypothesis_haystack,
    is_validation_or_execution_constraint_only,
)
from .candidate_spec_profiles import (
    FAMILY_RUNTIME,
    FAMILY_TIEBREAK,
    MAX_FAMILIES_PER_HYPOTHESIS,
    PORTFOLIO_SLEEVE_FAMILY_ORDER,
    PORTFOLIO_SLEEVE_FAMILY_TARGET,
    PORTFOLIO_TARGET_NET_PNL_PER_DAY,
)


def family_scores_for_hypothesis(
    card: HypothesisCard,
) -> list[tuple[str, int, tuple[str, ...]]]:
    haystack = hypothesis_haystack(card)
    scores = {family_template_id: 0 for family_template_id in FAMILY_RUNTIME}
    reasons: dict[str, list[str]] = {
        family_template_id: [] for family_template_id in FAMILY_RUNTIME
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
            "portable lob",
            "portable_lob",
            "feature stability",
            "feature_stability",
            "shap",
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
            "kanformer",
            "queue-position",
            "queue position",
            "queue_position",
            "time-to-fill",
            "time to fill",
            "time_to_fill",
            "survival analysis",
            "survival model",
            "survival_fill_curve",
            "fill survival",
            "fill_survival",
            "fill probability",
            "fill probabilities",
            "nonfill opportunity cost",
            "nonfill_opportunity_cost",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "queue_position_survival_fill_curve",
        )
        bump(
            "microbar_cross_sectional_pairs_v1", 3, "queue_position_survival_fill_curve"
        )

    if has_any(
        (
            "alpha decay",
            "alpha_decay",
            "predictability decay",
            "predictability_decay",
            "declined over time",
            "short-run market efficiency",
            "market efficiency",
            "t-kan",
            "tkan",
            "temporal kolmogorov",
            "tlob",
            "dual attention",
            "horizon bias",
            "spread-adjusted",
            "algorithmic activity",
            "tight spreads",
            "heavier trading",
            "high-volume regimes",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            5,
            "alpha_decay_predictability_stress",
        )
        bump("intraday_tsmom_v2", 3, "alpha_decay_predictability_stress")
        bump(
            "microbar_cross_sectional_pairs_v1",
            3,
            "alpha_decay_predictability_stress",
        )

    if has_any(
        (
            "crumbling quote",
            "crumbling quotes",
            "quote crumble",
            "quote erosion",
            "mechanical liquidity erosion",
            "mechanical liquidity withdrawal",
            "latent microstructure",
            "latent microstructure regime",
            "latent build-up",
            "latent_build_up",
            "early-warning",
            "early warning",
            "rising-edge",
            "rising edge",
            "adaptive threshold",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            7,
            "latent_crumbling_quote_regime",
        )
        bump("intraday_tsmom_v2", 3, "latent_crumbling_quote_regime")
        bump("microbar_cross_sectional_pairs_v1", 3, "latent_crumbling_quote_regime")

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
            "signed order flow",
            "signed_order_flow",
            "core flow",
            "core_flow",
            "filtered orderbook imbalance",
            "filtered_orderbook_imbalance",
            "parent order",
            "parent_order",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "order_flow_or_lob_signal")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "order_flow_or_lob_signal",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            3,
            "order_flow_or_lob_signal",
        )
    if has_any(
        (
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
            "veto calibration",
            "vetoes discard",
            "discard profitable",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "rejected_signal_outcome_calibration",
        )
        bump(
            "microbar_cross_sectional_pairs_v1",
            4,
            "rejected_signal_outcome_calibration",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            4,
            "rejected_signal_outcome_calibration",
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
            "cross-impact",
            "cross impact",
            "cross-effects",
            "cross effects",
            "cross-hedging",
            "cross hedging",
            "multi-asset optimal trade execution",
            "multi asset optimal trade execution",
            "matrix-valued price impact",
            "matrix valued price impact",
            "obizhaeva-wang",
        )
    ):
        bump(
            "microbar_cross_sectional_pairs_v1",
            8,
            "multi_asset_cross_impact_pairs_execution",
        )
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "multi_asset_cross_impact_pairs_execution",
        )
        bump(
            "intraday_tsmom_v2",
            2,
            "multi_asset_cross_impact_pairs_execution",
        )
    impact_ranking_only = has_any(
        (
            "nonlinear impact",
            "nonlinear_impact",
            "square-root",
            "square root",
            "power-law market impact",
            "power law market impact",
            "almgren",
            "route/tca",
            "route_tca",
            "market impact stress",
            "impact stress",
        )
    )
    if has_any(
        (
            "liquidity",
            "execution",
            "shortfall",
            "spread",
            "market-maker",
            "market maker",
            "market impact",
            "market-impact",
            "power-law",
            "power law",
            "square-root",
            "square root",
            "nonlinear impact",
            "nonlinear_impact",
            "maker-taker",
            "maker taker",
        )
    ):
        if impact_ranking_only:
            bump(
                "microstructure_continuation_matched_filter_v1",
                6,
                "nonlinear_impact_route_tca_constraint",
            )
            bump(
                "microbar_cross_sectional_pairs_v1",
                3,
                "nonlinear_impact_route_tca_constraint",
            )
            bump(
                "intraday_tsmom_v2",
                2,
                "nonlinear_impact_route_tca_constraint",
            )
        else:
            bump(
                "mean_reversion_rebound_v1",
                4,
                "liquidity_response_or_execution_stress",
            )
            bump("washout_rebound_v2", 3, "liquidity_response_or_execution_stress")
            bump(
                "mean_reversion_exhaustion_short_v1",
                2,
                "liquidity_response_or_execution_stress",
            )
            bump(
                "microstructure_continuation_matched_filter_v1",
                3,
                "liquidity_response_or_execution_stress",
            )
    if has_any(
        (
            "volatility",
            "regime",
            "latent regime",
            "regime persistence",
            "stress window",
            "nearly unstable",
            "hidden markov",
            "hmm",
            "entropy",
            "fragility",
            "latent build-up",
            "latent_build_up",
            "rising-edge",
            "rising edge",
            "adaptive threshold",
            "forecast horizon",
            "forecast_horizon",
            "horizon-dependent",
            "horizon dependent",
            "regime-dependent",
            "regime dependent",
            "ofi memory",
            "ofi_memory",
            "response-ratio",
            "response ratio",
            "macro news",
            "macro-news",
            "macroeconomic news",
            "price-flow dynamics",
            "price flow dynamics",
            "flow impact",
            "flow_impact",
        )
    ):
        bump("intraday_tsmom_v2", 6, "volatility_or_regime_state")
        bump("momentum_pullback_v1", 2, "volatility_or_regime_state")
        bump("opening_drive_leader_reclaim_v1", 2, "volatility_or_regime_state")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "volatility_or_regime_state",
        )
    if has_any(
        (
            "adverse selection",
            "adverse-selection",
            "toxicity",
            "toxic",
            "absorption",
            "passive buy",
            "passive-buy",
            "fill-side",
            "fill side",
            "quote attribution",
            "quote-attribution",
            "information value",
            "price-flow covariance",
            "price flow covariance",
            "kyle",
            "lambda",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            5,
            "adverse_selection_or_liquidity_toxicity",
        )
        bump("mean_reversion_rebound_v1", 3, "adverse_selection_or_liquidity_toxicity")
        bump(
            "mean_reversion_exhaustion_short_v1",
            3,
            "adverse_selection_or_liquidity_toxicity",
        )
        bump(
            "microbar_cross_sectional_pairs_v1",
            2,
            "adverse_selection_or_liquidity_toxicity",
        )
    if has_any(
        (
            "factor dsl",
            "factor_dsl",
            "factor program",
            "factor_program",
            "append-only experiment trace",
            "append_only_experiment_trace",
            "hypothesis search",
            "constrained llm",
            "fixed splits",
            "fixed-split",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "constrained_factor_search")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "constrained_factor_search",
        )
        bump("intraday_tsmom_v2", 3, "constrained_factor_search")
    if has_any(
        (
            "attention factors",
            "attention factor",
            "conditional latent factor",
            "conditional latent factors",
            "weak factors",
            "residual portfolio",
            "residual portfolios",
            "statistical arbitrage",
            "stat arb",
            "stat-arb",
            "mispricing",
            "similar assets",
            "hierarchical pair trading",
            "hierarchical pairs trading",
            "pair selector",
            "pair selection",
        )
    ):
        bump(
            "microbar_cross_sectional_pairs_v1",
            9,
            "attention_factor_stat_arb_pairs",
        )
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "attention_factor_stat_arb_pairs",
        )
        bump("intraday_tsmom_v2", 2, "attention_factor_stat_arb_pairs")
    if has_any(("momentum", "trend", "pullback", "trend persistence")):
        bump("momentum_pullback_v1", 5, "momentum_or_pullback")
        bump("intraday_tsmom_v2", 4, "momentum_or_pullback")
        bump("opening_drive_leader_reclaim_v1", 3, "momentum_or_pullback")
    if has_any(
        (
            "weighted microprice",
            "microprice momentum",
            "multi-window",
            "multi-level order book",
            "multi level order book",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "microprice_or_multi_level_order_book",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            3,
            "microprice_or_multi_level_order_book",
        )
        bump("breakout_reclaim_v2", 2, "microprice_or_multi_level_order_book")
    if has_any(
        (
            "late-day",
            "late day",
            "late-session",
            "late session",
            "final half-hour",
            "end-of-day",
            "end of day",
            "eod",
            "closing",
            "into the close",
            "macro announcement",
            "announcement",
            "portfolio adjustment",
            "vwap exit",
            "ladder exit",
        )
    ):
        bump("late_day_continuation_v1", 6, "late_session_or_announcement_momentum")
        bump("end_of_day_reversal_v1", 4, "late_session_or_announcement_momentum")
        bump("intraday_tsmom_v2", 2, "late_session_or_announcement_momentum")
        bump("momentum_pullback_v1", 2, "late_session_or_announcement_momentum")
    if has_any(
        (
            "final 30",
            "final half-hour",
            "end-of-day reversal",
            "end of day reversal",
            "eod reversal",
            "intraday loser",
            "intraday losers",
            "late-session loser",
            "late session loser",
            "closing-window",
            "closing window",
            "close reversion",
        )
    ):
        bump("end_of_day_reversal_v1", 7, "closing_window_reversal")
    if has_any(
        (
            "breakout",
            "continuation",
            "reclaim",
            "leader",
            "opening range breakout",
            "orb",
            "stocks in play",
            "overactive stocks",
        )
    ):
        bump("breakout_reclaim_v2", 5, "continuation_or_reclaim")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "continuation_or_reclaim",
        )
    if has_any(
        (
            "first half-hour",
            "first half hour",
            "first 30",
            "morning momentum",
            "opening drive",
            "opening-drive",
            "opening range",
            "opening-range",
            "opening range breakout",
            "opening window",
            "open window",
            "leader reclaim",
            "stocks in play",
            "unusually high daily volume",
            "macro announcement",
            "announcement",
            "information discreteness",
        )
    ):
        bump("opening_drive_leader_reclaim_v1", 7, "morning_or_announcement_momentum")
        bump("late_day_continuation_v1", 3, "morning_or_announcement_momentum")
        bump("intraday_tsmom_v2", 2, "morning_or_announcement_momentum")
    if has_any(("washout", "reversal", "rebound", "mean reversion", "dislocation")):
        bump("washout_rebound_v2", 5, "reversal_or_rebound")
        bump("mean_reversion_rebound_v1", 5, "reversal_or_rebound")
        bump("mean_reversion_exhaustion_short_v1", 3, "reversal_or_rebound")
        bump("end_of_day_reversal_v1", 4, "reversal_or_rebound")
    if has_any(
        (
            "short-side",
            "short side",
            "short sleeve",
            "short-selling",
            "short selling",
            "short fade",
            "fade",
            "exhaustion",
            "overbought",
            "offer pressure",
            "weakness",
            "downside",
            "upside extension",
        )
    ):
        bump("mean_reversion_exhaustion_short_v1", 7, "short_exhaustion_fade")
    if has_any(("relative_volume", "relative volume", "turnover")):
        bump("intraday_tsmom_v2", 2, "relative_volume_or_turnover")
        bump("breakout_reclaim_v2", 2, "relative_volume_or_turnover")
    if has_any(
        (
            "intraday volume",
            "volume forecasting",
            "volume forecast",
            "volume periodicity",
            "periodic volume",
            "vwap",
            "volume weighted average price",
            "volume-weighted average price",
            "u-shape",
            "u shaped",
            "u-shaped",
        )
    ):
        bump("opening_drive_leader_reclaim_v1", 10, "volume_periodicity_execution")
        bump("late_day_continuation_v1", 8, "volume_periodicity_execution")
        bump("intraday_tsmom_v2", 7, "volume_periodicity_execution")
        bump("breakout_reclaim_v2", 6, "volume_periodicity_execution")

    if not any(scores.values()):
        bump("microbar_cross_sectional_pairs_v1", 1, "default_executable_microbar")

    return sorted(
        (
            (family_template_id, score, tuple(reasons[family_template_id]))
            for family_template_id, score in scores.items()
            if score > 0
        ),
        key=lambda item: (-item[1], FAMILY_TIEBREAK.get(item[0], 10**6), item[0]),
    )


def families_for_hypothesis(
    card: HypothesisCard, *, target_net_pnl_per_day: Decimal = Decimal("300")
) -> tuple[tuple[str, int, tuple[str, ...]], ...]:
    scored = family_scores_for_hypothesis(card)
    rejected_signal_rescue = has_rejected_signal_outcome_calibration(card)
    if rejected_signal_rescue or is_validation_or_execution_constraint_only(card):
        family_limit = MAX_FAMILIES_PER_HYPOTHESIS
    else:
        family_limit = (
            PORTFOLIO_SLEEVE_FAMILY_TARGET
            if target_net_pnl_per_day >= PORTFOLIO_TARGET_NET_PNL_PER_DAY
            else MAX_FAMILIES_PER_HYPOTHESIS
        )
    selected = list(scored[:family_limit])
    if family_limit <= MAX_FAMILIES_PER_HYPOTHESIS:
        return tuple(selected)

    selected_family_ids = {family_template_id for family_template_id, _, _ in selected}
    for family_template_id in PORTFOLIO_SLEEVE_FAMILY_ORDER:
        if len(selected) >= family_limit:
            break
        if family_template_id in selected_family_ids:
            continue
        selected.append(
            (
                family_template_id,
                0,
                ("portfolio_sleeve_diversification",),
            )
        )
        selected_family_ids.add(family_template_id)
    return tuple(selected)


__all__ = [
    "family_scores_for_hypothesis",
    "families_for_hypothesis",
]

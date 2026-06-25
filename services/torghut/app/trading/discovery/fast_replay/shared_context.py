"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timezone
from decimal import Decimal
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.adaptive_signal_falsification_stress import (
    extract_adaptive_signal_falsification_stress,
)
from app.trading.discovery.bootstrap_robust_optimization_stress import (
    extract_bootstrap_robust_optimization_stress,
)
from app.trading.discovery.adaptive_market_limit_allocation_stress import (
    extract_adaptive_market_limit_allocation_stress,
)
from app.trading.discovery.alpha_decay_predictability_stress import (
    extract_alpha_decay_predictability_stress,
)
from app.trading.discovery.counterfactual_regime_replay_stress import (
    extract_counterfactual_regime_replay_stress,
)
from app.trading.discovery.cost_aware_forecast_filter_stress import (
    extract_cost_aware_forecast_filter_stress,
)
from app.trading.discovery.cluster_lob_features import (
    HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
    extract_cluster_lob_features,
    extract_hawkes_excitation_summary,
)
from app.trading.discovery.execution_schedule_stress import (
    extract_execution_schedule_stress,
)
from app.trading.discovery.feed_lag_liquidity_stress import (
    extract_feed_lag_liquidity_stress,
)
from app.trading.discovery.hawkes_transient_impact_stress import (
    extract_hawkes_transient_impact_stress,
)
from app.trading.discovery.intraday_jump_burst_stress import (
    extract_intraday_jump_burst_stress,
)
from app.trading.discovery.intraday_price_path_asymmetry_stress import (
    extract_intraday_price_path_asymmetry_stress,
)
from app.trading.discovery.institutional_mechanism_fidelity_stress import (
    extract_institutional_mechanism_fidelity_stress,
)
from app.trading.discovery.lead_lag_cross_asset_stress import (
    extract_lead_lag_cross_asset_stress,
)
from app.trading.discovery.metaorder_adverse_selection_stress import (
    extract_metaorder_adverse_selection_stress,
)
from app.trading.discovery.lob_reality_gap_stress import (
    extract_lob_reality_gap_stress,
)
from app.trading.discovery.microstructure_regime_tokenization_stress import (
    extract_microstructure_regime_tokenization_stress,
)
from app.trading.discovery.microstructure_prefilter import (
    HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL,
    HPAIRS_PREFILTER_PROOF_SOURCE,
    build_hpairs_microstructure_prefilter,
)
from app.trading.discovery.nonlinear_impact_execution_stress import (
    extract_nonlinear_impact_execution_stress,
)
from app.trading.discovery.order_book_observability_stress import (
    extract_order_book_observability_stress,
)
from app.trading.discovery.ofi_response_horizon_stress import (
    extract_ofi_response_horizon_stress,
)
from app.trading.discovery.option_gamma_flow_stress import (
    extract_option_gamma_flow_stress,
)
from app.trading.discovery.order_transition_stress import (
    extract_order_transition_stress,
)
from app.trading.discovery.order_flow_entropy_regime_stress import (
    extract_order_flow_entropy_regime_stress,
)
from app.trading.discovery.queue_survival_fill_stress import (
    extract_queue_survival_fill_stress,
)
from app.trading.discovery.rough_flow_volatility_stress import (
    extract_rough_flow_volatility_stress,
)
from app.trading.discovery.signal_adaptive_execution_resilience_stress import (
    extract_signal_adaptive_execution_resilience_stress,
)
from app.trading.discovery.stochastic_liquidity_resilience_stress import (
    extract_stochastic_liquidity_resilience_stress,
)
from app.trading.discovery.replay_tape import ReplayTapeManifest
from app.trading.models import SignalEnvelope


FAST_REPLAY_PREVIEW_SCHEMA_VERSION = "torghut.fast-replay-preview.v20"

FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION = "torghut.fast-replay-preview-row.v21"

FAST_REPLAY_PROOF_SEMANTICS_LABEL = (
    "preview_ranking_only_exact_replay_and_runtime_ledger_required"
)

FAST_REPLAY_TARGET_NET_PNL_PER_DAY = Decimal("500")

FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT = 4

FAST_REPLAY_DEFAULT_EXPLORATION_COUNT = 2

FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP = 6

FAST_REPLAY_WHITEPAPER_MECHANISMS = (
    "cluster_lob_event_clustering_proxy",
    "bounded_hpairs_clusterlob_ofi_candidate_prefilter",
    "offline_clusterlob_order_flow_feature_lane",
    "hawkes_event_time_excitation_replay_stress",
    "mpc_market_limit_execution_schedule_stress",
    "order_book_observability_feedback_stress",
    "markov_order_transition_latent_regime_stress",
    "order_flow_entropy_hmm_regime_stress",
    "dynamic_lead_lag_cross_asset_stress",
    "queue_position_survival_fill_stress",
    "public_feed_lag_quoted_liquidity_stress",
    "lob_simulation_reality_gap_execution_stress",
    "alpha_decay_predictability_stress",
    "counterfactual_regime_replay_stress",
    "nonlinear_impact_execution_stress",
    "option_gamma_flow_stress",
    "intraday_jump_burst_stress",
    "intraday_price_path_asymmetry_stress",
    "rough_flow_volatility_impact_stress",
    "institutional_mechanism_fidelity_stress",
    "signal_adaptive_execution_resilience_stress",
    "stochastic_liquidity_resilience_execution_stress",
    "microstructure_regime_tokenization_stress",
    "cost_aware_forecast_filter_stress",
    "adaptive_market_limit_allocation_stress",
    "metaorder_adverse_selection_stress",
    "hawkes_transient_impact_execution_stress",
    "ofi_response_horizon_execution_stress",
    "ofi_horizon_decay_regime_screen",
    "macro_news_ofi_stress_veto_if_present",
    "square_root_impact_capacity_prefilter",
    "conformal_tail_risk_prefilter",
    "bootstrap_lower_percentile_utility_prefilter",
    "bootstrap_robust_optimization_stress",
    "adaptive_signal_falsification_stress",
    "implementation_risk_preview_exact_runtime_parity_reporting",
)

FAST_REPLAY_FRONTIER_IDENTITY_SCHEMA_VERSION = (
    "torghut.fast-replay-frontier-identity.v1"
)

FAST_REPLAY_EXACT_FRONTIER_KEY_SCHEMA_VERSION = (
    "torghut.fast-replay-exact-frontier-key.v1"
)

FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION = (
    "torghut.fast-replay-runtime-ledger-lineage-handoff.v1"
)

FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2603.20319",
        "url": "https://arxiv.org/abs/2603.20319",
        "title": (
            "Implementation Risk in Portfolio Backtesting: A Previously "
            "Unquantified Source of Error"
        ),
        "mechanism": (
            "multi_engine_implementation_trace_and_cost_regime_sensitivity_"
            "before_capital_gate"
        ),
    },
    {
        "source_id": "arxiv-2603.21330",
        "url": "https://arxiv.org/abs/2603.21330",
        "title": "FinRL-X: An AI-Native Modular Infrastructure for Quantitative Trading",
        "mechanism": (
            "replay_paper_live_signal_payload_order_sizing_and_execution_"
            "semantic_parity"
        ),
    },
    {
        "source_id": "arxiv-2603.29086",
        "url": "https://arxiv.org/abs/2603.29086",
        "title": (
            "Realistic Market Impact Modeling for Reinforcement Learning "
            "Trading Environments"
        ),
        "mechanism": "trade_level_cost_logging_and_market_impact_trace_materialization",
    },
    {
        "source_id": "doi-10.1093/rof/rfaf049",
        "url": "https://doi.org/10.1093/rof/rfaf049",
        "title": "Retail Limit Orders",
        "mechanism": (
            "market_limit_order_type_fill_probability_opportunity_cost_and_"
            "route_tca_ablation"
        ),
    },
)

FAST_REPLAY_EXACT_SELECTION_SOURCE_INPUT_BLOCKERS = frozenset(
    (
        "missing_price_return_microbar_fields",
        "missing_ofi_or_depth_fields",
        "missing_spread_fields",
        "missing_volume_fields",
    )
)

FAST_REPLAY_EXACT_SELECTION_IMPACT_CAPACITY_BLOCKERS = frozenset(
    (
        "candidate_notional_missing",
        "median_price_missing",
        "median_volume_missing",
    )
)


@dataclass(frozen=True)
class FastReplayPreviewRow:
    candidate_spec_id: str
    rank: int
    preview_score: Decimal
    selected: bool
    selection_reason: str
    matched_row_count: int
    matched_symbol_count: int
    requested_symbol_count: int
    trading_day_count: int
    signed_return_bps: Decimal
    avg_abs_return_bps: Decimal
    median_spread_bps: Decimal
    activity_score: Decimal
    coverage_score: Decimal
    ofi_pressure_score: Decimal
    microprice_bias_bps: Decimal
    spread_tail_bps: Decimal
    return_tail_abs_bps: Decimal
    impact_liquidity_penalty_bps: Decimal
    cluster_lob_activity_score: Decimal
    ofi_decay_alignment_score: Decimal
    liquidity_regime_score: Decimal
    macro_stress_veto_score: Decimal
    conformal_tail_risk_penalty_bps: Decimal
    square_root_impact_capacity_penalty_bps: Decimal
    exploration_score: Decimal
    frontier_bucket: str
    microstructure_prefilter: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    clusterlob_order_flow_features: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    execution_schedule_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    order_book_observability_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    order_transition_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    order_flow_entropy_regime_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    lead_lag_cross_asset_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    queue_survival_fill_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    feed_lag_liquidity_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    lob_reality_gap_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    alpha_decay_predictability_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    counterfactual_regime_replay_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    nonlinear_impact_execution_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    option_gamma_flow_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    intraday_jump_burst_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    intraday_price_path_asymmetry_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    rough_flow_volatility_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    institutional_mechanism_fidelity_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    signal_adaptive_execution_resilience_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    stochastic_liquidity_resilience_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    microstructure_regime_tokenization_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    cost_aware_forecast_filter_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    adaptive_market_limit_allocation_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    metaorder_adverse_selection_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    hawkes_transient_impact_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    ofi_response_horizon_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    bootstrap_robust_optimization_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    adaptive_signal_falsification_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    proof_semantics_label: str = FAST_REPLAY_PROOF_SEMANTICS_LABEL
    candidate_frontier_hash: str = ""
    exact_replay_frontier_key: str = ""
    frontier_dedupe_status: str = "unique"
    duplicate_of_candidate_spec_id: str | None = None
    duplicate_candidate_spec_ids: tuple[str, ...] = ()
    candidate_lineage: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    replay_tape_cache_identity: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    robust_lower_percentile_post_cost_utility_bps: Decimal = Decimal("0")
    bootstrap_lower_percentile_post_cost_utility_bps: Decimal = Decimal("0")

    def to_payload(self) -> dict[str, Any]:
        from .extract_price import (
            mapping as _mapping,
            observed_post_cost_expectancy_bps as _observed_post_cost_expectancy_bps,
            ranking_only_reasons_for_row as _ranking_only_reasons_for_row,
            required_daily_notional_for_target as _required_daily_notional_for_target,
            risk_flags_for_row as _risk_flags_for_row,
            risk_veto_reasons_for_row as _risk_veto_reasons_for_row,
        )
        from .frontier_selection_blockers_for_row import (
            discovery_stage_metadata as _discovery_stage_metadata,
            exact_replay_selection_blockers_for_row as _exact_replay_selection_blockers_for_row,
            frontier_selection_blockers_for_row as _frontier_selection_blockers_for_row,
            lineage_blockers_for_row as _lineage_blockers_for_row,
            row_runtime_ledger_lineage_handoff as _row_runtime_ledger_lineage_handoff,
        )

        observed_post_cost_expectancy_bps = _observed_post_cost_expectancy_bps(self)
        required_daily_notional = _required_daily_notional_for_target(
            observed_post_cost_expectancy_bps
        )
        notional_blocked = required_daily_notional is None
        exact_replay_selection_blockers = _exact_replay_selection_blockers_for_row(self)
        frontier_selection_blockers = _frontier_selection_blockers_for_row(
            self, exact_replay_selection_blockers=exact_replay_selection_blockers
        )
        exact_replay_qualified = self.selected and not exact_replay_selection_blockers
        discovery_stage_metadata = _discovery_stage_metadata(
            selected=self.selected,
            exact_replay_qualified=exact_replay_qualified,
            evidence_collection_candidate=exact_replay_qualified,
            frontier_bucket=self.frontier_bucket,
            blockers=frontier_selection_blockers or exact_replay_selection_blockers,
        )
        lineage_blockers = _lineage_blockers_for_row(self)
        risk_flags = _risk_flags_for_row(self, lineage_blockers=lineage_blockers)
        ranking_only_reasons = _ranking_only_reasons_for_row(
            self, lineage_blockers=lineage_blockers
        )
        risk_veto_reasons = _risk_veto_reasons_for_row(
            self, risk_flags=risk_flags, lineage_blockers=lineage_blockers
        )
        runtime_ledger_lineage_handoff = _row_runtime_ledger_lineage_handoff(
            self, lineage_blockers=lineage_blockers
        )
        prefilter_capacity_lineage = _mapping(
            self.microstructure_prefilter.get("impact_capacity_lineage")
        )
        prefilter_macro_window_stress = _mapping(
            self.microstructure_prefilter.get("macro_window_stress")
        )
        return {
            "schema_version": FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION,
            "candidate_spec_id": self.candidate_spec_id,
            "rank": self.rank,
            "preview_score": str(self.preview_score),
            "preview_rank_score": str(self.preview_score),
            "robust_lower_percentile_post_cost_utility_bps": str(
                self.robust_lower_percentile_post_cost_utility_bps
            ),
            "bootstrap_lower_percentile_post_cost_utility_bps": str(
                self.bootstrap_lower_percentile_post_cost_utility_bps
            ),
            "selected": self.selected,
            "selection_reason": self.selection_reason,
            "matched_row_count": self.matched_row_count,
            "matched_symbol_count": self.matched_symbol_count,
            "requested_symbol_count": self.requested_symbol_count,
            "trading_day_count": self.trading_day_count,
            "signed_return_bps": str(self.signed_return_bps),
            "avg_abs_return_bps": str(self.avg_abs_return_bps),
            "median_spread_bps": str(self.median_spread_bps),
            "activity_score": str(self.activity_score),
            "coverage_score": str(self.coverage_score),
            "ofi_pressure_score": str(self.ofi_pressure_score),
            "microprice_bias_bps": str(self.microprice_bias_bps),
            "spread_tail_bps": str(self.spread_tail_bps),
            "return_tail_abs_bps": str(self.return_tail_abs_bps),
            "impact_liquidity_penalty_bps": str(self.impact_liquidity_penalty_bps),
            "cluster_lob_activity_score": str(self.cluster_lob_activity_score),
            "ofi_decay_alignment_score": str(self.ofi_decay_alignment_score),
            "liquidity_regime_score": str(self.liquidity_regime_score),
            "macro_stress_veto_score": str(self.macro_stress_veto_score),
            "conformal_tail_risk_penalty_bps": str(
                self.conformal_tail_risk_penalty_bps
            ),
            "square_root_impact_capacity_penalty_bps": str(
                self.square_root_impact_capacity_penalty_bps
            ),
            "exploration_score": str(self.exploration_score),
            "frontier_bucket": self.frontier_bucket,
            "execution_schedule_stress": dict(self.execution_schedule_stress),
            "order_book_observability_stress": dict(
                self.order_book_observability_stress
            ),
            "order_transition_stress": dict(self.order_transition_stress),
            "order_flow_entropy_regime_stress": dict(
                self.order_flow_entropy_regime_stress
            ),
            "lead_lag_cross_asset_stress": dict(self.lead_lag_cross_asset_stress),
            "queue_survival_fill_stress": dict(self.queue_survival_fill_stress),
            "feed_lag_liquidity_stress": dict(self.feed_lag_liquidity_stress),
            "lob_reality_gap_stress": dict(self.lob_reality_gap_stress),
            "alpha_decay_predictability_stress": dict(
                self.alpha_decay_predictability_stress
            ),
            "counterfactual_regime_replay_stress": dict(
                self.counterfactual_regime_replay_stress
            ),
            "nonlinear_impact_execution_stress": dict(
                self.nonlinear_impact_execution_stress
            ),
            "option_gamma_flow_stress": dict(self.option_gamma_flow_stress),
            "intraday_jump_burst_stress": dict(self.intraday_jump_burst_stress),
            "intraday_price_path_asymmetry_stress": dict(
                self.intraday_price_path_asymmetry_stress
            ),
            "rough_flow_volatility_stress": dict(self.rough_flow_volatility_stress),
            "ofi_response_horizon_stress": dict(self.ofi_response_horizon_stress),
            "institutional_mechanism_fidelity_stress": dict(
                self.institutional_mechanism_fidelity_stress
            ),
            "signal_adaptive_execution_resilience_stress": dict(
                self.signal_adaptive_execution_resilience_stress
            ),
            "stochastic_liquidity_resilience_stress": dict(
                self.stochastic_liquidity_resilience_stress
            ),
            "microstructure_regime_tokenization_stress": dict(
                self.microstructure_regime_tokenization_stress
            ),
            "cost_aware_forecast_filter_stress": dict(
                self.cost_aware_forecast_filter_stress
            ),
            "adaptive_market_limit_allocation_stress": dict(
                self.adaptive_market_limit_allocation_stress
            ),
            "metaorder_adverse_selection_stress": dict(
                self.metaorder_adverse_selection_stress
            ),
            "hawkes_transient_impact_stress": dict(self.hawkes_transient_impact_stress),
            "bootstrap_robust_optimization_stress": dict(
                self.bootstrap_robust_optimization_stress
            ),
            "adaptive_signal_falsification_stress": dict(
                self.adaptive_signal_falsification_stress
            ),
            "ranking_only_reasons": list(ranking_only_reasons),
            "risk_veto_reasons": list(risk_veto_reasons),
            "exact_replay_required": True,
            "runtime_ledger_required": True,
            "source_backed_runtime_ledger_required": True,
            "discovery_stage_metadata": discovery_stage_metadata,
            "candidate_frontier_hash": self.candidate_frontier_hash,
            "exact_replay_frontier_key": self.exact_replay_frontier_key,
            "frontier_dedupe_status": self.frontier_dedupe_status,
            "duplicate_of_candidate_spec_id": self.duplicate_of_candidate_spec_id,
            "duplicate_candidate_spec_ids": list(self.duplicate_candidate_spec_ids),
            "candidate_lineage": dict(self.candidate_lineage),
            "replay_tape_cache_identity": dict(self.replay_tape_cache_identity),
            "runtime_ledger_lineage_materialization_handoff": (
                runtime_ledger_lineage_handoff
            ),
            "frontier_selection": {
                "schema_version": "torghut.fast-replay-frontier-selection.v1",
                "selected": self.selected,
                "frontier_bucket": self.frontier_bucket,
                "reason_code": self.selection_reason,
                "blockers": list(frontier_selection_blockers),
                "rank": self.rank,
                "preview_rank_score": str(self.preview_score),
                "robust_lower_percentile_post_cost_utility_bps": str(
                    self.robust_lower_percentile_post_cost_utility_bps
                ),
                "ranking_only_reasons": list(ranking_only_reasons),
                "risk_veto_reasons": list(risk_veto_reasons),
                "exact_replay_required": True,
                "runtime_ledger_required": True,
                "exact_replay_enqueue_allowed": exact_replay_qualified,
                "bounded_sim_evidence_enqueue_allowed": exact_replay_qualified,
                "discovery_stage_metadata": discovery_stage_metadata,
                "resource_scope": "local_offline_bounded_queue_metadata_only",
                "proof_source": "prefilter_only",
                "prefilter_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            },
            "frontier_dedupe_metadata": {
                "schema_version": "torghut.fast-replay-frontier-dedupe.v1",
                "status": self.frontier_dedupe_status,
                "candidate_frontier_hash": self.candidate_frontier_hash,
                "exact_replay_frontier_key": self.exact_replay_frontier_key,
                "duplicate_of_candidate_spec_id": self.duplicate_of_candidate_spec_id,
                "duplicate_candidate_spec_ids": list(self.duplicate_candidate_spec_ids),
                "dedupe_scope": "same_replay_tape_cache_and_execution_identity",
                "proof_source": "prefilter_only",
                "prefilter_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            },
            "clusterlob_order_flow_features": dict(self.clusterlob_order_flow_features),
            "hpairs_clusterlob_order_flow_feature_lane": dict(
                self.clusterlob_order_flow_features
            ),
            "microstructure_prefilter": dict(self.microstructure_prefilter),
            "hpairs_microstructure_prefilter": dict(self.microstructure_prefilter),
            "hpairs_macro_window_stress": prefilter_macro_window_stress,
            "hpairs_impact_capacity_lineage": prefilter_capacity_lineage,
            "proof_source": HPAIRS_PREFILTER_PROOF_SOURCE,
            "hpairs_prefilter_proof_semantics_label": HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL,
            "observed_post_cost_expectancy_bps": str(observed_post_cost_expectancy_bps),
            "required_daily_notional": str(required_daily_notional)
            if required_daily_notional is not None
            else None,
            "target_implied_notional_context": {
                "target_net_pnl_per_day": str(FAST_REPLAY_TARGET_NET_PNL_PER_DAY),
                "observed_post_cost_expectancy_bps": str(
                    observed_post_cost_expectancy_bps
                ),
                "formula": "target_net_pnl_per_day/(observed_post_cost_expectancy_bps/10000)",
                "required_daily_notional": str(required_daily_notional)
                if required_daily_notional is not None
                else None,
                "feasibility_status": (
                    "blocked_non_positive_post_cost_expectancy"
                    if notional_blocked
                    else "unknown_source_backed_adv_required"
                ),
                "blocked": notional_blocked,
                "prefilter_only": True,
            },
            "exact_replay_selection_blocked": bool(exact_replay_selection_blockers),
            "exact_replay_selection_blockers": list(exact_replay_selection_blockers),
            "cost_impact_lineage": {
                "status": "preview_prefilter_only",
                "source": "manifest_verified_replay_tape",
                "cost_basis": "signed_return_minus_spread_plus_square_root_impact_penalty",
                "impact_model": "square_root_power_law_capacity_proxy",
                "median_spread_bps": str(self.median_spread_bps),
                "impact_liquidity_penalty_bps": str(self.impact_liquidity_penalty_bps),
                "square_root_impact_capacity_penalty_bps": str(
                    self.square_root_impact_capacity_penalty_bps
                ),
                "observed_post_cost_expectancy_bps": str(
                    observed_post_cost_expectancy_bps
                ),
                "hpairs_prefilter_impact_capacity_lineage": prefilter_capacity_lineage,
            },
            "impact_capacity_lineage": prefilter_capacity_lineage,
            "adv_capacity_context": {
                "status": "missing_source_backed_adv",
                "source": "missing_external_adv_source",
                "as_of": None,
                "as_of_status": "missing",
                "prefilter_only": True,
            },
            "lineage_blockers": list(lineage_blockers),
            "risk_flags": list(risk_flags),
            "proof_semantics_label": self.proof_semantics_label,
            "whitepaper_mechanisms": list(FAST_REPLAY_WHITEPAPER_MECHANISMS),
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_authority_reason": (
                "fast_replay_preview_rank_only_exact_replay_and_source_backed_runtime_ledger_required"
            ),
        }


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "CandidateSpec",
    "Decimal",
    "FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT",
    "FAST_REPLAY_DEFAULT_EXPLORATION_COUNT",
    "FAST_REPLAY_EXACT_FRONTIER_KEY_SCHEMA_VERSION",
    "FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP",
    "FAST_REPLAY_EXACT_SELECTION_IMPACT_CAPACITY_BLOCKERS",
    "FAST_REPLAY_EXACT_SELECTION_SOURCE_INPUT_BLOCKERS",
    "FAST_REPLAY_FRONTIER_IDENTITY_SCHEMA_VERSION",
    "FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION",
    "FAST_REPLAY_PREVIEW_SCHEMA_VERSION",
    "FAST_REPLAY_PROOF_SEMANTICS_LABEL",
    "FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION",
    "FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SOURCES",
    "FAST_REPLAY_TARGET_NET_PNL_PER_DAY",
    "FAST_REPLAY_WHITEPAPER_MECHANISMS",
    "FastReplayPreviewRow",
    "HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION",
    "HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL",
    "HPAIRS_PREFILTER_PROOF_SOURCE",
    "Mapping",
    "NDArray",
    "ReplayTapeManifest",
    "Sequence",
    "SignalEnvelope",
    "annotations",
    "build_hpairs_microstructure_prefilter",
    "cast",
    "dataclass",
    "extract_adaptive_market_limit_allocation_stress",
    "extract_adaptive_signal_falsification_stress",
    "extract_alpha_decay_predictability_stress",
    "extract_bootstrap_robust_optimization_stress",
    "extract_cluster_lob_features",
    "extract_cost_aware_forecast_filter_stress",
    "extract_counterfactual_regime_replay_stress",
    "extract_execution_schedule_stress",
    "extract_feed_lag_liquidity_stress",
    "extract_hawkes_excitation_summary",
    "extract_hawkes_transient_impact_stress",
    "extract_institutional_mechanism_fidelity_stress",
    "extract_intraday_jump_burst_stress",
    "extract_intraday_price_path_asymmetry_stress",
    "extract_lead_lag_cross_asset_stress",
    "extract_lob_reality_gap_stress",
    "extract_metaorder_adverse_selection_stress",
    "extract_microstructure_regime_tokenization_stress",
    "extract_nonlinear_impact_execution_stress",
    "extract_ofi_response_horizon_stress",
    "extract_option_gamma_flow_stress",
    "extract_order_book_observability_stress",
    "extract_order_flow_entropy_regime_stress",
    "extract_order_transition_stress",
    "extract_queue_survival_fill_stress",
    "extract_rough_flow_volatility_stress",
    "extract_signal_adaptive_execution_resilience_stress",
    "extract_stochastic_liquidity_resilience_stress",
    "field",
    "hashlib",
    "json",
    "np",
    "timezone",
)

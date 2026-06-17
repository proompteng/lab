from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
# ruff: noqa: F401,F811,F821
from typing import Any
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
from app.trading.discovery.lob_reality_gap_stress import extract_lob_reality_gap_stress
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

FAST_REPLAY_PREVIEW_SCHEMA_VERSION: Any
FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION: Any
FAST_REPLAY_PROOF_SEMANTICS_LABEL: Any
FAST_REPLAY_TARGET_NET_PNL_PER_DAY: Any
FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT: Any
FAST_REPLAY_DEFAULT_EXPLORATION_COUNT: Any
FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP: Any
FAST_REPLAY_WHITEPAPER_MECHANISMS: Any
FAST_REPLAY_FRONTIER_IDENTITY_SCHEMA_VERSION: Any
FAST_REPLAY_EXACT_FRONTIER_KEY_SCHEMA_VERSION: Any
FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION: Any
FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SOURCES: tuple[Mapping[str, str], ...]
FAST_REPLAY_EXACT_SELECTION_SOURCE_INPUT_BLOCKERS: Any
FAST_REPLAY_EXACT_SELECTION_IMPACT_CAPACITY_BLOCKERS: Any

class FastReplayPreviewRow:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    microstructure_prefilter: Mapping[str, Any]
    clusterlob_order_flow_features: Mapping[str, Any]
    execution_schedule_stress: Mapping[str, Any]
    order_book_observability_stress: Mapping[str, Any]
    order_transition_stress: Mapping[str, Any]
    order_flow_entropy_regime_stress: Mapping[str, Any]
    lead_lag_cross_asset_stress: Mapping[str, Any]
    queue_survival_fill_stress: Mapping[str, Any]
    feed_lag_liquidity_stress: Mapping[str, Any]
    lob_reality_gap_stress: Mapping[str, Any]
    alpha_decay_predictability_stress: Mapping[str, Any]
    counterfactual_regime_replay_stress: Mapping[str, Any]
    nonlinear_impact_execution_stress: Mapping[str, Any]
    option_gamma_flow_stress: Mapping[str, Any]
    intraday_jump_burst_stress: Mapping[str, Any]
    intraday_price_path_asymmetry_stress: Mapping[str, Any]
    rough_flow_volatility_stress: Mapping[str, Any]
    institutional_mechanism_fidelity_stress: Mapping[str, Any]
    signal_adaptive_execution_resilience_stress: Mapping[str, Any]
    stochastic_liquidity_resilience_stress: Mapping[str, Any]
    microstructure_regime_tokenization_stress: Mapping[str, Any]
    cost_aware_forecast_filter_stress: Mapping[str, Any]
    adaptive_market_limit_allocation_stress: Mapping[str, Any]
    metaorder_adverse_selection_stress: Mapping[str, Any]
    hawkes_transient_impact_stress: Mapping[str, Any]
    ofi_response_horizon_stress: Mapping[str, Any]
    bootstrap_robust_optimization_stress: Mapping[str, Any]
    adaptive_signal_falsification_stress: Mapping[str, Any]
    proof_semantics_label: str
    candidate_frontier_hash: str
    exact_replay_frontier_key: str
    frontier_dedupe_status: str
    duplicate_of_candidate_spec_id: str | None
    duplicate_candidate_spec_ids: tuple[str, ...]
    candidate_lineage: Mapping[str, Any]
    replay_tape_cache_identity: Mapping[str, Any]
    robust_lower_percentile_post_cost_utility_bps: Decimal
    bootstrap_lower_percentile_post_cost_utility_bps: Decimal
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class FastReplayPreviewResult:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    rows: tuple[FastReplayPreviewRow, ...]
    selected_candidate_spec_ids: tuple[str, ...]
    requested_top_k: int
    input_candidate_count: int
    replay_tape_manifest: ReplayTapeManifest
    selected_row_count: int
    exploitation_candidate_count: int
    exploration_candidate_count: int
    exact_replay_candidate_cap: int
    hpairs_microstructure_prefilter: Mapping[str, Any]
    clusterlob_order_flow_feature_lane: Mapping[str, Any]
    def to_manifest_payload(*args: Any, **kwargs: Any) -> Any: ...

class _SymbolTapeStats:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    symbol: str
    row_count: int
    trading_day_count: int
    returns_bps: NDArray[np.float64]
    ofi_values: NDArray[np.float64]
    median_spread_bps: float
    spread_tail_bps: float
    ofi_pressure_score: float
    ofi_decay_score: float
    ofi_memory_regime_score: float
    microprice_bias_bps: float
    median_volume: float
    median_price: float
    return_tail_abs_bps: float
    cluster_lob_activity_score: float
    liquidity_regime_score: float
    macro_stress_veto_score: float
    source_rows: tuple[SignalEnvelope, ...]

def build_fast_replay_preview(*args: Any, **kwargs: Any) -> Any: ...
def _build_symbol_stats(*args: Any, **kwargs: Any) -> Any: ...
def _build_clusterlob_feature_lane_by_symbol(*args: Any, **kwargs: Any) -> Any: ...
def _candidate_clusterlob_feature_lane(*args: Any, **kwargs: Any) -> Any: ...
def _clusterlob_feature_lane_manifest(*args: Any, **kwargs: Any) -> Any: ...
def _clusterlob_feature_lane_score(*args: Any, **kwargs: Any) -> Any: ...
def _score_candidate_spec(*args: Any, **kwargs: Any) -> Any: ...
def _preview_rank_key(*args: Any, **kwargs: Any) -> Any: ...
def _risk_adjusted_robust_rank_score(*args: Any, **kwargs: Any) -> Any: ...
def _execution_schedule_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _order_book_observability_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _order_transition_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _order_flow_entropy_regime_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _lead_lag_cross_asset_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _queue_survival_fill_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _feed_lag_liquidity_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _lob_reality_gap_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _alpha_decay_predictability_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _counterfactual_regime_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _nonlinear_impact_execution_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _option_gamma_flow_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _intraday_jump_burst_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _intraday_price_path_asymmetry_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _rough_flow_volatility_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _institutional_mechanism_fidelity_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _signal_adaptive_execution_resilience_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _stochastic_liquidity_resilience_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _microstructure_regime_tokenization_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _cost_aware_forecast_filter_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _adaptive_market_limit_allocation_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _metaorder_adverse_selection_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _hawkes_transient_impact_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _ofi_response_horizon_rank_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _bootstrap_robust_optimization_rank_penalty_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _row_explicitly_non_hpairs(*args: Any, **kwargs: Any) -> Any: ...
def _mark_frontier_duplicates(*args: Any, **kwargs: Any) -> Any: ...
def _frontier_dedupe_key(*args: Any, **kwargs: Any) -> Any: ...
def _row_frontier_duplicate_filtered(*args: Any, **kwargs: Any) -> Any: ...
def _select_frontier_buckets(*args: Any, **kwargs: Any) -> Any: ...
def _row_exploration_diversity_key(*args: Any, **kwargs: Any) -> Any: ...
def _row_with_rank_and_selection(*args: Any, **kwargs: Any) -> Any: ...
def _row_with_frontier_dedupe(*args: Any, **kwargs: Any) -> Any: ...
def _frontier_selection_blockers_for_row(*args: Any, **kwargs: Any) -> Any: ...
def _selected_candidate_ids_by_bucket(*args: Any, **kwargs: Any) -> Any: ...
def _runtime_ledger_lineage_handoff_manifest(*args: Any, **kwargs: Any) -> Any: ...
def _row_runtime_ledger_lineage_handoff(*args: Any, **kwargs: Any) -> Any: ...
def _runtime_ledger_required_artifacts(*args: Any, **kwargs: Any) -> Any: ...
def _discovery_stage_semantics(*args: Any, **kwargs: Any) -> Any: ...
def _discovery_stage_metadata(*args: Any, **kwargs: Any) -> Any: ...
def _row_exact_replay_selection_blocked(*args: Any, **kwargs: Any) -> Any: ...
def _exact_replay_selection_blockers_for_row(*args: Any, **kwargs: Any) -> Any: ...
def _post_cost_utility_distribution_bps(*args: Any, **kwargs: Any) -> Any: ...
def _lower_percentile_post_cost_utility_bps(*args: Any, **kwargs: Any) -> Any: ...
def _bootstrap_lower_percentile_post_cost_utility_bps(
    *args: Any, **kwargs: Any
) -> Any: ...
def _ofi_decay_score(*args: Any, **kwargs: Any) -> Any: ...
def _combined_ofi_decay_score(*args: Any, **kwargs: Any) -> Any: ...
def _ewma_last(*args: Any, **kwargs: Any) -> Any: ...
def _cluster_lob_activity_score(*args: Any, **kwargs: Any) -> Any: ...
def _event_label(*args: Any, **kwargs: Any) -> Any: ...
def _normalized_entropy(*args: Any, **kwargs: Any) -> Any: ...
def _liquidity_regime_score(*args: Any, **kwargs: Any) -> Any: ...
def _macro_stress_veto_score(*args: Any, **kwargs: Any) -> Any: ...
def _extract_macro_stress(*args: Any, **kwargs: Any) -> Any: ...
def _conformal_tail_risk_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _square_root_impact_capacity_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _candidate_notional(*args: Any, **kwargs: Any) -> Any: ...
def _candidate_lineage(*args: Any, **kwargs: Any) -> Any: ...
def _candidate_frontier_hash(*args: Any, **kwargs: Any) -> Any: ...
def _exact_replay_frontier_key(*args: Any, **kwargs: Any) -> Any: ...
def _candidate_symbols(*args: Any, **kwargs: Any) -> Any: ...
def _candidate_direction(*args: Any, **kwargs: Any) -> Any: ...
def _extract_price(*args: Any, **kwargs: Any) -> Any: ...
def _extract_spread_bps(*args: Any, **kwargs: Any) -> Any: ...
def _extract_ofi_pressure(*args: Any, **kwargs: Any) -> Any: ...
def _extract_ofi_memory_regime_score(*args: Any, **kwargs: Any) -> Any: ...
def _extract_quote_depth_imbalance(*args: Any, **kwargs: Any) -> Any: ...
def _extract_microprice_bias_bps(*args: Any, **kwargs: Any) -> Any: ...
def _extract_volume(*args: Any, **kwargs: Any) -> Any: ...
def _impact_liquidity_penalty_bps(*args: Any, **kwargs: Any) -> Any: ...
def _weighted_average(*args: Any, **kwargs: Any) -> Any: ...
def _first_float(*args: Any, **kwargs: Any) -> Any: ...
def _float_or_none(*args: Any, **kwargs: Any) -> Any: ...
def _hpairs_replay_tape_features(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_from_float(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_string_from_float(*args: Any, **kwargs: Any) -> Any: ...
def _observed_post_cost_expectancy_bps(*args: Any, **kwargs: Any) -> Any: ...
def _required_daily_notional_for_target(*args: Any, **kwargs: Any) -> Any: ...
def _lineage_blockers_for_row(*args: Any, **kwargs: Any) -> Any: ...
def _risk_flags_for_row(*args: Any, **kwargs: Any) -> Any: ...
def _ranking_only_reasons_for_row(*args: Any, **kwargs: Any) -> Any: ...
def _risk_veto_reasons_for_row(*args: Any, **kwargs: Any) -> Any: ...
def _mapping(*args: Any, **kwargs: Any) -> Any: ...
def _string_tuple(*args: Any, **kwargs: Any) -> Any: ...
def _stable_hash(*args: Any, **kwargs: Any) -> Any: ...
def _json_ready(*args: Any, **kwargs: Any) -> Any: ...
def _string(*args: Any, **kwargs: Any) -> Any: ...

__all__: Any

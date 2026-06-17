# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821

from .shared_context import (
    FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT,
    FAST_REPLAY_DEFAULT_EXPLORATION_COUNT,
    FAST_REPLAY_EXACT_FRONTIER_KEY_SCHEMA_VERSION,
    FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
    FAST_REPLAY_EXACT_SELECTION_IMPACT_CAPACITY_BLOCKERS,
    FAST_REPLAY_EXACT_SELECTION_SOURCE_INPUT_BLOCKERS,
    FAST_REPLAY_FRONTIER_IDENTITY_SCHEMA_VERSION,
    FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION,
    FAST_REPLAY_PREVIEW_SCHEMA_VERSION,
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION,
    FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SOURCES,
    FAST_REPLAY_TARGET_NET_PNL_PER_DAY,
    FAST_REPLAY_WHITEPAPER_MECHANISMS,
    FastReplayPreviewRow,
)
from .fast_replay_preview_result import (
    FastReplayPreviewResult,
    SymbolTapeStats as _SymbolTapeStats,
    build_clusterlob_feature_lane_by_symbol as _build_clusterlob_feature_lane_by_symbol,
    build_symbol_stats as _build_symbol_stats,
    build_fast_replay_preview,
)
from .candidate_clusterlob_feature_lane import (
    candidate_clusterlob_feature_lane as _candidate_clusterlob_feature_lane,
    clusterlob_feature_lane_manifest as _clusterlob_feature_lane_manifest,
    clusterlob_feature_lane_score as _clusterlob_feature_lane_score,
)


def _score_candidate_spec(
    *,
    spec: CandidateSpec,
    symbol_stats: Mapping[str, _SymbolTapeStats],
    min_rows_per_candidate: int,
    microstructure_prefilter: Mapping[str, Any],
    clusterlob_order_flow_features: Mapping[str, Any],
    replay_tape_manifest: ReplayTapeManifest,
) -> FastReplayPreviewRow:
    from .extract_price import (
        decimal_from_float as _decimal_from_float,
        float_or_none as _float_or_none,
        impact_liquidity_penalty_bps as _impact_liquidity_penalty_bps,
        mapping as _mapping,
        weighted_average as _weighted_average,
    )
    from .frontier_selection_blockers_for_row import (
        bootstrap_lower_percentile_post_cost_utility_bps as _bootstrap_lower_percentile_post_cost_utility_bps,
        candidate_direction as _candidate_direction,
        candidate_frontier_hash as _candidate_frontier_hash,
        candidate_lineage as _candidate_lineage,
        candidate_notional as _candidate_notional,
        candidate_symbols as _candidate_symbols,
        conformal_tail_risk_penalty_bps as _conformal_tail_risk_penalty_bps,
        exact_replay_frontier_key as _exact_replay_frontier_key,
        lower_percentile_post_cost_utility_bps as _lower_percentile_post_cost_utility_bps,
        post_cost_utility_distribution_bps as _post_cost_utility_distribution_bps,
        square_root_impact_capacity_penalty_bps as _square_root_impact_capacity_penalty_bps,
    )

    candidate_frontier_hash = _candidate_frontier_hash(spec)
    exact_replay_frontier_key = _exact_replay_frontier_key(
        replay_tape_manifest=replay_tape_manifest,
        candidate_frontier_hash=candidate_frontier_hash,
    )
    requested_symbols = _candidate_symbols(spec)
    matched = [
        stat for symbol in requested_symbols if (stat := symbol_stats.get(symbol))
    ]
    matched_row_count = sum(stat.row_count for stat in matched)
    requested_symbol_count = len(requested_symbols)
    matched_symbol_count = len(matched)
    if matched_row_count < min_rows_per_candidate or not matched:
        return FastReplayPreviewRow(
            candidate_spec_id=spec.candidate_spec_id,
            rank=0,
            preview_score=Decimal("-1000000"),
            selected=False,
            selection_reason="insufficient_replay_tape_rows",
            matched_row_count=matched_row_count,
            matched_symbol_count=matched_symbol_count,
            requested_symbol_count=requested_symbol_count,
            trading_day_count=max(
                (stat.trading_day_count for stat in matched), default=0
            ),
            signed_return_bps=Decimal("0"),
            avg_abs_return_bps=Decimal("0"),
            median_spread_bps=Decimal("0"),
            activity_score=Decimal("0"),
            coverage_score=Decimal("0"),
            ofi_pressure_score=Decimal("0"),
            microprice_bias_bps=Decimal("0"),
            spread_tail_bps=Decimal("0"),
            return_tail_abs_bps=Decimal("0"),
            impact_liquidity_penalty_bps=Decimal("0"),
            cluster_lob_activity_score=Decimal("0"),
            ofi_decay_alignment_score=Decimal("0"),
            liquidity_regime_score=Decimal("0"),
            macro_stress_veto_score=Decimal("0"),
            conformal_tail_risk_penalty_bps=Decimal("0"),
            square_root_impact_capacity_penalty_bps=Decimal("0"),
            exploration_score=Decimal("0"),
            frontier_bucket="not_selected",
            microstructure_prefilter=dict(microstructure_prefilter),
            clusterlob_order_flow_features=dict(clusterlob_order_flow_features),
            execution_schedule_stress={},
            order_book_observability_stress={},
            order_transition_stress={},
            order_flow_entropy_regime_stress={},
            lead_lag_cross_asset_stress={},
            queue_survival_fill_stress={},
            feed_lag_liquidity_stress={},
            lob_reality_gap_stress={},
            alpha_decay_predictability_stress={},
            counterfactual_regime_replay_stress={},
            nonlinear_impact_execution_stress={},
            option_gamma_flow_stress={},
            intraday_jump_burst_stress={},
            intraday_price_path_asymmetry_stress={},
            rough_flow_volatility_stress={},
            institutional_mechanism_fidelity_stress={},
            signal_adaptive_execution_resilience_stress={},
            stochastic_liquidity_resilience_stress={},
            microstructure_regime_tokenization_stress={},
            cost_aware_forecast_filter_stress={},
            adaptive_market_limit_allocation_stress={},
            metaorder_adverse_selection_stress={},
            hawkes_transient_impact_stress={},
            candidate_frontier_hash=candidate_frontier_hash,
            exact_replay_frontier_key=exact_replay_frontier_key,
            candidate_lineage=_candidate_lineage(spec),
            replay_tape_cache_identity=replay_tape_manifest.cache_identity_diagnostics(),
        )

    return_vectors = [stat.returns_bps for stat in matched if stat.returns_bps.size]
    returns = (
        np.concatenate(return_vectors)
        if return_vectors
        else np.asarray([], dtype=np.float64)
    )
    direction = _candidate_direction(spec)
    signed_returns = (
        returns * direction if returns.size else np.asarray([], dtype=np.float64)
    )
    signed_return_bps = float(np.mean(signed_returns)) if signed_returns.size else 0.0
    avg_abs_return_bps = float(np.mean(np.abs(returns))) if returns.size else 0.0
    median_spread_bps = float(np.median([stat.median_spread_bps for stat in matched]))
    spread_tail_bps = float(np.median([stat.spread_tail_bps for stat in matched]))
    ofi_pressure_score = _weighted_average(
        [(stat.ofi_pressure_score, stat.row_count) for stat in matched]
    )
    ofi_decay_alignment_score = direction * _weighted_average(
        [(stat.ofi_decay_score, stat.row_count) for stat in matched]
    )
    microprice_bias_bps = _weighted_average(
        [(stat.microprice_bias_bps, stat.row_count) for stat in matched]
    )
    return_tail_abs_bps = float(
        np.median([stat.return_tail_abs_bps for stat in matched])
    )
    median_volume = float(np.median([stat.median_volume for stat in matched]))
    median_price = float(np.median([stat.median_price for stat in matched]))
    activity_score = float(np.log1p(matched_row_count))
    coverage_score = matched_symbol_count / max(1, requested_symbol_count)
    cluster_lob_activity_score = _weighted_average(
        [(stat.cluster_lob_activity_score, stat.row_count) for stat in matched]
    )
    liquidity_regime_score = _weighted_average(
        [(stat.liquidity_regime_score, stat.row_count) for stat in matched]
    )
    macro_stress_veto_score = _weighted_average(
        [(stat.macro_stress_veto_score, stat.row_count) for stat in matched]
    )
    matched_source_rows = tuple(row for stat in matched for row in stat.source_rows)
    execution_schedule_stress = extract_execution_schedule_stress(
        matched_source_rows,
        direction=direction,
        max_notional=_candidate_notional(spec),
    ).to_payload()
    execution_schedule_rank_penalty_bps = (
        _float_or_none(
            _mapping(execution_schedule_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    order_book_observability_stress = extract_order_book_observability_stress(
        matched_source_rows,
        direction=direction,
        max_notional=_candidate_notional(spec),
    ).to_payload()
    order_book_observability_rank_penalty_bps = (
        _float_or_none(
            _mapping(order_book_observability_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    order_transition_stress = extract_order_transition_stress(
        matched_source_rows
    ).to_payload()
    order_transition_rank_penalty_bps = (
        _float_or_none(
            _mapping(order_transition_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    order_flow_entropy_regime_stress = extract_order_flow_entropy_regime_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    order_flow_entropy_regime_rank_penalty_bps = (
        _float_or_none(
            _mapping(order_flow_entropy_regime_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    lead_lag_cross_asset_stress = extract_lead_lag_cross_asset_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    lead_lag_cross_asset_rank_penalty_bps = (
        _float_or_none(
            _mapping(lead_lag_cross_asset_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    queue_survival_fill_stress = extract_queue_survival_fill_stress(
        matched_source_rows,
        direction=direction,
        max_notional=_candidate_notional(spec),
    ).to_payload()
    queue_survival_fill_rank_penalty_bps = (
        _float_or_none(
            _mapping(queue_survival_fill_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    feed_lag_liquidity_stress = extract_feed_lag_liquidity_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    feed_lag_liquidity_rank_penalty_bps = (
        _float_or_none(
            _mapping(feed_lag_liquidity_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    lob_reality_gap_stress = extract_lob_reality_gap_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    lob_reality_gap_rank_penalty_bps = (
        _float_or_none(
            _mapping(lob_reality_gap_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    alpha_decay_predictability_stress = extract_alpha_decay_predictability_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    alpha_decay_predictability_rank_penalty_bps = (
        _float_or_none(
            _mapping(alpha_decay_predictability_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    counterfactual_regime_replay_stress = extract_counterfactual_regime_replay_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    counterfactual_regime_rank_penalty_bps = (
        _float_or_none(
            _mapping(counterfactual_regime_replay_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    nonlinear_impact_execution_stress = extract_nonlinear_impact_execution_stress(
        matched_source_rows,
        direction=direction,
        max_notional=_candidate_notional(spec),
    ).to_payload()
    nonlinear_impact_execution_rank_penalty_bps = (
        _float_or_none(
            _mapping(nonlinear_impact_execution_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    option_gamma_flow_stress = extract_option_gamma_flow_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    option_gamma_flow_rank_penalty_bps = (
        _float_or_none(
            _mapping(option_gamma_flow_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    intraday_jump_burst_stress = extract_intraday_jump_burst_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    intraday_jump_burst_rank_penalty_bps = (
        _float_or_none(
            _mapping(intraday_jump_burst_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    intraday_price_path_asymmetry_stress = extract_intraday_price_path_asymmetry_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    intraday_price_path_asymmetry_rank_penalty_bps = (
        _float_or_none(
            _mapping(intraday_price_path_asymmetry_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    rough_flow_volatility_stress = extract_rough_flow_volatility_stress(
        matched_source_rows
    ).to_payload()
    rough_flow_volatility_rank_penalty_bps = (
        _float_or_none(
            _mapping(rough_flow_volatility_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    institutional_mechanism_fidelity_stress = (
        extract_institutional_mechanism_fidelity_stress(
            matched_source_rows
        ).to_payload()
    )
    institutional_mechanism_fidelity_rank_penalty_bps = (
        _float_or_none(
            _mapping(
                institutional_mechanism_fidelity_stress.get("ranking_features")
            ).get("replay_rank_penalty_bps")
        )
        or 0.0
    )
    signal_adaptive_execution_resilience_stress = (
        extract_signal_adaptive_execution_resilience_stress(
            matched_source_rows,
            direction=direction,
        ).to_payload()
    )
    signal_adaptive_execution_resilience_rank_penalty_bps = (
        _float_or_none(
            _mapping(
                signal_adaptive_execution_resilience_stress.get("ranking_features")
            ).get("replay_rank_penalty_bps")
        )
        or 0.0
    )
    stochastic_liquidity_resilience_stress = (
        extract_stochastic_liquidity_resilience_stress(
            matched_source_rows,
            max_notional=_candidate_notional(spec),
        ).to_payload()
    )
    stochastic_liquidity_resilience_rank_penalty_bps = (
        _float_or_none(
            _mapping(
                stochastic_liquidity_resilience_stress.get("ranking_features")
            ).get("replay_rank_penalty_bps")
        )
        or 0.0
    )
    microstructure_regime_tokenization_stress = (
        extract_microstructure_regime_tokenization_stress(
            matched_source_rows,
            direction=direction,
        ).to_payload()
    )
    microstructure_regime_tokenization_rank_penalty_bps = (
        _float_or_none(
            _mapping(
                microstructure_regime_tokenization_stress.get("ranking_features")
            ).get("replay_rank_penalty_bps")
        )
        or 0.0
    )
    cost_aware_forecast_filter_stress = extract_cost_aware_forecast_filter_stress(
        matched_source_rows
    ).to_payload()
    cost_aware_forecast_filter_rank_penalty_bps = (
        _float_or_none(
            _mapping(cost_aware_forecast_filter_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    adaptive_market_limit_allocation_stress = (
        extract_adaptive_market_limit_allocation_stress(
            matched_source_rows,
            direction=direction,
        ).to_payload()
    )
    adaptive_market_limit_allocation_rank_penalty_bps = (
        _float_or_none(
            _mapping(
                adaptive_market_limit_allocation_stress.get("ranking_features")
            ).get("replay_rank_penalty_bps")
        )
        or 0.0
    )
    metaorder_adverse_selection_stress = extract_metaorder_adverse_selection_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    metaorder_adverse_selection_rank_penalty_bps = (
        _float_or_none(
            _mapping(metaorder_adverse_selection_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    impact_liquidity_penalty_bps = _impact_liquidity_penalty_bps(
        median_spread_bps=median_spread_bps,
        spread_tail_bps=spread_tail_bps,
        median_volume=median_volume,
    )
    square_root_impact_capacity_penalty_bps = _square_root_impact_capacity_penalty_bps(
        spec=spec,
        median_price=median_price,
        median_volume=median_volume,
        median_spread_bps=median_spread_bps,
    )
    conformal_tail_risk_penalty_bps = _conformal_tail_risk_penalty_bps(signed_returns)
    post_cost_utilities_bps = _post_cost_utility_distribution_bps(
        signed_returns_bps=signed_returns,
        median_spread_bps=median_spread_bps,
        impact_liquidity_penalty_bps=impact_liquidity_penalty_bps,
        square_root_impact_capacity_penalty_bps=square_root_impact_capacity_penalty_bps,
    )
    lower_percentile_post_cost_utility_bps = _lower_percentile_post_cost_utility_bps(
        post_cost_utilities_bps
    )
    bootstrap_lower_percentile_post_cost_utility_bps = (
        _bootstrap_lower_percentile_post_cost_utility_bps(post_cost_utilities_bps)
    )
    hawkes_transient_impact_stress = extract_hawkes_transient_impact_stress(
        matched_source_rows,
        direction=direction,
        max_notional=_candidate_notional(spec),
    ).to_payload()
    hawkes_transient_impact_rank_penalty_bps = (
        _float_or_none(
            _mapping(hawkes_transient_impact_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    ofi_response_horizon_stress = extract_ofi_response_horizon_stress(
        matched_source_rows,
        direction=direction,
    ).to_payload()
    ofi_response_horizon_rank_penalty_bps = (
        _float_or_none(
            _mapping(ofi_response_horizon_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    bootstrap_robust_optimization_stress = extract_bootstrap_robust_optimization_stress(
        matched_source_rows,
        post_cost_utilities_bps=post_cost_utilities_bps,
        candidate_count=len(spec.strategy_overrides.get("universe_symbols", ()))
        or None,
    ).to_payload()
    adaptive_signal_falsification_stress = extract_adaptive_signal_falsification_stress(
        tuple(float(value) / 10000.0 for value in signed_returns),
        null_model_record_sets=(),
        incumbent_records=(),
        candidate_id=spec.candidate_spec_id,
        effective_test_count=max(
            len(spec.strategy_overrides.get("universe_symbols", ())) or 1,
            1,
        ),
        leakage_probe_passed=False,
    ).to_payload()
    bootstrap_robust_optimization_rank_penalty_bps = (
        _float_or_none(
            _mapping(bootstrap_robust_optimization_stress.get("ranking_features")).get(
                "replay_rank_penalty_bps"
            )
        )
        or 0.0
    )
    bootstrap_robust_utility_bps = (
        _float_or_none(
            _mapping(bootstrap_robust_optimization_stress.get("ranking_features")).get(
                "robust_utility_for_ranking_bps"
            )
        )
        or 0.0
    )
    robust_lower_percentile_post_cost_utility_bps = min(
        lower_percentile_post_cost_utility_bps,
        bootstrap_lower_percentile_post_cost_utility_bps,
        bootstrap_robust_utility_bps,
    )
    preview_score = (
        robust_lower_percentile_post_cost_utility_bps * 0.65
        + signed_return_bps * 0.35
        + avg_abs_return_bps * 0.12
        + direction * ofi_pressure_score * 6.0
        + ofi_decay_alignment_score * 8.0
        + direction * microprice_bias_bps * 0.32
        + cluster_lob_activity_score * 5.0
        + liquidity_regime_score * 4.0
        + activity_score
        + coverage_score * 25.0
        - median_spread_bps * 0.05
        - spread_tail_bps * 0.03
        - return_tail_abs_bps * 0.02
        - impact_liquidity_penalty_bps * 0.18
        - square_root_impact_capacity_penalty_bps * 0.22
        - execution_schedule_rank_penalty_bps * 0.14
        - order_book_observability_rank_penalty_bps * 0.12
        - order_transition_rank_penalty_bps * 0.11
        - order_flow_entropy_regime_rank_penalty_bps * 0.09
        - lead_lag_cross_asset_rank_penalty_bps * 0.08
        - queue_survival_fill_rank_penalty_bps * 0.13
        - feed_lag_liquidity_rank_penalty_bps * 0.10
        - lob_reality_gap_rank_penalty_bps * 0.09
        - alpha_decay_predictability_rank_penalty_bps * 0.08
        - counterfactual_regime_rank_penalty_bps * 0.07
        - nonlinear_impact_execution_rank_penalty_bps * 0.06
        - option_gamma_flow_rank_penalty_bps * 0.05
        - intraday_jump_burst_rank_penalty_bps * 0.05
        - intraday_price_path_asymmetry_rank_penalty_bps * 0.04
        - rough_flow_volatility_rank_penalty_bps * 0.06
        - institutional_mechanism_fidelity_rank_penalty_bps * 0.05
        - signal_adaptive_execution_resilience_rank_penalty_bps * 0.05
        - stochastic_liquidity_resilience_rank_penalty_bps * 0.05
        - microstructure_regime_tokenization_rank_penalty_bps * 0.05
        - cost_aware_forecast_filter_rank_penalty_bps * 0.05
        - adaptive_market_limit_allocation_rank_penalty_bps * 0.05
        - metaorder_adverse_selection_rank_penalty_bps * 0.05
        - hawkes_transient_impact_rank_penalty_bps * 0.06
        - ofi_response_horizon_rank_penalty_bps * 0.06
        - bootstrap_robust_optimization_rank_penalty_bps * 0.07
        - conformal_tail_risk_penalty_bps * 0.12
        - macro_stress_veto_score * 18.0
    )
    hpairs_prefilter_score = _float_or_none(
        microstructure_prefilter.get("prefilter_score")
    )
    if hpairs_prefilter_score is not None:
        preview_score = preview_score * 0.65 + hpairs_prefilter_score * 0.35
    macro_window_stress = _mapping(microstructure_prefilter.get("macro_window_stress"))
    macro_window_concentration = _float_or_none(
        macro_window_stress.get("concentration")
    )
    if macro_window_concentration is not None:
        preview_score -= macro_window_concentration * 6.0
    clusterlob_lane_score = _clusterlob_feature_lane_score(
        clusterlob_order_flow_features,
        direction=direction,
    )
    preview_score += clusterlob_lane_score * 0.20
    exploration_score = (
        cluster_lob_activity_score * 4.0
        + abs(ofi_decay_alignment_score) * 5.0
        + abs(clusterlob_lane_score) * 0.12
        + liquidity_regime_score * 2.0
        + coverage_score * 6.0
        - macro_stress_veto_score * 8.0
        - (macro_window_concentration or 0.0) * 3.0
        - conformal_tail_risk_penalty_bps * 0.04
        - square_root_impact_capacity_penalty_bps * 0.08
        - execution_schedule_rank_penalty_bps * 0.05
        - order_book_observability_rank_penalty_bps * 0.04
        - order_transition_rank_penalty_bps * 0.04
        - order_flow_entropy_regime_rank_penalty_bps * 0.04
        - lead_lag_cross_asset_rank_penalty_bps * 0.04
        - queue_survival_fill_rank_penalty_bps * 0.05
        - feed_lag_liquidity_rank_penalty_bps * 0.04
        - lob_reality_gap_rank_penalty_bps * 0.04
        - alpha_decay_predictability_rank_penalty_bps * 0.04
        - counterfactual_regime_rank_penalty_bps * 0.03
        - nonlinear_impact_execution_rank_penalty_bps * 0.03
        - option_gamma_flow_rank_penalty_bps * 0.03
        - intraday_jump_burst_rank_penalty_bps * 0.03
        - intraday_price_path_asymmetry_rank_penalty_bps * 0.02
        - rough_flow_volatility_rank_penalty_bps * 0.03
        - institutional_mechanism_fidelity_rank_penalty_bps * 0.03
        - signal_adaptive_execution_resilience_rank_penalty_bps * 0.03
        - stochastic_liquidity_resilience_rank_penalty_bps * 0.03
        - microstructure_regime_tokenization_rank_penalty_bps * 0.03
        - cost_aware_forecast_filter_rank_penalty_bps * 0.03
        - adaptive_market_limit_allocation_rank_penalty_bps * 0.03
        - metaorder_adverse_selection_rank_penalty_bps * 0.03
        - hawkes_transient_impact_rank_penalty_bps * 0.04
        - ofi_response_horizon_rank_penalty_bps * 0.04
        - bootstrap_robust_optimization_rank_penalty_bps * 0.04
    )
    return FastReplayPreviewRow(
        candidate_spec_id=spec.candidate_spec_id,
        rank=0,
        preview_score=_decimal_from_float(preview_score),
        selected=False,
        selection_reason="fast_replay_preview_ranked",
        matched_row_count=matched_row_count,
        matched_symbol_count=matched_symbol_count,
        requested_symbol_count=requested_symbol_count,
        trading_day_count=max((stat.trading_day_count for stat in matched), default=0),
        signed_return_bps=_decimal_from_float(signed_return_bps),
        avg_abs_return_bps=_decimal_from_float(avg_abs_return_bps),
        median_spread_bps=_decimal_from_float(median_spread_bps),
        activity_score=_decimal_from_float(activity_score),
        coverage_score=_decimal_from_float(coverage_score),
        ofi_pressure_score=_decimal_from_float(ofi_pressure_score),
        microprice_bias_bps=_decimal_from_float(microprice_bias_bps),
        spread_tail_bps=_decimal_from_float(spread_tail_bps),
        return_tail_abs_bps=_decimal_from_float(return_tail_abs_bps),
        impact_liquidity_penalty_bps=_decimal_from_float(impact_liquidity_penalty_bps),
        cluster_lob_activity_score=_decimal_from_float(cluster_lob_activity_score),
        ofi_decay_alignment_score=_decimal_from_float(ofi_decay_alignment_score),
        liquidity_regime_score=_decimal_from_float(liquidity_regime_score),
        macro_stress_veto_score=_decimal_from_float(macro_stress_veto_score),
        conformal_tail_risk_penalty_bps=_decimal_from_float(
            conformal_tail_risk_penalty_bps
        ),
        square_root_impact_capacity_penalty_bps=_decimal_from_float(
            square_root_impact_capacity_penalty_bps
        ),
        exploration_score=_decimal_from_float(exploration_score),
        frontier_bucket="not_selected",
        microstructure_prefilter=dict(microstructure_prefilter),
        clusterlob_order_flow_features=dict(clusterlob_order_flow_features),
        execution_schedule_stress=dict(execution_schedule_stress),
        order_book_observability_stress=dict(order_book_observability_stress),
        order_transition_stress=dict(order_transition_stress),
        order_flow_entropy_regime_stress=dict(order_flow_entropy_regime_stress),
        lead_lag_cross_asset_stress=dict(lead_lag_cross_asset_stress),
        queue_survival_fill_stress=dict(queue_survival_fill_stress),
        feed_lag_liquidity_stress=dict(feed_lag_liquidity_stress),
        lob_reality_gap_stress=dict(lob_reality_gap_stress),
        alpha_decay_predictability_stress=dict(alpha_decay_predictability_stress),
        counterfactual_regime_replay_stress=dict(counterfactual_regime_replay_stress),
        nonlinear_impact_execution_stress=dict(nonlinear_impact_execution_stress),
        option_gamma_flow_stress=dict(option_gamma_flow_stress),
        intraday_jump_burst_stress=dict(intraday_jump_burst_stress),
        intraday_price_path_asymmetry_stress=dict(intraday_price_path_asymmetry_stress),
        rough_flow_volatility_stress=dict(rough_flow_volatility_stress),
        institutional_mechanism_fidelity_stress=dict(
            institutional_mechanism_fidelity_stress
        ),
        signal_adaptive_execution_resilience_stress=dict(
            signal_adaptive_execution_resilience_stress
        ),
        stochastic_liquidity_resilience_stress=dict(
            stochastic_liquidity_resilience_stress
        ),
        microstructure_regime_tokenization_stress=dict(
            microstructure_regime_tokenization_stress
        ),
        cost_aware_forecast_filter_stress=dict(cost_aware_forecast_filter_stress),
        adaptive_market_limit_allocation_stress=dict(
            adaptive_market_limit_allocation_stress
        ),
        metaorder_adverse_selection_stress=dict(metaorder_adverse_selection_stress),
        hawkes_transient_impact_stress=dict(hawkes_transient_impact_stress),
        ofi_response_horizon_stress=dict(ofi_response_horizon_stress),
        bootstrap_robust_optimization_stress=dict(bootstrap_robust_optimization_stress),
        adaptive_signal_falsification_stress=dict(adaptive_signal_falsification_stress),
        candidate_frontier_hash=candidate_frontier_hash,
        exact_replay_frontier_key=exact_replay_frontier_key,
        candidate_lineage=_candidate_lineage(spec),
        replay_tape_cache_identity=replay_tape_manifest.cache_identity_diagnostics(),
        robust_lower_percentile_post_cost_utility_bps=_decimal_from_float(
            robust_lower_percentile_post_cost_utility_bps
        ),
        bootstrap_lower_percentile_post_cost_utility_bps=_decimal_from_float(
            bootstrap_lower_percentile_post_cost_utility_bps
        ),
    )


# Public aliases used by split-module consumers.
score_candidate_spec = _score_candidate_spec

score_candidate_spec_split_export = _score_candidate_spec
__all__ = [name for name in globals() if not name.startswith("__")]

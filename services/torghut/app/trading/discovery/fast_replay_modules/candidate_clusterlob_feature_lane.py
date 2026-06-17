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


def _candidate_clusterlob_feature_lane(
    *,
    requested_symbols: Sequence[str],
    feature_lane_by_symbol: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    from .extract_price import (
        decimal_string_from_float as _decimal_string_from_float,
        float_or_none as _float_or_none,
        mapping as _mapping,
        string_tuple as _string_tuple,
        weighted_average as _weighted_average,
    )

    matched_symbols = tuple(
        symbol for symbol in requested_symbols if symbol in feature_lane_by_symbol
    )
    symbol_features = {
        symbol: dict(feature_lane_by_symbol[symbol]) for symbol in matched_symbols
    }
    row_counts = [
        int(_float_or_none(payload.get("row_count")) or 0.0)
        for payload in symbol_features.values()
    ]
    weights = [max(1, row_count) for row_count in row_counts]
    ranking_payloads = [
        _mapping(payload.get("ranking_features"))
        for payload in symbol_features.values()
    ]
    directional_alignment_score = _weighted_average(
        [
            (
                _float_or_none(ranking.get("directional_alignment_score")) or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    imbalance_abs_mean = _weighted_average(
        [
            (_float_or_none(ranking.get("imbalance_abs_mean")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    cluster_entropy = _weighted_average(
        [
            (_float_or_none(ranking.get("cluster_entropy")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    cluster_switch_rate = _weighted_average(
        [
            (_float_or_none(ranking.get("cluster_switch_rate")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    event_taxonomy_coverage_ratio = _weighted_average(
        [
            (
                _float_or_none(ranking.get("event_taxonomy_coverage_ratio")) or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    event_mix_entropy = _weighted_average(
        [
            (_float_or_none(ranking.get("event_mix_entropy")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    hawkes_time_rescaling_ks_proxy = _weighted_average(
        [
            (
                _float_or_none(ranking.get("hawkes_time_rescaling_ks_proxy")) or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    hawkes_nearly_unstable_branching_pressure = _weighted_average(
        [
            (
                _float_or_none(ranking.get("hawkes_nearly_unstable_branching_pressure"))
                or 0.0,
                weight,
            )
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    missing_penalty = _weighted_average(
        [
            (_float_or_none(ranking.get("missing_data_penalty")) or 0.0, weight)
            for ranking, weight in zip(ranking_payloads, weights)
        ]
    )
    preview_rank_feature_score = (
        abs(directional_alignment_score) * 18.0
        + imbalance_abs_mean * 10.0
        + cluster_entropy * 4.0
        + cluster_switch_rate * 2.0
        + event_mix_entropy * 2.0
        - (1.0 - event_taxonomy_coverage_ratio) * 3.0
        - hawkes_time_rescaling_ks_proxy * 4.0
        - hawkes_nearly_unstable_branching_pressure * 2.0
        - missing_penalty * 8.0
    )
    feature_schema_hashes = tuple(
        sorted(
            {
                str(payload.get("feature_schema_hash") or "")
                for payload in symbol_features.values()
                if str(payload.get("feature_schema_hash") or "")
            }
        )
    )
    warnings = tuple(
        sorted(
            {
                str(warning)
                for payload in symbol_features.values()
                for warning in _string_tuple(payload.get("warnings"))
            }
        )
    )
    return {
        "schema_version": "torghut.fast-replay-clusterlob-order-flow-feature-lane.v1",
        "feature_schema_version": HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
        "status": "preview_only_research_ranking",
        "matched_symbols": list(matched_symbols),
        "requested_symbols": list(requested_symbols),
        "matched_symbol_count": len(matched_symbols),
        "requested_symbol_count": len(requested_symbols),
        "row_count": sum(row_counts),
        "feature_schema_hashes": list(feature_schema_hashes),
        "warnings": list(warnings),
        "ranking_features": {
            "directional_alignment_score": _decimal_string_from_float(
                directional_alignment_score
            ),
            "imbalance_abs_mean": _decimal_string_from_float(imbalance_abs_mean),
            "cluster_entropy": _decimal_string_from_float(cluster_entropy),
            "cluster_switch_rate": _decimal_string_from_float(cluster_switch_rate),
            "event_taxonomy_coverage_ratio": _decimal_string_from_float(
                event_taxonomy_coverage_ratio
            ),
            "event_mix_entropy": _decimal_string_from_float(event_mix_entropy),
            "hawkes_time_rescaling_ks_proxy": _decimal_string_from_float(
                hawkes_time_rescaling_ks_proxy
            ),
            "hawkes_nearly_unstable_branching_pressure": (
                _decimal_string_from_float(hawkes_nearly_unstable_branching_pressure)
            ),
            "missing_data_penalty": _decimal_string_from_float(missing_penalty),
            "preview_rank_feature_score": _decimal_string_from_float(
                preview_rank_feature_score
            ),
        },
        "symbol_features": symbol_features,
        "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
        "research_ranking_only": True,
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _clusterlob_feature_lane_manifest(
    *, feature_lane_by_symbol: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    feature_schema_hashes = tuple(
        sorted(
            {
                str(payload.get("feature_schema_hash") or "")
                for payload in feature_lane_by_symbol.values()
                if str(payload.get("feature_schema_hash") or "")
            }
        )
    )
    return {
        "schema_version": "torghut.fast-replay-clusterlob-order-flow-feature-lane-manifest.v1",
        "feature_schema_version": HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
        "status": "preview_only_research_ranking",
        "symbol_count": len(feature_lane_by_symbol),
        "feature_schema_hashes": list(feature_schema_hashes),
        "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
        "research_ranking_only": True,
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _clusterlob_feature_lane_score(
    payload: Mapping[str, Any], *, direction: float
) -> float:
    from .extract_price import (
        float_or_none as _float_or_none,
        mapping as _mapping,
    )

    ranking_features = _mapping(payload.get("ranking_features"))
    directional_alignment_score = (
        _float_or_none(ranking_features.get("directional_alignment_score")) or 0.0
    )
    imbalance_abs_mean = (
        _float_or_none(ranking_features.get("imbalance_abs_mean")) or 0.0
    )
    cluster_entropy = _float_or_none(ranking_features.get("cluster_entropy")) or 0.0
    cluster_switch_rate = (
        _float_or_none(ranking_features.get("cluster_switch_rate")) or 0.0
    )
    event_taxonomy_coverage_ratio = (
        _float_or_none(ranking_features.get("event_taxonomy_coverage_ratio")) or 0.0
    )
    event_mix_entropy = _float_or_none(ranking_features.get("event_mix_entropy")) or 0.0
    hawkes_time_rescaling_ks_proxy = (
        _float_or_none(ranking_features.get("hawkes_time_rescaling_ks_proxy")) or 0.0
    )
    hawkes_nearly_unstable_branching_pressure = (
        _float_or_none(
            ranking_features.get("hawkes_nearly_unstable_branching_pressure")
        )
        or 0.0
    )
    missing_penalty = (
        _float_or_none(ranking_features.get("missing_data_penalty")) or 0.0
    )
    return (
        direction * directional_alignment_score * 30.0
        + imbalance_abs_mean * 8.0
        + cluster_entropy * 3.0
        + cluster_switch_rate * 2.0
        + event_mix_entropy * 1.5
        - (1.0 - event_taxonomy_coverage_ratio) * 2.0
        - hawkes_time_rescaling_ks_proxy * 3.0
        - hawkes_nearly_unstable_branching_pressure * 2.0
        - missing_penalty * 12.0
    )


# Public aliases used by split-module consumers.
candidate_clusterlob_feature_lane = _candidate_clusterlob_feature_lane
clusterlob_feature_lane_manifest = _clusterlob_feature_lane_manifest
clusterlob_feature_lane_score = _clusterlob_feature_lane_score

candidate_clusterlob_feature_lane_split_export = _candidate_clusterlob_feature_lane
clusterlob_feature_lane_manifest_split_export = _clusterlob_feature_lane_manifest
clusterlob_feature_lane_score_split_export = _clusterlob_feature_lane_score
__all__ = (
    "candidate_clusterlob_feature_lane",
    "clusterlob_feature_lane_manifest",
    "clusterlob_feature_lane_score",
    "candidate_clusterlob_feature_lane_split_export",
    "clusterlob_feature_lane_manifest_split_export",
    "clusterlob_feature_lane_score_split_export",
)

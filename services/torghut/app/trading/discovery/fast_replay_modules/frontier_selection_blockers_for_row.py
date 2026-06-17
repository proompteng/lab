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
from .score_candidate_spec import score_candidate_spec as _score_candidate_spec
from .preview_rank_key import (
    adaptive_market_limit_allocation_rank_penalty_bps as _adaptive_market_limit_allocation_rank_penalty_bps,
    alpha_decay_predictability_rank_penalty_bps as _alpha_decay_predictability_rank_penalty_bps,
    bootstrap_robust_optimization_rank_penalty_bps as _bootstrap_robust_optimization_rank_penalty_bps,
    cost_aware_forecast_filter_rank_penalty_bps as _cost_aware_forecast_filter_rank_penalty_bps,
    counterfactual_regime_rank_penalty_bps as _counterfactual_regime_rank_penalty_bps,
    execution_schedule_rank_penalty_bps as _execution_schedule_rank_penalty_bps,
    feed_lag_liquidity_rank_penalty_bps as _feed_lag_liquidity_rank_penalty_bps,
    frontier_dedupe_key as _frontier_dedupe_key,
    hawkes_transient_impact_rank_penalty_bps as _hawkes_transient_impact_rank_penalty_bps,
    institutional_mechanism_fidelity_rank_penalty_bps as _institutional_mechanism_fidelity_rank_penalty_bps,
    intraday_jump_burst_rank_penalty_bps as _intraday_jump_burst_rank_penalty_bps,
    intraday_price_path_asymmetry_rank_penalty_bps as _intraday_price_path_asymmetry_rank_penalty_bps,
    lead_lag_cross_asset_rank_penalty_bps as _lead_lag_cross_asset_rank_penalty_bps,
    lob_reality_gap_rank_penalty_bps as _lob_reality_gap_rank_penalty_bps,
    mark_frontier_duplicates as _mark_frontier_duplicates,
    metaorder_adverse_selection_rank_penalty_bps as _metaorder_adverse_selection_rank_penalty_bps,
    microstructure_regime_tokenization_rank_penalty_bps as _microstructure_regime_tokenization_rank_penalty_bps,
    nonlinear_impact_execution_rank_penalty_bps as _nonlinear_impact_execution_rank_penalty_bps,
    ofi_response_horizon_rank_penalty_bps as _ofi_response_horizon_rank_penalty_bps,
    option_gamma_flow_rank_penalty_bps as _option_gamma_flow_rank_penalty_bps,
    order_book_observability_rank_penalty_bps as _order_book_observability_rank_penalty_bps,
    order_flow_entropy_regime_rank_penalty_bps as _order_flow_entropy_regime_rank_penalty_bps,
    order_transition_rank_penalty_bps as _order_transition_rank_penalty_bps,
    preview_rank_key as _preview_rank_key,
    queue_survival_fill_rank_penalty_bps as _queue_survival_fill_rank_penalty_bps,
    risk_adjusted_robust_rank_score as _risk_adjusted_robust_rank_score,
    rough_flow_volatility_rank_penalty_bps as _rough_flow_volatility_rank_penalty_bps,
    row_explicitly_non_hpairs as _row_explicitly_non_hpairs,
    row_exploration_diversity_key as _row_exploration_diversity_key,
    row_frontier_duplicate_filtered as _row_frontier_duplicate_filtered,
    row_with_frontier_dedupe as _row_with_frontier_dedupe,
    row_with_rank_and_selection as _row_with_rank_and_selection,
    select_frontier_buckets as _select_frontier_buckets,
    signal_adaptive_execution_resilience_rank_penalty_bps as _signal_adaptive_execution_resilience_rank_penalty_bps,
    stochastic_liquidity_resilience_rank_penalty_bps as _stochastic_liquidity_resilience_rank_penalty_bps,
)


def _float_or_none(value: Any) -> float | None:
    from .extract_price import float_or_none as impl

    return impl(value)


def _hpairs_replay_tape_features(signal: SignalEnvelope) -> Mapping[str, Any]:
    from .extract_price import hpairs_replay_tape_features as impl

    return impl(signal)


def _json_ready(value: Any) -> Any:
    from .extract_price import json_ready as impl

    return impl(value)


def _lineage_blockers_for_row(row: FastReplayPreviewRow) -> tuple[str, ...]:
    from .extract_price import lineage_blockers_for_row as impl

    return impl(row)


def _mapping(value: Any) -> Mapping[str, Any]:
    from .extract_price import mapping as impl

    return impl(value)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    from .extract_price import stable_hash as impl

    return impl(payload)


def _string(value: Any) -> str:
    from .extract_price import string as impl

    return impl(value)


def _string_tuple(value: Any) -> tuple[str, ...]:
    from .extract_price import string_tuple as impl

    return impl(value)


def _frontier_selection_blockers_for_row(
    row: FastReplayPreviewRow,
    *,
    exact_replay_selection_blockers: Sequence[str],
) -> tuple[str, ...]:
    if row.selected:
        return ()
    if row.selection_reason == "fast_replay_frontier_budget_exhausted_skipped":
        return ("frontier_budget_exhausted",)
    if row.selection_reason == "fast_replay_frontier_duplicate_filtered":
        return ("frontier_duplicate_filtered",)
    if row.selection_reason == "fast_replay_frontier_non_hpairs_skipped":
        return ("non_hpairs_candidate",)
    if row.selection_reason == "insufficient_replay_tape_rows":
        return ("insufficient_replay_tape_rows",)
    if row.selection_reason == "fast_replay_frontier_lineage_blocked":
        return tuple(exact_replay_selection_blockers)
    return ()


def _selected_candidate_ids_by_bucket(
    rows: Sequence[FastReplayPreviewRow],
) -> dict[str, list[str]]:
    bucket_order = (
        "exploitation",
        "exploration",
        "exploitation_backfill",
    )
    selected_by_bucket = {
        bucket: [
            row.candidate_spec_id
            for row in rows
            if row.selected and row.frontier_bucket == bucket
        ]
        for bucket in bucket_order
    }
    return {
        **selected_by_bucket,
        "all": [
            row.candidate_spec_id
            for row in rows
            if row.selected and row.frontier_bucket in bucket_order
        ],
    }


def _runtime_ledger_lineage_handoff_manifest(
    rows: Sequence[FastReplayPreviewRow],
) -> dict[str, Any]:
    selected_handoffs = [
        _row_runtime_ledger_lineage_handoff(
            row, lineage_blockers=_lineage_blockers_for_row(row)
        )
        for row in rows
        if row.selected
    ]
    return {
        "schema_version": FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION,
        "status": "metadata_only_not_dispatched",
        "purpose": (
            "make the runtime-ledger lineage/materialization proof gap explicit for "
            "selected exact-replay candidates"
        ),
        "source_papers": [
            dict(source)
            for source in FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SOURCES
        ],
        "candidate_count": len(selected_handoffs),
        "candidates": selected_handoffs,
        "required_materialized_artifacts": _runtime_ledger_required_artifacts(),
        "required_daily_pnl_basis": "post_cost_closed_round_trip_daily_pnl",
        "zero_authoritative_daily_pnl_until_materialized": True,
        "command_execution_allowed_here": False,
        "db_writes_allowed": False,
        "proof_packet_upload_allowed": False,
        "preview_only": True,
        "research_ranking_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _row_runtime_ledger_lineage_handoff(
    row: FastReplayPreviewRow, *, lineage_blockers: Sequence[str]
) -> dict[str, Any]:
    return {
        "schema_version": FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION,
        "status": "requires_runtime_ledger_materialization_before_authoritative_pnl",
        "candidate_spec_id": row.candidate_spec_id,
        "selected_for_exact_replay_evidence_collection": row.selected,
        "frontier_bucket": row.frontier_bucket,
        "exact_replay_frontier_key": row.exact_replay_frontier_key,
        "candidate_frontier_hash": row.candidate_frontier_hash,
        "candidate_lineage": dict(row.candidate_lineage),
        "replay_tape_cache_identity": dict(row.replay_tape_cache_identity),
        "source_papers": [
            dict(source)
            for source in FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SOURCES
        ],
        "required_materialized_artifacts": _runtime_ledger_required_artifacts(),
        "required_semantic_parity_checks": [
            "signal_payload_parity",
            "order_sizing_parity",
            "route_constraint_parity",
            "broker_execution_semantics_parity",
            "portfolio_risk_overlay_parity",
        ],
        "required_daily_pnl_basis": "post_cost_closed_round_trip_daily_pnl",
        "lineage_blockers": list(lineage_blockers),
        "zero_authoritative_daily_pnl_until_materialized": True,
        "runtime_ledger_required": True,
        "source_backed_runtime_ledger_required": True,
        "exact_replay_required": True,
        "preview_only": True,
        "research_ranking_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _runtime_ledger_required_artifacts() -> list[str]:
    return [
        "source_backed_runtime_ledger_bucket",
        "closed_round_trip_ledger",
        "order_lifecycle_fill_evidence",
        "route_tca_observations",
        "execution_shortfall",
        "market_limit_order_type_ablation",
        "trade_level_cost_log",
        "signal_payload_hash",
        "order_sizing_trace",
        "broker_execution_semantics_trace",
        "portfolio_risk_overlay_trace",
        "dataset_snapshot_ref",
        "source_query_digest",
        "feature_schema_hash",
        "cost_model_hash",
        "lineage_hash",
    ]


def _discovery_stage_semantics() -> dict[str, Any]:
    return {
        "schema_version": "torghut.hpairs-discovery-stage-semantics.v1",
        "preview_only_status": "preview_only_ranked",
        "exact_replay_qualified_status": "exact_replay_qualified_frontier",
        "evidence_collection_candidate_status": (
            "bounded_sim_evidence_collection_candidate"
        ),
        "authority": "candidate_discovery_only",
        "preview_output_can_authorize_promotion": False,
        "exact_replay_frontier_can_authorize_promotion": False,
        "requires_runtime_ledger_for_promotion": True,
        "requires_live_paper_evidence_for_final_promotion": True,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _discovery_stage_metadata(
    *,
    selected: bool,
    exact_replay_qualified: bool,
    evidence_collection_candidate: bool,
    frontier_bucket: str,
    blockers: Sequence[str],
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.hpairs-discovery-stage-metadata.v1",
        "preview_status": "preview_only_ranked",
        "preview_only": True,
        "exact_replay_status": (
            "exact_replay_qualified_frontier"
            if exact_replay_qualified
            else "not_exact_replay_qualified"
        ),
        "exact_replay_qualified": exact_replay_qualified,
        "evidence_collection_status": (
            "bounded_sim_evidence_collection_candidate"
            if evidence_collection_candidate
            else "not_evidence_collection_candidate"
        ),
        "evidence_collection_candidate": evidence_collection_candidate,
        "selected_for_bounded_frontier": selected,
        "frontier_bucket": frontier_bucket,
        "blockers": list(blockers),
        "authority": "candidate_discovery_only",
        "resource_scope": "local_offline_bounded_queue_metadata_only",
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _row_exact_replay_selection_blocked(row: FastReplayPreviewRow) -> bool:
    return bool(_exact_replay_selection_blockers_for_row(row))


def _exact_replay_selection_blockers_for_row(
    row: FastReplayPreviewRow,
) -> tuple[str, ...]:
    """Block exact-replay handoff when local cost/capacity lineage is incomplete.

    Source-backed ADV remains a downstream promotion-authority blocker. This
    preview filter blocks only missing local replay-tape inputs that would make
    the bounded exact-replay frontier ranking cost- or capacity-blind.
    """

    blockers: set[str] = set()
    source_input_blockers = set(
        _string_tuple(row.microstructure_prefilter.get("source_input_blockers"))
    )
    blockers.update(
        source_input_blockers & FAST_REPLAY_EXACT_SELECTION_SOURCE_INPUT_BLOCKERS
    )
    if row.avg_abs_return_bps > 0:
        blockers.discard("missing_price_return_microbar_fields")
    if row.ofi_pressure_score != 0:
        blockers.discard("missing_ofi_or_depth_fields")
    if row.median_spread_bps > 0:
        blockers.discard("missing_spread_fields")
    if row.square_root_impact_capacity_penalty_bps > 0:
        blockers.discard("missing_volume_fields")
    impact_capacity_lineage = _mapping(
        row.microstructure_prefilter.get("impact_capacity_lineage")
    )
    impact_blockers = set(_string_tuple(impact_capacity_lineage.get("blockers")))
    blockers.update(
        impact_blockers & FAST_REPLAY_EXACT_SELECTION_IMPACT_CAPACITY_BLOCKERS
    )
    if str(impact_capacity_lineage.get("status") or "") == "missing_inputs":
        blockers.add("impact_capacity_lineage_missing_inputs")
    if "missing_spread_fields" in source_input_blockers:
        if row.median_spread_bps <= 0:
            blockers.add("cost_lineage_spread_missing")
    if (
        "missing_volume_fields" in source_input_blockers
        or "median_volume_missing" in impact_blockers
    ):
        if row.square_root_impact_capacity_penalty_bps <= 0:
            blockers.add("adv_capacity_lineage_volume_missing")
    if "candidate_notional_missing" in impact_blockers:
        blockers.add("candidate_notional_lineage_missing")
    return tuple(sorted(blockers))


def _post_cost_utility_distribution_bps(
    *,
    signed_returns_bps: NDArray[np.float64],
    median_spread_bps: float,
    impact_liquidity_penalty_bps: float,
    square_root_impact_capacity_penalty_bps: float,
) -> NDArray[np.float64]:
    if signed_returns_bps.size == 0:
        return np.asarray([], dtype=np.float64)
    total_cost_bps = (
        max(0.0, median_spread_bps)
        + max(0.0, impact_liquidity_penalty_bps)
        + max(0.0, square_root_impact_capacity_penalty_bps)
    )
    return signed_returns_bps - total_cost_bps


def _lower_percentile_post_cost_utility_bps(
    post_cost_utilities_bps: NDArray[np.float64],
) -> float:
    if post_cost_utilities_bps.size == 0:
        return 0.0
    percentile = 20.0 if post_cost_utilities_bps.size >= 5 else 10.0
    return float(np.percentile(post_cost_utilities_bps, percentile))


def _bootstrap_lower_percentile_post_cost_utility_bps(
    post_cost_utilities_bps: NDArray[np.float64],
) -> float:
    if post_cost_utilities_bps.size == 0:
        return 0.0
    if post_cost_utilities_bps.size == 1:
        return float(post_cost_utilities_bps[0])
    sample_count = int(post_cost_utilities_bps.size)
    replicates: list[float] = []
    for offset in range(sample_count):
        indices = (np.arange(sample_count) + offset) % sample_count
        shifted = post_cost_utilities_bps[indices]
        replicates.append(float(np.mean(shifted[: max(1, sample_count - 1)])))
    return float(np.percentile(np.asarray(replicates, dtype=np.float64), 20))


def _ofi_decay_score(values: NDArray[np.float64]) -> float:
    if values.size == 0:
        return 0.0
    short = _ewma_last(values, half_life=3.0)
    long = _ewma_last(values, half_life=12.0)
    return float(np.clip(0.65 * short + 0.35 * long, -1.0, 1.0))


def _combined_ofi_decay_score(
    *,
    ofi_array: NDArray[np.float64],
    ofi_memory_regime_values: Sequence[float],
) -> float:
    tape_score = _ofi_decay_score(ofi_array)
    if not ofi_memory_regime_values:
        return tape_score
    memory_score = float(
        np.clip(
            np.mean(np.asarray(ofi_memory_regime_values, dtype=np.float64)),
            -1.0,
            1.0,
        )
    )
    if ofi_array.size == 0:
        return memory_score
    return float(np.clip(0.55 * tape_score + 0.45 * memory_score, -1.0, 1.0))


def _ewma_last(values: NDArray[np.float64], *, half_life: float) -> float:
    if values.size == 0:
        return 0.0
    decay = np.log(2.0) / max(1.0, half_life)
    distances = np.arange(values.size - 1, -1, -1, dtype=np.float64)
    weights = np.exp(-decay * distances)
    total = float(np.sum(weights))
    if total <= 0.0:
        return 0.0
    return float(np.sum(values * weights) / total)


def _cluster_lob_activity_score(
    rows: Sequence[SignalEnvelope], ofi_values: NDArray[np.float64]
) -> float:
    event_labels = [_event_label(row) for row in rows]
    label_entropy = _normalized_entropy(event_labels)
    pressure = float(np.mean(np.abs(ofi_values))) if ofi_values.size else 0.0
    if ofi_values.size >= 3:
        changes = np.abs(np.diff(ofi_values))
        burstiness = float(np.clip(np.percentile(changes, 75), 0.0, 1.0))
    else:
        burstiness = 0.0
    hawkes_stress = extract_hawkes_excitation_summary(rows).replay_stress_score
    return float(
        np.clip(
            0.30 * label_entropy
            + 0.35 * pressure
            + 0.15 * burstiness
            + 0.20 * hawkes_stress,
            0.0,
            1.0,
        )
    )


def _event_label(signal: SignalEnvelope) -> str:
    payload = signal.payload
    for key in (
        "cluster_lob_label",
        "order_cluster",
        "event_type",
        "order_event_type",
        "side",
        "liquidity_side",
    ):
        value = str(payload.get(key) or "").strip().lower()
        if value:
            return value
    hpairs_features = _hpairs_replay_tape_features(signal)
    cluster_lob = _mapping(hpairs_features.get("cluster_lob"))
    for key in ("bucket", "label"):
        value = str(cluster_lob.get(key) or "").strip().lower()
        if value:
            return value
    return "unknown"


def _normalized_entropy(labels: Sequence[str]) -> float:
    if not labels:
        return 0.0
    counts: dict[str, int] = {}
    for label in labels:
        counts[label] = counts.get(label, 0) + 1
    if len(counts) <= 1:
        return 0.0
    probabilities = np.asarray(
        [count / len(labels) for count in counts.values()], dtype=np.float64
    )
    entropy = -float(np.sum(probabilities * np.log(probabilities)))
    return float(np.clip(entropy / np.log(len(counts)), 0.0, 1.0))


def _liquidity_regime_score(
    *, spread_values: Sequence[float], volume_values: Sequence[float], row_count: int
) -> float:
    if row_count <= 0:
        return 0.0
    median_spread = float(np.median(spread_values)) if spread_values else 0.0
    median_volume = float(np.median(volume_values)) if volume_values else 0.0
    tight_spread_score = 1.0 / (1.0 + max(0.0, median_spread) / 10.0)
    volume_score = float(np.clip(np.log1p(max(0.0, median_volume)) / 12.0, 0.0, 1.0))
    coverage_score = float(np.clip(np.log1p(row_count) / 8.0, 0.0, 1.0))
    return float(
        np.clip(
            0.45 * tight_spread_score + 0.35 * volume_score + 0.20 * coverage_score,
            0.0,
            1.0,
        )
    )


def _macro_stress_veto_score(rows: Sequence[SignalEnvelope]) -> float:
    if not rows:
        return 0.0
    stress_values = [_extract_macro_stress(row) for row in rows]
    supported = [value for value in stress_values if value is not None]
    if not supported:
        return 0.0
    return float(np.clip(np.mean(supported), 0.0, 1.0))


def _extract_macro_stress(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    for key in (
        "macro_news_stress_score",
        "macro_stress_score",
        "news_stress_score",
        "macro_event_window",
        "macro_announcement_window",
        "news_event_window",
        "stress_veto_window",
    ):
        if key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        parsed = _float_or_none(value)
        if parsed is not None:
            return float(np.clip(parsed, 0.0, 1.0))
        text = str(value).strip().lower()
        if text in {"yes", "true", "macro", "news", "event", "stress"}:
            return 1.0
        if text in {"no", "false", "none", "normal"}:
            return 0.0
    hpairs_features = _hpairs_replay_tape_features(signal)
    stress_tags = hpairs_features.get("stress_tags")
    if isinstance(stress_tags, Sequence) and not isinstance(
        stress_tags, (str, bytes, bytearray)
    ):
        parsed_stress_tags = cast(Sequence[object], stress_tags)
        return 1.0 if any(str(item).strip() for item in parsed_stress_tags) else 0.0
    return None


def _conformal_tail_risk_penalty_bps(signed_returns_bps: NDArray[np.float64]) -> float:
    if signed_returns_bps.size < 2:
        return 0.0
    lower_tail = float(np.percentile(signed_returns_bps, 10))
    mean_return = float(np.mean(signed_returns_bps))
    sample_error = float(np.std(signed_returns_bps) / np.sqrt(signed_returns_bps.size))
    return max(0.0, -lower_tail) + max(0.0, sample_error - max(0.0, mean_return))


def _square_root_impact_capacity_penalty_bps(
    *,
    spec: CandidateSpec,
    median_price: float,
    median_volume: float,
    median_spread_bps: float,
) -> float:
    notional = _candidate_notional(spec)
    if notional <= 0.0:
        return 0.0
    dollar_volume = max(0.0, median_price) * max(0.0, median_volume)
    if dollar_volume <= 0.0:
        return 25.0 + median_spread_bps
    participation = notional / dollar_volume
    return float(
        np.clip(
            np.sqrt(max(0.0, participation)) * 100.0 + median_spread_bps * 0.25,
            0.0,
            500.0,
        )
    )


def _candidate_notional(spec: CandidateSpec) -> float:
    return _float_or_none(spec.strategy_overrides.get("max_notional_per_trade")) or 0.0


def _candidate_lineage(spec: CandidateSpec) -> dict[str, Any]:
    return {
        "schema_version": "torghut.fast-replay-candidate-lineage.v1",
        "candidate_spec_id": spec.candidate_spec_id,
        "hypothesis_id": spec.hypothesis_id,
        "family_template_id": spec.family_template_id,
        "candidate_kind": spec.candidate_kind,
        "runtime_family": spec.runtime_family,
        "runtime_strategy_name": spec.runtime_strategy_name,
        "symbol_universe": list(_candidate_symbols(spec)),
        "feature_contract": _json_ready(spec.feature_contract),
        "objective": _json_ready(spec.objective),
        "hard_vetoes": _json_ready(spec.hard_vetoes),
        "promotion_contract": _json_ready(spec.promotion_contract),
        "candidate_frontier_hash": _candidate_frontier_hash(spec),
        "lineage_preserved": True,
        "prefilter_only": True,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _candidate_frontier_hash(spec: CandidateSpec) -> str:
    """Hash the exact-replay execution identity, excluding hypothesis lineage.

    Two candidate specs with different paper or hypothesis lineage but identical
    runtime parameters produce the same offline replay target. The preview can
    keep both rows for auditability while allowing only one representative into
    the bounded exact-replay handoff.
    """

    return _stable_hash(
        {
            "schema_version": FAST_REPLAY_FRONTIER_IDENTITY_SCHEMA_VERSION,
            "candidate_kind": spec.candidate_kind,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "strategy_overrides": spec.strategy_overrides,
            "objective": spec.objective,
            "hard_vetoes": spec.hard_vetoes,
        }
    )


def _exact_replay_frontier_key(
    *,
    replay_tape_manifest: ReplayTapeManifest,
    candidate_frontier_hash: str,
) -> str:
    return _stable_hash(
        {
            "schema_version": FAST_REPLAY_EXACT_FRONTIER_KEY_SCHEMA_VERSION,
            "replay_cache_key": replay_tape_manifest.replay_cache_key,
            "dataset_snapshot_ref": replay_tape_manifest.dataset_snapshot_ref,
            "source_query_digest": replay_tape_manifest.source_query_digest,
            "source_table_versions": dict(replay_tape_manifest.source_table_versions),
            "feature_schema_hash": replay_tape_manifest.feature_schema_hash,
            "cost_model_hash": replay_tape_manifest.cost_model_hash,
            "strategy_family": replay_tape_manifest.strategy_family,
            "feature_versions": dict(replay_tape_manifest.feature_versions),
            "candidate_frontier_hash": candidate_frontier_hash,
        }
    )


def _candidate_symbols(spec: CandidateSpec) -> tuple[str, ...]:
    raw = spec.strategy_overrides.get("universe_symbols")
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes, bytearray)):
        raw_symbols = cast(Sequence[Any], raw)
        symbols = tuple(
            sorted(
                {_string(item).upper() for item in raw_symbols if _string(item).strip()}
            )
        )
        if symbols:
            return symbols
    return (spec.runtime_strategy_name.upper(),)


def _candidate_direction(spec: CandidateSpec) -> float:
    params = _mapping(spec.strategy_overrides.get("params"))
    text = " ".join(
        item
        for item in (
            spec.runtime_strategy_name,
            spec.family_template_id,
            _string(params.get("selection_mode")),
            _string(params.get("signal_motif")),
            _string(params.get("rank_feature")),
        )
        if item
    ).lower()
    if any(
        token in text for token in ("reversal", "rebound", "washout", "mean_revert")
    ):
        return -1.0
    return 1.0


# Public aliases used by split-module consumers.
bootstrap_lower_percentile_post_cost_utility_bps = (
    _bootstrap_lower_percentile_post_cost_utility_bps
)
candidate_direction = _candidate_direction
candidate_frontier_hash = _candidate_frontier_hash
candidate_lineage = _candidate_lineage
candidate_notional = _candidate_notional
candidate_symbols = _candidate_symbols
cluster_lob_activity_score = _cluster_lob_activity_score
combined_ofi_decay_score = _combined_ofi_decay_score
conformal_tail_risk_penalty_bps = _conformal_tail_risk_penalty_bps
discovery_stage_metadata = _discovery_stage_metadata
discovery_stage_semantics = _discovery_stage_semantics
exact_replay_frontier_key = _exact_replay_frontier_key
exact_replay_selection_blockers_for_row = _exact_replay_selection_blockers_for_row
frontier_selection_blockers_for_row = _frontier_selection_blockers_for_row
lineage_blockers_for_row = _lineage_blockers_for_row
liquidity_regime_score = _liquidity_regime_score
lower_percentile_post_cost_utility_bps = _lower_percentile_post_cost_utility_bps
macro_stress_veto_score = _macro_stress_veto_score
post_cost_utility_distribution_bps = _post_cost_utility_distribution_bps
row_exact_replay_selection_blocked = _row_exact_replay_selection_blocked
row_runtime_ledger_lineage_handoff = _row_runtime_ledger_lineage_handoff
runtime_ledger_lineage_handoff_manifest = _runtime_ledger_lineage_handoff_manifest
selected_candidate_ids_by_bucket = _selected_candidate_ids_by_bucket
square_root_impact_capacity_penalty_bps = _square_root_impact_capacity_penalty_bps

bootstrap_lower_percentile_post_cost_utility_bps_split_export = (
    _bootstrap_lower_percentile_post_cost_utility_bps
)
candidate_direction_split_export = _candidate_direction
candidate_frontier_hash_split_export = _candidate_frontier_hash
candidate_lineage_split_export = _candidate_lineage
candidate_notional_split_export = _candidate_notional
candidate_symbols_split_export = _candidate_symbols
cluster_lob_activity_score_split_export = _cluster_lob_activity_score
combined_ofi_decay_score_split_export = _combined_ofi_decay_score
conformal_tail_risk_penalty_bps_split_export = _conformal_tail_risk_penalty_bps
discovery_stage_metadata_split_export = _discovery_stage_metadata
discovery_stage_semantics_split_export = _discovery_stage_semantics
event_label = _event_label
ewma_last = _ewma_last
exact_replay_frontier_key_split_export = _exact_replay_frontier_key
exact_replay_selection_blockers_for_row_split_export = (
    _exact_replay_selection_blockers_for_row
)
extract_macro_stress = _extract_macro_stress
frontier_selection_blockers_for_row_split_export = _frontier_selection_blockers_for_row
liquidity_regime_score_split_export = _liquidity_regime_score
lower_percentile_post_cost_utility_bps_split_export = (
    _lower_percentile_post_cost_utility_bps
)
macro_stress_veto_score_split_export = _macro_stress_veto_score
normalized_entropy = _normalized_entropy
ofi_decay_score = _ofi_decay_score
post_cost_utility_distribution_bps_split_export = _post_cost_utility_distribution_bps
row_exact_replay_selection_blocked_split_export = _row_exact_replay_selection_blocked
row_runtime_ledger_lineage_handoff_split_export = _row_runtime_ledger_lineage_handoff
runtime_ledger_lineage_handoff_manifest_split_export = (
    _runtime_ledger_lineage_handoff_manifest
)
runtime_ledger_required_artifacts = _runtime_ledger_required_artifacts
selected_candidate_ids_by_bucket_split_export = _selected_candidate_ids_by_bucket
square_root_impact_capacity_penalty_bps_split_export = (
    _square_root_impact_capacity_penalty_bps
)
__all__ = [name for name in globals() if not name.startswith("__")]

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
from app.trading.discovery.cluster_lob_features import (
    HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
    extract_cluster_lob_features,
)
from app.trading.discovery.microstructure_prefilter import (
    HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL,
    HPAIRS_PREFILTER_PROOF_SOURCE,
    build_hpairs_microstructure_prefilter,
)
from app.trading.discovery.replay_tape import ReplayTapeManifest
from app.trading.models import SignalEnvelope

FAST_REPLAY_PREVIEW_SCHEMA_VERSION = "torghut.fast-replay-preview.v8"
FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION = "torghut.fast-replay-preview-row.v9"
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
    "ofi_horizon_decay_regime_screen",
    "macro_news_ofi_stress_veto_if_present",
    "square_root_impact_capacity_prefilter",
    "conformal_tail_risk_prefilter",
    "bootstrap_lower_percentile_utility_prefilter",
    "implementation_risk_preview_exact_runtime_parity_reporting",
)
FAST_REPLAY_FRONTIER_IDENTITY_SCHEMA_VERSION = (
    "torghut.fast-replay-frontier-identity.v1"
)
FAST_REPLAY_EXACT_FRONTIER_KEY_SCHEMA_VERSION = (
    "torghut.fast-replay-exact-frontier-key.v1"
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


@dataclass(frozen=True)
class FastReplayPreviewResult:
    rows: tuple[FastReplayPreviewRow, ...]
    selected_candidate_spec_ids: tuple[str, ...]
    requested_top_k: int
    input_candidate_count: int
    replay_tape_manifest: ReplayTapeManifest
    selected_row_count: int
    exploitation_candidate_count: int
    exploration_candidate_count: int
    exact_replay_candidate_cap: int
    hpairs_microstructure_prefilter: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    clusterlob_order_flow_feature_lane: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )

    def to_manifest_payload(self) -> dict[str, Any]:
        selected_candidate_ids_by_bucket = _selected_candidate_ids_by_bucket(self.rows)
        return {
            "schema_version": FAST_REPLAY_PREVIEW_SCHEMA_VERSION,
            "status": "preview_only",
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "authority": "not_promotion_proof",
            "proof_semantics_label": FAST_REPLAY_PROOF_SEMANTICS_LABEL,
            "selection_policy": {
                "exact_replay_candidate_cap": FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
                "exploitation_slots": FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT,
                "exploration_slots": FAST_REPLAY_DEFAULT_EXPLORATION_COUNT,
                "broad_cluster_fanout_allowed": False,
                "lineage_filter": (
                    "block_exact_replay_selection_when_local_cost_capacity_or_"
                    "replay_tape_identity_inputs_are_missing"
                ),
                "lineage_filter_blockers": sorted(
                    FAST_REPLAY_EXACT_SELECTION_SOURCE_INPUT_BLOCKERS
                    | FAST_REPLAY_EXACT_SELECTION_IMPACT_CAPACITY_BLOCKERS
                ),
            },
            "whitepaper_mechanisms": list(FAST_REPLAY_WHITEPAPER_MECHANISMS),
            "implemented_mechanisms": {
                "hpairs_clusterlob_ofi_prefilter": "deterministic bounded H-PAIRS candidate prefilter metadata only; never promotion authority",
                "clusterlob_order_flow_feature_lane": "offline replay-tape/fixture ClusterLOB and horizon OFI features for preview ranking only",
                "cluster_lob": "cheap event-mix/OFI proxy only; exact replay remains authoritative",
                "ofi_horizon_decay_regime": "EWMA short-vs-long OFI alignment plus spread/liquidity regime score",
                "macro_news_stress_veto": "penalizes rows carrying macro/news stress fields; absent fields are neutral",
                "square_root_impact_capacity": "sqrt(notional / tape dollar-volume proxy) capacity prefilter",
                "conformal_tail_risk": "distribution-free lower-tail signed-return penalty used only for ranking",
                "bootstrap_robust_optimization": "deterministic lower-percentile bootstrap post-cost utility used only for ranking",
                "implementation_risk_backtesting": "preview/exact/runtime parity fields are reported as required downstream evidence, not proof",
            },
            "ranking_authority_boundary": {
                "schema_version": "torghut.fast-replay-ranking-authority-boundary.v1",
                "preview_rank_score_field": "preview_rank_score",
                "ranking_only_reasons_field": "ranking_only_reasons",
                "risk_veto_reasons_field": "risk_veto_reasons",
                "exact_replay_required": True,
                "runtime_ledger_required": True,
                "promotion_allowed": False,
                "ranking_output_can_authorize_promotion": False,
                "prefilter_only": True,
            },
            "blockers": [
                "preview_only_not_promotion_proof",
                "exact_replay_required",
                "source_backed_runtime_ledger_proof_required",
                "live_paper_runtime_evidence_required_for_final_promotion",
            ],
            "hpairs_microstructure_prefilter": dict(
                self.hpairs_microstructure_prefilter
            ),
            "clusterlob_order_flow_feature_lane": dict(
                self.clusterlob_order_flow_feature_lane
            ),
            "hpairs_clusterlob_order_flow_feature_lane": dict(
                self.clusterlob_order_flow_feature_lane
            ),
            "requested_top_k": self.requested_top_k,
            "exact_replay_candidate_cap": self.exact_replay_candidate_cap,
            "exploitation_candidate_count": self.exploitation_candidate_count,
            "exploration_candidate_count": self.exploration_candidate_count,
            "input_candidate_count": self.input_candidate_count,
            "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
            "selected_candidate_ids_by_bucket": selected_candidate_ids_by_bucket,
            "selected_candidate_spec_count": len(self.selected_candidate_spec_ids),
            "selected_row_count": self.selected_row_count,
            "discovery_stage_semantics": _discovery_stage_semantics(),
            "frontier_dedupe_policy": {
                "schema_version": "torghut.fast-replay-frontier-dedupe-policy.v1",
                "status": "enabled",
                "dedupe_scope": "same_replay_tape_cache_and_execution_identity",
                "candidate_frontier_hash_components": [
                    "candidate_kind",
                    "family_template_id",
                    "runtime_family",
                    "runtime_strategy_name",
                    "strategy_overrides",
                    "objective",
                    "hard_vetoes",
                ],
                "exact_replay_frontier_key_components": [
                    "replay_cache_key",
                    "dataset_snapshot_ref",
                    "source_query_digest",
                    "feature_schema_hash",
                    "cost_model_hash",
                    "strategy_family",
                    "feature_versions",
                    "candidate_frontier_hash",
                ],
                "prefilter_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            },
            "throughput_limits": {
                "schema_version": "torghut.fast-replay-throughput-limits.v1",
                "exact_replay_candidate_cap": self.exact_replay_candidate_cap,
                "max_exact_replay_candidates": FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
                "max_local_workers": 2,
                "kubernetes_fanout_allowed": False,
                "cluster_fanout_allowed": False,
                "promotion_allowed": False,
            },
            "bounded_exact_replay_queue": {
                "schema_version": "torghut.fast-replay-bounded-exact-replay-queue.v1",
                "status": "metadata_only_not_dispatched",
                "queue_scope": "offline_preview_to_exact_replay_handoff",
                "discovery_stage_semantics": _discovery_stage_semantics(),
                "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
                "selected_candidate_ids_by_bucket": selected_candidate_ids_by_bucket,
                "exact_replay_candidate_cap": self.exact_replay_candidate_cap,
                "target_candidate_cap": self.exact_replay_candidate_cap,
                "enqueue_candidate_count": len(self.selected_candidate_spec_ids),
                "exploitation_candidate_count": self.exploitation_candidate_count,
                "exploration_candidate_count": self.exploration_candidate_count,
                "handoff_contract": (
                    "selected candidate specs are bounded inputs for a later exact "
                    "replay worker; this preview path does not dispatch workers"
                ),
                "candidate_command_contract": {
                    "source": "selected_candidate_spec_ids",
                    "command_materialization": "downstream_exact_replay_runner_only",
                    "command_execution_allowed_here": False,
                },
                "command_execution_allowed_here": False,
                "broad_cluster_fanout_allowed": False,
                "kubernetes_fanout_allowed": False,
                "db_writes_allowed": False,
                "proof_packet_upload_allowed": False,
                "exact_replay_required": True,
                "runtime_ledger_required": True,
                "source_backed_runtime_ledger_required": True,
                "preview_only": True,
                "research_ranking_only": True,
                "promotion_proof": False,
                "proof_authority": False,
                "promotion_authority": False,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            },
            "replay_tape": {
                "dataset_snapshot_ref": self.replay_tape_manifest.dataset_snapshot_ref,
                "content_sha256": self.replay_tape_manifest.content_sha256,
                "replay_cache_key": self.replay_tape_manifest.replay_cache_key,
                "source_query_digest": self.replay_tape_manifest.source_query_digest,
                "source_table_versions": dict(
                    self.replay_tape_manifest.source_table_versions
                ),
                "feature_schema_hash": self.replay_tape_manifest.feature_schema_hash,
                "cost_model_hash": self.replay_tape_manifest.cost_model_hash,
                "strategy_family": self.replay_tape_manifest.strategy_family,
                "feature_versions": dict(self.replay_tape_manifest.feature_versions),
                "cache_identity": (
                    self.replay_tape_manifest.cache_identity_diagnostics()
                ),
                "row_count": self.replay_tape_manifest.row_count,
                "trading_day_count": self.replay_tape_manifest.trading_day_count,
                "start_date": self.replay_tape_manifest.start_date.isoformat(),
                "end_date": self.replay_tape_manifest.end_date.isoformat(),
                "row_symbols": list(self.replay_tape_manifest.row_symbols),
            },
            "bounded_sim_target_queue": {
                "schema_version": "torghut.fast-replay-bounded-sim-target-queue.v2",
                "status": "metadata_only_not_dispatched",
                "queue_scope": "offline_preview_to_exact_replay_or_bounded_sim_handoff",
                "discovery_stage_semantics": _discovery_stage_semantics(),
                "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
                "selected_candidate_ids_by_bucket": selected_candidate_ids_by_bucket,
                "target_candidate_cap": self.exact_replay_candidate_cap,
                "enqueue_candidate_count": len(self.selected_candidate_spec_ids),
                "exploitation_candidate_count": self.exploitation_candidate_count,
                "exploration_candidate_count": self.exploration_candidate_count,
                "broad_cluster_fanout_allowed": False,
                "kubernetes_fanout_allowed": False,
                "db_writes_allowed": False,
                "proof_packet_upload_allowed": False,
                "exact_replay_required": True,
                "source_backed_runtime_ledger_required": True,
                "bounded_sim_evidence_collection_allowed": True,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_authority_ok": False,
            },
        }


@dataclass(frozen=True)
class _SymbolTapeStats:
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


def build_fast_replay_preview(
    *,
    specs: Sequence[CandidateSpec],
    rows: Sequence[SignalEnvelope],
    replay_tape_manifest: ReplayTapeManifest,
    top_k: int,
    min_rows_per_candidate: int = 2,
    exploitation_count: int | None = None,
    exploration_count: int | None = None,
    exact_replay_candidate_cap: int | None = None,
) -> FastReplayPreviewResult:
    """Rank candidate specs with cheap tape-derived features only.

    This intentionally produces a preview artifact, not replay evidence. Exact
    scheduler replay and runtime ledger proof remain required downstream.
    """

    requested_exact_cap = (
        FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP
        if exact_replay_candidate_cap is None
        else int(exact_replay_candidate_cap)
    )
    bounded_exact_cap = max(
        1,
        min(
            FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
            requested_exact_cap,
        ),
    )
    bounded_top_k = max(1, min(len(specs) or 1, int(top_k), bounded_exact_cap))
    if exact_replay_candidate_cap is not None:
        bounded_top_k = max(1, min(bounded_top_k, bounded_exact_cap))
    requested_exploitation_count = (
        FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT
        if exploitation_count is None
        else int(exploitation_count)
    )
    requested_exploration_count = (
        FAST_REPLAY_DEFAULT_EXPLORATION_COUNT
        if exploration_count is None
        else int(exploration_count)
    )
    bounded_exploitation_count = max(
        0,
        min(
            bounded_top_k,
            FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT,
            requested_exploitation_count,
        ),
    )
    bounded_exploration_count = max(
        0,
        min(
            bounded_top_k - bounded_exploitation_count,
            FAST_REPLAY_DEFAULT_EXPLORATION_COUNT,
            requested_exploration_count,
        ),
    )
    symbol_stats = _build_symbol_stats(rows)
    clusterlob_feature_lane_by_symbol = _build_clusterlob_feature_lane_by_symbol(rows)
    hpairs_prefilter = build_hpairs_microstructure_prefilter(
        specs=specs,
        rows=rows,
        top_k=bounded_top_k,
        min_rows_per_candidate=max(1, int(min_rows_per_candidate)),
        exploitation_count=bounded_exploitation_count,
        exploration_count=bounded_exploration_count,
        exact_replay_candidate_cap=bounded_top_k,
    )
    hpairs_prefilter_payload_by_spec = {
        row.candidate_spec_id: row.to_payload() for row in hpairs_prefilter.rows
    }
    scored_rows: list[FastReplayPreviewRow] = []
    for spec in specs:
        scored_rows.append(
            _score_candidate_spec(
                spec=spec,
                symbol_stats=symbol_stats,
                min_rows_per_candidate=max(1, int(min_rows_per_candidate)),
                microstructure_prefilter=hpairs_prefilter_payload_by_spec.get(
                    spec.candidate_spec_id, {}
                ),
                clusterlob_order_flow_features=_candidate_clusterlob_feature_lane(
                    requested_symbols=_candidate_symbols(spec),
                    feature_lane_by_symbol=clusterlob_feature_lane_by_symbol,
                ),
                replay_tape_manifest=replay_tape_manifest,
            )
        )

    ranked_rows = sorted(scored_rows, key=_preview_rank_key)
    ranked_rows = _mark_frontier_duplicates(ranked_rows)
    selected_bucket_by_id = _select_frontier_buckets(
        ranked_rows=ranked_rows,
        exploitation_count=bounded_exploitation_count,
        exploration_count=bounded_exploration_count,
        exact_replay_candidate_cap=bounded_top_k,
    )
    final_rows = tuple(
        _row_with_rank_and_selection(
            row=row,
            rank=index,
            frontier_bucket=selected_bucket_by_id.get(
                row.candidate_spec_id, "not_selected"
            ),
        )
        for index, row in enumerate(ranked_rows, start=1)
    )
    return FastReplayPreviewResult(
        rows=final_rows,
        selected_candidate_spec_ids=tuple(
            row.candidate_spec_id for row in final_rows if row.selected
        ),
        requested_top_k=bounded_top_k,
        input_candidate_count=len(specs),
        replay_tape_manifest=replay_tape_manifest,
        selected_row_count=len(rows),
        exploitation_candidate_count=sum(
            1 for row in final_rows if row.frontier_bucket == "exploitation"
        ),
        exploration_candidate_count=sum(
            1 for row in final_rows if row.frontier_bucket == "exploration"
        ),
        exact_replay_candidate_cap=bounded_top_k,
        hpairs_microstructure_prefilter=hpairs_prefilter.to_manifest_payload(),
        clusterlob_order_flow_feature_lane=_clusterlob_feature_lane_manifest(
            feature_lane_by_symbol=clusterlob_feature_lane_by_symbol
        ),
    )


def _build_symbol_stats(rows: Sequence[SignalEnvelope]) -> dict[str, _SymbolTapeStats]:
    rows_by_symbol: dict[str, list[SignalEnvelope]] = {}
    for row in rows:
        symbol = row.symbol.strip().upper()
        if not symbol:
            continue
        rows_by_symbol.setdefault(symbol, []).append(row)

    stats: dict[str, _SymbolTapeStats] = {}
    for symbol, symbol_rows in rows_by_symbol.items():
        ordered = sorted(symbol_rows, key=lambda item: item.event_ts)
        prices = [_extract_price(row) for row in ordered]
        price_array = np.asarray(
            [price for price in prices if price is not None and price > 0.0],
            dtype=np.float64,
        )
        returns = (
            np.diff(price_array) / price_array[:-1] * 10_000.0
            if price_array.size >= 2
            else np.asarray([], dtype=np.float64)
        )
        spread_values = [
            spread
            for row in ordered
            if (spread := _extract_spread_bps(row)) is not None
        ]
        ofi_values = [
            ofi for row in ordered if (ofi := _extract_ofi_pressure(row)) is not None
        ]
        ofi_array = np.asarray(ofi_values, dtype=np.float64)
        ofi_memory_regime_values = [
            score
            for row in ordered
            if (score := _extract_ofi_memory_regime_score(row)) is not None
        ]
        microprice_bias_values = [
            bias
            for row in ordered
            if (bias := _extract_microprice_bias_bps(row)) is not None
        ]
        volume_values = [
            volume for row in ordered if (volume := _extract_volume(row)) is not None
        ]
        abs_returns = (
            np.abs(returns) if returns.size else np.asarray([], dtype=np.float64)
        )
        stats[symbol] = _SymbolTapeStats(
            symbol=symbol,
            row_count=len(ordered),
            trading_day_count=len(
                {row.event_ts.astimezone(timezone.utc).date() for row in ordered}
            ),
            returns_bps=returns,
            ofi_values=ofi_array,
            median_spread_bps=float(np.median(spread_values)) if spread_values else 0.0,
            spread_tail_bps=float(np.percentile(spread_values, 95))
            if spread_values
            else 0.0,
            ofi_pressure_score=float(np.mean(ofi_values)) if ofi_values else 0.0,
            ofi_decay_score=_combined_ofi_decay_score(
                ofi_array=ofi_array,
                ofi_memory_regime_values=ofi_memory_regime_values,
            ),
            ofi_memory_regime_score=(
                float(np.mean(ofi_memory_regime_values))
                if ofi_memory_regime_values
                else 0.0
            ),
            microprice_bias_bps=(
                float(np.mean(microprice_bias_values))
                if microprice_bias_values
                else 0.0
            ),
            median_volume=float(np.median(volume_values)) if volume_values else 0.0,
            median_price=float(np.median(price_array)) if price_array.size else 0.0,
            return_tail_abs_bps=(
                float(np.percentile(abs_returns, 95)) if abs_returns.size else 0.0
            ),
            cluster_lob_activity_score=_cluster_lob_activity_score(ordered, ofi_array),
            liquidity_regime_score=_liquidity_regime_score(
                spread_values=spread_values,
                volume_values=volume_values,
                row_count=len(ordered),
            ),
            macro_stress_veto_score=_macro_stress_veto_score(ordered),
        )
    return stats


def _build_clusterlob_feature_lane_by_symbol(
    rows: Sequence[SignalEnvelope],
) -> dict[str, Mapping[str, Any]]:
    rows_by_symbol: dict[str, list[SignalEnvelope]] = {}
    for row in rows:
        symbol = row.symbol.strip().upper()
        if symbol:
            rows_by_symbol.setdefault(symbol, []).append(row)
    return {
        symbol: extract_cluster_lob_features(symbol_rows).to_payload()
        for symbol, symbol_rows in rows_by_symbol.items()
    }


def _candidate_clusterlob_feature_lane(
    *,
    requested_symbols: Sequence[str],
    feature_lane_by_symbol: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
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
    missing_penalty = (
        _float_or_none(ranking_features.get("missing_data_penalty")) or 0.0
    )
    return (
        direction * directional_alignment_score * 30.0
        + imbalance_abs_mean * 8.0
        + cluster_entropy * 3.0
        + cluster_switch_rate * 2.0
        - missing_penalty * 12.0
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
    robust_lower_percentile_post_cost_utility_bps = min(
        lower_percentile_post_cost_utility_bps,
        bootstrap_lower_percentile_post_cost_utility_bps,
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


def _preview_rank_key(
    row: FastReplayPreviewRow,
) -> tuple[bool, float, float, float, str]:
    prefilter_score = _float_or_none(
        row.microstructure_prefilter.get("prefilter_score")
    )
    return (
        row.selection_reason == "insufficient_replay_tape_rows"
        or _row_explicitly_non_hpairs(row),
        -_risk_adjusted_robust_rank_score(row),
        -float(row.preview_score),
        -(prefilter_score if prefilter_score is not None else float(row.preview_score)),
        row.candidate_spec_id,
    )


def _risk_adjusted_robust_rank_score(row: FastReplayPreviewRow) -> float:
    return (
        float(row.robust_lower_percentile_post_cost_utility_bps)
        - float(row.macro_stress_veto_score) * 25.0
        - float(row.square_root_impact_capacity_penalty_bps) * 0.15
        - float(row.conformal_tail_risk_penalty_bps) * 0.10
    )


def _row_explicitly_non_hpairs(row: FastReplayPreviewRow) -> bool:
    value = row.microstructure_prefilter.get("is_hpairs_candidate")
    return isinstance(value, bool) and not value


def _mark_frontier_duplicates(
    ranked_rows: Sequence[FastReplayPreviewRow],
) -> list[FastReplayPreviewRow]:
    grouped_ids: dict[str, list[str]] = {}
    representative_by_key: dict[str, str] = {}
    for row in ranked_rows:
        key = _frontier_dedupe_key(row)
        grouped_ids.setdefault(key, []).append(row.candidate_spec_id)
        representative_by_key.setdefault(key, row.candidate_spec_id)

    deduped_rows: list[FastReplayPreviewRow] = []
    for row in ranked_rows:
        key = _frontier_dedupe_key(row)
        group = tuple(grouped_ids[key])
        representative = representative_by_key[key]
        if len(group) <= 1:
            deduped_rows.append(
                _row_with_frontier_dedupe(
                    row=row,
                    frontier_dedupe_status="unique",
                    duplicate_of_candidate_spec_id=None,
                    duplicate_candidate_spec_ids=(),
                )
            )
        elif row.candidate_spec_id == representative:
            deduped_rows.append(
                _row_with_frontier_dedupe(
                    row=row,
                    frontier_dedupe_status="representative",
                    duplicate_of_candidate_spec_id=None,
                    duplicate_candidate_spec_ids=tuple(
                        candidate_spec_id
                        for candidate_spec_id in group
                        if candidate_spec_id != row.candidate_spec_id
                    ),
                )
            )
        else:
            deduped_rows.append(
                _row_with_frontier_dedupe(
                    row=row,
                    frontier_dedupe_status="duplicate_filtered",
                    duplicate_of_candidate_spec_id=representative,
                    duplicate_candidate_spec_ids=tuple(
                        candidate_spec_id
                        for candidate_spec_id in group
                        if candidate_spec_id != row.candidate_spec_id
                    ),
                )
            )
    return deduped_rows


def _frontier_dedupe_key(row: FastReplayPreviewRow) -> str:
    return (
        row.exact_replay_frontier_key
        or row.candidate_frontier_hash
        or row.candidate_spec_id
    )


def _row_frontier_duplicate_filtered(row: FastReplayPreviewRow) -> bool:
    return row.frontier_dedupe_status == "duplicate_filtered"


def _select_frontier_buckets(
    *,
    ranked_rows: Sequence[FastReplayPreviewRow],
    exploitation_count: int,
    exploration_count: int,
    exact_replay_candidate_cap: int,
) -> dict[str, str]:
    eligible = [
        row
        for row in ranked_rows
        if row.selection_reason != "insufficient_replay_tape_rows"
        and not _row_explicitly_non_hpairs(row)
        and not _row_frontier_duplicate_filtered(row)
        and not _row_exact_replay_selection_blocked(row)
    ]
    selected: dict[str, str] = {}
    for row in eligible[:exploitation_count]:
        if len(selected) >= exact_replay_candidate_cap:
            break
        selected[row.candidate_spec_id] = "exploitation"
    exploration_pool = sorted(
        (row for row in eligible if row.candidate_spec_id not in selected),
        key=lambda row: (-float(row.exploration_score), row.candidate_spec_id),
    )
    explored_diversity_keys: set[tuple[str, ...]] = set()
    deferred_exploration: list[FastReplayPreviewRow] = []
    for row in exploration_pool:
        if (
            len(selected) >= exact_replay_candidate_cap
            or len([bucket for bucket in selected.values() if bucket == "exploration"])
            >= exploration_count
        ):
            break
        diversity_key = _row_exploration_diversity_key(row)
        if diversity_key in explored_diversity_keys:
            deferred_exploration.append(row)
            continue
        selected[row.candidate_spec_id] = "exploration"
        explored_diversity_keys.add(diversity_key)
    for row in deferred_exploration:
        if (
            len(selected) >= exact_replay_candidate_cap
            or len([bucket for bucket in selected.values() if bucket == "exploration"])
            >= exploration_count
        ):
            break
        selected[row.candidate_spec_id] = "exploration"
    if not selected:
        for row in eligible:
            selected[row.candidate_spec_id] = "exploitation_backfill"
            break
    return selected


def _row_exploration_diversity_key(row: FastReplayPreviewRow) -> tuple[str, ...]:
    lineage = row.candidate_lineage
    symbols = lineage.get("symbol_universe")
    if isinstance(symbols, Sequence) and not isinstance(
        symbols, (str, bytes, bytearray)
    ):
        raw_symbols = cast(Sequence[object], symbols)
        symbol_key = ",".join(str(symbol).upper() for symbol in raw_symbols)
    else:
        symbol_key = str(symbols or row.candidate_spec_id)
    return (
        str(lineage.get("family_template_id") or "unknown_family"),
        str(lineage.get("runtime_strategy_name") or "unknown_strategy"),
        symbol_key,
    )


def _row_with_rank_and_selection(
    *, row: FastReplayPreviewRow, rank: int, frontier_bucket: str
) -> FastReplayPreviewRow:
    selected = frontier_bucket != "not_selected"
    selection_reason = row.selection_reason
    if selected:
        selection_reason = f"fast_replay_frontier_{frontier_bucket}_selected"
    elif _row_frontier_duplicate_filtered(row):
        selection_reason = "fast_replay_frontier_duplicate_filtered"
    elif _row_exact_replay_selection_blocked(row):
        selection_reason = "fast_replay_frontier_lineage_blocked"
    elif _row_explicitly_non_hpairs(row):
        selection_reason = "fast_replay_frontier_non_hpairs_skipped"
    elif row.selection_reason != "insufficient_replay_tape_rows":
        selection_reason = "fast_replay_frontier_budget_exhausted_skipped"
    return FastReplayPreviewRow(
        candidate_spec_id=row.candidate_spec_id,
        rank=rank,
        preview_score=row.preview_score,
        selected=selected,
        selection_reason=selection_reason,
        matched_row_count=row.matched_row_count,
        matched_symbol_count=row.matched_symbol_count,
        requested_symbol_count=row.requested_symbol_count,
        trading_day_count=row.trading_day_count,
        signed_return_bps=row.signed_return_bps,
        avg_abs_return_bps=row.avg_abs_return_bps,
        median_spread_bps=row.median_spread_bps,
        activity_score=row.activity_score,
        coverage_score=row.coverage_score,
        ofi_pressure_score=row.ofi_pressure_score,
        microprice_bias_bps=row.microprice_bias_bps,
        spread_tail_bps=row.spread_tail_bps,
        return_tail_abs_bps=row.return_tail_abs_bps,
        impact_liquidity_penalty_bps=row.impact_liquidity_penalty_bps,
        cluster_lob_activity_score=row.cluster_lob_activity_score,
        ofi_decay_alignment_score=row.ofi_decay_alignment_score,
        liquidity_regime_score=row.liquidity_regime_score,
        macro_stress_veto_score=row.macro_stress_veto_score,
        conformal_tail_risk_penalty_bps=row.conformal_tail_risk_penalty_bps,
        square_root_impact_capacity_penalty_bps=row.square_root_impact_capacity_penalty_bps,
        exploration_score=row.exploration_score,
        frontier_bucket=frontier_bucket,
        microstructure_prefilter=dict(row.microstructure_prefilter),
        clusterlob_order_flow_features=dict(row.clusterlob_order_flow_features),
        proof_semantics_label=row.proof_semantics_label,
        candidate_frontier_hash=row.candidate_frontier_hash,
        exact_replay_frontier_key=row.exact_replay_frontier_key,
        frontier_dedupe_status=row.frontier_dedupe_status,
        duplicate_of_candidate_spec_id=row.duplicate_of_candidate_spec_id,
        duplicate_candidate_spec_ids=row.duplicate_candidate_spec_ids,
        candidate_lineage=dict(row.candidate_lineage),
        replay_tape_cache_identity=dict(row.replay_tape_cache_identity),
        robust_lower_percentile_post_cost_utility_bps=(
            row.robust_lower_percentile_post_cost_utility_bps
        ),
        bootstrap_lower_percentile_post_cost_utility_bps=(
            row.bootstrap_lower_percentile_post_cost_utility_bps
        ),
    )


def _row_with_frontier_dedupe(
    *,
    row: FastReplayPreviewRow,
    frontier_dedupe_status: str,
    duplicate_of_candidate_spec_id: str | None,
    duplicate_candidate_spec_ids: tuple[str, ...],
) -> FastReplayPreviewRow:
    selection_reason = row.selection_reason
    if frontier_dedupe_status == "duplicate_filtered":
        selection_reason = "fast_replay_frontier_duplicate_filtered"
    return FastReplayPreviewRow(
        candidate_spec_id=row.candidate_spec_id,
        rank=row.rank,
        preview_score=row.preview_score,
        selected=False,
        selection_reason=selection_reason,
        matched_row_count=row.matched_row_count,
        matched_symbol_count=row.matched_symbol_count,
        requested_symbol_count=row.requested_symbol_count,
        trading_day_count=row.trading_day_count,
        signed_return_bps=row.signed_return_bps,
        avg_abs_return_bps=row.avg_abs_return_bps,
        median_spread_bps=row.median_spread_bps,
        activity_score=row.activity_score,
        coverage_score=row.coverage_score,
        ofi_pressure_score=row.ofi_pressure_score,
        microprice_bias_bps=row.microprice_bias_bps,
        spread_tail_bps=row.spread_tail_bps,
        return_tail_abs_bps=row.return_tail_abs_bps,
        impact_liquidity_penalty_bps=row.impact_liquidity_penalty_bps,
        cluster_lob_activity_score=row.cluster_lob_activity_score,
        ofi_decay_alignment_score=row.ofi_decay_alignment_score,
        liquidity_regime_score=row.liquidity_regime_score,
        macro_stress_veto_score=row.macro_stress_veto_score,
        conformal_tail_risk_penalty_bps=row.conformal_tail_risk_penalty_bps,
        square_root_impact_capacity_penalty_bps=row.square_root_impact_capacity_penalty_bps,
        exploration_score=row.exploration_score,
        frontier_bucket=row.frontier_bucket,
        microstructure_prefilter=dict(row.microstructure_prefilter),
        clusterlob_order_flow_features=dict(row.clusterlob_order_flow_features),
        proof_semantics_label=row.proof_semantics_label,
        candidate_frontier_hash=row.candidate_frontier_hash,
        exact_replay_frontier_key=row.exact_replay_frontier_key,
        frontier_dedupe_status=frontier_dedupe_status,
        duplicate_of_candidate_spec_id=duplicate_of_candidate_spec_id,
        duplicate_candidate_spec_ids=duplicate_candidate_spec_ids,
        candidate_lineage=dict(row.candidate_lineage),
        replay_tape_cache_identity=dict(row.replay_tape_cache_identity),
        robust_lower_percentile_post_cost_utility_bps=(
            row.robust_lower_percentile_post_cost_utility_bps
        ),
        bootstrap_lower_percentile_post_cost_utility_bps=(
            row.bootstrap_lower_percentile_post_cost_utility_bps
        ),
    )


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
    return float(
        np.clip(0.35 * label_entropy + 0.45 * pressure + 0.20 * burstiness, 0.0, 1.0)
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


def _extract_price(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    for key in ("price", "mid_price", "mid", "mark", "last_price", "close"):
        value = _float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            return value
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def _extract_spread_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    explicit = _float_or_none(payload.get("spread_bps"))
    if explicit is not None:
        return max(0.0, explicit)
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = _float_or_none(payload.get("spread"))
    price = _extract_price(signal)
    if spread is not None and price is not None and price > 0.0:
        return max(0.0, spread / price * 10_000.0)
    return None


def _extract_ofi_pressure(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    for key in (
        "ofi_pressure_score",
        "order_flow_imbalance",
        "ofi",
        "signed_order_flow_imbalance",
        "queue_imbalance",
        "book_imbalance",
        "depth_imbalance",
    ):
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        if -1.0 <= value <= 1.0:
            return value
        return float(np.tanh(value / 100.0))
    hpairs_ofi = _mapping(
        _hpairs_replay_tape_features(signal).get("order_flow_imbalance_horizons")
    )
    values: list[float] = []
    for horizon in ("instant", "1", "3", "12", "36"):
        value = _float_or_none(hpairs_ofi.get(horizon))
        if value is not None:
            values.append(value)
    if not values:
        for value in hpairs_ofi.values():
            parsed = _float_or_none(value)
            if parsed is not None:
                values.append(parsed)
    if values:
        mean_value = float(np.mean(np.asarray(values, dtype=np.float64)))
        if -1.0 <= mean_value <= 1.0:
            return mean_value
        return float(np.tanh(mean_value / 100.0))
    hpairs_memory_regime = _mapping(
        _hpairs_replay_tape_features(signal).get("ofi_memory_regime_slices")
    )
    hpairs_memory_horizons = _mapping(hpairs_memory_regime.get("horizons"))
    memory_values: list[float] = []
    for horizon in ("instant", "short", "medium", "long"):
        value = _float_or_none(hpairs_memory_horizons.get(horizon))
        if value is not None:
            memory_values.append(value)
    if memory_values:
        mean_value = float(np.mean(np.asarray(memory_values, dtype=np.float64)))
        if -1.0 <= mean_value <= 1.0:
            return mean_value
        return float(np.tanh(mean_value / 100.0))
    return _extract_quote_depth_imbalance(signal)


def _extract_ofi_memory_regime_score(signal: SignalEnvelope) -> float | None:
    hpairs_features = _hpairs_replay_tape_features(signal)
    memory_regime = _mapping(hpairs_features.get("ofi_memory_regime_slices"))
    for key in ("directional_alignment_score", "memory_score", "shock_score"):
        value = _float_or_none(memory_regime.get(key))
        if value is not None:
            return float(np.clip(value, -1.0, 1.0))
    decay_memory = _mapping(hpairs_features.get("ofi_decay_memory"))
    values = [
        value
        for item in decay_memory.values()
        if (value := _float_or_none(item)) is not None
    ]
    if not values:
        return None
    return float(np.clip(np.mean(np.asarray(values, dtype=np.float64)), -1.0, 1.0))


def _extract_quote_depth_imbalance(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    bid_size = _first_float(
        payload,
        (
            "bid_size",
            "bid_qty",
            "best_bid_size",
            "best_bid_qty",
            "bid_depth",
            "bid_volume",
        ),
    )
    ask_size = _first_float(
        payload,
        (
            "ask_size",
            "ask_qty",
            "best_ask_size",
            "best_ask_qty",
            "ask_depth",
            "ask_volume",
        ),
    )
    if (
        bid_size is None
        or ask_size is None
        or bid_size < 0.0
        or ask_size < 0.0
        or bid_size + ask_size <= 0.0
    ):
        return None
    return float(np.clip((bid_size - ask_size) / (bid_size + ask_size), -1.0, 1.0))


def _extract_microprice_bias_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    bid = _first_float(payload, ("bid", "best_bid", "bid_price", "best_bid_price"))
    ask = _first_float(payload, ("ask", "best_ask", "ask_price", "best_ask_price"))
    explicit_microprice = _first_float(payload, ("microprice", "micro_price"))
    price = _extract_price(signal)
    if explicit_microprice is not None and price is not None and price > 0.0:
        return (explicit_microprice - price) / price * 10_000.0

    bid_size = _first_float(
        payload, ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty")
    )
    ask_size = _first_float(
        payload, ("ask_size", "ask_qty", "best_ask_size", "best_ask_qty")
    )
    if (
        bid is None
        or ask is None
        or bid <= 0.0
        or ask <= 0.0
        or ask < bid
        or bid_size is None
        or ask_size is None
        or bid_size < 0.0
        or ask_size < 0.0
        or bid_size + ask_size <= 0.0
    ):
        return None
    mid = (bid + ask) / 2.0
    microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
    return (microprice - mid) / mid * 10_000.0


def _extract_volume(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    return _first_float(
        payload,
        ("microbar_volume", "bar_volume", "trade_volume", "volume", "qty", "size"),
        positive=True,
    )


def _impact_liquidity_penalty_bps(
    *, median_spread_bps: float, spread_tail_bps: float, median_volume: float
) -> float:
    volume_penalty = 25.0 / max(1.0, np.log1p(max(0.0, median_volume)))
    return max(0.0, median_spread_bps * 0.5 + spread_tail_bps * 0.5 + volume_penalty)


def _weighted_average(values: Sequence[tuple[float, int]]) -> float:
    total_weight = sum(max(0, weight) for _, weight in values)
    if total_weight <= 0:
        return 0.0
    return sum(value * max(0, weight) for value, weight in values) / total_weight


def _first_float(
    payload: Mapping[str, Any], keys: Sequence[str], *, positive: bool = False
) -> float | None:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        if positive and value <= 0.0:
            continue
        return value
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(parsed):
        return None
    return parsed


def _hpairs_replay_tape_features(signal: SignalEnvelope) -> dict[str, Any]:
    raw = signal.payload.get("hpairs_replay_tape_features") or signal.payload.get(
        "hpairs_features"
    )
    if not isinstance(raw, Mapping):
        return {}
    return dict(cast(Mapping[str, Any], raw))


def _decimal_from_float(value: float) -> Decimal:
    return Decimal(str(round(float(value), 8)))


def _decimal_string_from_float(value: float) -> str:
    return str(_decimal_from_float(value))


def _observed_post_cost_expectancy_bps(row: FastReplayPreviewRow) -> Decimal:
    return (
        row.signed_return_bps - row.median_spread_bps - row.impact_liquidity_penalty_bps
    )


def _required_daily_notional_for_target(expectancy_bps: Decimal) -> Decimal | None:
    if expectancy_bps <= 0:
        return None
    return FAST_REPLAY_TARGET_NET_PNL_PER_DAY / (expectancy_bps / Decimal("10000"))


def _lineage_blockers_for_row(row: FastReplayPreviewRow) -> tuple[str, ...]:
    blockers = [
        "source_backed_adv_missing",
        "adv_as_of_missing",
        "source_backed_cost_impact_model_required",
        "exact_replay_required",
        "live_paper_runtime_ledger_required",
    ]
    blockers.extend(_exact_replay_selection_blockers_for_row(row))
    cache_identity = _mapping(row.replay_tape_cache_identity)
    if cache_identity:
        blockers.extend(
            str(blocker)
            for blocker in _string_tuple(cache_identity.get("blockers"))
            if str(blocker).strip()
        )
    if _observed_post_cost_expectancy_bps(row) <= 0:
        blockers.append("positive_post_cost_expectancy_missing")
        blockers.append("target_implied_notional_blocked_non_positive_expectancy")
    source_input_blockers = row.microstructure_prefilter.get("source_input_blockers")
    if isinstance(source_input_blockers, Sequence) and not isinstance(
        source_input_blockers, (str, bytes, bytearray)
    ):
        if source_input_blockers:
            blockers.append("hpairs_prefilter_source_inputs_missing")
    return tuple(blockers)


def _risk_flags_for_row(
    row: FastReplayPreviewRow, *, lineage_blockers: Sequence[str]
) -> tuple[str, ...]:
    flags = set(lineage_blockers)
    if row.macro_stress_veto_score > 0:
        flags.add("macro_news_stress_veto_active")
    if row.conformal_tail_risk_penalty_bps > 0:
        flags.add("conformal_tail_risk_penalty_active")
    if row.square_root_impact_capacity_penalty_bps > 0:
        flags.add("square_root_impact_capacity_penalty_active")
    if row.matched_symbol_count < row.requested_symbol_count:
        flags.add("partial_symbol_coverage")
    if row.trading_day_count <= 0:
        flags.add("no_trading_day_coverage")
    if row.selection_reason == "insufficient_replay_tape_rows":
        flags.add("insufficient_replay_tape_rows")
    return tuple(sorted(flags))


def _ranking_only_reasons_for_row(
    row: FastReplayPreviewRow, *, lineage_blockers: Sequence[str]
) -> tuple[str, ...]:
    reasons = {
        "preview_rank_score_is_prefilter_only",
        "clusterlob_ofi_regime_news_impact_bootstrap_conformal_features_rank_only",
        "exact_replay_required_before_any_promotion_claim",
        "runtime_ledger_required_before_any_profitability_claim",
    }
    if row.robust_lower_percentile_post_cost_utility_bps != 0:
        reasons.add("robust_lower_percentile_post_cost_utility_used_for_ranking")
    if row.bootstrap_lower_percentile_post_cost_utility_bps != 0:
        reasons.add("bootstrap_lower_percentile_post_cost_utility_used_for_ranking")
    if row.macro_stress_veto_score > 0:
        reasons.add("macro_news_ofi_stress_slice_downranks_only")
    if row.conformal_tail_risk_penalty_bps > 0:
        reasons.add("conformal_tail_risk_buffer_downranks_only")
    if row.square_root_impact_capacity_penalty_bps > 0:
        reasons.add("square_root_impact_capacity_cap_downranks_only")
    if row.selection_reason == "insufficient_replay_tape_rows":
        reasons.add("missing_replay_tape_source_data_explicit_blocker")
    if lineage_blockers:
        reasons.add("lineage_blockers_reported_not_fabricated")
    return tuple(sorted(reasons))


def _risk_veto_reasons_for_row(
    row: FastReplayPreviewRow,
    *,
    risk_flags: Sequence[str],
    lineage_blockers: Sequence[str],
) -> tuple[str, ...]:
    vetoes = {str(flag) for flag in risk_flags if str(flag).strip()}
    vetoes.update(str(blocker) for blocker in lineage_blockers if str(blocker).strip())
    if row.macro_stress_veto_score > 0:
        vetoes.add("macro_news_stress_slice_veto_or_downrank")
    if row.liquidity_regime_score <= 0 and row.matched_row_count > 0:
        vetoes.add("liquidity_regime_unobserved_or_weak")
    if row.square_root_impact_capacity_penalty_bps > 0:
        vetoes.add("square_root_impact_capacity_penalty")
    if row.robust_lower_percentile_post_cost_utility_bps <= 0:
        vetoes.add("robust_lower_percentile_post_cost_utility_not_positive")
    return tuple(sorted(vetoes))


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    sequence = cast(Sequence[Any], value)
    return tuple(str(item) for item in sequence if str(item).strip())


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        ready: dict[str, Any] = {}
        for key in sorted(mapping.keys(), key=str):
            ready[str(key)] = _json_ready(mapping[key])
        return ready
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    return value


def _string(value: Any) -> str:
    return str(value or "").strip()


__all__ = [
    "FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION",
    "FAST_REPLAY_PREVIEW_SCHEMA_VERSION",
    "FAST_REPLAY_PROOF_SEMANTICS_LABEL",
    "FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT",
    "FAST_REPLAY_DEFAULT_EXPLORATION_COUNT",
    "FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP",
    "FAST_REPLAY_WHITEPAPER_MECHANISMS",
    "FastReplayPreviewResult",
    "FastReplayPreviewRow",
    "build_fast_replay_preview",
]

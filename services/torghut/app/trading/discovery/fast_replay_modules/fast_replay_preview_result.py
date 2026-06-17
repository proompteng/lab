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
        from .frontier_selection_blockers_for_row import (
            discovery_stage_semantics as _discovery_stage_semantics,
            runtime_ledger_lineage_handoff_manifest as _runtime_ledger_lineage_handoff_manifest,
            selected_candidate_ids_by_bucket as _selected_candidate_ids_by_bucket,
        )

        selected_candidate_ids_by_bucket = _selected_candidate_ids_by_bucket(self.rows)
        runtime_ledger_lineage_handoff = _runtime_ledger_lineage_handoff_manifest(
            self.rows
        )
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
                "hawkes_event_time_excitation_replay_stress": "deterministic Hawkes-style event-time burst/self-excitation, LOB event-taxonomy coverage, and time-rescaling GOF proxy from arXiv:2510.08085, arXiv:2502.17417, and arXiv:2604.23961; preview ranking only",
                "mpc_market_limit_execution_schedule_stress": "deterministic MPC-style schedule deviation/opportunity-cost/market-limit-mix and submission-latency fill-probability stress from arXiv:2603.28898, arXiv:2507.06345, and arXiv:2504.00846; preview ranking only",
                "order_book_observability_feedback_stress": "deterministic order-book feedback/censored-trade and state-dependent spread-cost stress from arXiv:2605.19584 and arXiv:2507.09196; preview ranking only",
                "markov_order_transition_latent_regime_stress": "deterministic Markov transition entropy/inertia plus latent rising-edge stress from arXiv:2502.07625 and arXiv:2604.20949; preview ranking only",
                "order_flow_entropy_hmm_regime_stress": "deterministic OFI Markov entropy, asymmetric HMM-regime, and multi-scale volatility/intensity stress from SSRN:5315733, arXiv:2512.15720, and arXiv:2603.20456; entropy is not directional alpha proof; preview ranking only",
                "dynamic_lead_lag_cross_asset_stress": "deterministic event-grid dynamic pair-specific lead-lag, cross-market LOB/order-flow predictability, and one-second OFI endogeneity stress from arXiv:2511.00390, SSRN:5523878, and arXiv:2508.06788; lead-lag is not alpha proof; preview ranking only",
                "queue_position_survival_fill_stress": "deterministic queue-position survival fill probability, state-dependent fill-before-price-move, market/limit allocation, depth-delay, MDQR queue-reactive event-mix/order-size replay parity, queue-allocation-rule sensitivity, maker fill/return tradeoff, and group-normalized downside reward stress from arXiv:2512.05734, arXiv:2403.02572v2, arXiv:2507.06345v2, arXiv:2501.08822, arXiv:2511.15262, arXiv:2502.18625, arXiv:2605.25527, SSRN:6440898, SSRN:6730443, SSRN:6574208, and SSRN:6578978; preview ranking only",
                "public_feed_lag_quoted_liquidity_stress": "deterministic public-feed delay, quoted-liquidity reliability, stale-quote, and authoritative trade-direction join stress from SSRN:6675338, arXiv:2604.24366, and arXiv:2511.20606; preview ranking only",
                "lob_simulation_reality_gap_execution_stress": "deterministic spread-volume imbalance, latency-race mode, power-law signed-flow impact, odd-lot liquidity reliability, and responsive exchange event-mix stress from arXiv:2603.24137, OFR WP 25-01, arXiv:2507.06345, and arXiv:2502.07071; preview ranking only",
                "alpha_decay_predictability_stress": "deterministic multi-horizon spread-adjusted alpha decay, cost-crossover, latency-horizon mismatch, and efficiency-regime compression stress from arXiv:2601.02310 and SSRN:6608199; preview ranking only",
                "counterfactual_regime_replay_stress": "deterministic real-tape regime support, edge concentration, and temporal Wasserstein shift stress from arXiv:2602.03776 and SSRN:6232459; no synthetic PnL; preview ranking only",
                "nonlinear_impact_execution_stress": "deterministic real-tape participation-rate, square-root impact, directional elliptic uncertainty, and permanent-impact decay stress from arXiv:2603.29086, arXiv:2510.19950, and arXiv:2502.16246; model costs are not PnL authority; preview ranking only",
                "option_gamma_flow_stress": "deterministic replay-row option gamma, short-horizon option availability, and dealer-hedging feedback stress from SSRN:4692190 and SSRN:6703098; gamma proxies are not PnL authority; preview ranking only",
                "intraday_jump_burst_stress": "deterministic replay-row intraday jump, volatility burst, and spurious-jump source-gap stress from SSRN:5223127, SSRN:5199540, and arXiv:2602.10925; jump proxies are not PnL authority; preview ranking only",
                "intraday_price_path_asymmetry_stress": "deterministic range-based open-high-low intraday path asymmetry and late-session pressure stress from SSRN:6074846 and SSRN:5039009; next-session reversal proxies are not PnL authority; preview ranking only",
                "rough_flow_volatility_impact_stress": "deterministic persistent signed-flow, rough traded-volume/volatility, Poisson-arrival, and power-law impact consistency stress from arXiv:2601.23172 and arXiv:2603.13170; roughness proxies are not PnL authority; preview ranking only",
                "institutional_mechanism_fidelity_stress": "deterministic market-calendar, auction/session-boundary, price-limit, tick-size, latency, and asynchronous cross-asset mechanism-fidelity stress from arXiv:2604.18046 and arXiv:2511.02016; simulator realism proxies are not PnL authority; preview ranking only",
                "signal_adaptive_execution_resilience_stress": "deterministic signal-adaptive quote, fill-intensity, inventory-risk, stochastic liquidity-resilience, and regime-switch stress from arXiv:2605.24242 and arXiv:2506.11813; signal drift and modeled fill intensity are not PnL authority; preview ranking only",
                "stochastic_liquidity_resilience_execution_stress": "deterministic stochastic market-depth regime switching, LOB shape imbalance, depth-recovery resilience, execution-boundary pressure, and shortfall-by-liquidity-regime stress from arXiv:2506.11813 and SSRN:3798235; modeled resilience is not fill, PnL, or promotion authority; preview ranking only",
                "microstructure_regime_tokenization_stress": "deterministic latent-regime early-warning, scale-invariant trade-flow token coverage, raw event precision, and stylized-fact replay stress from arXiv:2604.20949, arXiv:2602.23784, and arXiv:2508.02247; latent triggers and tokenized trade-flow are not PnL authority; preview ranking only",
                "cost_aware_forecast_filter_stress": "deterministic walk-forward forecast-magnitude, transaction-cost threshold, turnover churn, multi-scale trend coverage, and dynamic-variable-selection stress from arXiv:2606.00060 and arXiv:2512.12727; cost-filtered forecasts are not PnL authority; preview ranking only",
                "adaptive_market_limit_allocation_stress": "deterministic observed market/limit allocation, fill-uncertainty, tactical-imbalance, terminal-inventory risk, and trade-level cost logging stress from arXiv:2507.06345, arXiv:2605.24242, and arXiv:2603.29086; allocation and inventory-risk models are not fill, position, or PnL authority; preview ranking only",
                "metaorder_adverse_selection_stress": "deterministic Hawkes-style event clustering, same-direction metaorder footprint, adverse-selection drift, and liquidity-replenishment gap stress from arXiv:2510.27334 and DOI:10.1007/s10203-026-00570-z; metaorder footprints and Hawkes intensity are not fill or PnL authority; preview ranking only",
                "bootstrap_robust_optimization_stress": "deterministic stationary-block bootstrap percentile utility, parameter-instability, and adaptive-search selection-bias stress from arXiv:2510.12725 and arXiv:2604.15531; model utility is not PnL authority; preview ranking only",
                "adaptive_signal_falsification_stress": "deterministic research-only adaptive-signal falsification artifact wiring from arXiv:2604.15531 and arXiv:2605.05580; explicit null references, leakage probes, exact replay, route TCA, and runtime ledger remain required; no synthetic fills or PnL authority",
                "hawkes_transient_impact_execution_stress": "deterministic event-time Hawkes burst/self-excitation, transient-impact pressure, and square-root impact pressure stress from arXiv:2504.10282 and arXiv:2603.29086; intensity and modeled impact are not fill or PnL authority; preview ranking only",
                "ofi_response_horizon_execution_stress": "deterministic one-second and multi-horizon OFI response-ratio, memory-reversal, shock-dissipation, and macro-news distortion stress from arXiv:2505.17388 and arXiv:2508.06788; OFI response is not PnL or promotion authority; preview ranking only",
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
                "runtime_ledger_lineage_materialization_handoff": (
                    runtime_ledger_lineage_handoff
                ),
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
                "runtime_ledger_lineage_materialization_handoff": (
                    runtime_ledger_lineage_handoff
                ),
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
    source_rows: tuple[SignalEnvelope, ...]


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

    from .candidate_clusterlob_feature_lane import (
        candidate_clusterlob_feature_lane as _candidate_clusterlob_feature_lane,
        clusterlob_feature_lane_manifest as _clusterlob_feature_lane_manifest,
    )
    from .frontier_selection_blockers_for_row import (
        candidate_symbols as _candidate_symbols,
    )
    from .preview_rank_key import (
        mark_frontier_duplicates as _mark_frontier_duplicates,
        preview_rank_key as _preview_rank_key,
        row_with_rank_and_selection as _row_with_rank_and_selection,
        select_frontier_buckets as _select_frontier_buckets,
    )
    from .score_candidate_spec import score_candidate_spec as _score_candidate_spec

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
    from .extract_price import (
        extract_microprice_bias_bps as _extract_microprice_bias_bps,
        extract_ofi_memory_regime_score as _extract_ofi_memory_regime_score,
        extract_ofi_pressure as _extract_ofi_pressure,
        extract_price as _extract_price,
        extract_spread_bps as _extract_spread_bps,
        extract_volume as _extract_volume,
    )
    from .frontier_selection_blockers_for_row import (
        cluster_lob_activity_score as _cluster_lob_activity_score,
        combined_ofi_decay_score as _combined_ofi_decay_score,
        liquidity_regime_score as _liquidity_regime_score,
        macro_stress_veto_score as _macro_stress_veto_score,
    )

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
            source_rows=tuple(ordered),
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


# Public aliases used by split-module consumers.
SymbolTapeStats = _SymbolTapeStats
build_clusterlob_feature_lane_by_symbol = _build_clusterlob_feature_lane_by_symbol
build_symbol_stats = _build_symbol_stats

SymbolTapeStats_split_export = _SymbolTapeStats
build_clusterlob_feature_lane_by_symbol_split_export = (
    _build_clusterlob_feature_lane_by_symbol
)
build_symbol_stats_split_export = _build_symbol_stats
__all__ = [name for name in globals() if not name.startswith("__")]

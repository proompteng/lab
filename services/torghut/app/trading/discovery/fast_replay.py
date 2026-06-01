"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timezone
from decimal import Decimal
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.microstructure_prefilter import (
    HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL,
    HPAIRS_PREFILTER_PROOF_SOURCE,
    build_hpairs_microstructure_prefilter,
)
from app.trading.discovery.replay_tape import ReplayTapeManifest
from app.trading.models import SignalEnvelope

FAST_REPLAY_PREVIEW_SCHEMA_VERSION = "torghut.fast-replay-preview.v4"
FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION = "torghut.fast-replay-preview-row.v5"
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
    "ofi_horizon_decay_regime_screen",
    "macro_news_ofi_stress_veto_if_present",
    "square_root_impact_capacity_prefilter",
    "conformal_tail_risk_prefilter",
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
    proof_semantics_label: str = FAST_REPLAY_PROOF_SEMANTICS_LABEL

    def to_payload(self) -> dict[str, Any]:
        observed_post_cost_expectancy_bps = _observed_post_cost_expectancy_bps(self)
        required_daily_notional = _required_daily_notional_for_target(
            observed_post_cost_expectancy_bps
        )
        notional_blocked = required_daily_notional is None
        lineage_blockers = _lineage_blockers_for_row(self)
        risk_flags = _risk_flags_for_row(self, lineage_blockers=lineage_blockers)
        return {
            "schema_version": FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION,
            "candidate_spec_id": self.candidate_spec_id,
            "rank": self.rank,
            "preview_score": str(self.preview_score),
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
            "microstructure_prefilter": dict(self.microstructure_prefilter),
            "hpairs_microstructure_prefilter": dict(self.microstructure_prefilter),
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
            "cost_impact_lineage": {
                "status": "preview_prefilter_only",
                "source": "manifest_verified_replay_tape",
                "cost_basis": "signed_return_minus_spread_plus_square_root_impact_penalty",
                "median_spread_bps": str(self.median_spread_bps),
                "impact_liquidity_penalty_bps": str(self.impact_liquidity_penalty_bps),
                "square_root_impact_capacity_penalty_bps": str(
                    self.square_root_impact_capacity_penalty_bps
                ),
                "observed_post_cost_expectancy_bps": str(
                    observed_post_cost_expectancy_bps
                ),
            },
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

    def to_manifest_payload(self) -> dict[str, Any]:
        return {
            "schema_version": FAST_REPLAY_PREVIEW_SCHEMA_VERSION,
            "status": "preview_only",
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "authority": "not_promotion_proof",
            "proof_semantics_label": FAST_REPLAY_PROOF_SEMANTICS_LABEL,
            "selection_policy": {
                "exact_replay_candidate_cap": FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
                "exploitation_slots": FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT,
                "exploration_slots": FAST_REPLAY_DEFAULT_EXPLORATION_COUNT,
                "broad_cluster_fanout_allowed": False,
            },
            "whitepaper_mechanisms": list(FAST_REPLAY_WHITEPAPER_MECHANISMS),
            "implemented_mechanisms": {
                "hpairs_clusterlob_ofi_prefilter": "deterministic bounded H-PAIRS candidate prefilter metadata only; never promotion authority",
                "cluster_lob": "cheap event-mix/OFI proxy only; exact replay remains authoritative",
                "ofi_horizon_decay_regime": "EWMA short-vs-long OFI alignment plus spread/liquidity regime score",
                "macro_news_stress_veto": "penalizes rows carrying macro/news stress fields; absent fields are neutral",
                "square_root_impact_capacity": "sqrt(notional / tape dollar-volume proxy) capacity prefilter",
                "conformal_tail_risk": "distribution-free lower-tail signed-return penalty used only for ranking",
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
            "requested_top_k": self.requested_top_k,
            "exact_replay_candidate_cap": self.exact_replay_candidate_cap,
            "exploitation_candidate_count": self.exploitation_candidate_count,
            "exploration_candidate_count": self.exploration_candidate_count,
            "input_candidate_count": self.input_candidate_count,
            "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
            "selected_candidate_spec_count": len(self.selected_candidate_spec_ids),
            "selected_row_count": self.selected_row_count,
            "replay_tape": {
                "dataset_snapshot_ref": self.replay_tape_manifest.dataset_snapshot_ref,
                "content_sha256": self.replay_tape_manifest.content_sha256,
                "replay_cache_key": self.replay_tape_manifest.replay_cache_key,
                "feature_schema_hash": self.replay_tape_manifest.feature_schema_hash,
                "cost_model_hash": self.replay_tape_manifest.cost_model_hash,
                "strategy_family": self.replay_tape_manifest.strategy_family,
                "cache_identity": (
                    self.replay_tape_manifest.cache_identity_diagnostics()
                ),
                "row_count": self.replay_tape_manifest.row_count,
                "trading_day_count": self.replay_tape_manifest.trading_day_count,
                "start_date": self.replay_tape_manifest.start_date.isoformat(),
                "end_date": self.replay_tape_manifest.end_date.isoformat(),
                "row_symbols": list(self.replay_tape_manifest.row_symbols),
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
            )
        )

    ranked_rows = sorted(scored_rows, key=_preview_rank_key)
    selected_bucket_by_id = {
        row.candidate_spec_id: row.frontier_bucket
        for row in hpairs_prefilter.rows
        if row.selected and row.frontier_bucket in {"exploitation", "exploration"}
    }
    if not selected_bucket_by_id:
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
            ofi_decay_score=_ofi_decay_score(ofi_array),
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


def _score_candidate_spec(
    *,
    spec: CandidateSpec,
    symbol_stats: Mapping[str, _SymbolTapeStats],
    min_rows_per_candidate: int,
    microstructure_prefilter: Mapping[str, Any],
) -> FastReplayPreviewRow:
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
    preview_score = (
        signed_return_bps
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
    exploration_score = (
        cluster_lob_activity_score * 4.0
        + abs(ofi_decay_alignment_score) * 5.0
        + liquidity_regime_score * 2.0
        + coverage_score * 6.0
        - macro_stress_veto_score * 8.0
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
    )


def _preview_rank_key(row: FastReplayPreviewRow) -> tuple[bool, float, str]:
    prefilter_score = _float_or_none(
        row.microstructure_prefilter.get("prefilter_score")
    )
    return (
        row.selection_reason == "insufficient_replay_tape_rows",
        -(prefilter_score if prefilter_score is not None else float(row.preview_score)),
        row.candidate_spec_id,
    )


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
    for row in exploration_pool[:exploration_count]:
        if len(selected) >= exact_replay_candidate_cap:
            break
        selected[row.candidate_spec_id] = "exploration"
    if not selected and ranked_rows:
        selected[ranked_rows[0].candidate_spec_id] = "exploitation_backfill"
    return selected


def _row_with_rank_and_selection(
    *, row: FastReplayPreviewRow, rank: int, frontier_bucket: str
) -> FastReplayPreviewRow:
    selected = frontier_bucket != "not_selected"
    selection_reason = row.selection_reason
    if selected:
        selection_reason = f"fast_replay_frontier_{frontier_bucket}_selected"
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
        proof_semantics_label=row.proof_semantics_label,
    )


def _ofi_decay_score(values: NDArray[np.float64]) -> float:
    if values.size == 0:
        return 0.0
    short = _ewma_last(values, half_life=3.0)
    long = _ewma_last(values, half_life=12.0)
    return float(np.clip(0.65 * short + 0.35 * long, -1.0, 1.0))


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
    return _extract_quote_depth_imbalance(signal)


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


def _decimal_from_float(value: float) -> Decimal:
    return Decimal(str(round(float(value), 8)))


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
    if _observed_post_cost_expectancy_bps(row) <= 0:
        blockers.append("positive_post_cost_expectancy_missing")
        blockers.append("target_implied_notional_blocked_non_positive_expectancy")
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


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


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

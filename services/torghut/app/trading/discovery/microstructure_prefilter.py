"""Bounded H-PAIRS ClusterLOB/OFI candidate prefiltering.

The scores in this module are discovery metadata only. They intentionally rank
candidate specs for a bounded exact-replay handoff and never create promotion
or runtime-ledger authority.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timezone
from decimal import Decimal
from math import exp, isfinite, log, sqrt
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.models import SignalEnvelope

HPAIRS_PREFILTER_SCHEMA_VERSION = "torghut.hpairs-microstructure-prefilter.v1"
HPAIRS_PREFILTER_ROW_SCHEMA_VERSION = "torghut.hpairs-microstructure-prefilter-row.v1"
HPAIRS_PREFILTER_PROOF_SOURCE = "prefilter_only"
HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL = (
    "hpairs_clusterlob_ofi_prefilter_only_exact_replay_and_runtime_ledger_required"
)
HPAIRS_FAMILY_TEMPLATE_ID = "microbar_cross_sectional_pairs_v1"
HPAIRS_RUNTIME_STRATEGY_NAME = "microbar-cross-sectional-pairs-v1"
HPAIRS_AUTHORITY_BLOCKERS = (
    "prefilter_only_not_promotion_proof",
    "exact_replay_required",
    "source_backed_runtime_ledger_required",
    "live_paper_runtime_evidence_required",
    "source_window_source_ref_complete_live_paper_evidence_required",
)
HPAIRS_HORIZONS = (3, 12, 36)


@dataclass(frozen=True)
class MicrostructureCandidatePrefilterRow:
    candidate_spec_id: str
    rank: int
    prefilter_score: Decimal
    exploitation_score: Decimal
    exploration_score: Decimal
    selected: bool
    frontier_bucket: str
    selection_reason: str
    is_hpairs_candidate: bool
    matched_row_count: int
    matched_symbol_count: int
    requested_symbol_count: int
    trading_day_count: int
    source_fields: tuple[str, ...]
    blockers: tuple[str, ...]
    warnings: tuple[str, ...]
    horizon_ofi_features: Mapping[str, Any]
    cluster_behavior: Mapping[str, Any]
    regime_stress_veto: Mapping[str, Any]
    macro_window_stress: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    impact_capacity_lineage: Mapping[str, Any] = field(
        default_factory=lambda: cast(dict[str, Any], {})
    )
    proof_source: str = HPAIRS_PREFILTER_PROOF_SOURCE
    proof_semantics_label: str = HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL
    promotion_allowed: bool = False
    final_promotion_allowed: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": HPAIRS_PREFILTER_ROW_SCHEMA_VERSION,
            "candidate_spec_id": self.candidate_spec_id,
            "rank": self.rank,
            "prefilter_score": str(self.prefilter_score),
            "exploitation_score": str(self.exploitation_score),
            "exploration_score": str(self.exploration_score),
            "selected": self.selected,
            "frontier_bucket": self.frontier_bucket,
            "selection_reason": self.selection_reason,
            "is_hpairs_candidate": self.is_hpairs_candidate,
            "matched_row_count": self.matched_row_count,
            "matched_symbol_count": self.matched_symbol_count,
            "requested_symbol_count": self.requested_symbol_count,
            "trading_day_count": self.trading_day_count,
            "source_fields": list(self.source_fields),
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "horizon_ofi_features": dict(self.horizon_ofi_features),
            "cluster_behavior": dict(self.cluster_behavior),
            "regime_stress_veto": dict(self.regime_stress_veto),
            "macro_window_stress": dict(self.macro_window_stress),
            "impact_capacity_lineage": dict(self.impact_capacity_lineage),
            "source_input_blockers": list(
                _source_input_blockers(self.blockers, self.warnings)
            ),
            "proof_source": self.proof_source,
            "proof_semantics_label": self.proof_semantics_label,
            "promotion_allowed": self.promotion_allowed,
            "final_promotion_allowed": self.final_promotion_allowed,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "authority": "not_promotion_proof",
            "authority_blockers": list(HPAIRS_AUTHORITY_BLOCKERS),
        }


@dataclass(frozen=True)
class MicrostructurePrefilterResult:
    rows: tuple[MicrostructureCandidatePrefilterRow, ...]
    selected_candidate_spec_ids: tuple[str, ...]
    requested_top_k: int
    input_candidate_count: int
    selected_row_count: int
    exploitation_candidate_count: int
    exploration_candidate_count: int
    exact_replay_candidate_cap: int

    def to_manifest_payload(self) -> dict[str, Any]:
        return {
            "schema_version": HPAIRS_PREFILTER_SCHEMA_VERSION,
            "status": "prefilter_only",
            "proof_source": HPAIRS_PREFILTER_PROOF_SOURCE,
            "proof_semantics_label": HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "authority": "not_promotion_proof",
            "authority_blockers": list(HPAIRS_AUTHORITY_BLOCKERS),
            "mechanisms": [
                "cluster_lob_event_behavior_bucket_prefilter",
                "horizon_specific_ofi_shock_memory_prefilter",
                "microbar_order_flow_fallback_when_lob_absent",
                "regime_stress_veto_metadata",
                "macro_window_concentration_stress_metadata",
                "square_root_power_law_impact_capacity_lineage",
                "bounded_exploitation_plus_exploration_handoff",
            ],
            "requested_top_k": self.requested_top_k,
            "exact_replay_candidate_cap": self.exact_replay_candidate_cap,
            "input_candidate_count": self.input_candidate_count,
            "selected_row_count": self.selected_row_count,
            "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
            "selected_candidate_spec_count": len(self.selected_candidate_spec_ids),
            "exploitation_candidate_count": self.exploitation_candidate_count,
            "exploration_candidate_count": self.exploration_candidate_count,
        }


@dataclass(frozen=True)
class _SymbolMicrostructureStats:
    symbol: str
    row_count: int
    trading_day_count: int
    source_fields: tuple[str, ...]
    warnings: tuple[str, ...]
    blockers: tuple[str, ...]
    returns_bps: NDArray[np.float64]
    median_price: float
    ofi_values: NDArray[np.float64]
    spread_values: NDArray[np.float64]
    volume_values: NDArray[np.float64]
    microprice_bias_bps: NDArray[np.float64]
    event_labels: tuple[str, ...]
    horizon_features: Mapping[str, Any]
    cluster_behavior: Mapping[str, Any]
    regime_stress_veto: Mapping[str, Any]
    stress_values: tuple[float, ...]


def build_hpairs_microstructure_prefilter(
    *,
    specs: Sequence[CandidateSpec],
    rows: Sequence[SignalEnvelope],
    top_k: int,
    min_rows_per_candidate: int = 2,
    exploitation_count: int | None = None,
    exploration_count: int = 0,
    exact_replay_candidate_cap: int | None = None,
) -> MicrostructurePrefilterResult:
    """Rank H-PAIRS specs with deterministic ClusterLOB/OFI preview metadata.

    Full LOB data is optional. When it is absent, the adapter falls back to
    available microbar/order-flow fields and records explicit non-authoritative
    warnings or blockers instead of inventing evidence.
    """

    bounded_top_k = max(1, min(len(specs) or 1, int(top_k)))
    if exact_replay_candidate_cap is not None:
        bounded_top_k = max(1, min(bounded_top_k, int(exact_replay_candidate_cap)))
    bounded_exploitation_count = (
        bounded_top_k
        if exploitation_count is None
        else max(0, min(bounded_top_k, int(exploitation_count)))
    )
    bounded_exploration_count = max(
        0,
        min(bounded_top_k - bounded_exploitation_count, int(exploration_count)),
    )

    stats_by_symbol = _build_symbol_microstructure_stats(rows)
    scored_rows = tuple(
        _score_spec(
            spec=spec,
            stats_by_symbol=stats_by_symbol,
            min_rows_per_candidate=max(1, int(min_rows_per_candidate)),
        )
        for spec in specs
    )
    ranked = sorted(scored_rows, key=_rank_key)
    selected_bucket_by_id = _select_frontier_buckets(
        ranked_rows=ranked,
        exploitation_count=bounded_exploitation_count,
        exploration_count=bounded_exploration_count,
        exact_replay_candidate_cap=bounded_top_k,
    )
    final_rows = tuple(
        _with_rank_and_bucket(
            row=row,
            rank=index,
            frontier_bucket=selected_bucket_by_id.get(
                row.candidate_spec_id, "not_selected"
            ),
        )
        for index, row in enumerate(ranked, start=1)
    )
    return MicrostructurePrefilterResult(
        rows=final_rows,
        selected_candidate_spec_ids=tuple(
            row.candidate_spec_id for row in final_rows if row.selected
        ),
        requested_top_k=bounded_top_k,
        input_candidate_count=len(specs),
        selected_row_count=len(rows),
        exploitation_candidate_count=sum(
            1 for row in final_rows if row.frontier_bucket == "exploitation"
        ),
        exploration_candidate_count=sum(
            1 for row in final_rows if row.frontier_bucket == "exploration"
        ),
        exact_replay_candidate_cap=bounded_top_k,
    )


def _build_symbol_microstructure_stats(
    rows: Sequence[SignalEnvelope],
) -> dict[str, _SymbolMicrostructureStats]:
    rows_by_symbol: dict[str, list[SignalEnvelope]] = {}
    for row in rows:
        symbol = row.symbol.strip().upper()
        if symbol:
            rows_by_symbol.setdefault(symbol, []).append(row)

    stats: dict[str, _SymbolMicrostructureStats] = {}
    for symbol, symbol_rows in rows_by_symbol.items():
        ordered = sorted(symbol_rows, key=lambda item: item.event_ts)
        source_fields: set[str] = set()
        prices = [_extract_price(row, source_fields=source_fields) for row in ordered]
        price_array = np.asarray(
            [price for price in prices if price is not None and price > 0.0],
            dtype=np.float64,
        )
        returns = (
            np.diff(price_array) / price_array[:-1] * 10_000.0
            if price_array.size >= 2
            else np.asarray([], dtype=np.float64)
        )
        spread_values = np.asarray(
            [
                spread
                for row in ordered
                if (spread := _extract_spread_bps(row, source_fields=source_fields))
                is not None
            ],
            dtype=np.float64,
        )
        ofi_values = np.asarray(
            [
                ofi
                for row in ordered
                if (ofi := _extract_ofi_pressure(row, source_fields=source_fields))
                is not None
            ],
            dtype=np.float64,
        )
        microprice_bias = np.asarray(
            [
                bias
                for row in ordered
                if (
                    bias := _extract_microprice_bias_bps(
                        row, source_fields=source_fields
                    )
                )
                is not None
            ],
            dtype=np.float64,
        )
        volume_values = np.asarray(
            [
                volume
                for row in ordered
                if (volume := _extract_volume(row, source_fields=source_fields))
                is not None
            ],
            dtype=np.float64,
        )
        event_labels = tuple(
            _event_label(row, source_fields=source_fields) for row in ordered
        )
        stress_values = [
            stress
            for row in ordered
            if (stress := _extract_regime_stress(row, source_fields=source_fields))
            is not None
        ]
        blockers, warnings = _source_field_diagnostics(
            row_count=len(ordered),
            prices=price_array,
            returns=returns,
            spread_values=spread_values,
            ofi_values=ofi_values,
            microprice_bias=microprice_bias,
            volume_values=volume_values,
            event_labels=event_labels,
            stress_values=stress_values,
        )
        horizon_features = _horizon_ofi_features(ofi_values)
        cluster_behavior = _cluster_behavior(
            event_labels=event_labels,
            ofi_values=ofi_values,
            microprice_bias_bps=microprice_bias,
            has_cluster_fields="cluster_lob_label" in source_fields
            or "order_cluster" in source_fields
            or "lob_event_type" in source_fields,
        )
        regime_stress_veto = _regime_stress_veto(
            spread_values=spread_values,
            returns_bps=returns,
            volume_values=volume_values,
            stress_values=stress_values,
            row_count=len(ordered),
        )
        stats[symbol] = _SymbolMicrostructureStats(
            symbol=symbol,
            row_count=len(ordered),
            trading_day_count=len(
                {row.event_ts.astimezone(timezone.utc).date() for row in ordered}
            ),
            source_fields=tuple(sorted(source_fields)),
            warnings=warnings,
            blockers=blockers,
            returns_bps=returns,
            median_price=_percentile(price_array, 50.0),
            ofi_values=ofi_values,
            spread_values=spread_values,
            volume_values=volume_values,
            microprice_bias_bps=microprice_bias,
            event_labels=event_labels,
            horizon_features=horizon_features,
            cluster_behavior=cluster_behavior,
            regime_stress_veto=regime_stress_veto,
            stress_values=tuple(stress_values),
        )
    return stats


def _score_spec(
    *,
    spec: CandidateSpec,
    stats_by_symbol: Mapping[str, _SymbolMicrostructureStats],
    min_rows_per_candidate: int,
) -> MicrostructureCandidatePrefilterRow:
    requested_symbols = _candidate_symbols(spec)
    matched = [
        stat for symbol in requested_symbols if (stat := stats_by_symbol.get(symbol))
    ]
    is_hpairs_candidate = _is_hpairs_candidate(spec)
    matched_row_count = sum(stat.row_count for stat in matched)
    matched_symbol_count = len(matched)
    requested_symbol_count = len(requested_symbols)
    blockers: set[str] = set(HPAIRS_AUTHORITY_BLOCKERS)
    warnings: set[str] = set()
    source_fields: set[str] = set()
    for stat in matched:
        blockers.update(stat.blockers)
        warnings.update(stat.warnings)
        source_fields.update(stat.source_fields)
    if not is_hpairs_candidate:
        blockers.add("not_hpairs_candidate")
    if matched_row_count < min_rows_per_candidate or not matched:
        blockers.add("insufficient_replay_tape_rows")

    if not matched or matched_row_count < min_rows_per_candidate:
        return MicrostructureCandidatePrefilterRow(
            candidate_spec_id=spec.candidate_spec_id,
            rank=0,
            prefilter_score=Decimal("-1000000"),
            exploitation_score=Decimal("-1000000"),
            exploration_score=Decimal("-1000000"),
            selected=False,
            frontier_bucket="not_selected",
            selection_reason="insufficient_replay_tape_rows",
            is_hpairs_candidate=is_hpairs_candidate,
            matched_row_count=matched_row_count,
            matched_symbol_count=matched_symbol_count,
            requested_symbol_count=requested_symbol_count,
            trading_day_count=max(
                (stat.trading_day_count for stat in matched), default=0
            ),
            source_fields=tuple(sorted(source_fields)),
            blockers=tuple(sorted(blockers)),
            warnings=tuple(sorted(warnings)),
            horizon_ofi_features=_empty_horizon_features(),
            cluster_behavior=_empty_cluster_behavior(),
            regime_stress_veto=_empty_regime_stress_veto(),
            macro_window_stress=_empty_macro_window_stress(),
            impact_capacity_lineage=_impact_capacity_lineage(
                spec=spec,
                median_price=0.0,
                median_volume=0.0,
                median_spread_bps=0.0,
                capacity_penalty_bps=0.0,
            ),
        )

    direction = _candidate_direction(spec)
    returns = _concat_arrays(tuple(stat.returns_bps for stat in matched))
    signed_returns = (
        returns * direction if returns.size else np.asarray([], dtype=np.float64)
    )
    ofi_values = _concat_arrays(tuple(stat.ofi_values for stat in matched))
    spread_values = _concat_arrays(tuple(stat.spread_values for stat in matched))
    volume_values = _concat_arrays(tuple(stat.volume_values for stat in matched))
    microprice_bias = _concat_arrays(
        tuple(stat.microprice_bias_bps for stat in matched)
    )
    event_labels = tuple(label for stat in matched for label in stat.event_labels)
    horizon_features = _merged_horizon_features(matched, direction=direction)
    cluster_behavior = _cluster_behavior(
        event_labels=event_labels,
        ofi_values=ofi_values,
        microprice_bias_bps=microprice_bias,
        has_cluster_fields=any(
            "cluster_lob_label" in stat.source_fields
            or "order_cluster" in stat.source_fields
            or "lob_event_type" in stat.source_fields
            for stat in matched
        ),
    )
    merged_stress_values = tuple(
        value for stat in matched for value in stat.stress_values
    )
    regime_stress_veto = _regime_stress_veto(
        spread_values=spread_values,
        returns_bps=returns,
        volume_values=volume_values,
        stress_values=merged_stress_values,
        row_count=matched_row_count,
    )
    if float(regime_stress_veto["veto_score"]) >= 0.65:
        blockers.add("regime_stress_veto_active")
    elif float(regime_stress_veto["veto_score"]) > 0.0:
        warnings.add("regime_stress_veto_metadata_nonzero")

    signed_return_bps = _mean(signed_returns)
    return_tail_abs_bps = _percentile(np.abs(returns), 95.0)
    median_spread_bps = _percentile(spread_values, 50.0)
    spread_tail_bps = _percentile(spread_values, 95.0)
    volume_score = _volume_score(volume_values)
    coverage_score = matched_symbol_count / max(1, requested_symbol_count)
    ofi_alignment = float(horizon_features["directional_alignment_score"])
    ofi_shock = float(horizon_features["shock_score"])
    ofi_memory = float(horizon_features["memory_score"])
    cluster_score = float(cluster_behavior["cluster_score"])
    stress_veto = float(regime_stress_veto["veto_score"])
    microprice_alignment = direction * _mean(microprice_bias)
    median_price = _weighted_average(
        tuple((stat.median_price, stat.row_count) for stat in matched)
    )
    median_volume = _percentile(volume_values, 50.0)
    capacity_penalty = _capacity_penalty_bps(
        spec=spec,
        median_price=median_price,
        median_volume=median_volume,
        median_spread_bps=median_spread_bps,
    )
    impact_capacity_lineage = _impact_capacity_lineage(
        spec=spec,
        median_price=median_price,
        median_volume=median_volume,
        median_spread_bps=median_spread_bps,
        capacity_penalty_bps=capacity_penalty,
    )
    exploitation_score = (
        signed_return_bps
        + ofi_alignment * 18.0
        + ofi_shock * 9.0
        + ofi_memory * 6.0
        + cluster_score * 12.0
        + microprice_alignment * 0.25
        + coverage_score * 15.0
        + volume_score * 5.0
        - median_spread_bps * 0.06
        - spread_tail_bps * 0.04
        - return_tail_abs_bps * 0.025
        - capacity_penalty * 0.18
        - stress_veto * 30.0
    )
    exploration_score = (
        abs(ofi_shock) * 12.0
        + abs(ofi_memory) * 8.0
        + cluster_score * 10.0
        + volume_score * 4.0
        + coverage_score * 8.0
        - stress_veto * 12.0
        - capacity_penalty * 0.06
    )
    prefilter_score = (
        exploitation_score if is_hpairs_candidate else exploitation_score - 1_000.0
    )
    return MicrostructureCandidatePrefilterRow(
        candidate_spec_id=spec.candidate_spec_id,
        rank=0,
        prefilter_score=_decimal(prefilter_score),
        exploitation_score=_decimal(exploitation_score),
        exploration_score=_decimal(exploration_score),
        selected=False,
        frontier_bucket="not_selected",
        selection_reason="hpairs_microstructure_prefilter_ranked",
        is_hpairs_candidate=is_hpairs_candidate,
        matched_row_count=matched_row_count,
        matched_symbol_count=matched_symbol_count,
        requested_symbol_count=requested_symbol_count,
        trading_day_count=max((stat.trading_day_count for stat in matched), default=0),
        source_fields=tuple(sorted(source_fields)),
        blockers=tuple(sorted(blockers)),
        warnings=tuple(sorted(warnings)),
        horizon_ofi_features=horizon_features,
        cluster_behavior=cluster_behavior,
        regime_stress_veto=regime_stress_veto,
        macro_window_stress=_macro_window_stress_from_regime(regime_stress_veto),
        impact_capacity_lineage=impact_capacity_lineage,
    )


def _rank_key(
    row: MicrostructureCandidatePrefilterRow,
) -> tuple[bool, bool, float, str]:
    return (
        not row.is_hpairs_candidate,
        row.selection_reason == "insufficient_replay_tape_rows",
        -float(row.prefilter_score),
        row.candidate_spec_id,
    )


def _select_frontier_buckets(
    *,
    ranked_rows: Sequence[MicrostructureCandidatePrefilterRow],
    exploitation_count: int,
    exploration_count: int,
    exact_replay_candidate_cap: int,
) -> dict[str, str]:
    eligible = [
        row
        for row in ranked_rows
        if row.is_hpairs_candidate
        and row.selection_reason != "insufficient_replay_tape_rows"
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
    for row in eligible:
        if len(selected) >= exact_replay_candidate_cap:
            break
        selected.setdefault(row.candidate_spec_id, "exploitation_backfill")
    return selected


def _with_rank_and_bucket(
    *, row: MicrostructureCandidatePrefilterRow, rank: int, frontier_bucket: str
) -> MicrostructureCandidatePrefilterRow:
    selected = frontier_bucket != "not_selected"
    selection_reason = row.selection_reason
    if selected:
        selection_reason = f"hpairs_microstructure_prefilter_{frontier_bucket}_selected"
    return MicrostructureCandidatePrefilterRow(
        candidate_spec_id=row.candidate_spec_id,
        rank=rank,
        prefilter_score=row.prefilter_score,
        exploitation_score=row.exploitation_score,
        exploration_score=row.exploration_score,
        selected=selected,
        frontier_bucket=frontier_bucket,
        selection_reason=selection_reason,
        is_hpairs_candidate=row.is_hpairs_candidate,
        matched_row_count=row.matched_row_count,
        matched_symbol_count=row.matched_symbol_count,
        requested_symbol_count=row.requested_symbol_count,
        trading_day_count=row.trading_day_count,
        source_fields=row.source_fields,
        blockers=row.blockers,
        warnings=row.warnings,
        horizon_ofi_features=row.horizon_ofi_features,
        cluster_behavior=row.cluster_behavior,
        regime_stress_veto=row.regime_stress_veto,
        macro_window_stress=row.macro_window_stress,
        impact_capacity_lineage=row.impact_capacity_lineage,
    )


def _source_field_diagnostics(
    *,
    row_count: int,
    prices: NDArray[np.float64],
    returns: NDArray[np.float64],
    spread_values: NDArray[np.float64],
    ofi_values: NDArray[np.float64],
    microprice_bias: NDArray[np.float64],
    volume_values: NDArray[np.float64],
    event_labels: Sequence[str],
    stress_values: Sequence[float],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    blockers: set[str] = set()
    warnings: set[str] = set()
    if row_count <= 0:
        blockers.add("missing_replay_tape_rows")
    if prices.size < 2 or returns.size == 0:
        blockers.add("missing_price_return_microbar_fields")
    if ofi_values.size == 0:
        blockers.add("missing_ofi_or_depth_fields")
    if spread_values.size == 0:
        warnings.add("missing_spread_fields")
    if microprice_bias.size == 0:
        warnings.add("missing_microprice_fields")
    if volume_values.size == 0:
        warnings.add("missing_volume_fields")
    if not event_labels or set(event_labels) == {"unknown"}:
        warnings.add("missing_cluster_lob_event_fields_using_microbar_fallback")
    if not stress_values:
        warnings.add("missing_regime_stress_veto_fields")
    return tuple(sorted(blockers)), tuple(sorted(warnings))


def _source_input_blockers(
    blockers: Sequence[str], warnings: Sequence[str]
) -> tuple[str, ...]:
    """Surface missing input blockers separately from permanent authority blockers."""

    prefixes = ("missing_", "insufficient_")
    return tuple(
        sorted({item for item in (*blockers, *warnings) if item.startswith(prefixes)})
    )


def _horizon_ofi_features(values: NDArray[np.float64]) -> dict[str, Any]:
    if values.size == 0:
        return _empty_horizon_features()
    horizon_payload: dict[str, dict[str, str]] = {}
    ewma_values: dict[int, float] = {}
    for horizon in HPAIRS_HORIZONS:
        ewma_value = _ewma_last(values, half_life=float(horizon))
        ewma_values[horizon] = ewma_value
        recent = values[-min(values.size, horizon) :]
        baseline = values[: max(0, values.size - horizon)]
        baseline_mean = _mean(baseline)
        shock = _mean(recent) - baseline_mean if baseline.size else _mean(recent)
        horizon_payload[f"{horizon}_microbars"] = {
            "ewma": str(_decimal(ewma_value)),
            "shock": str(_decimal(shock)),
            "memory": str(_decimal(baseline_mean)),
            "sample_count": str(min(values.size, horizon)),
        }
    short = ewma_values[HPAIRS_HORIZONS[0]]
    medium = ewma_values[HPAIRS_HORIZONS[1]]
    long = ewma_values[HPAIRS_HORIZONS[2]]
    shock_score = float(np.clip(short - long, -1.0, 1.0))
    memory_score = float(np.clip(0.65 * medium + 0.35 * long, -1.0, 1.0))
    return {
        "status": "available",
        "horizons": horizon_payload,
        "shock_score": str(_decimal(shock_score)),
        "memory_score": str(_decimal(memory_score)),
        "directional_alignment_score": str(
            _decimal(0.6 * shock_score + 0.4 * memory_score)
        ),
        "source": "available_ofi_or_depth_fields",
    }


def _merged_horizon_features(
    stats: Sequence[_SymbolMicrostructureStats], *, direction: float
) -> dict[str, Any]:
    values = _concat_arrays(tuple(stat.ofi_values for stat in stats))
    features = _horizon_ofi_features(values)
    alignment = float(features["directional_alignment_score"])
    return {
        **features,
        "directional_alignment_score": str(_decimal(direction * alignment)),
        "candidate_direction": "continuation" if direction > 0 else "reversal",
    }


def _empty_horizon_features() -> dict[str, Any]:
    return {
        "status": "missing_inputs",
        "horizons": {},
        "shock_score": "0",
        "memory_score": "0",
        "directional_alignment_score": "0",
        "source": "missing_ofi_or_depth_fields",
    }


def _cluster_behavior(
    *,
    event_labels: Sequence[str],
    ofi_values: NDArray[np.float64],
    microprice_bias_bps: NDArray[np.float64],
    has_cluster_fields: bool,
) -> dict[str, Any]:
    entropy = _normalized_entropy(event_labels)
    pressure = _mean(np.abs(ofi_values))
    burstiness = (
        _percentile(np.abs(np.diff(ofi_values)), 75.0) if ofi_values.size >= 3 else 0.0
    )
    microprice = _mean(microprice_bias_bps)
    cluster_score = float(
        np.clip(
            0.30 * entropy
            + 0.40 * pressure
            + 0.20 * burstiness
            + 0.10 * min(1.0, abs(microprice) / 5.0),
            0.0,
            1.0,
        )
    )
    dominant_label = _dominant_label(event_labels)
    if pressure >= 0.25 and microprice >= 0.0:
        behavior_bucket = "clusterlob_accumulation"
    elif pressure >= 0.25 and microprice < 0.0:
        behavior_bucket = "clusterlob_distribution"
    elif burstiness >= 0.20:
        behavior_bucket = "clusterlob_bursty_order_flow"
    else:
        behavior_bucket = "balanced_microbar_flow"
    source = (
        "cluster_lob_fields" if has_cluster_fields else "microbar_order_flow_fallback"
    )
    return {
        "status": "available" if ofi_values.size else "missing_ofi_inputs",
        "behavior_bucket": behavior_bucket,
        "dominant_event_label": dominant_label,
        "cluster_score": str(_decimal(cluster_score)),
        "event_entropy": str(_decimal(entropy)),
        "ofi_abs_pressure": str(_decimal(pressure)),
        "ofi_burstiness": str(_decimal(burstiness)),
        "microprice_bias_bps": str(_decimal(microprice)),
        "source": source,
    }


def _empty_cluster_behavior() -> dict[str, Any]:
    return {
        "status": "missing_inputs",
        "behavior_bucket": "unknown",
        "dominant_event_label": "unknown",
        "cluster_score": "0",
        "event_entropy": "0",
        "ofi_abs_pressure": "0",
        "ofi_burstiness": "0",
        "microprice_bias_bps": "0",
        "source": "missing_cluster_lob_and_order_flow_fields",
    }


def _regime_stress_veto(
    *,
    spread_values: NDArray[np.float64],
    returns_bps: NDArray[np.float64],
    volume_values: NDArray[np.float64],
    stress_values: Sequence[float],
    row_count: int,
) -> dict[str, Any]:
    spread_tail_bps = _percentile(spread_values, 95.0)
    return_tail_bps = _percentile(np.abs(returns_bps), 95.0)
    liquidity_score = _volume_score(volume_values)
    bounded_row_count = max(0, int(row_count))
    stress_sample_count = len(stress_values)
    stress_active_count = sum(1 for value in stress_values if value > 0.0)
    macro_window_concentration = (
        stress_sample_count / bounded_row_count if bounded_row_count > 0 else 0.0
    )
    macro_window_active_share = (
        stress_active_count / bounded_row_count if bounded_row_count > 0 else 0.0
    )
    input_stress_score = (
        float(np.clip(_mean(np.asarray(stress_values, dtype=np.float64)), 0.0, 1.0))
        if stress_values
        else 0.0
    )
    spread_stress = float(np.clip(max(0.0, spread_tail_bps - 12.0) / 38.0, 0.0, 1.0))
    return_stress = float(np.clip(max(0.0, return_tail_bps - 35.0) / 115.0, 0.0, 1.0))
    liquidity_stress = (
        float(np.clip(1.0 - liquidity_score, 0.0, 1.0)) if volume_values.size else 0.0
    )
    veto_score = float(
        np.clip(
            max(
                input_stress_score,
                0.45 * spread_stress + 0.35 * return_stress + 0.20 * liquidity_stress,
            ),
            0.0,
            1.0,
        )
    )
    return {
        "status": "available"
        if stress_values or spread_values.size or returns_bps.size
        else "missing_inputs",
        "veto_score": str(_decimal(veto_score)),
        "veto_active": veto_score >= 0.65,
        "input_stress_score": str(_decimal(input_stress_score)),
        "macro_window_sample_count": stress_sample_count,
        "macro_window_active_count": stress_active_count,
        "macro_window_concentration": str(_decimal(macro_window_concentration)),
        "macro_window_active_share": str(_decimal(macro_window_active_share)),
        "spread_tail_bps": str(_decimal(spread_tail_bps)),
        "return_tail_abs_bps": str(_decimal(return_tail_bps)),
        "liquidity_score": str(_decimal(liquidity_score)),
        "source": "source_fields_plus_microbar_stress_fallback"
        if stress_values
        else "microbar_regime_fallback_missing_explicit_stress_fields",
    }


def _empty_regime_stress_veto() -> dict[str, Any]:
    return {
        "status": "missing_inputs",
        "veto_score": "0",
        "veto_active": False,
        "input_stress_score": "0",
        "macro_window_sample_count": 0,
        "macro_window_active_count": 0,
        "macro_window_concentration": "0",
        "macro_window_active_share": "0",
        "spread_tail_bps": "0",
        "return_tail_abs_bps": "0",
        "liquidity_score": "0",
        "source": "missing_regime_stress_fields",
    }


def _macro_window_stress_from_regime(
    regime_stress_veto: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "status": regime_stress_veto.get("status", "missing_inputs"),
        "concentration": str(
            regime_stress_veto.get("macro_window_concentration") or "0"
        ),
        "active_share": str(regime_stress_veto.get("macro_window_active_share") or "0"),
        "sample_count": int(regime_stress_veto.get("macro_window_sample_count") or 0),
        "active_count": int(regime_stress_veto.get("macro_window_active_count") or 0),
        "stress_score": str(regime_stress_veto.get("input_stress_score") or "0"),
        "veto_score": str(regime_stress_veto.get("veto_score") or "0"),
        "veto_active": bool(regime_stress_veto.get("veto_active")),
        "source": regime_stress_veto.get("source", "missing_regime_stress_fields"),
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
    }


def _empty_macro_window_stress() -> dict[str, Any]:
    return _macro_window_stress_from_regime(_empty_regime_stress_veto())


def _extract_price(signal: SignalEnvelope, *, source_fields: set[str]) -> float | None:
    payload = signal.payload
    for key in ("price", "mid_price", "mid", "mark", "last_price", "close"):
        value = _float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            source_fields.add(key)
            return value
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        source_fields.update(("bid", "ask"))
        return (bid + ask) / 2.0
    return None


def _extract_spread_bps(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    explicit = _float_or_none(payload.get("spread_bps"))
    if explicit is not None:
        source_fields.add("spread_bps")
        return max(0.0, explicit)
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        source_fields.update(("bid", "ask"))
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = _float_or_none(payload.get("spread"))
    price = _extract_price(signal, source_fields=source_fields)
    if spread is not None and price is not None and price > 0.0:
        source_fields.add("spread")
        return max(0.0, spread / price * 10_000.0)
    return None


def _extract_ofi_pressure(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
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
        source_fields.add(key)
        if -1.0 <= value <= 1.0:
            return value
        return float(np.tanh(value / 100.0))
    return _extract_quote_depth_imbalance(signal, source_fields=source_fields)


def _extract_quote_depth_imbalance(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    bid_size, bid_key = _first_float_with_key(
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
    ask_size, ask_key = _first_float_with_key(
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
    if bid_key is not None:
        source_fields.add(bid_key)
    if ask_key is not None:
        source_fields.add(ask_key)
    return float(np.clip((bid_size - ask_size) / (bid_size + ask_size), -1.0, 1.0))


def _extract_microprice_bias_bps(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    bid, bid_key = _first_float_with_key(
        payload, ("bid", "best_bid", "bid_price", "best_bid_price")
    )
    ask, ask_key = _first_float_with_key(
        payload, ("ask", "best_ask", "ask_price", "best_ask_price")
    )
    explicit_microprice, microprice_key = _first_float_with_key(
        payload, ("microprice", "micro_price")
    )
    price = _extract_price(signal, source_fields=source_fields)
    if explicit_microprice is not None and price is not None and price > 0.0:
        if microprice_key is not None:
            source_fields.add(microprice_key)
        return (explicit_microprice - price) / price * 10_000.0

    bid_size, bid_size_key = _first_float_with_key(
        payload, ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty")
    )
    ask_size, ask_size_key = _first_float_with_key(
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
    for key in (bid_key, ask_key, bid_size_key, ask_size_key):
        if key is not None:
            source_fields.add(key)
    mid = (bid + ask) / 2.0
    microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
    return (microprice - mid) / mid * 10_000.0


def _extract_volume(signal: SignalEnvelope, *, source_fields: set[str]) -> float | None:
    payload = signal.payload
    value, key = _first_float_with_key(
        payload,
        ("microbar_volume", "bar_volume", "trade_volume", "volume", "qty", "size"),
        positive=True,
    )
    if value is not None and key is not None:
        source_fields.add(key)
    return value


def _event_label(signal: SignalEnvelope, *, source_fields: set[str]) -> str:
    payload = signal.payload
    for key in (
        "cluster_lob_label",
        "order_cluster",
        "lob_event_type",
        "event_type",
        "order_event_type",
        "side",
        "liquidity_side",
    ):
        value = str(payload.get(key) or "").strip().lower()
        if value:
            source_fields.add(key)
            return value
    return "unknown"


def _extract_regime_stress(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    for key in (
        "regime_stress_score",
        "stress_veto_score",
        "macro_news_stress_score",
        "macro_stress_score",
        "news_stress_score",
        "macro_event_window",
        "macro_announcement_window",
        "news_event_window",
        "stress_veto_window",
        "volatility_shock_veto",
    ):
        if key not in payload:
            continue
        source_fields.add(key)
        value = payload.get(key)
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        parsed = _float_or_none(value)
        if parsed is not None:
            return float(np.clip(parsed, 0.0, 1.0))
        text = str(value).strip().lower()
        if text in {"yes", "true", "macro", "news", "event", "stress", "veto"}:
            return 1.0
        if text in {"no", "false", "none", "normal"}:
            return 0.0
    return None


def _candidate_symbols(spec: CandidateSpec) -> tuple[str, ...]:
    raw = spec.strategy_overrides.get("universe_symbols")
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes, bytearray)):
        raw_symbols = cast(Sequence[Any], raw)
        symbols = tuple(
            sorted({_string(item).upper() for item in raw_symbols if _string(item)})
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


def _is_hpairs_candidate(spec: CandidateSpec) -> bool:
    return (
        spec.family_template_id == HPAIRS_FAMILY_TEMPLATE_ID
        or spec.runtime_strategy_name == HPAIRS_RUNTIME_STRATEGY_NAME
    )


def _candidate_notional(spec: CandidateSpec) -> float:
    return _float_or_none(spec.strategy_overrides.get("max_notional_per_trade")) or 0.0


def _capacity_penalty_bps(
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
            sqrt(max(0.0, participation)) * 100.0 + median_spread_bps * 0.25, 0.0, 500.0
        )
    )


def _impact_capacity_lineage(
    *,
    spec: CandidateSpec,
    median_price: float,
    median_volume: float,
    median_spread_bps: float,
    capacity_penalty_bps: float,
) -> dict[str, Any]:
    """Return square-root/power-law impact context as non-authoritative metadata."""

    notional = _candidate_notional(spec)
    dollar_volume = max(0.0, median_price) * max(0.0, median_volume)
    participation_rate_proxy = notional / dollar_volume if dollar_volume > 0.0 else None
    blockers: list[str] = []
    if notional <= 0.0:
        blockers.append("candidate_notional_missing")
    if median_price <= 0.0:
        blockers.append("median_price_missing")
    if median_volume <= 0.0:
        blockers.append("median_volume_missing")
    return {
        "schema_version": "torghut.hpairs-impact-capacity-lineage.v1",
        "status": "available"
        if dollar_volume > 0.0 and notional > 0.0
        else "missing_inputs",
        "model": "square_root_power_law_impact_proxy",
        "source": "replay_tape_price_volume_spread_fields",
        "candidate_notional": str(_decimal(notional)),
        "median_price": str(_decimal(median_price)),
        "median_volume": str(_decimal(median_volume)),
        "dollar_volume_proxy": str(_decimal(dollar_volume)),
        "participation_rate_proxy": str(_decimal(participation_rate_proxy))
        if participation_rate_proxy is not None
        else None,
        "median_spread_bps": str(_decimal(median_spread_bps)),
        "capacity_penalty_bps": str(_decimal(capacity_penalty_bps)),
        "blockers": blockers,
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
        "requires_source_backed_adv": True,
    }


def _volume_score(values: NDArray[np.float64]) -> float:
    if values.size == 0:
        return 0.0
    return float(
        np.clip(log(1.0 + max(0.0, _percentile(values, 50.0))) / 12.0, 0.0, 1.0)
    )


def _weighted_average(values: Sequence[tuple[float, int]]) -> float:
    total_weight = sum(max(0, weight) for _, weight in values)
    if total_weight <= 0:
        return 0.0
    return sum(value * max(0, weight) for value, weight in values) / total_weight


def _ewma_last(values: NDArray[np.float64], *, half_life: float) -> float:
    if values.size == 0:
        return 0.0
    decay = log(2.0) / max(1.0, half_life)
    total = 0.0
    weighted = 0.0
    for distance, value in enumerate(reversed(values.tolist())):
        weight = exp(-decay * float(distance))
        total += weight
        weighted += float(value) * weight
    if total <= 0.0:
        return 0.0
    return float(np.clip(weighted / total, -1.0, 1.0))


def _normalized_entropy(labels: Sequence[str]) -> float:
    clean = [label for label in labels if label and label != "unknown"]
    if not clean:
        return 0.0
    counts = Counter(clean)
    if len(counts) <= 1:
        return 0.0
    probabilities = np.asarray(
        [count / len(clean) for count in counts.values()], dtype=np.float64
    )
    entropy = -float(np.sum(probabilities * np.log(probabilities)))
    return float(np.clip(entropy / np.log(len(counts)), 0.0, 1.0))


def _dominant_label(labels: Sequence[str]) -> str:
    clean = [label for label in labels if label and label != "unknown"]
    if not clean:
        return "unknown"
    return sorted(Counter(clean).items(), key=lambda item: (-item[1], item[0]))[0][0]


def _concat_arrays(arrays: Sequence[NDArray[np.float64]]) -> NDArray[np.float64]:
    non_empty = [array for array in arrays if array.size]
    if not non_empty:
        return np.asarray([], dtype=np.float64)
    return np.concatenate(non_empty)


def _first_float_with_key(
    payload: Mapping[str, Any], keys: Sequence[str], *, positive: bool = False
) -> tuple[float | None, str | None]:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        if positive and value <= 0.0:
            continue
        return value, key
    return None, None


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _mean(values: NDArray[np.float64]) -> float:
    return float(np.mean(values)) if values.size else 0.0


def _percentile(values: NDArray[np.float64], percentile: float) -> float:
    return float(np.percentile(values, percentile)) if values.size else 0.0


def _decimal(value: float) -> Decimal:
    return Decimal(str(round(float(value), 8)))


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


__all__ = [
    "HPAIRS_AUTHORITY_BLOCKERS",
    "HPAIRS_FAMILY_TEMPLATE_ID",
    "HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL",
    "HPAIRS_PREFILTER_PROOF_SOURCE",
    "HPAIRS_PREFILTER_ROW_SCHEMA_VERSION",
    "HPAIRS_PREFILTER_SCHEMA_VERSION",
    "HPAIRS_RUNTIME_STRATEGY_NAME",
    "MicrostructureCandidatePrefilterRow",
    "MicrostructurePrefilterResult",
    "build_hpairs_microstructure_prefilter",
]

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821


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
    pair_convergence_risk: Mapping[str, Any] = field(
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
            "pair_convergence_risk": dict(self.pair_convergence_risk),
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
                "pair_spread_convergence_risk_prefilter",
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
    price_by_timestamp: Mapping[int, float]


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
    from .horizon_ofi_features import (
        cluster_behavior as _cluster_behavior,
        event_label as _event_label,
        extract_microprice_bias_bps as _extract_microprice_bias_bps,
        extract_ofi_pressure as _extract_ofi_pressure,
        extract_price as _extract_price,
        extract_regime_stress as _extract_regime_stress,
        extract_spread_bps as _extract_spread_bps,
        extract_volume as _extract_volume,
        horizon_ofi_features as _horizon_ofi_features,
        regime_stress_veto as _regime_stress_veto,
        timestamp_key as _timestamp_key,
    )
    from .weighted_average import percentile as _percentile

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
        price_by_timestamp = {
            _timestamp_key(row): price
            for row, price in zip(ordered, prices, strict=False)
            if price is not None and price > 0.0
        }
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
            price_by_timestamp=price_by_timestamp,
        )
    return stats


def _score_spec(
    *,
    spec: CandidateSpec,
    stats_by_symbol: Mapping[str, _SymbolMicrostructureStats],
    min_rows_per_candidate: int,
) -> MicrostructureCandidatePrefilterRow:
    from .horizon_ofi_features import (
        candidate_direction as _candidate_direction,
        candidate_symbols as _candidate_symbols,
        capacity_penalty_bps as _capacity_penalty_bps,
        cluster_behavior as _cluster_behavior,
        empty_cluster_behavior as _empty_cluster_behavior,
        empty_horizon_features as _empty_horizon_features,
        empty_macro_window_stress as _empty_macro_window_stress,
        empty_pair_convergence_risk as _empty_pair_convergence_risk,
        empty_regime_stress_veto as _empty_regime_stress_veto,
        impact_capacity_lineage as _impact_capacity_lineage,
        is_hpairs_candidate as _is_hpairs_candidate,
        macro_window_stress_from_regime as _macro_window_stress_from_regime,
        merged_horizon_features as _merged_horizon_features,
        pair_convergence_risk as _pair_convergence_risk,
        regime_stress_veto as _regime_stress_veto,
        volume_score as _volume_score,
    )
    from .weighted_average import (
        concat_arrays as _concat_arrays,
        decimal as _decimal,
        mean as _mean,
        percentile as _percentile,
        weighted_average as _weighted_average,
    )

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
            pair_convergence_risk=_empty_pair_convergence_risk(),
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
    pair_convergence_risk = _pair_convergence_risk(matched)
    convergence_risk_score = float(pair_convergence_risk["risk_score"])
    convergence_quality_score = float(pair_convergence_risk["convergence_score"])
    if pair_convergence_risk.get("status") != "available" and len(matched) >= 2:
        warnings.add("missing_pair_convergence_price_alignment")
    elif convergence_risk_score >= 0.85:
        blockers.add("pair_convergence_risk_veto_active")
    elif convergence_risk_score >= 0.55:
        warnings.add("pair_convergence_risk_elevated")
    exploitation_score = (
        signed_return_bps
        + ofi_alignment * 18.0
        + ofi_shock * 9.0
        + ofi_memory * 6.0
        + cluster_score * 12.0
        + convergence_quality_score * 16.0
        + microprice_alignment * 0.25
        + coverage_score * 15.0
        + volume_score * 5.0
        - median_spread_bps * 0.06
        - spread_tail_bps * 0.04
        - return_tail_abs_bps * 0.025
        - capacity_penalty * 0.18
        - stress_veto * 30.0
        - convergence_risk_score * 24.0
    )
    exploration_score = (
        abs(ofi_shock) * 12.0
        + abs(ofi_memory) * 8.0
        + cluster_score * 10.0
        + convergence_quality_score * 8.0
        + volume_score * 4.0
        + coverage_score * 8.0
        - stress_veto * 12.0
        - capacity_penalty * 0.06
        - convergence_risk_score * 8.0
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
        pair_convergence_risk=pair_convergence_risk,
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
        pair_convergence_risk=row.pair_convergence_risk,
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


# Public aliases used by split-module consumers.
SymbolMicrostructureStats = _SymbolMicrostructureStats
build_symbol_microstructure_stats = _build_symbol_microstructure_stats
rank_key = _rank_key
score_spec = _score_spec
select_frontier_buckets = _select_frontier_buckets
source_field_diagnostics = _source_field_diagnostics
source_input_blockers = _source_input_blockers
with_rank_and_bucket = _with_rank_and_bucket

SymbolMicrostructureStats_split_export = _SymbolMicrostructureStats
build_symbol_microstructure_stats_split_export = _build_symbol_microstructure_stats
rank_key_split_export = _rank_key
score_spec_split_export = _score_spec
select_frontier_buckets_split_export = _select_frontier_buckets
source_field_diagnostics_split_export = _source_field_diagnostics
source_input_blockers_split_export = _source_input_blockers
with_rank_and_bucket_split_export = _with_rank_and_bucket
__all__ = [name for name in globals() if not name.startswith("__")]

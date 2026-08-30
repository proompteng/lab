"""Preview-only Hawkes transient-impact stress for replay ranking.

This module actualizes recent 2025-2026 execution papers into deterministic
replay-ranking features. It uses only local replay rows/fixtures, records source
coverage gaps explicitly, and never claims realized PnL, fills, promotion
authority, or live-capital eligibility.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, sqrt
from typing import Any

from app.trading.models import SignalEnvelope

HAWKES_TRANSIENT_IMPACT_STRESS_SCHEMA_VERSION = (
    "torghut.hawkes-transient-impact-stress.v1"
)
HAWKES_TRANSIENT_IMPACT_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.hawkes-transient-impact-stress-contract.v1"
)
HAWKES_TRANSIENT_IMPACT_STRESS_PROOF_SEMANTICS_LABEL = "hawkes_transient_impact_stress_preview_only_exact_event_replay_route_tca_order_lifecycle_runtime_ledger_required"
HAWKES_TRANSIENT_IMPACT_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2504.10282",
        "url": "https://arxiv.org/abs/2504.10282",
        "title": "Optimal Execution in Intraday Energy Markets under Hawkes Processes with Transient Impact",
        "date": "2025-11-25",
        "mechanism": "mutually_exciting_order_flow_with_transient_impact_changes_intraday_execution_costs",
    },
    {
        "source_id": "arxiv-2603.29086",
        "url": "https://arxiv.org/abs/2603.29086",
        "title": "Realistic Market Impact Modeling for Reinforcement Learning Trading Environments",
        "date": "2026-04-04",
        "mechanism": "nonlinear_square_root_impact_permanent_decay_and_trade_level_cost_logging_change_replay_rankings",
    },
    {
        "source_id": "ssrn-5170318",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5170318",
        "title": "Assessing the Impact of the Order Book with a Hawkes Process in a Random Environment",
        "date": "2025-03-08",
        "mechanism": "order_book_conditioned_hawkes_arrivals_require_session_specific_execution_context",
    },
    {
        "source_id": "arxiv-2604.23961",
        "url": "https://arxiv.org/abs/2604.23961",
        "title": "Extended State-dependent Hawkes Process for Limit Order Books: Mathematical Foundation and the Reproduction of Volatility Signature Plots",
        "date": "2026-04-27",
        "mechanism": "state_dependent_lob_hawkes_models_require_physical_consistency_and_marketable_limit_order_context",
    },
)
HAWKES_TRANSIENT_IMPACT_STRESS_SOURCE_MARKERS: tuple[str, ...] = (
    "hawkes_transient_impact_arxiv_2504_10282_2025",
    "realistic_market_impact_arxiv_2603_29086_2026",
    "orderbook_hawkes_random_environment_ssrn_5170318_2025",
    "state_dependent_hawkes_arxiv_2604_23961_2026",
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_FIELDS = (
    "spread_bps",
    "quoted_spread_bps",
    "effective_spread_bps",
    "nbbo_spread_bps",
)
_SIZE_FIELDS = (
    "signed_size",
    "signed_qty",
    "signed_quantity",
    "signed_order_flow",
    "ofi_size",
    "order_size",
    "quantity",
    "qty",
    "size",
    "trade_size",
    "shares",
)
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "share_volume",
    "trade_volume",
    "notional_volume",
)
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "orderflow_imbalance",
    "imbalance_pressure",
    "signed_order_flow",
)
_DEPTH_FIELDS = (
    "top_depth",
    "top_of_book_depth",
    "visible_depth",
    "queue_depth",
    "bid_depth",
    "ask_depth",
    "bid_size",
    "ask_size",
)
_PARTICIPATION_FIELDS = (
    "participation_rate",
    "target_participation_rate",
    "arrival_participation_rate",
)
_LATENCY_FIELDS = (
    "submit_latency_ms",
    "route_latency_ms",
    "ack_latency_ms",
    "decision_latency_ms",
)
_BUY_TOKENS = frozenset(("buy", "b", "bid", "buyer", "lift", "aggressive_buy"))
_SELL_TOKENS = frozenset(("sell", "s", "ask", "seller", "hit", "aggressive_sell"))
_SIDE_FIELDS = (
    "side",
    "trade_side",
    "aggressor_side",
    "order_side",
    "direction",
    "signed_direction",
)


@dataclass(frozen=True)
class HawkesTransientImpactStressSummary:
    row_count: int
    event_observation_count: int
    signed_event_count: int
    size_observation_count: int
    volume_observation_count: int
    spread_observation_count: int
    depth_observation_count: int
    participation_observation_count: int
    latency_observation_count: int
    median_interarrival_seconds: float
    burst_event_share: float
    same_side_cluster_share: float
    cross_side_excitation_share: float
    transient_impact_pressure_bps: float
    square_root_impact_pressure_bps: float
    impact_decay_gap_score: float
    source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": HAWKES_TRANSIENT_IMPACT_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_hawkes_transient_impact_stress_ranking",
            "source_papers": [
                dict(item) for item in HAWKES_TRANSIENT_IMPACT_STRESS_PRIMARY_SOURCES
            ],
            "source_markers": list(HAWKES_TRANSIENT_IMPACT_STRESS_SOURCE_MARKERS),
            "row_count": self.row_count,
            "event_observation_count": self.event_observation_count,
            "signed_event_count": self.signed_event_count,
            "size_observation_count": self.size_observation_count,
            "volume_observation_count": self.volume_observation_count,
            "spread_observation_count": self.spread_observation_count,
            "depth_observation_count": self.depth_observation_count,
            "participation_observation_count": self.participation_observation_count,
            "latency_observation_count": self.latency_observation_count,
            "median_interarrival_seconds": _stable_float(
                self.median_interarrival_seconds
            ),
            "burst_event_share": _stable_float(self.burst_event_share),
            "same_side_cluster_share": _stable_float(self.same_side_cluster_share),
            "cross_side_excitation_share": _stable_float(
                self.cross_side_excitation_share
            ),
            "transient_impact_pressure_bps": _stable_float(
                self.transient_impact_pressure_bps
            ),
            "square_root_impact_pressure_bps": _stable_float(
                self.square_root_impact_pressure_bps
            ),
            "impact_decay_gap_score": _stable_float(self.impact_decay_gap_score),
            "source_gap_score": _stable_float(self.source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "burst_event_share": _stable_float(self.burst_event_share),
                "same_side_cluster_share": _stable_float(self.same_side_cluster_share),
                "cross_side_excitation_share": _stable_float(
                    self.cross_side_excitation_share
                ),
                "transient_impact_pressure_bps": _stable_float(
                    self.transient_impact_pressure_bps
                ),
                "square_root_impact_pressure_bps": _stable_float(
                    self.square_root_impact_pressure_bps
                ),
                "impact_decay_gap_score": _stable_float(self.impact_decay_gap_score),
                "source_gap_score": _stable_float(self.source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "hawkes_excitation_preview": True,
            "transient_impact_preview": True,
            "square_root_impact_preview": True,
            "requires_event_time_replay_downstream": True,
            "requires_order_lifecycle_events_downstream": True,
            "requires_route_tca_downstream": True,
            "requires_runtime_ledger_downstream": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": HAWKES_TRANSIENT_IMPACT_STRESS_PROOF_SEMANTICS_LABEL,
        }


def hawkes_transient_impact_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": HAWKES_TRANSIENT_IMPACT_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": HAWKES_TRANSIENT_IMPACT_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in HAWKES_TRANSIENT_IMPACT_STRESS_PRIMARY_SOURCES
        ],
        "source_markers": list(HAWKES_TRANSIENT_IMPACT_STRESS_SOURCE_MARKERS),
        "stress_policy": "hawkes_event_time_transient_impact_execution_replay_guard",
        "stress_components": [
            "burst_event_share",
            "same_side_cluster_share",
            "cross_side_excitation_share",
            "transient_impact_pressure_bps",
            "square_root_impact_pressure_bps",
            "impact_decay_gap_score",
            "source_gap_score",
        ],
        "price_fields": list(_PRICE_FIELDS),
        "spread_fields": list(_SPREAD_FIELDS),
        "size_fields": list(_SIZE_FIELDS),
        "volume_fields": list(_VOLUME_FIELDS),
        "ofi_fields": list(_OFI_FIELDS),
        "depth_fields": list(_DEPTH_FIELDS),
        "participation_fields": list(_PARTICIPATION_FIELDS),
        "latency_fields": list(_LATENCY_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_event_time_replay": True,
            "requires_order_lifecycle_events": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "rejects_hawkes_intensity_as_fill_authority": True,
            "rejects_modeled_impact_as_realized_pnl_authority": True,
            "rejects_missing_event_signs_as_neutral_order_flow": True,
        },
    }


def build_hawkes_transient_impact_stress_schema_hash() -> str:
    return _stable_hash(hawkes_transient_impact_stress_contract())


def extract_hawkes_transient_impact_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    max_notional: float | int | None = None,
) -> HawkesTransientImpactStressSummary:
    """Extract deterministic Hawkes/transient-impact stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    event_rows = tuple(row for row in ordered if _is_event_observation(row))
    signed_events = tuple(
        (row, sign, size)
        for row in event_rows
        if (sign := _row_sign(row)) is not None
        and (size := _row_size(row, fallback_abs_ofi=True)) is not None
        and size > 0.0
    )
    interarrivals = _interarrival_seconds(event_rows)
    median_interarrival_seconds = _median(interarrivals)
    burst_threshold_seconds = _burst_threshold_seconds(interarrivals)
    burst_count = sum(
        1 for seconds in interarrivals if seconds <= burst_threshold_seconds
    )
    same_side_cluster_count = 0
    cross_side_excitation_count = 0
    transient_pressures: list[float] = []
    for (previous_row, previous_sign, _), (row, sign, _) in zip(
        signed_events, signed_events[1:]
    ):
        if previous_row.symbol != row.symbol:
            continue
        seconds = (row.event_ts - previous_row.event_ts).total_seconds()
        if seconds < 0.0 or seconds > max(burst_threshold_seconds * 3.0, 30.0):
            continue
        if previous_sign == sign:
            same_side_cluster_count += 1
        else:
            cross_side_excitation_count += 1
        return_bps = _row_return_bps(previous_row, row)
        if return_bps is not None:
            transient_pressures.append(
                max(0.0, return_bps * previous_sign)
                + max(0.0, return_bps * signed_direction) * 0.25
            )

    spread_values: list[float] = []
    volume_values: list[float] = []
    depth_values: list[float] = []
    participation_values: list[float] = []
    latency_values: list[float] = []
    for row in ordered:
        spread = _row_spread_bps(row)
        if spread is not None:
            spread_values.append(spread)
        volume = _row_volume(row)
        if volume is not None:
            volume_values.append(volume)
        depth = _row_depth(row)
        if depth is not None:
            depth_values.append(depth)
        participation = _row_participation(row)
        if participation is not None:
            participation_values.append(participation)
        latency = _row_latency_ms(row)
        if latency is not None:
            latency_values.append(latency)
    size_values = tuple(size for _, _, size in signed_events)
    median_spread_bps = _median(spread_values)
    median_volume = _median(volume_values)
    median_size = _median(size_values)
    explicit_notional = float(max_notional or 0.0)
    impact_notional_proxy = max(
        explicit_notional, median_size * max(1.0, _median_price(ordered))
    )
    square_root_impact_pressure_bps = _square_root_impact_pressure_bps(
        impact_notional_proxy=impact_notional_proxy,
        median_volume=median_volume,
        median_price=_median_price(ordered),
        median_spread_bps=median_spread_bps,
    )
    denominator = max(1, len(interarrivals))
    signed_denominator = max(1, len(signed_events) - 1)
    burst_event_share = burst_count / denominator
    same_side_cluster_share = same_side_cluster_count / signed_denominator
    cross_side_excitation_share = cross_side_excitation_count / signed_denominator
    transient_impact_pressure_bps = _percentile(tuple(transient_pressures), 0.75)
    impact_decay_gap_score = _impact_decay_gap_score(
        latency_observation_count=len(latency_values),
        depth_observation_count=len(depth_values),
        participation_observation_count=len(participation_values),
        transient_impact_pressure_bps=transient_impact_pressure_bps,
        square_root_impact_pressure_bps=square_root_impact_pressure_bps,
    )
    source_gap_score, warnings = _source_gap_score(
        ordered=ordered,
        event_observation_count=len(event_rows),
        signed_event_count=len(signed_events),
        size_observation_count=len(size_values),
        volume_observation_count=len(volume_values),
        spread_observation_count=len(spread_values),
        median_interarrival_seconds=median_interarrival_seconds,
    )
    warnings_set = set(warnings)
    if burst_event_share >= 0.50:
        warnings_set.add("hawkes_event_time_burst_cluster_detected")
    if same_side_cluster_share >= 0.35:
        warnings_set.add("same_side_self_excitation_cluster_detected")
    if cross_side_excitation_share >= 0.35:
        warnings_set.add("cross_side_mutual_excitation_cluster_detected")
    if transient_impact_pressure_bps > 0.0 and not latency_values:
        warnings_set.add("transient_impact_without_latency_decay_context")
    if square_root_impact_pressure_bps > 0.0 and not volume_values:
        warnings_set.add("square_root_impact_without_volume_context")
    replay_rank_penalty_bps = min(
        275.0,
        burst_event_share * 22.0
        + same_side_cluster_share * 32.0
        + cross_side_excitation_share * 18.0
        + transient_impact_pressure_bps * 0.75
        + square_root_impact_pressure_bps * 0.55
        + impact_decay_gap_score * 34.0
        + source_gap_score * 28.0,
    )
    return HawkesTransientImpactStressSummary(
        row_count=len(ordered),
        event_observation_count=len(event_rows),
        signed_event_count=len(signed_events),
        size_observation_count=len(size_values),
        volume_observation_count=len(volume_values),
        spread_observation_count=len(spread_values),
        depth_observation_count=len(depth_values),
        participation_observation_count=len(participation_values),
        latency_observation_count=len(latency_values),
        median_interarrival_seconds=median_interarrival_seconds,
        burst_event_share=burst_event_share,
        same_side_cluster_share=same_side_cluster_share,
        cross_side_excitation_share=cross_side_excitation_share,
        transient_impact_pressure_bps=transient_impact_pressure_bps,
        square_root_impact_pressure_bps=square_root_impact_pressure_bps,
        impact_decay_gap_score=impact_decay_gap_score,
        source_gap_score=source_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings_set)),
        feature_schema_hash=build_hawkes_transient_impact_stress_schema_hash(),
    )


def _is_event_observation(row: SignalEnvelope) -> bool:
    return (
        _row_sign(row) is not None
        or _row_size(row, fallback_abs_ofi=False) is not None
        or _coalesce_numeric(row.payload, _OFI_FIELDS) is not None
    )


def _row_return_bps(previous_row: SignalEnvelope, row: SignalEnvelope) -> float | None:
    previous_price = _row_price(previous_row)
    price = _row_price(row)
    if previous_price is None or price is None or previous_price <= 0.0:
        return None
    return (price - previous_price) / previous_price * 10_000.0


def _source_gap_score(
    *,
    ordered: Sequence[SignalEnvelope],
    event_observation_count: int,
    signed_event_count: int,
    size_observation_count: int,
    volume_observation_count: int,
    spread_observation_count: int,
    median_interarrival_seconds: float,
) -> tuple[float, tuple[str, ...]]:
    warnings: set[str] = set()
    if not ordered:
        return 1.0, ("missing_replay_rows",)
    score = 0.0
    if event_observation_count == 0:
        score += 0.25
        warnings.add("missing_event_time_observations")
    if signed_event_count == 0:
        score += 0.25
        warnings.add("missing_signed_order_flow_events")
    elif signed_event_count < max(2, event_observation_count // 2):
        score += 0.10
        warnings.add("partial_signed_order_flow_coverage")
    if size_observation_count == 0:
        score += 0.15
        warnings.add("missing_event_size_context")
    if volume_observation_count == 0:
        score += 0.15
        warnings.add("missing_volume_context")
    if spread_observation_count == 0:
        score += 0.10
        warnings.add("missing_spread_context")
    if median_interarrival_seconds >= 300.0:
        score += 0.25
        warnings.add("coarse_replay_clock_for_hawkes_stress")
    elif median_interarrival_seconds >= 60.0:
        score += 0.12
        warnings.add("minute_bar_clock_for_hawkes_stress")
    return min(1.0, score), tuple(sorted(warnings))


def _impact_decay_gap_score(
    *,
    latency_observation_count: int,
    depth_observation_count: int,
    participation_observation_count: int,
    transient_impact_pressure_bps: float,
    square_root_impact_pressure_bps: float,
) -> float:
    score = 0.0
    if transient_impact_pressure_bps > 0.0 and latency_observation_count == 0:
        score += 0.35
    if square_root_impact_pressure_bps > 0.0 and participation_observation_count == 0:
        score += 0.25
    if (
        transient_impact_pressure_bps > 0.0 or square_root_impact_pressure_bps > 0.0
    ) and depth_observation_count == 0:
        score += 0.25
    if transient_impact_pressure_bps >= 10.0:
        score += 0.15
    return min(1.0, score)


def _square_root_impact_pressure_bps(
    *,
    impact_notional_proxy: float,
    median_volume: float,
    median_price: float,
    median_spread_bps: float,
) -> float:
    dollar_volume = median_volume * max(0.0, median_price)
    if impact_notional_proxy <= 0.0 or dollar_volume <= 0.0:
        return 0.0
    participation = min(25.0, impact_notional_proxy / dollar_volume)
    return max(0.0, median_spread_bps) + 12.5 * sqrt(max(0.0, participation))


def _burst_threshold_seconds(interarrivals: Sequence[float]) -> float:
    if not interarrivals:
        return 0.0
    median = _median(interarrivals)
    p25 = _percentile(interarrivals, 0.25)
    return max(0.001, min(30.0, max(p25, median * 0.50)))


def _interarrival_seconds(rows: Sequence[SignalEnvelope]) -> tuple[float, ...]:
    if len(rows) < 2:
        return ()
    ordered = tuple(sorted(rows, key=lambda row: (row.symbol, row.event_ts, row.seq)))
    deltas: list[float] = []
    for previous, current in zip(ordered, ordered[1:]):
        if previous.symbol != current.symbol:
            continue
        seconds = (current.event_ts - previous.event_ts).total_seconds()
        if seconds >= 0.0 and isfinite(seconds):
            deltas.append(seconds)
    return tuple(deltas)


def _row_sign(row: SignalEnvelope) -> float | None:
    side = _coalesce_string(row.payload, _SIDE_FIELDS)
    if side is not None:
        lowered = side.strip().lower()
        if lowered in _BUY_TOKENS:
            return 1.0
        if lowered in _SELL_TOKENS:
            return -1.0
        numeric = _float_or_none(lowered)
        if numeric is not None and numeric != 0.0:
            return 1.0 if numeric > 0.0 else -1.0
    signed_size = _coalesce_numeric(
        row.payload,
        ("signed_size", "signed_qty", "signed_quantity", "signed_order_flow"),
    )
    if signed_size is not None and signed_size != 0.0:
        return 1.0 if signed_size > 0.0 else -1.0
    ofi = _coalesce_numeric(row.payload, _OFI_FIELDS)
    if ofi is not None and ofi != 0.0:
        return 1.0 if ofi > 0.0 else -1.0
    return None


def _row_size(row: SignalEnvelope, *, fallback_abs_ofi: bool) -> float | None:
    value = _coalesce_numeric(row.payload, _SIZE_FIELDS)
    if value is not None:
        value = abs(value)
        if value > 0.0:
            return value
    if fallback_abs_ofi:
        ofi = _coalesce_numeric(row.payload, _OFI_FIELDS)
        if ofi is not None and ofi != 0.0:
            return abs(ofi)
    return None


def _row_price(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _PRICE_FIELDS)
    if value is None or value <= 0.0:
        return None
    return value


def _row_spread_bps(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _SPREAD_FIELDS)
    if value is None or value < 0.0:
        return None
    return value


def _row_volume(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _VOLUME_FIELDS)
    if value is None or value <= 0.0:
        return None
    return value


def _row_depth(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _DEPTH_FIELDS)
    if value is None or value <= 0.0:
        return None
    return value


def _row_participation(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _PARTICIPATION_FIELDS)
    if value is None or value < 0.0:
        return None
    return value


def _row_latency_ms(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _LATENCY_FIELDS)
    if value is None or value < 0.0:
        return None
    return value


def _median_price(rows: Sequence[SignalEnvelope]) -> float:
    return _median(
        tuple(value for row in rows if (value := _row_price(row)) is not None)
    )


def _coalesce_numeric(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> float | None:
    for field in fields:
        value = payload.get(field)
        numeric = _float_or_none(value)
        if numeric is not None and isfinite(numeric):
            return numeric
    return None


def _coalesce_string(payload: Mapping[str, Any], fields: Sequence[str]) -> str | None:
    for field in fields:
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(numeric):
        return None
    return numeric


def _median(values: Sequence[float]) -> float:
    return _percentile(values, 0.50)


def _percentile(values: Sequence[float], percentile: float) -> float:
    clean = sorted(float(value) for value in values if isfinite(float(value)))
    if not clean:
        return 0.0
    if len(clean) == 1:
        return clean[0]
    position = max(0.0, min(1.0, percentile)) * (len(clean) - 1)
    lower = int(position)
    upper = min(lower + 1, len(clean) - 1)
    fraction = position - lower
    return clean[lower] * (1.0 - fraction) + clean[upper] * fraction


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 8)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()[:24]

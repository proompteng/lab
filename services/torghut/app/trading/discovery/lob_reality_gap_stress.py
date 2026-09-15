"""Preview-only LOB reality-gap stress for replay candidate ranking.

This module converts recent limit-order-book simulation and liquidity reliability
papers into deterministic replay-ranking inputs. It never simulates fills, writes
ledgers, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

LOB_REALITY_GAP_STRESS_SCHEMA_VERSION = "torghut.lob-reality-gap-stress.v2"
LOB_REALITY_GAP_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.lob-reality-gap-stress-contract.v1"
)
LOB_REALITY_GAP_STRESS_PROOF_SEMANTICS_LABEL = "lob_reality_gap_stress_preview_only_exact_replay_route_tca_order_lifecycle_runtime_ledger_required"
LOB_REALITY_GAP_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2603.24137",
        "url": "https://arxiv.org/abs/2603.24137",
        "title": "Bridging the Reality Gap in Limit Order Book Simulation",
        "date": "2026-03-25",
        "mechanism": "spread_volume_imbalance_projection_latency_mode_and_power_law_signed_flow_impact",
    },
    {
        "source_id": "ofr-25-01",
        "url": "https://www.financialresearch.gov/working-papers/2025/06/05/the-reliability-of-odd-lot-liquidity/",
        "title": "The Reliability of Odd-Lot Liquidity",
        "date": "2025-06-05",
        "mechanism": "off_exchange_trade_correlated_odd_lot_liquidity_vanish_and_cancellation_stress",
    },
    {
        "source_id": "arxiv-2507.06345",
        "url": "https://arxiv.org/abs/2507.06345",
        "title": "Reinforcement Learning for Trade Execution with Market and Limit Orders",
        "date": "2026-01-26",
        "mechanism": "market_limit_allocation_sensitivity_to_order_book_imbalance_tactical_response",
    },
    {
        "source_id": "arxiv-2502.07071",
        "url": "https://arxiv.org/abs/2502.07071",
        "title": "TRADES: Tool for Responsive Agent-Based Modeling of Digital Exchange Simulator",
        "date": "2025-02-11",
        "mechanism": "responsive_exchange_event_mix_and_state_conditioned_order_response_gap",
    },
)

_BID_FIELDS = ("bid", "best_bid", "bid_price", "best_bid_price")
_ASK_FIELDS = ("ask", "best_ask", "ask_price", "best_ask_price")
_BID_SIZE_FIELDS = (
    "bid_size",
    "bid_qty",
    "best_bid_size",
    "best_bid_qty",
    "bid_depth",
    "bid_volume",
)
_ASK_SIZE_FIELDS = (
    "ask_size",
    "ask_qty",
    "best_ask_size",
    "best_ask_qty",
    "ask_depth",
    "ask_volume",
)
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_TRADE_SIZE_FIELDS = ("trade_size", "trade_qty", "last_size", "volume", "qty")
_NOTIONAL_FIELDS = ("trade_notional", "notional", "dollar_volume", "signed_notional")
_DIRECTION_FIELDS = (
    "trade_direction",
    "aggressor_side",
    "trade_side",
    "side",
    "execution_side",
)
_LATENCY_MS_FIELDS = (
    "round_trip_latency_ms",
    "exchange_round_trip_latency_ms",
    "latency_ms",
    "event_latency_ms",
)
_ODD_LOT_BID_FIELDS = ("odd_lot_bid_size", "odd_lot_bid_qty", "hidden_odd_lot_bid_size")
_ODD_LOT_ASK_FIELDS = ("odd_lot_ask_size", "odd_lot_ask_qty", "hidden_odd_lot_ask_size")
_OFF_EXCHANGE_FIELDS = (
    "off_exchange_trade",
    "off_exchange_print",
    "trf_trade",
    "dark_trade",
)
_EVENT_TYPE_FIELDS = ("event_type", "lob_event_type", "order_event_type")
_MARKET_EVENT_TOKENS = ("trade", "market", "fill", "execute")
_LIMIT_EVENT_TOKENS = ("add", "insert", "new", "quote", "limit")
_CANCEL_EVENT_TOKENS = ("cancel", "delete", "remove", "replace")
_POWER_LAW_DECAY_EXPONENT = 0.60
_HIGH_IMBALANCE_FLOOR = 0.65
_ODD_LOT_VANISH_FLOOR = 0.50


@dataclass(frozen=True)
class LobRealityGapStressSummary:
    row_count: int
    observed_spread_count: int
    observed_depth_count: int
    observed_latency_count: int
    observed_signed_flow_count: int
    observed_odd_lot_count: int
    observed_responsive_event_count: int
    off_exchange_event_count: int
    median_spread_bps: float
    median_abs_volume_imbalance: float
    high_imbalance_share: float
    responsive_event_concentration_share: float
    state_conditioned_response_gap_share: float
    responsive_simulation_gap_score: float
    latency_mode_ms: float
    latency_mode_share: float
    power_law_signed_flow_impact_bps: float
    impact_reversion_failure_share: float
    odd_lot_vanish_share: float
    off_exchange_cancellation_share: float
    replay_reality_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": LOB_REALITY_GAP_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_lob_reality_gap_stress_ranking",
            "source_papers": [
                dict(item) for item in LOB_REALITY_GAP_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_depth_count": self.observed_depth_count,
            "observed_latency_count": self.observed_latency_count,
            "observed_signed_flow_count": self.observed_signed_flow_count,
            "observed_odd_lot_count": self.observed_odd_lot_count,
            "observed_responsive_event_count": self.observed_responsive_event_count,
            "off_exchange_event_count": self.off_exchange_event_count,
            "median_spread_bps": _stable_float(self.median_spread_bps),
            "median_abs_volume_imbalance": _stable_float(
                self.median_abs_volume_imbalance
            ),
            "high_imbalance_share": _stable_float(self.high_imbalance_share),
            "responsive_event_concentration_share": _stable_float(
                self.responsive_event_concentration_share
            ),
            "state_conditioned_response_gap_share": _stable_float(
                self.state_conditioned_response_gap_share
            ),
            "responsive_simulation_gap_score": _stable_float(
                self.responsive_simulation_gap_score
            ),
            "latency_mode_ms": _stable_float(self.latency_mode_ms),
            "latency_mode_share": _stable_float(self.latency_mode_share),
            "power_law_signed_flow_impact_bps": _stable_float(
                self.power_law_signed_flow_impact_bps
            ),
            "impact_reversion_failure_share": _stable_float(
                self.impact_reversion_failure_share
            ),
            "odd_lot_vanish_share": _stable_float(self.odd_lot_vanish_share),
            "off_exchange_cancellation_share": _stable_float(
                self.off_exchange_cancellation_share
            ),
            "replay_reality_gap_score": _stable_float(self.replay_reality_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "median_abs_volume_imbalance": _stable_float(
                    self.median_abs_volume_imbalance
                ),
                "high_imbalance_share": _stable_float(self.high_imbalance_share),
                "responsive_event_concentration_share": _stable_float(
                    self.responsive_event_concentration_share
                ),
                "state_conditioned_response_gap_share": _stable_float(
                    self.state_conditioned_response_gap_share
                ),
                "responsive_simulation_gap_score": _stable_float(
                    self.responsive_simulation_gap_score
                ),
                "latency_mode_share": _stable_float(self.latency_mode_share),
                "power_law_signed_flow_impact_bps": _stable_float(
                    self.power_law_signed_flow_impact_bps
                ),
                "impact_reversion_failure_share": _stable_float(
                    self.impact_reversion_failure_share
                ),
                "odd_lot_vanish_share": _stable_float(self.odd_lot_vanish_share),
                "off_exchange_cancellation_share": _stable_float(
                    self.off_exchange_cancellation_share
                ),
                "replay_reality_gap_score": _stable_float(
                    self.replay_reality_gap_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "spread_volume_imbalance_projection_preview": True,
            "latency_race_mode_preview": True,
            "power_law_signed_flow_impact_preview": True,
            "odd_lot_liquidity_reliability_preview": True,
            "responsive_exchange_simulation_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": LOB_REALITY_GAP_STRESS_PROOF_SEMANTICS_LABEL,
        }


def lob_reality_gap_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": LOB_REALITY_GAP_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": LOB_REALITY_GAP_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in LOB_REALITY_GAP_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "lob_simulation_reality_gap_latency_impact_odd_lot_reliability_stress",
        "stress_components": [
            "spread_volume_imbalance_projection",
            "latency_mode_share",
            "power_law_signed_flow_impact_bps",
            "impact_reversion_failure_share",
            "odd_lot_vanish_share",
            "off_exchange_cancellation_share",
            "responsive_event_concentration_share",
            "state_conditioned_response_gap_share",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_simulator_only_pnl_authority": True,
            "rejects_hidden_or_odd_lot_liquidity_as_fill_authority": True,
            "rejects_responsive_simulator_only_pnl_authority": True,
        },
    }


def build_lob_reality_gap_stress_schema_hash() -> str:
    return _stable_hash(lob_reality_gap_stress_contract())


def extract_lob_reality_gap_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> LobRealityGapStressSummary:
    """Extract deterministic LOB simulation reality-gap stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    spreads = tuple(value for row in ordered if (value := _spread_bps(row)) is not None)
    depths = tuple(_depth_notional(row) for row in ordered)
    observed_depths = tuple(
        value for value in depths if value is not None and value > 0
    )
    depth_median = _median(observed_depths) or 1.0
    volume_imbalances = tuple(_volume_imbalance(row) for row in ordered)
    imbalances = tuple(value for value in volume_imbalances if value is not None)
    abs_imbalances = tuple(abs(value) for value in imbalances)
    responsive_event_categories = tuple(
        category for row in ordered if (category := _event_category(row)) is not None
    )
    responsive_event_concentration_share = _event_category_concentration(
        responsive_event_categories
    )
    event_mix_gap_score = max(
        0.0, (responsive_event_concentration_share - (1.0 / 3.0)) / (2.0 / 3.0)
    )
    state_conditioned_response_gap_share = _state_conditioned_response_gap_share(
        ordered,
        volume_imbalances=volume_imbalances,
    )
    responsive_simulation_gap_score = min(
        1.0, event_mix_gap_score * 0.55 + state_conditioned_response_gap_share * 0.45
    )
    latency_values: list[float] = []
    for row in ordered:
        value = _latency_ms(row)
        if value is not None:
            latency_values.append(value)
    latency_mode_ms, latency_mode_share = _latency_mode(latency_values)
    signed_flow = tuple(
        _signed_flow_notional(row, direction=signed_direction) for row in ordered
    )
    observed_signed_flow = tuple(value for value in signed_flow if value is not None)
    decayed_flow = _power_law_decayed_signed_flow(
        ordered,
        signed_flow=signed_flow,
        depth_median=depth_median,
    )
    impact_bps = _signed_flow_impact_bps(ordered, decayed_flow=decayed_flow)
    odd_lot_values = tuple(_odd_lot_notional(row) for row in ordered)
    observed_odd_lots = tuple(value for value in odd_lot_values if value is not None)
    odd_lot_median = _median(observed_odd_lots) or 0.0
    off_exchange_count = sum(1 for row in ordered if _is_off_exchange(row))
    odd_lot_vanish_count = sum(
        1
        for row, value in zip(ordered, odd_lot_values, strict=False)
        if _is_off_exchange(row)
        and value is not None
        and odd_lot_median > 0.0
        and value < odd_lot_median * _ODD_LOT_VANISH_FLOOR
    )
    off_exchange_cancel_count = sum(
        1
        for row in ordered
        if _is_off_exchange(row) and _event_type_contains(row, ("cancel", "delete"))
    )
    impact_reversion_failure_share = _impact_reversion_failure_share(
        ordered,
        decayed_flow=decayed_flow,
        direction=signed_direction,
    )
    high_imbalance_share = _share(
        1 for value in abs_imbalances if value >= _HIGH_IMBALANCE_FLOOR
    ) / max(1, len(abs_imbalances))
    odd_lot_vanish_share = odd_lot_vanish_count / max(1, off_exchange_count)
    off_exchange_cancellation_share = off_exchange_cancel_count / max(
        1, off_exchange_count
    )
    median_abs_imbalance = _median(abs_imbalances) or 0.0
    median_spread_bps = _median(spreads) or 0.0
    power_law_signed_flow_impact_bps = max(
        (abs(value) for value in impact_bps), default=0.0
    )
    replay_reality_gap_score = min(
        1.0,
        median_abs_imbalance * 0.35
        + high_imbalance_share * 0.20
        + min(1.0, latency_mode_share) * 0.12
        + min(1.0, power_law_signed_flow_impact_bps / 25.0) * 0.18
        + impact_reversion_failure_share * 0.10
        + odd_lot_vanish_share * 0.12
        + responsive_simulation_gap_score * 0.12
        + off_exchange_cancellation_share * 0.08,
    )
    replay_rank_penalty_bps = (
        median_spread_bps * 0.10
        + median_abs_imbalance * 8.0
        + high_imbalance_share * 4.0
        + latency_mode_share * 2.0
        + power_law_signed_flow_impact_bps * 0.18
        + impact_reversion_failure_share * 6.0
        + odd_lot_vanish_share * 5.0
        + off_exchange_cancellation_share * 3.0
        + responsive_simulation_gap_score * 4.0
    )
    warnings: list[str] = []
    if not spreads:
        warnings.append("missing_spread_inputs")
    if not observed_depths:
        warnings.append("missing_depth_inputs")
    if not latency_values:
        warnings.append("missing_latency_inputs")
    if not observed_signed_flow:
        warnings.append("missing_signed_flow_inputs")
    if not observed_odd_lots:
        warnings.append("missing_odd_lot_liquidity_inputs")
    if not responsive_event_categories:
        warnings.append("missing_responsive_event_type_inputs")

    return LobRealityGapStressSummary(
        row_count=len(ordered),
        observed_spread_count=len(spreads),
        observed_depth_count=len(observed_depths),
        observed_latency_count=len(latency_values),
        observed_signed_flow_count=len(observed_signed_flow),
        observed_odd_lot_count=len(observed_odd_lots),
        observed_responsive_event_count=len(responsive_event_categories),
        off_exchange_event_count=off_exchange_count,
        median_spread_bps=median_spread_bps,
        median_abs_volume_imbalance=median_abs_imbalance,
        high_imbalance_share=high_imbalance_share,
        responsive_event_concentration_share=responsive_event_concentration_share,
        state_conditioned_response_gap_share=state_conditioned_response_gap_share,
        responsive_simulation_gap_score=responsive_simulation_gap_score,
        latency_mode_ms=latency_mode_ms,
        latency_mode_share=latency_mode_share,
        power_law_signed_flow_impact_bps=power_law_signed_flow_impact_bps,
        impact_reversion_failure_share=impact_reversion_failure_share,
        odd_lot_vanish_share=odd_lot_vanish_share,
        off_exchange_cancellation_share=off_exchange_cancellation_share,
        replay_reality_gap_score=replay_reality_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(warnings),
        feature_schema_hash=build_lob_reality_gap_stress_schema_hash(),
    )


def _payload(row: SignalEnvelope) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], row.payload)


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if isfinite(result) else None


def _first_number(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = _number(payload.get(field))
        if value is not None:
            return value
    return None


def _spread_bps(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    explicit = _first_number(payload, _SPREAD_BPS_FIELDS)
    if explicit is not None:
        return max(0.0, explicit)
    bid = _first_number(payload, _BID_FIELDS)
    ask = _first_number(payload, _ASK_FIELDS)
    if bid is None or ask is None or bid <= 0.0 or ask <= bid:
        return None
    mid = (bid + ask) / 2.0
    return ((ask - bid) / mid) * 10_000.0 if mid > 0.0 else None


def _price(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    price = _first_number(payload, _PRICE_FIELDS)
    if price is not None and price > 0.0:
        return price
    bid = _first_number(payload, _BID_FIELDS)
    ask = _first_number(payload, _ASK_FIELDS)
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def _depth_notional(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    bid_size = _first_number(payload, _BID_SIZE_FIELDS)
    ask_size = _first_number(payload, _ASK_SIZE_FIELDS)
    price = _price(row)
    if bid_size is None or ask_size is None or price is None:
        return None
    return max(0.0, bid_size + ask_size) * price


def _volume_imbalance(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    bid_size = _first_number(payload, _BID_SIZE_FIELDS)
    ask_size = _first_number(payload, _ASK_SIZE_FIELDS)
    if bid_size is None or ask_size is None:
        return None
    total = bid_size + ask_size
    if total <= 0.0:
        return None
    return (bid_size - ask_size) / total


def _latency_ms(row: SignalEnvelope) -> float | None:
    value = _first_number(_payload(row), _LATENCY_MS_FIELDS)
    return max(0.0, value) if value is not None else None


def _signed_flow_notional(row: SignalEnvelope, *, direction: float) -> float | None:
    payload = _payload(row)
    explicit = _first_number(payload, _NOTIONAL_FIELDS)
    price = _price(row) or 1.0
    size = _first_number(payload, _TRADE_SIZE_FIELDS)
    magnitude = abs(explicit) if explicit is not None else None
    if magnitude is None and size is not None:
        magnitude = abs(size) * price
    if magnitude is None or magnitude == 0.0:
        return None
    sign = _direction_sign(payload) or direction
    return sign * magnitude


def _direction_sign(payload: Mapping[str, Any]) -> float | None:
    for field in _DIRECTION_FIELDS:
        value = payload.get(field)
        if value is None:
            continue
        token = str(value).strip().lower()
        if token in {"buy", "bid", "b", "1", "+1", "long"}:
            return 1.0
        if token in {"sell", "ask", "offer", "s", "-1", "short"}:
            return -1.0
    return None


def _power_law_decayed_signed_flow(
    rows: Sequence[SignalEnvelope],
    *,
    signed_flow: Sequence[float | None],
    depth_median: float,
) -> tuple[float, ...]:
    values: list[float] = []
    state = 0.0
    previous_ts = None
    for row, flow in zip(rows, signed_flow, strict=False):
        if previous_ts is not None:
            dt_seconds = max(0.0, (row.event_ts - previous_ts).total_seconds())
            state *= (1.0 + dt_seconds) ** (-_POWER_LAW_DECAY_EXPONENT)
        if flow is not None:
            state += flow / max(1.0, depth_median)
        values.append(state)
        previous_ts = row.event_ts
    return tuple(values)


def _signed_flow_impact_bps(
    rows: Sequence[SignalEnvelope], *, decayed_flow: Sequence[float]
) -> tuple[float, ...]:
    prices = tuple(_price(row) for row in rows)
    impacts: list[float] = []
    for index, state in enumerate(decayed_flow[:-1]):
        current_price = prices[index]
        next_price = prices[index + 1]
        if current_price is None or next_price is None or current_price <= 0.0:
            continue
        move_bps = ((next_price - current_price) / current_price) * 10_000.0
        impacts.append(move_bps * (1.0 if state >= 0.0 else -1.0))
    return tuple(value for value in impacts if value > 0.0)


def _impact_reversion_failure_share(
    rows: Sequence[SignalEnvelope], *, decayed_flow: Sequence[float], direction: float
) -> float:
    prices = tuple(_price(row) for row in rows)
    failures = 0
    observations = 0
    for index, state in enumerate(decayed_flow[:-1]):
        current_price = prices[index]
        next_price = prices[index + 1]
        if (
            abs(state) < 0.05
            or current_price is None
            or next_price is None
            or current_price <= 0.0
        ):
            continue
        observations += 1
        signed_move = (
            ((next_price - current_price) / current_price)
            * (1.0 if state >= 0.0 else -1.0)
            * direction
        )
        if signed_move >= 0.0:
            failures += 1
    return failures / max(1, observations)


def _odd_lot_notional(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    bid = _first_number(payload, _ODD_LOT_BID_FIELDS)
    ask = _first_number(payload, _ODD_LOT_ASK_FIELDS)
    price = _price(row)
    if bid is None or ask is None or price is None:
        return None
    return max(0.0, bid + ask) * price


def _is_off_exchange(row: SignalEnvelope) -> bool:
    payload = _payload(row)
    return any(_truthy(payload.get(field)) for field in _OFF_EXCHANGE_FIELDS)


def _event_type_contains(row: SignalEnvelope, needles: Sequence[str]) -> bool:
    payload = _payload(row)
    tokens = tuple(
        str(payload.get(field) or "").strip().lower() for field in _EVENT_TYPE_FIELDS
    )
    return any(needle in token for token in tokens for needle in needles)


def _event_category(row: SignalEnvelope) -> str | None:
    payload = _payload(row)
    tokens = tuple(
        str(payload.get(field) or "").strip().lower()
        for field in _EVENT_TYPE_FIELDS
        if str(payload.get(field) or "").strip()
    )
    for token in tokens:
        if any(item in token for item in _CANCEL_EVENT_TOKENS):
            return "cancel"
        if any(item in token for item in _LIMIT_EVENT_TOKENS):
            return "limit"
        if any(item in token for item in _MARKET_EVENT_TOKENS):
            return "market"
    return None


def _event_category_concentration(categories: Sequence[str]) -> float:
    if not categories:
        return 0.0
    counts: dict[str, int] = {}
    for category in categories:
        counts[category] = counts.get(category, 0) + 1
    return max(counts.values()) / max(1, len(categories))


def _state_conditioned_response_gap_share(
    rows: Sequence[SignalEnvelope],
    *,
    volume_imbalances: Sequence[float | None],
) -> float:
    gaps = 0
    observations = 0
    for index in range(1, min(len(rows), len(volume_imbalances))):
        previous_imbalance = volume_imbalances[index - 1]
        current_imbalance = volume_imbalances[index]
        if previous_imbalance is None or current_imbalance is None:
            continue
        if abs(previous_imbalance) < _HIGH_IMBALANCE_FLOOR:
            continue
        previous_category = _event_category(rows[index - 1])
        current_category = _event_category(rows[index])
        if previous_category is None or current_category is None:
            continue
        observations += 1
        if (
            previous_category == current_category
            and abs(current_imbalance) >= abs(previous_imbalance) * 0.90
        ):
            gaps += 1
    return gaps / max(1, observations)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _latency_mode(values: Sequence[float]) -> tuple[float, float]:
    if not values:
        return 0.0, 0.0
    buckets: dict[float, int] = {}
    for value in values:
        bucket = round(value, 1)
        buckets[bucket] = buckets.get(bucket, 0) + 1
    mode, count = max(buckets.items(), key=lambda item: (item[1], -item[0]))
    return mode, count / max(1, len(values))


def _median(values: Sequence[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _share(items: Any) -> float:
    return float(sum(1 for _ in items))


def _stable_float(value: float) -> float:
    return round(float(value), 8) if isfinite(float(value)) else 0.0


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

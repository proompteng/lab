"""Preview-only institutional market-mechanism fidelity stress.

This module converts recent 2025-2026 market-simulation papers into deterministic
replay-ranking inputs. It flags candidate previews whose edge is concentrated in
auction/session-boundary, price-limit, tick-size, or asynchronous cross-asset
regions that historical microbar replay can easily over-credit unless exact
exchange-calendar, price-time-priority order lifecycle, route TCA, and runtime
ledger evidence are present.

The output is a local replay prefilter only: it never synthesizes PnL, writes a
runtime ledger, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import timezone
from math import floor, isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_SCHEMA_VERSION = (
    "torghut.institutional-mechanism-fidelity-stress.v1"
)
INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.institutional-mechanism-fidelity-stress-contract.v1"
)
INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PROOF_SEMANTICS_LABEL = (
    "institutional_mechanism_fidelity_stress_preview_only_"
    "exchange_calendar_price_time_priority_route_tca_runtime_ledger_required"
)
INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PRIMARY_SOURCES: tuple[
    Mapping[str, str], ...
] = (
    {
        "source_id": "arxiv-2604.18046",
        "url": "https://arxiv.org/abs/2604.18046",
        "title": "EvoMarket: A High-Fidelity and Scalable Financial Market Simulator",
        "date": "2026-04-20",
        "mechanism": (
            "market_calendars_opening_call_auctions_price_limits_"
            "propagation_delays_asynchronous_per_asset_matching"
        ),
    },
    {
        "source_id": "arxiv-2511.02016",
        "url": "https://arxiv.org/abs/2511.02016",
        "title": (
            "ABIDES-MARL: A Multi-Agent Reinforcement Learning Environment for "
            "Endogenous Price Formation and Execution in a Limit Order Book"
        ),
        "date": "2025-11-03",
        "mechanism": (
            "price_time_priority_discrete_tick_sizes_heterogeneous_agents_"
            "individual_price_impacts"
        ),
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_MARKET_PHASE_FIELDS = (
    "market_phase",
    "session_phase",
    "session",
    "trading_session",
    "market_session",
)
_AUCTION_FLAG_FIELDS = (
    "is_auction",
    "auction",
    "opening_auction",
    "closing_auction",
    "is_opening_auction",
    "is_closing_auction",
    "call_auction",
)
_BOUNDARY_FLAG_FIELDS = (
    "session_open_window",
    "session_close_window",
    "market_open_window",
    "market_close_window",
    "open_auction_window",
    "close_auction_window",
)
_LIMIT_FLAG_FIELDS = (
    "price_limit_hit",
    "limit_up_hit",
    "limit_down_hit",
    "limit_state",
    "trading_halt",
    "halted",
    "is_halted",
)
_LIMIT_UP_FIELDS = ("limit_up_price", "price_limit_up", "upper_price_limit")
_LIMIT_DOWN_FIELDS = ("limit_down_price", "price_limit_down", "lower_price_limit")
_TICK_SIZE_FIELDS = (
    "tick_size",
    "minimum_tick",
    "price_increment",
    "min_price_increment",
)
_ORDER_TYPE_FIELDS = (
    "order_type",
    "event_type",
    "order_event_type",
    "lob_event_type",
    "action",
    "type",
)
_LATENCY_FIELDS = (
    "propagation_delay_ms",
    "venue_latency_ms",
    "exchange_latency_ms",
    "event_latency_ms",
    "round_trip_latency_ms",
    "latency_ms",
)
_AUCTION_TOKENS = frozenset(("auction", "call", "opening", "closing", "open", "close"))
_LIMIT_TOKENS = frozenset(("limit", "halt", "paused", "limit_up", "limit_down"))
_MARKET_ORDER_TOKENS = frozenset(
    ("market", "mo", "trade", "execution", "executed", "fill")
)
_LIMIT_ORDER_TOKENS = frozenset(("limit", "add", "insert", "quote", "post"))
_CANCEL_TOKENS = frozenset(("cancel", "delete", "remove", "replace"))
_US_CASH_OPEN_MINUTE_UTC = 14 * 60 + 30
_US_CASH_CLOSE_MINUTE_UTC = 21 * 60
_BOUNDARY_WINDOW_MINUTES = 15
_PRICE_LIMIT_PROXIMITY_BPS = 25.0
_ASYNC_GAP_MS_FLOOR = 750.0
_LATENCY_SPIKE_MS_FLOOR = 250.0


@dataclass(frozen=True)
class InstitutionalMechanismFidelityStressSummary:
    row_count: int
    observed_market_phase_count: int
    observed_tick_size_count: int
    observed_order_type_count: int
    observed_latency_count: int
    auction_or_boundary_count: int
    price_limit_or_halt_count: int
    session_boundary_abs_return_share: float
    auction_or_boundary_share: float
    price_limit_proximity_share: float
    tick_rounding_violation_share: float
    cross_asset_async_gap_share: float
    latency_spike_share: float
    order_space_coverage_score: float
    missing_mechanism_metadata_score: float
    mechanism_fidelity_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_institutional_mechanism_fidelity_stress_ranking",
            "source_papers": [
                dict(item)
                for item in INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_market_phase_count": self.observed_market_phase_count,
            "observed_tick_size_count": self.observed_tick_size_count,
            "observed_order_type_count": self.observed_order_type_count,
            "observed_latency_count": self.observed_latency_count,
            "auction_or_boundary_count": self.auction_or_boundary_count,
            "price_limit_or_halt_count": self.price_limit_or_halt_count,
            "session_boundary_abs_return_share": _stable_float(
                self.session_boundary_abs_return_share
            ),
            "auction_or_boundary_share": _stable_float(self.auction_or_boundary_share),
            "price_limit_proximity_share": _stable_float(
                self.price_limit_proximity_share
            ),
            "tick_rounding_violation_share": _stable_float(
                self.tick_rounding_violation_share
            ),
            "cross_asset_async_gap_share": _stable_float(
                self.cross_asset_async_gap_share
            ),
            "latency_spike_share": _stable_float(self.latency_spike_share),
            "order_space_coverage_score": _stable_float(
                self.order_space_coverage_score
            ),
            "missing_mechanism_metadata_score": _stable_float(
                self.missing_mechanism_metadata_score
            ),
            "mechanism_fidelity_gap_score": _stable_float(
                self.mechanism_fidelity_gap_score
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "session_boundary_abs_return_share": _stable_float(
                    self.session_boundary_abs_return_share
                ),
                "auction_or_boundary_share": _stable_float(
                    self.auction_or_boundary_share
                ),
                "price_limit_proximity_share": _stable_float(
                    self.price_limit_proximity_share
                ),
                "tick_rounding_violation_share": _stable_float(
                    self.tick_rounding_violation_share
                ),
                "cross_asset_async_gap_share": _stable_float(
                    self.cross_asset_async_gap_share
                ),
                "latency_spike_share": _stable_float(self.latency_spike_share),
                "order_space_coverage_score": _stable_float(
                    self.order_space_coverage_score
                ),
                "missing_mechanism_metadata_score": _stable_float(
                    self.missing_mechanism_metadata_score
                ),
                "mechanism_fidelity_gap_score": _stable_float(
                    self.mechanism_fidelity_gap_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "market_calendar_preview": True,
            "opening_closing_call_auction_preview": True,
            "price_limit_and_halt_preview": True,
            "price_time_priority_tick_size_preview": True,
            "asynchronous_cross_asset_matching_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def institutional_mechanism_fidelity_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item)
            for item in INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": (
            "institutional_market_mechanism_fidelity_stress_for_replay_ranking"
        ),
        "stress_components": [
            "session_boundary_abs_return_share",
            "auction_or_boundary_share",
            "price_limit_proximity_share",
            "tick_rounding_violation_share",
            "cross_asset_async_gap_share",
            "latency_spike_share",
            "order_space_coverage_score",
            "missing_mechanism_metadata_score",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_exchange_calendar_replay": True,
            "requires_price_time_priority_order_lifecycle": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "rejects_simulator_calibration_as_pnl_authority": True,
            "rejects_session_boundary_microbar_alpha_as_fill_proof": True,
            "rejects_price_limit_or_halt_rows_as_live_capital_authority": True,
        },
    }


def build_institutional_mechanism_fidelity_stress_schema_hash() -> str:
    return _stable_hash(institutional_mechanism_fidelity_stress_contract())


def extract_institutional_mechanism_fidelity_stress(
    records: Sequence[SignalEnvelope],
) -> InstitutionalMechanismFidelityStressSummary:
    """Extract deterministic institutional-mechanism fidelity stress from rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    schema_hash = build_institutional_mechanism_fidelity_stress_schema_hash()
    if not ordered:
        return InstitutionalMechanismFidelityStressSummary(
            row_count=0,
            observed_market_phase_count=0,
            observed_tick_size_count=0,
            observed_order_type_count=0,
            observed_latency_count=0,
            auction_or_boundary_count=0,
            price_limit_or_halt_count=0,
            session_boundary_abs_return_share=0.0,
            auction_or_boundary_share=0.0,
            price_limit_proximity_share=0.0,
            tick_rounding_violation_share=0.0,
            cross_asset_async_gap_share=0.0,
            latency_spike_share=0.0,
            order_space_coverage_score=0.0,
            missing_mechanism_metadata_score=1.0,
            mechanism_fidelity_gap_score=1.0,
            replay_rank_penalty_bps=30.0,
            warnings=("empty_replay_rows_for_institutional_mechanism_fidelity_stress",),
            feature_schema_hash=schema_hash,
        )

    row_count = len(ordered)
    phase_count = 0
    tick_count = 0
    order_type_count = 0
    latency_count = 0
    auction_count = 0
    limit_count = 0
    price_limit_near = 0
    tick_violations = 0
    latency_spikes = 0
    action_tokens: set[str] = set()
    warnings: set[str] = set()
    prices_by_symbol: dict[str, list[tuple[int, float, bool]]] = {}
    previous_by_symbol: dict[str, float] = {}
    total_abs_return_bps = 0.0
    boundary_abs_return_bps = 0.0

    for row in ordered:
        payload = row.payload
        price = _first_number(payload, _PRICE_FIELDS)
        boundary = _is_auction_or_boundary(row)
        limit_or_halt = _is_limit_or_halt(payload)
        if _first_value(payload, _MARKET_PHASE_FIELDS) is not None:
            phase_count += 1
        if _first_value(payload, _TICK_SIZE_FIELDS) is not None:
            tick_count += 1
        if _first_value(payload, _ORDER_TYPE_FIELDS) is not None:
            order_type_count += 1
        latency = _first_number(payload, _LATENCY_FIELDS)
        if latency is not None:
            latency_count += 1
            if latency >= _LATENCY_SPIKE_MS_FLOOR:
                latency_spikes += 1
        if boundary:
            auction_count += 1
        if limit_or_halt:
            limit_count += 1
        if price is not None:
            if _near_price_limit(payload, price):
                price_limit_near += 1
            tick_size = _first_number(payload, _TICK_SIZE_FIELDS)
            if (
                tick_size is not None
                and tick_size > 0.0
                and _tick_rounding_violated(price, tick_size)
            ):
                tick_violations += 1
            previous = previous_by_symbol.get(row.symbol)
            if previous is not None and previous > 0.0:
                abs_return_bps = abs((price / previous - 1.0) * 10000.0)
                total_abs_return_bps += abs_return_bps
                if boundary:
                    boundary_abs_return_bps += abs_return_bps
            previous_by_symbol[row.symbol] = price
            prices_by_symbol.setdefault(row.symbol, []).append(
                (_epoch_millis(row), price, boundary)
            )
        action_token = _order_action_token(payload)
        if action_token:
            action_tokens.add(action_token)

    if phase_count == 0:
        warnings.add("missing_market_phase_or_session_metadata")
    if tick_count == 0:
        warnings.add("missing_tick_size_metadata_for_price_time_priority_replay")
    if order_type_count == 0:
        warnings.add("missing_order_action_space_metadata")
    if latency_count == 0:
        warnings.add("missing_propagation_or_exchange_latency_metadata")

    observed_metadata_components = sum(
        1
        for count in (phase_count, tick_count, order_type_count, latency_count)
        if count > 0
    )
    missing_mechanism_metadata_score = 1.0 - observed_metadata_components / 4.0
    auction_share = auction_count / row_count
    price_limit_proximity_share = (limit_count + price_limit_near) / row_count
    tick_rounding_violation_share = tick_violations / max(1, tick_count)
    latency_spike_share = latency_spikes / max(1, latency_count)
    session_boundary_abs_return_share = (
        boundary_abs_return_bps / total_abs_return_bps
        if total_abs_return_bps > 0.0
        else 0.0
    )
    cross_asset_async_gap_share = _cross_asset_async_gap_share(ordered)
    order_space_coverage_score = len(action_tokens) / 3.0
    if order_space_coverage_score < 1.0:
        warnings.add("incomplete_market_limit_cancel_action_space_observed")

    mechanism_fidelity_gap_score = min(
        1.0,
        missing_mechanism_metadata_score * 0.24
        + auction_share * 0.18
        + session_boundary_abs_return_share * 0.16
        + price_limit_proximity_share * 0.16
        + tick_rounding_violation_share * 0.10
        + cross_asset_async_gap_share * 0.10
        + latency_spike_share * 0.06
        + (1.0 - min(1.0, order_space_coverage_score)) * 0.10,
    )
    replay_rank_penalty_bps = min(90.0, 8.0 + mechanism_fidelity_gap_score * 82.0)

    return InstitutionalMechanismFidelityStressSummary(
        row_count=row_count,
        observed_market_phase_count=phase_count,
        observed_tick_size_count=tick_count,
        observed_order_type_count=order_type_count,
        observed_latency_count=latency_count,
        auction_or_boundary_count=auction_count,
        price_limit_or_halt_count=limit_count,
        session_boundary_abs_return_share=session_boundary_abs_return_share,
        auction_or_boundary_share=auction_share,
        price_limit_proximity_share=price_limit_proximity_share,
        tick_rounding_violation_share=tick_rounding_violation_share,
        cross_asset_async_gap_share=cross_asset_async_gap_share,
        latency_spike_share=latency_spike_share,
        order_space_coverage_score=min(1.0, order_space_coverage_score),
        missing_mechanism_metadata_score=missing_mechanism_metadata_score,
        mechanism_fidelity_gap_score=mechanism_fidelity_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=schema_hash,
    )


def _is_auction_or_boundary(row: SignalEnvelope) -> bool:
    payload = row.payload
    phase = str(_first_value(payload, _MARKET_PHASE_FIELDS) or "").lower()
    if any(token in phase for token in _AUCTION_TOKENS):
        return True
    for field in _AUCTION_FLAG_FIELDS + _BOUNDARY_FLAG_FIELDS:
        value = payload.get(field)
        if _truthy(value):
            return True
    minute = (
        row.event_ts.astimezone(timezone.utc).hour * 60
        + row.event_ts.astimezone(timezone.utc).minute
    )
    return (
        abs(minute - _US_CASH_OPEN_MINUTE_UTC) <= _BOUNDARY_WINDOW_MINUTES
        or abs(minute - _US_CASH_CLOSE_MINUTE_UTC) <= _BOUNDARY_WINDOW_MINUTES
    )


def _is_limit_or_halt(payload: Mapping[str, Any]) -> bool:
    for field in _LIMIT_FLAG_FIELDS:
        value = payload.get(field)
        if _truthy(value):
            return True
        if isinstance(value, str) and any(
            token in value.lower() for token in _LIMIT_TOKENS
        ):
            return True
    phase = str(_first_value(payload, _MARKET_PHASE_FIELDS) or "").lower()
    return any(token in phase for token in _LIMIT_TOKENS)


def _near_price_limit(payload: Mapping[str, Any], price: float) -> bool:
    if price <= 0.0:
        return False
    limit_up = _first_number(payload, _LIMIT_UP_FIELDS)
    limit_down = _first_number(payload, _LIMIT_DOWN_FIELDS)
    for limit_price in (limit_up, limit_down):
        if limit_price is None or limit_price <= 0.0:
            continue
        distance_bps = abs(price / limit_price - 1.0) * 10000.0
        if distance_bps <= _PRICE_LIMIT_PROXIMITY_BPS:
            return True
    return False


def _tick_rounding_violated(price: float, tick_size: float) -> bool:
    if tick_size <= 0.0:
        return False
    ticks = price / tick_size
    distance = abs(ticks - round(ticks))
    return distance > max(1e-6, min(0.02, 0.05 / max(1.0, floor(abs(ticks)))))


def _order_action_token(payload: Mapping[str, Any]) -> str | None:
    value = str(_first_value(payload, _ORDER_TYPE_FIELDS) or "").lower().strip()
    if not value:
        return None
    if any(token in value for token in _CANCEL_TOKENS):
        return "cancel"
    if any(token in value for token in _LIMIT_ORDER_TOKENS):
        return "limit"
    if any(token in value for token in _MARKET_ORDER_TOKENS):
        return "market"
    return None


def _cross_asset_async_gap_share(rows: Sequence[SignalEnvelope]) -> float:
    if len({row.symbol for row in rows}) < 2:
        return 0.0
    gaps: list[int] = []
    previous = rows[0]
    for row in rows[1:]:
        if row.symbol != previous.symbol:
            gaps.append(abs(_epoch_millis(row) - _epoch_millis(previous)))
        previous = row
    if not gaps:
        return 0.0
    return sum(1 for gap in gaps if gap >= _ASYNC_GAP_MS_FLOOR) / len(gaps)


def _epoch_millis(row: SignalEnvelope) -> int:
    return int(row.event_ts.astimezone(timezone.utc).timestamp() * 1000)


def _first_value(payload: Mapping[str, Any], fields: Sequence[str]) -> Any | None:
    for field in fields:
        if field in payload and payload[field] is not None:
            return payload[field]
    return None


def _first_number(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    value = _first_value(payload, fields)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(number):
        return None
    return number


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        return normalized not in (
            "",
            "0",
            "false",
            "none",
            "no",
            "normal",
            "continuous",
        )
    if isinstance(value, (int, float)):
        return bool(value)
    return value is not None


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 6)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        return {
            str(key): _json_ready(mapping[key])
            for key in sorted(mapping.keys(), key=str)
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_ready(item) for item in cast(Sequence[Any], value)]
    return value


__all__ = [
    "INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PRIMARY_SOURCES",
    "INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_PROOF_SEMANTICS_LABEL",
    "INSTITUTIONAL_MECHANISM_FIDELITY_STRESS_SCHEMA_VERSION",
    "InstitutionalMechanismFidelityStressSummary",
    "build_institutional_mechanism_fidelity_stress_schema_hash",
    "extract_institutional_mechanism_fidelity_stress",
    "institutional_mechanism_fidelity_stress_contract",
]

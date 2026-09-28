"""Preview-only intraday jump/burst stress for replay ranking.

This module converts recent 2025-2026 intraday jump and volatility-burst papers
into deterministic replay-ranking inputs. It consumes only replay rows/fixtures,
marks microstructure-source gaps explicitly, and never authorizes promotion,
realized PnL, or live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

INTRADAY_JUMP_BURST_STRESS_SCHEMA_VERSION = "torghut.intraday-jump-burst-stress.v1"
INTRADAY_JUMP_BURST_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.intraday-jump-burst-stress-contract.v1"
)
INTRADAY_JUMP_BURST_STRESS_PROOF_SEMANTICS_LABEL = "intraday_jump_burst_stress_preview_only_exact_tick_replay_news_route_tca_runtime_ledger_required"
INTRADAY_JUMP_BURST_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "ssrn-5223127",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5223127",
        "title": "Intraday Jumps and 0DTE Options: Pricing and Hedging Implications",
        "date": "2026-05-28",
        "mechanism": "intraday_jump_timing_and_0dte_hedging_risk_affect_short_horizon_execution",
    },
    {
        "source_id": "ssrn-5199540",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5199540",
        "title": "Volatility Bursts",
        "date": "2025-04-08",
        "mechanism": "short_lived_intraday_volatility_bursts_can_distort_replay_alpha_and_costs",
    },
    {
        "source_id": "arxiv-2602.10925",
        "url": "https://arxiv.org/abs/2602.10925",
        "title": "Fact or Friction: Toward a Formal Framework for Detecting Spurious Jumps in Financial Data",
        "date": "2026-02-12",
        "mechanism": "jump_detection_requires_microstructure_noise_controls_before_it_can_be_used_as_evidence",
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_FIELDS = (
    "spread_bps",
    "quoted_spread_bps",
    "effective_spread_bps",
    "nbbo_spread_bps",
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
    "signed_order_flow",
    "imbalance_pressure",
)
_JUMP_FIELDS = (
    "jump_bps",
    "quote_mid_jump_bps",
    "midpoint_jump_bps",
    "recent_quote_jump_bps_max",
    "recent_quote_jump_bps",
    "mid_jump_bps",
)
_NEWS_WINDOW_FIELDS = (
    "macro_event_window",
    "news_event_window",
    "economic_event_window",
    "earnings_event_window",
    "scheduled_event_window",
    "fed_event_window",
)
_SESSION_EDGE_FIELDS = (
    "session_edge_window",
    "session_open_window",
    "opening_window",
    "market_open_window",
    "session_close_window",
    "closing_window",
    "market_close_window",
)


@dataclass(frozen=True)
class IntradayJumpBurstStressSummary:
    row_count: int
    return_observation_count: int
    observed_spread_count: int
    observed_volume_count: int
    observed_ofi_count: int
    jump_event_count: int
    burst_event_count: int
    ambiguous_extreme_count: int
    open_close_extreme_count: int
    liquidity_shock_jump_count: int
    news_burst_count: int
    median_abs_return_bps: float
    jump_threshold_bps: float
    jump_event_share: float
    volatility_burst_share: float
    ambiguous_extreme_share: float
    open_close_extreme_share: float
    liquidity_shock_jump_share: float
    news_burst_share: float
    microstructure_source_gap_score: float
    spurious_jump_risk_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": INTRADAY_JUMP_BURST_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_intraday_jump_burst_stress_ranking",
            "source_papers": [
                dict(item) for item in INTRADAY_JUMP_BURST_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "return_observation_count": self.return_observation_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_volume_count": self.observed_volume_count,
            "observed_ofi_count": self.observed_ofi_count,
            "jump_event_count": self.jump_event_count,
            "burst_event_count": self.burst_event_count,
            "ambiguous_extreme_count": self.ambiguous_extreme_count,
            "open_close_extreme_count": self.open_close_extreme_count,
            "liquidity_shock_jump_count": self.liquidity_shock_jump_count,
            "news_burst_count": self.news_burst_count,
            "median_abs_return_bps": _stable_float(self.median_abs_return_bps),
            "jump_threshold_bps": _stable_float(self.jump_threshold_bps),
            "jump_event_share": _stable_float(self.jump_event_share),
            "volatility_burst_share": _stable_float(self.volatility_burst_share),
            "ambiguous_extreme_share": _stable_float(self.ambiguous_extreme_share),
            "open_close_extreme_share": _stable_float(self.open_close_extreme_share),
            "liquidity_shock_jump_share": _stable_float(
                self.liquidity_shock_jump_share
            ),
            "news_burst_share": _stable_float(self.news_burst_share),
            "microstructure_source_gap_score": _stable_float(
                self.microstructure_source_gap_score
            ),
            "spurious_jump_risk_score": _stable_float(self.spurious_jump_risk_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "jump_event_share": _stable_float(self.jump_event_share),
                "volatility_burst_share": _stable_float(self.volatility_burst_share),
                "ambiguous_extreme_share": _stable_float(self.ambiguous_extreme_share),
                "open_close_extreme_share": _stable_float(
                    self.open_close_extreme_share
                ),
                "liquidity_shock_jump_share": _stable_float(
                    self.liquidity_shock_jump_share
                ),
                "news_burst_share": _stable_float(self.news_burst_share),
                "microstructure_source_gap_score": _stable_float(
                    self.microstructure_source_gap_score
                ),
                "spurious_jump_risk_score": _stable_float(
                    self.spurious_jump_risk_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "intraday_jump_preview": True,
            "volatility_burst_preview": True,
            "spurious_jump_guard_preview": True,
            "requires_tick_level_replay_downstream": True,
            "requires_news_calendar_or_event_labels_downstream": True,
            "requires_microstructure_noise_controls_downstream": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": INTRADAY_JUMP_BURST_STRESS_PROOF_SEMANTICS_LABEL,
        }


def intraday_jump_burst_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": INTRADAY_JUMP_BURST_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": INTRADAY_JUMP_BURST_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in INTRADAY_JUMP_BURST_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "intraday_jump_volatility_burst_spurious_jump_guard",
        "stress_components": [
            "jump_event_share",
            "volatility_burst_share",
            "ambiguous_extreme_share",
            "open_close_extreme_share",
            "liquidity_shock_jump_share",
            "news_burst_share",
            "microstructure_source_gap_score",
            "spurious_jump_risk_score",
        ],
        "price_fields": list(_PRICE_FIELDS),
        "spread_fields": list(_SPREAD_FIELDS),
        "volume_fields": list(_VOLUME_FIELDS),
        "ofi_fields": list(_OFI_FIELDS),
        "jump_fields": list(_JUMP_FIELDS),
        "news_window_fields": list(_NEWS_WINDOW_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_tick_level_replay": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "requires_news_calendar_or_event_labels": True,
            "requires_microstructure_noise_controls": True,
            "rejects_jump_proxy_as_realized_pnl_authority": True,
            "rejects_coarse_bar_jump_as_exact_replay_authority": True,
            "rejects_missing_news_labels_as_no_news_assumption": True,
        },
    }


def build_intraday_jump_burst_stress_schema_hash() -> str:
    return _stable_hash(intraday_jump_burst_stress_contract())


def extract_intraday_jump_burst_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> IntradayJumpBurstStressSummary:
    """Extract deterministic intraday jump/burst stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    price_observations = tuple(
        (row, price)
        for row in ordered
        if (price := _row_price(row)) is not None and price > 0.0
    )
    events: list[tuple[SignalEnvelope, float]] = []
    for (previous_row, previous_price), (current_row, current_price) in zip(
        price_observations, price_observations[1:]
    ):
        if previous_row.symbol != current_row.symbol or previous_price <= 0.0:
            continue
        return_bps = (current_price - previous_price) / previous_price * 10_000.0
        explicit_jump_bps = _row_explicit_jump_bps(current_row)
        if explicit_jump_bps is not None and abs(explicit_jump_bps) > abs(return_bps):
            return_bps = explicit_jump_bps
        events.append((current_row, return_bps * signed_direction))

    abs_returns = tuple(abs(value) for _, value in events if isfinite(value))
    median_abs_return_bps = _median(abs_returns)
    percentile_90_abs_return_bps = _percentile(abs_returns, 0.90)
    jump_threshold_bps = max(
        8.0,
        min(median_abs_return_bps * 6.0, percentile_90_abs_return_bps * 0.75),
    )
    burst_threshold_bps = max(4.0, median_abs_return_bps * 3.0)
    spread_values: list[float] = []
    volume_values: list[float] = []
    ofi_values: list[float] = []
    for row in ordered:
        spread = _row_spread_bps(row)
        if spread is not None:
            spread_values.append(spread)
        volume = _row_volume(row)
        if volume is not None:
            volume_values.append(volume)
        ofi = _row_ofi(row)
        if ofi is not None:
            ofi_values.append(ofi)
    median_spread_bps = _median(tuple(spread_values))
    median_volume = _median(tuple(volume_values))

    jump_event_count = 0
    burst_event_count = 0
    ambiguous_extreme_count = 0
    open_close_extreme_count = 0
    liquidity_shock_jump_count = 0
    news_burst_count = 0
    supported_extreme_count = 0
    for row, return_bps in events:
        abs_return_bps = abs(return_bps)
        is_jump = abs_return_bps >= jump_threshold_bps
        is_burst = not is_jump and abs_return_bps >= burst_threshold_bps
        spread_shock = _row_spread_shock(row, median_spread_bps=median_spread_bps)
        volume_shock = _row_volume_shock(row, median_volume=median_volume)
        ofi_shock = _row_ofi_shock(row)
        news_window = _row_bool(row, _NEWS_WINDOW_FIELDS)
        session_edge = _row_bool(row, _SESSION_EDGE_FIELDS) or _is_session_edge(row)
        liquidity_supported = spread_shock or volume_shock or ofi_shock
        news_supported = news_window or session_edge
        if is_jump:
            jump_event_count += 1
            if liquidity_supported:
                liquidity_shock_jump_count += 1
            if news_supported:
                news_burst_count += 1
            if session_edge:
                open_close_extreme_count += 1
            if liquidity_supported or news_supported:
                supported_extreme_count += 1
            if not liquidity_supported and not news_supported:
                ambiguous_extreme_count += 1
        elif is_burst:
            burst_event_count += 1
            if news_supported:
                news_burst_count += 1
            if session_edge:
                open_close_extreme_count += 1
            if not liquidity_supported and not news_supported:
                ambiguous_extreme_count += 1

    denominator = max(1, len(events))
    jump_event_share = jump_event_count / denominator
    volatility_burst_share = burst_event_count / denominator
    ambiguous_extreme_share = ambiguous_extreme_count / denominator
    open_close_extreme_share = open_close_extreme_count / denominator
    liquidity_shock_jump_share = liquidity_shock_jump_count / denominator
    news_burst_share = news_burst_count / denominator
    microstructure_source_gap_score, gap_warnings = _microstructure_source_gap_score(
        ordered=ordered,
        return_observation_count=len(events),
        observed_spread_count=len(spread_values),
        observed_volume_count=len(volume_values),
        observed_ofi_count=len(ofi_values),
    )
    support_gap_share = 0.0
    if jump_event_count:
        support_gap_share = max(0.0, 1.0 - supported_extreme_count / jump_event_count)
    spurious_jump_risk_score = min(
        1.0,
        support_gap_share * 0.60
        + microstructure_source_gap_score * 0.35
        + (1.0 if len(events) and median_abs_return_bps <= 0.0 else 0.0) * 0.05,
    )
    replay_rank_penalty_bps = min(
        250.0,
        jump_event_share * 40.0
        + volatility_burst_share * 20.0
        + ambiguous_extreme_share * 35.0
        + open_close_extreme_share * 12.0
        + liquidity_shock_jump_share * 18.0
        + news_burst_share * 10.0
        + microstructure_source_gap_score * 25.0
        + spurious_jump_risk_score * 25.0,
    )
    warnings = set(gap_warnings)
    if not ordered:
        warnings.add("empty_intraday_jump_burst_records")
    if not events:
        warnings.add("missing_price_return_observations")
    if jump_event_count and ambiguous_extreme_count:
        warnings.add("ambiguous_intraday_jump_without_liquidity_or_news_context")
    if jump_event_count and microstructure_source_gap_score > 0.0:
        warnings.add("jump_detected_with_microstructure_source_gaps")
    if burst_event_count and not spread_values:
        warnings.add("volatility_burst_without_spread_context")

    return IntradayJumpBurstStressSummary(
        row_count=len(ordered),
        return_observation_count=len(events),
        observed_spread_count=len(spread_values),
        observed_volume_count=len(volume_values),
        observed_ofi_count=len(ofi_values),
        jump_event_count=jump_event_count,
        burst_event_count=burst_event_count,
        ambiguous_extreme_count=ambiguous_extreme_count,
        open_close_extreme_count=open_close_extreme_count,
        liquidity_shock_jump_count=liquidity_shock_jump_count,
        news_burst_count=news_burst_count,
        median_abs_return_bps=median_abs_return_bps,
        jump_threshold_bps=jump_threshold_bps,
        jump_event_share=jump_event_share,
        volatility_burst_share=volatility_burst_share,
        ambiguous_extreme_share=ambiguous_extreme_share,
        open_close_extreme_share=open_close_extreme_share,
        liquidity_shock_jump_share=liquidity_shock_jump_share,
        news_burst_share=news_burst_share,
        microstructure_source_gap_score=microstructure_source_gap_score,
        spurious_jump_risk_score=spurious_jump_risk_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=build_intraday_jump_burst_stress_schema_hash(),
    )


def _microstructure_source_gap_score(
    *,
    ordered: Sequence[SignalEnvelope],
    return_observation_count: int,
    observed_spread_count: int,
    observed_volume_count: int,
    observed_ofi_count: int,
) -> tuple[float, tuple[str, ...]]:
    warnings: set[str] = set()
    if not ordered:
        return 1.0, ("missing_replay_rows",)
    score = 0.0
    if return_observation_count == 0:
        score += 0.35
        warnings.add("missing_price_return_observations")
    if observed_spread_count == 0:
        score += 0.20
        warnings.add("missing_spread_context")
    if observed_volume_count == 0:
        score += 0.15
        warnings.add("missing_volume_context")
    if observed_ofi_count == 0:
        score += 0.10
        warnings.add("missing_order_flow_context")
    median_interval_seconds = _median_interarrival_seconds(ordered)
    if median_interval_seconds >= 300.0:
        score += 0.30
        warnings.add("coarse_replay_clock_for_jump_detection")
    elif median_interval_seconds >= 60.0:
        score += 0.15
        warnings.add("minute_bar_clock_for_jump_detection")
    return min(1.0, score), tuple(sorted(warnings))


def _row_spread_shock(row: SignalEnvelope, *, median_spread_bps: float) -> bool:
    spread = _row_spread_bps(row)
    if spread is None:
        return False
    return spread >= max(5.0, median_spread_bps * 2.0)


def _row_volume_shock(row: SignalEnvelope, *, median_volume: float) -> bool:
    volume = _row_volume(row)
    if volume is None or median_volume <= 0.0:
        return False
    return volume >= median_volume * 2.0


def _row_ofi_shock(row: SignalEnvelope) -> bool:
    ofi = _row_ofi(row)
    if ofi is None:
        return False
    return abs(ofi) >= 0.50


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
    if value is None or value < 0.0:
        return None
    return value


def _row_ofi(row: SignalEnvelope) -> float | None:
    return _coalesce_numeric(row.payload, _OFI_FIELDS)


def _row_explicit_jump_bps(row: SignalEnvelope) -> float | None:
    return _coalesce_numeric(row.payload, _JUMP_FIELDS)


def _row_bool(row: SignalEnvelope, fields: Sequence[str]) -> bool:
    value = _coalesce_bool(row.payload, fields)
    return bool(value)


def _is_session_edge(row: SignalEnvelope) -> bool:
    minute_of_day = row.event_ts.hour * 60 + row.event_ts.minute
    utc_open_windows = (
        (13 * 60 + 30, 15 * 60 + 30),
        (14 * 60 + 30, 16 * 60 + 30),
    )
    utc_close_windows = (
        (19 * 60, 20 * 60 + 15),
        (20 * 60, 21 * 60 + 15),
    )
    return any(start <= minute_of_day <= end for start, end in utc_open_windows) or any(
        start <= minute_of_day <= end for start, end in utc_close_windows
    )


def _median_interarrival_seconds(rows: Sequence[SignalEnvelope]) -> float:
    if len(rows) < 2:
        return 0.0
    ordered = tuple(sorted(rows, key=lambda row: row.event_ts))
    deltas: list[float] = []
    for previous, current in zip(ordered, ordered[1:]):
        seconds = (current.event_ts - previous.event_ts).total_seconds()
        if isfinite(seconds) and seconds >= 0.0:
            deltas.append(seconds)
    return _median(tuple(deltas))


def _coalesce_numeric(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> float | None:
    for field in fields:
        value = _float_or_none(payload.get(field))
        if value is not None:
            return value
    return None


def _coalesce_bool(payload: Mapping[str, Any], fields: Sequence[str]) -> bool | None:
    for field in fields:
        if field not in payload:
            continue
        value = payload.get(field)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "y", "available", "present"}:
                return True
            if normalized in {"0", "false", "no", "n", "unavailable", "absent"}:
                return False
        number = _float_or_none(value)
        if number is not None:
            return number > 0.0
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(converted):
        return None
    return converted


def _median(values: Sequence[float]) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    middle = len(clean) // 2
    if len(clean) % 2:
        return clean[middle]
    return (clean[middle - 1] + clean[middle]) / 2.0


def _percentile(values: Sequence[float], percentile: float) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    clamped = min(1.0, max(0.0, percentile))
    index = int(round((len(clean) - 1) * clamped))
    return clean[index]


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
        return {str(key): _json_ready(item) for key, item in mapping.items()}
    if isinstance(value, (list, tuple)):
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    return value


__all__ = [
    "INTRADAY_JUMP_BURST_STRESS_PRIMARY_SOURCES",
    "INTRADAY_JUMP_BURST_STRESS_PROOF_SEMANTICS_LABEL",
    "INTRADAY_JUMP_BURST_STRESS_SCHEMA_VERSION",
    "IntradayJumpBurstStressSummary",
    "build_intraday_jump_burst_stress_schema_hash",
    "extract_intraday_jump_burst_stress",
    "intraday_jump_burst_stress_contract",
]

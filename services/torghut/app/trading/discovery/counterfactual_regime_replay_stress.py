"""Preview-only counterfactual regime replay stress for candidate ranking.

This module converts recent counterfactual/regime-conditioned LOB papers into
real-tape replay robustness inputs. It never generates synthetic PnL, simulates
fills, writes ledgers, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log1p
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope

COUNTERFACTUAL_REGIME_REPLAY_STRESS_SCHEMA_VERSION = (
    "torghut.counterfactual-regime-replay-stress.v1"
)
COUNTERFACTUAL_REGIME_REPLAY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.counterfactual-regime-replay-stress-contract.v1"
)
COUNTERFACTUAL_REGIME_REPLAY_STRESS_PROOF_SEMANTICS_LABEL = (
    "counterfactual_regime_replay_stress_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
COUNTERFACTUAL_REGIME_REPLAY_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2602.03776",
        "url": "https://arxiv.org/abs/2602.03776",
        "title": "DiffLOB: Diffusion Models for Counterfactual Generation in Limit Order Books",
        "date": "2026-02-03",
        "mechanism": "regime_conditioned_trend_volatility_liquidity_ofi_counterfactual_support_checks",
    },
    {
        "source_id": "ssrn-6232459",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6232459",
        "title": "Distributional Stress in High-Frequency Limit Order Books: Temporal Wasserstein Regimes and Contagion",
        "date": "2026-02-13",
        "mechanism": "temporal_wasserstein_lob_regime_distribution_shift_stress",
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_BID_FIELDS = ("bid", "best_bid", "bid_price", "best_bid_price")
_ASK_FIELDS = ("ask", "best_ask", "ask_price", "best_ask_price")
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "trade_volume",
    "dollar_volume",
    "notional",
    "trade_notional",
)
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "order_flow_imbalance_score",
    "signed_order_flow",
    "trade_imbalance",
    "queue_imbalance",
    "book_imbalance",
)
_TREND_REGIME_FIELDS = ("future_trend_regime", "trend_regime", "price_trend_regime")
_VOLATILITY_REGIME_FIELDS = (
    "future_volatility_regime",
    "volatility_regime",
    "realized_volatility_regime",
)
_LIQUIDITY_REGIME_FIELDS = (
    "future_liquidity_regime",
    "liquidity_regime",
    "depth_regime",
)
_OFI_REGIME_FIELDS = (
    "future_ofi_regime",
    "ofi_regime",
    "order_flow_regime",
)
_MIN_REGIME_OBSERVATIONS = 4


@dataclass(frozen=True)
class _RegimeObservation:
    index: int
    symbol: str
    signed_return_bps: float
    spread_bps: float
    volume: float
    ofi: float
    net_bps: float
    trend_regime: str
    volatility_regime: str
    liquidity_regime: str
    ofi_regime: str

    @property
    def regime_key(self) -> str:
        return "|".join(
            (
                f"trend={self.trend_regime}",
                f"vol={self.volatility_regime}",
                f"liq={self.liquidity_regime}",
                f"ofi={self.ofi_regime}",
            )
        )


@dataclass(frozen=True)
class CounterfactualRegimeReplayStressSummary:
    row_count: int
    priced_transition_count: int
    regime_observation_count: int
    observed_regime_count: int
    channel_value_counts: Mapping[str, int]
    dominant_regime_key: str
    dominant_regime_share: float
    counterfactual_support_gap: float
    regime_edge_concentration_share: float
    channel_counterfactual_sensitivity_bps: float
    temporal_wasserstein_shift: float
    dominant_regime_wasserstein_shift_bps: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": COUNTERFACTUAL_REGIME_REPLAY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_counterfactual_regime_replay_stress_ranking",
            "source_papers": [
                dict(item)
                for item in COUNTERFACTUAL_REGIME_REPLAY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "priced_transition_count": self.priced_transition_count,
            "regime_observation_count": self.regime_observation_count,
            "observed_regime_count": self.observed_regime_count,
            "channel_value_counts": dict(self.channel_value_counts),
            "dominant_regime_key": self.dominant_regime_key,
            "dominant_regime_share": _stable_float(self.dominant_regime_share),
            "counterfactual_support_gap": _stable_float(
                self.counterfactual_support_gap
            ),
            "regime_edge_concentration_share": _stable_float(
                self.regime_edge_concentration_share
            ),
            "channel_counterfactual_sensitivity_bps": _stable_float(
                self.channel_counterfactual_sensitivity_bps
            ),
            "temporal_wasserstein_shift": _stable_float(
                self.temporal_wasserstein_shift
            ),
            "dominant_regime_wasserstein_shift_bps": _stable_float(
                self.dominant_regime_wasserstein_shift_bps
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "observed_regime_count": self.observed_regime_count,
                "dominant_regime_share": _stable_float(self.dominant_regime_share),
                "counterfactual_support_gap": _stable_float(
                    self.counterfactual_support_gap
                ),
                "regime_edge_concentration_share": _stable_float(
                    self.regime_edge_concentration_share
                ),
                "channel_counterfactual_sensitivity_bps": _stable_float(
                    self.channel_counterfactual_sensitivity_bps
                ),
                "temporal_wasserstein_shift": _stable_float(
                    self.temporal_wasserstein_shift
                ),
                "dominant_regime_wasserstein_shift_bps": _stable_float(
                    self.dominant_regime_wasserstein_shift_bps
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "counterfactual_generation_preview": False,
            "synthetic_trajectory_generation": False,
            "regime_conditioned_real_tape_support_preview": True,
            "temporal_wasserstein_distribution_shift_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                COUNTERFACTUAL_REGIME_REPLAY_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def counterfactual_regime_replay_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": COUNTERFACTUAL_REGIME_REPLAY_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": COUNTERFACTUAL_REGIME_REPLAY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in COUNTERFACTUAL_REGIME_REPLAY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "real_tape_counterfactual_regime_support_and_temporal_wasserstein_shift_stress",
        "stress_components": [
            "counterfactual_support_gap",
            "regime_edge_concentration_share",
            "channel_counterfactual_sensitivity_bps",
            "temporal_wasserstein_shift",
            "dominant_regime_wasserstein_shift_bps",
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
            "rejects_synthetic_counterfactual_pnl_authority": True,
            "rejects_regime_label_backtest_without_fill_evidence": True,
            "rejects_wasserstein_shift_as_profit_proof": True,
        },
    }


def build_counterfactual_regime_replay_stress_schema_hash() -> str:
    return _stable_hash(counterfactual_regime_replay_stress_contract())


def extract_counterfactual_regime_replay_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> CounterfactualRegimeReplayStressSummary:
    """Extract deterministic real-tape counterfactual regime replay stress."""

    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    observations, warnings = _build_observations(records, direction=signed_direction)
    if len(observations) < _MIN_REGIME_OBSERVATIONS:
        warnings = tuple(sorted(set((*warnings, "insufficient_regime_observations"))))

    regime_counts = _counts(obs.regime_key for obs in observations)
    dominant_regime_key = ""
    dominant_regime_share = 0.0
    if regime_counts:
        dominant_regime_key = max(
            sorted(regime_counts), key=lambda key: regime_counts[key]
        )
        dominant_regime_share = regime_counts[dominant_regime_key] / max(
            1, len(observations)
        )

    trend_values = {obs.trend_regime for obs in observations}
    volatility_values = {obs.volatility_regime for obs in observations}
    liquidity_values = {obs.liquidity_regime for obs in observations}
    ofi_values = {obs.ofi_regime for obs in observations}
    channel_value_counts = {
        "trend": len(trend_values),
        "volatility": len(volatility_values),
        "liquidity": len(liquidity_values),
        "ofi": len(ofi_values),
    }
    possible_regime_count = 1
    for count in channel_value_counts.values():
        possible_regime_count *= max(1, count)
    if possible_regime_count > 1:
        counterfactual_support_gap = 1.0 - (len(regime_counts) / possible_regime_count)
    else:
        counterfactual_support_gap = 0.0
    counterfactual_support_gap = _clamp(counterfactual_support_gap, 0.0, 1.0)

    regime_edge_concentration_share = _positive_edge_concentration(
        observations, dominant_regime_key=dominant_regime_key
    )
    channel_counterfactual_sensitivity_bps = _channel_sensitivity_bps(observations)
    temporal_wasserstein_shift = _temporal_wasserstein_shift(observations)
    dominant_regime_wasserstein_shift_bps = _dominant_regime_wasserstein_shift_bps(
        observations, dominant_regime_key=dominant_regime_key
    )
    replay_rank_penalty_bps = _rank_penalty_bps(
        counterfactual_support_gap=counterfactual_support_gap,
        dominant_regime_share=dominant_regime_share,
        regime_edge_concentration_share=regime_edge_concentration_share,
        channel_counterfactual_sensitivity_bps=channel_counterfactual_sensitivity_bps,
        temporal_wasserstein_shift=temporal_wasserstein_shift,
        dominant_regime_wasserstein_shift_bps=dominant_regime_wasserstein_shift_bps,
    )

    priced_transition_count = sum(
        1 for obs in observations if obs.signed_return_bps != 0
    )
    return CounterfactualRegimeReplayStressSummary(
        row_count=len(records),
        priced_transition_count=priced_transition_count,
        regime_observation_count=len(observations),
        observed_regime_count=len(regime_counts),
        channel_value_counts=channel_value_counts,
        dominant_regime_key=dominant_regime_key,
        dominant_regime_share=dominant_regime_share,
        counterfactual_support_gap=counterfactual_support_gap,
        regime_edge_concentration_share=regime_edge_concentration_share,
        channel_counterfactual_sensitivity_bps=channel_counterfactual_sensitivity_bps,
        temporal_wasserstein_shift=temporal_wasserstein_shift,
        dominant_regime_wasserstein_shift_bps=dominant_regime_wasserstein_shift_bps,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(set(warnings))),
        feature_schema_hash=build_counterfactual_regime_replay_stress_schema_hash(),
    )


def _build_observations(
    records: Sequence[SignalEnvelope], *, direction: float
) -> tuple[tuple[_RegimeObservation, ...], tuple[str, ...]]:
    warnings: list[str] = []
    ordered = sorted(
        records,
        key=lambda row: (
            row.symbol,
            row.event_ts,
            row.seq if row.seq is not None else 0,
        ),
    )
    raw_rows: list[tuple[SignalEnvelope, float, float, float, float, float]] = []
    for index, row in enumerate(ordered):
        payload = _payload(row)
        price = _price(payload)
        if price is None:
            continue
        spread_bps = _spread_bps(payload, price=price)
        volume = _first_float(payload, _VOLUME_FIELDS) or 0.0
        ofi = _first_float(payload, _OFI_FIELDS) or 0.0
        next_price = _next_price_same_symbol(ordered, index)
        if next_price is None:
            signed_return_bps = 0.0
        else:
            signed_return_bps = ((next_price - price) / price) * 10_000.0 * direction
        raw_rows.append((row, price, spread_bps, volume, ofi, signed_return_bps))

    if not raw_rows:
        return (), ("missing_price_fields",)

    spread_median = _safe_median([item[2] for item in raw_rows if item[2] > 0.0])
    volume_median = _safe_median([item[3] for item in raw_rows if item[3] > 0.0])
    abs_return_median = _safe_median(
        [abs(item[5]) for item in raw_rows if abs(item[5]) > 0.0]
    )
    if spread_median <= 0.0:
        warnings.append("missing_spread_fields")
    if volume_median <= 0.0:
        warnings.append("missing_volume_fields")

    observations: list[_RegimeObservation] = []
    for index, (
        row,
        _price_value,
        spread_bps,
        volume,
        ofi,
        signed_return_bps,
    ) in enumerate(raw_rows):
        payload = _payload(row)
        net_bps = signed_return_bps - (spread_bps * 0.5)
        trend_regime = _explicit_regime(payload, _TREND_REGIME_FIELDS)
        if not trend_regime:
            trend_regime = _trend_regime(signed_return_bps, spread_bps=spread_bps)
        volatility_regime = _explicit_regime(payload, _VOLATILITY_REGIME_FIELDS)
        if not volatility_regime:
            volatility_regime = _volatility_regime(
                signed_return_bps, median_abs_return_bps=abs_return_median
            )
        liquidity_regime = _explicit_regime(payload, _LIQUIDITY_REGIME_FIELDS)
        if not liquidity_regime:
            liquidity_regime = _liquidity_regime(
                spread_bps,
                volume,
                median_spread_bps=spread_median,
                median_volume=volume_median,
            )
        ofi_regime = _explicit_regime(payload, _OFI_REGIME_FIELDS)
        if not ofi_regime:
            ofi_regime = _ofi_regime(ofi)
        observations.append(
            _RegimeObservation(
                index=index,
                symbol=row.symbol,
                signed_return_bps=signed_return_bps,
                spread_bps=spread_bps,
                volume=volume,
                ofi=ofi,
                net_bps=net_bps,
                trend_regime=trend_regime,
                volatility_regime=volatility_regime,
                liquidity_regime=liquidity_regime,
                ofi_regime=ofi_regime,
            )
        )
    return tuple(observations), tuple(warnings)


def _next_price_same_symbol(
    records: Sequence[SignalEnvelope], index: int
) -> float | None:
    row = records[index]
    for next_row in records[index + 1 :]:
        if next_row.symbol != row.symbol:
            break
        price = _price(_payload(next_row))
        if price is not None:
            return price
    return None


def _positive_edge_concentration(
    observations: Sequence[_RegimeObservation], *, dominant_regime_key: str
) -> float:
    positive_by_regime: dict[str, float] = {}
    for obs in observations:
        if obs.net_bps > 0.0:
            positive_by_regime[obs.regime_key] = (
                positive_by_regime.get(obs.regime_key, 0.0) + obs.net_bps
            )
    total_positive = sum(positive_by_regime.values())
    if total_positive <= 0.0:
        return 0.0
    dominant_positive = positive_by_regime.get(dominant_regime_key, 0.0)
    max_positive = max(positive_by_regime.values(), default=0.0)
    return _clamp(max(dominant_positive, max_positive) / total_positive, 0.0, 1.0)


def _channel_sensitivity_bps(observations: Sequence[_RegimeObservation]) -> float:
    channel_ranges = [
        _regime_value_range_bps(
            observations,
            values={obs.trend_regime: obs.net_bps for obs in observations},
            channel_name="trend",
        ),
        _regime_value_range_bps(
            observations,
            values={obs.volatility_regime: obs.net_bps for obs in observations},
            channel_name="volatility",
        ),
        _regime_value_range_bps(
            observations,
            values={obs.liquidity_regime: obs.net_bps for obs in observations},
            channel_name="liquidity",
        ),
        _regime_value_range_bps(
            observations,
            values={obs.ofi_regime: obs.net_bps for obs in observations},
            channel_name="ofi",
        ),
    ]
    return max(0.0, _safe_median([value for value in channel_ranges if value > 0.0]))


def _regime_value_range_bps(
    observations: Sequence[_RegimeObservation],
    *,
    values: Mapping[str, float],
    channel_name: str,
) -> float:
    grouped: dict[str, list[float]] = {key: [] for key in values}
    for obs in observations:
        if channel_name == "trend":
            key = obs.trend_regime
        elif channel_name == "volatility":
            key = obs.volatility_regime
        elif channel_name == "liquidity":
            key = obs.liquidity_regime
        else:
            key = obs.ofi_regime
        grouped.setdefault(key, []).append(obs.net_bps)
    medians = [_safe_median(group) for group in grouped.values() if group]
    if len(medians) < 2:
        return 0.0
    return max(medians) - min(medians)


def _temporal_wasserstein_shift(observations: Sequence[_RegimeObservation]) -> float:
    if len(observations) < 4:
        return 0.0
    midpoint = len(observations) // 2
    first = observations[:midpoint]
    second = observations[midpoint:]
    shifts = (
        _normalized_wasserstein(
            [obs.signed_return_bps for obs in first],
            [obs.signed_return_bps for obs in second],
        ),
        _normalized_wasserstein(
            [obs.spread_bps for obs in first],
            [obs.spread_bps for obs in second],
        ),
        _normalized_wasserstein(
            [log1p(max(0.0, obs.volume)) for obs in first],
            [log1p(max(0.0, obs.volume)) for obs in second],
        ),
        _normalized_wasserstein(
            [obs.ofi for obs in first],
            [obs.ofi for obs in second],
        ),
    )
    return _clamp(sum(shifts) / max(1, len(shifts)), 0.0, 10.0)


def _dominant_regime_wasserstein_shift_bps(
    observations: Sequence[_RegimeObservation], *, dominant_regime_key: str
) -> float:
    dominant = [
        obs.net_bps for obs in observations if obs.regime_key == dominant_regime_key
    ]
    other = [
        obs.net_bps for obs in observations if obs.regime_key != dominant_regime_key
    ]
    if len(dominant) < 2 or len(other) < 2:
        return 0.0
    return _wasserstein_1d(dominant, other)


def _rank_penalty_bps(
    *,
    counterfactual_support_gap: float,
    dominant_regime_share: float,
    regime_edge_concentration_share: float,
    channel_counterfactual_sensitivity_bps: float,
    temporal_wasserstein_shift: float,
    dominant_regime_wasserstein_shift_bps: float,
) -> float:
    concentration_excess = max(0.0, regime_edge_concentration_share - 0.50)
    dominance_excess = max(0.0, dominant_regime_share - 0.45)
    return max(
        0.0,
        counterfactual_support_gap * 12.0
        + dominance_excess * 10.0
        + concentration_excess * 18.0
        + channel_counterfactual_sensitivity_bps * 0.20
        + temporal_wasserstein_shift * 4.0
        + dominant_regime_wasserstein_shift_bps * 0.08,
    )


def _trend_regime(signed_return_bps: float, *, spread_bps: float) -> str:
    threshold = max(0.5, spread_bps * 0.5)
    if signed_return_bps > threshold:
        return "up"
    if signed_return_bps < -threshold:
        return "down"
    return "flat"


def _volatility_regime(
    signed_return_bps: float, *, median_abs_return_bps: float
) -> str:
    threshold = max(1.0, median_abs_return_bps)
    if abs(signed_return_bps) >= threshold:
        return "high"
    return "low"


def _liquidity_regime(
    spread_bps: float,
    volume: float,
    *,
    median_spread_bps: float,
    median_volume: float,
) -> str:
    if median_spread_bps <= 0.0 and median_volume <= 0.0:
        return "unknown"
    spread_is_wide = median_spread_bps > 0.0 and spread_bps > median_spread_bps
    volume_is_thin = median_volume > 0.0 and volume < median_volume
    if spread_is_wide or volume_is_thin:
        return "thin"
    return "deep"


def _ofi_regime(ofi: float) -> str:
    if ofi > 0.10:
        return "buy_pressure"
    if ofi < -0.10:
        return "sell_pressure"
    return "neutral"


def _normalized_wasserstein(left: Sequence[float], right: Sequence[float]) -> float:
    combined = [value for value in (*left, *right) if isfinite(value)]
    scale = _safe_median([abs(value) for value in combined])
    return _wasserstein_1d(left, right) / max(1.0, scale)


def _wasserstein_1d(left: Sequence[float], right: Sequence[float]) -> float:
    left_values = sorted(value for value in left if isfinite(value))
    right_values = sorted(value for value in right if isfinite(value))
    if not left_values or not right_values:
        return 0.0
    count = max(len(left_values), len(right_values))
    total = 0.0
    for index in range(count):
        left_index = min(len(left_values) - 1, int(index * len(left_values) / count))
        right_index = min(len(right_values) - 1, int(index * len(right_values) / count))
        total += abs(left_values[left_index] - right_values[right_index])
    return total / count


def _counts(values: Sequence[str] | Any) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def _payload(row: SignalEnvelope) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], row.payload or {})


def _price(payload: Mapping[str, Any]) -> float | None:
    price = _first_float(payload, _PRICE_FIELDS)
    if price is not None and price > 0.0:
        return price
    bid = _first_float(payload, _BID_FIELDS)
    ask = _first_float(payload, _ASK_FIELDS)
    if bid is None or ask is None or bid <= 0.0 or ask <= 0.0:
        return None
    return (bid + ask) / 2.0


def _spread_bps(payload: Mapping[str, Any], *, price: float) -> float:
    spread = _first_float(payload, _SPREAD_BPS_FIELDS)
    if spread is not None and spread >= 0.0:
        return spread
    bid = _first_float(payload, _BID_FIELDS)
    ask = _first_float(payload, _ASK_FIELDS)
    if bid is None or ask is None or price <= 0.0 or ask < bid:
        return 0.0
    return ((ask - bid) / price) * 10_000.0


def _explicit_regime(payload: Mapping[str, Any], fields: Sequence[str]) -> str:
    for field in fields:
        value = payload.get(field)
        if value is None:
            continue
        if isinstance(value, bool):
            return "true" if value else "false"
        text = str(value).strip().lower().replace(" ", "_").replace("-", "_")
        if text:
            return text
    return ""


def _first_float(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = payload.get(field)
        number = _float_or_none(value)
        if number is not None:
            return number
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(number):
        return None
    return number


def _safe_median(values: Sequence[float]) -> float:
    filtered = [value for value in values if isfinite(value)]
    if not filtered:
        return 0.0
    return float(median(filtered))


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return float(f"{value:.6f}")


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


__all__ = [
    "COUNTERFACTUAL_REGIME_REPLAY_STRESS_CONTRACT_SCHEMA_VERSION",
    "COUNTERFACTUAL_REGIME_REPLAY_STRESS_PRIMARY_SOURCES",
    "COUNTERFACTUAL_REGIME_REPLAY_STRESS_PROOF_SEMANTICS_LABEL",
    "COUNTERFACTUAL_REGIME_REPLAY_STRESS_SCHEMA_VERSION",
    "CounterfactualRegimeReplayStressSummary",
    "build_counterfactual_regime_replay_stress_schema_hash",
    "counterfactual_regime_replay_stress_contract",
    "extract_counterfactual_regime_replay_stress",
]

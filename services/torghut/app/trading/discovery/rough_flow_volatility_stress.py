"""Preview-only rough order-flow/volatility stress for replay candidate ranking.

This module turns 2026 rough microstructure papers into deterministic replay
features. It estimates whether a candidate's replay rows exhibit persistent
signed order flow, rough traded-volume/volatility bursts, and market-impact
scaling mismatch. The output is a downranking/search input only: it never
simulates fills, writes ledgers, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log
from typing import Any

from app.trading.models import SignalEnvelope

ROUGH_FLOW_VOLATILITY_STRESS_SCHEMA_VERSION = "torghut.rough-flow-volatility-stress.v1"
ROUGH_FLOW_VOLATILITY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.rough-flow-volatility-stress-contract.v1"
)
ROUGH_FLOW_VOLATILITY_STRESS_PROOF_SEMANTICS_LABEL = "rough_flow_volatility_stress_preview_only_exact_tick_replay_route_tca_runtime_ledger_required"
ROUGH_FLOW_VOLATILITY_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2601.23172",
        "url": "https://arxiv.org/abs/2601.23172",
        "title": "A unified theory of order flow, market impact, and volatility",
        "date": "2026-02-02",
        "mechanism": "persistent_signed_order_flow_rough_volume_volatility_power_law_market_impact_consistency",
    },
    {
        "source_id": "arxiv-2603.13170",
        "url": "https://arxiv.org/abs/2603.13170",
        "title": "Microstructural Foundation of Rough Log-Normal Volatility Models",
        "date": "2026-03-13",
        "mechanism": "order_driven_arrivals_with_long_lasting_volatility_impact_and_poisson_microstructure_error_guard",
    },
)

_RETURN_FIELDS = (
    "return_bps",
    "signed_return_bps",
    "microbar_return_bps",
    "mid_return_bps",
    "future_return_bps",
)
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "trade_imbalance",
    "signed_order_flow",
    "signed_trade_volume",
    "net_order_flow",
)
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "qty",
    "quantity",
    "size",
    "trade_size",
    "last_size",
)
_DIRECTION_FIELDS = (
    "trade_direction",
    "aggressor_side",
    "trade_side",
    "side",
    "execution_side",
    "authoritative_trade_direction",
)
_EVENT_TYPE_FIELDS = ("event_type", "lob_event_type", "order_event_type")


@dataclass(frozen=True)
class RoughFlowVolatilityStressSummary:
    row_count: int
    observed_return_count: int
    observed_signed_flow_count: int
    observed_volume_count: int
    flow_persistence_h0_proxy: float
    signed_flow_lag1_autocorr: float
    signed_flow_lag2_autocorr: float
    rough_volume_score: float
    rough_volatility_score: float
    volatility_flow_coupling_score: float
    impact_power_law_exponent_proxy: float
    expected_impact_power_law_exponent: float
    impact_scaling_mismatch: float
    poisson_arrival_irregularity_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": ROUGH_FLOW_VOLATILITY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_rough_flow_volatility_stress_ranking",
            "source_papers": [
                dict(item) for item in ROUGH_FLOW_VOLATILITY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_return_count": self.observed_return_count,
            "observed_signed_flow_count": self.observed_signed_flow_count,
            "observed_volume_count": self.observed_volume_count,
            "flow_persistence_h0_proxy": _stable_float(self.flow_persistence_h0_proxy),
            "signed_flow_lag1_autocorr": _stable_float(self.signed_flow_lag1_autocorr),
            "signed_flow_lag2_autocorr": _stable_float(self.signed_flow_lag2_autocorr),
            "rough_volume_score": _stable_float(self.rough_volume_score),
            "rough_volatility_score": _stable_float(self.rough_volatility_score),
            "volatility_flow_coupling_score": _stable_float(
                self.volatility_flow_coupling_score
            ),
            "impact_power_law_exponent_proxy": _stable_float(
                self.impact_power_law_exponent_proxy
            ),
            "expected_impact_power_law_exponent": _stable_float(
                self.expected_impact_power_law_exponent
            ),
            "impact_scaling_mismatch": _stable_float(self.impact_scaling_mismatch),
            "poisson_arrival_irregularity_score": _stable_float(
                self.poisson_arrival_irregularity_score
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "flow_persistence_h0_proxy": _stable_float(
                    self.flow_persistence_h0_proxy
                ),
                "signed_flow_lag1_autocorr": _stable_float(
                    self.signed_flow_lag1_autocorr
                ),
                "signed_flow_lag2_autocorr": _stable_float(
                    self.signed_flow_lag2_autocorr
                ),
                "rough_volume_score": _stable_float(self.rough_volume_score),
                "rough_volatility_score": _stable_float(self.rough_volatility_score),
                "volatility_flow_coupling_score": _stable_float(
                    self.volatility_flow_coupling_score
                ),
                "impact_scaling_mismatch": _stable_float(self.impact_scaling_mismatch),
                "poisson_arrival_irregularity_score": _stable_float(
                    self.poisson_arrival_irregularity_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "rough_flow_volatility_preview": True,
            "persistent_flow_impact_scaling_preview": True,
            "rough_volatility_is_not_alpha_proof": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": ROUGH_FLOW_VOLATILITY_STRESS_PROOF_SEMANTICS_LABEL,
        }


def rough_flow_volatility_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ROUGH_FLOW_VOLATILITY_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ROUGH_FLOW_VOLATILITY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in ROUGH_FLOW_VOLATILITY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": (
            "persistent_signed_flow_rough_volume_volatility_and_power_law_impact_consistency_downrank"
        ),
        "stress_components": [
            "flow_persistence_h0_proxy",
            "rough_volume_score",
            "rough_volatility_score",
            "volatility_flow_coupling_score",
            "impact_scaling_mismatch",
            "poisson_arrival_irregularity_score",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_tick_replay": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "rejects_rough_volatility_as_directional_alpha_proof": True,
            "rejects_power_law_impact_proxy_as_fill_proof": True,
        },
    }


def build_rough_flow_volatility_stress_schema_hash() -> str:
    return _stable_hash(rough_flow_volatility_stress_contract())


def extract_rough_flow_volatility_stress(
    records: Sequence[SignalEnvelope],
) -> RoughFlowVolatilityStressSummary:
    """Extract rough order-flow/volatility replay stress features.

    The output is a preview ranking input only. Exact tick replay, route TCA,
    and runtime-ledger proof remain authoritative for promotion.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    returns = _return_series(ordered)
    signed_flows = tuple(_signed_flow(row.payload) for row in ordered)
    volumes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _VOLUME_FIELDS))
        for row in ordered
    )
    event_times = tuple(row.event_ts.timestamp() for row in ordered if row.event_ts)

    observed_return_count = sum(1 for item in returns if item is not None)
    observed_signed_flow_count = sum(1 for item in signed_flows if item is not None)
    observed_volume_count = sum(
        1 for item in volumes if item is not None and item > 0.0
    )
    warnings: list[str] = []
    if len(ordered) < 5:
        warnings.append("insufficient_rough_flow_replay_rows")
    if observed_return_count < 4:
        warnings.append("missing_return_path_for_rough_volatility_stress")
    if observed_signed_flow_count < 4:
        warnings.append("missing_signed_order_flow_for_rough_volatility_stress")
    if observed_volume_count < 4:
        warnings.append("missing_volume_path_for_rough_volatility_stress")

    return_values = tuple(item for item in returns if item is not None)
    signed_flow_values = tuple(item for item in signed_flows if item is not None)
    volume_values = tuple(item for item in volumes if item is not None and item > 0.0)
    abs_returns = tuple(abs(item) for item in return_values)

    lag1_autocorr = max(0.0, _autocorrelation(signed_flow_values, lag=1))
    lag2_autocorr = max(0.0, _autocorrelation(signed_flow_values, lag=2))
    flow_persistence_h0_proxy = min(
        0.95, max(0.50, 0.50 + 0.20 * lag1_autocorr + 0.12 * lag2_autocorr)
    )
    expected_impact_exponent = max(
        0.10, min(1.0, 2.0 - 2.0 * flow_persistence_h0_proxy)
    )
    rough_volume_score = _rough_path_score(volume_values)
    rough_volatility_score = _rough_path_score(abs_returns)
    volatility_flow_coupling_score = max(
        0.0,
        _absolute_coupling(
            abs_returns, tuple(abs(item) for item in signed_flow_values)
        ),
    )
    impact_power_law_exponent_proxy = _impact_power_law_exponent(
        signed_flow_values, return_values
    )
    impact_scaling_mismatch = (
        abs(impact_power_law_exponent_proxy - expected_impact_exponent)
        if impact_power_law_exponent_proxy > 0.0
        else 0.0
    )
    poisson_arrival_irregularity_score = _poisson_arrival_irregularity(event_times)
    if impact_power_law_exponent_proxy <= 0.0:
        warnings.append("insufficient_horizon_impact_scaling_evidence")
    if not event_times:
        warnings.append("missing_event_timestamps_for_poisson_arrival_guard")

    missing_penalty_bps = 3.0 * len(warnings)
    replay_rank_penalty_bps = (
        max(0.0, flow_persistence_h0_proxy - 0.55) * 18.0
        + rough_volume_score * 7.0
        + rough_volatility_score * 10.0
        + volatility_flow_coupling_score * 8.0
        + impact_scaling_mismatch * 12.0
        + poisson_arrival_irregularity_score * 5.0
        + missing_penalty_bps
    )

    return RoughFlowVolatilityStressSummary(
        row_count=len(ordered),
        observed_return_count=observed_return_count,
        observed_signed_flow_count=observed_signed_flow_count,
        observed_volume_count=observed_volume_count,
        flow_persistence_h0_proxy=flow_persistence_h0_proxy,
        signed_flow_lag1_autocorr=lag1_autocorr,
        signed_flow_lag2_autocorr=lag2_autocorr,
        rough_volume_score=rough_volume_score,
        rough_volatility_score=rough_volatility_score,
        volatility_flow_coupling_score=volatility_flow_coupling_score,
        impact_power_law_exponent_proxy=impact_power_law_exponent_proxy,
        expected_impact_power_law_exponent=expected_impact_exponent,
        impact_scaling_mismatch=impact_scaling_mismatch,
        poisson_arrival_irregularity_score=poisson_arrival_irregularity_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_rough_flow_volatility_stress_schema_hash(),
    )


def _return_series(records: Sequence[SignalEnvelope]) -> tuple[float | None, ...]:
    explicit_returns = tuple(
        _finite_float(_first_payload_value(row.payload, _RETURN_FIELDS))
        for row in records
    )
    if sum(1 for item in explicit_returns if item is not None) >= 2:
        return explicit_returns

    prices = tuple(
        _positive_float(_first_payload_value(row.payload, _PRICE_FIELDS))
        for row in records
    )
    values: list[float | None] = []
    previous: float | None = None
    for price in prices:
        if price is None or price <= 0.0 or previous is None or previous <= 0.0:
            values.append(None)
        else:
            values.append((price - previous) / previous * 10_000.0)
        if price is not None and price > 0.0:
            previous = price
    return tuple(values)


def _signed_flow(payload: Mapping[str, Any]) -> float | None:
    ofi = _finite_float(_first_payload_value(payload, _OFI_FIELDS))
    if ofi is not None:
        return ofi
    volume = _nonnegative_float(_first_payload_value(payload, _VOLUME_FIELDS))
    if volume is None or volume <= 0.0:
        return None
    direction = _direction_sign(payload)
    if direction == 0.0:
        event = _string(_first_payload_value(payload, _EVENT_TYPE_FIELDS)).lower()
        if event in {"cancel", "delete", "remove"}:
            direction = -1.0
        elif event in {"add", "trade", "execute", "fill"}:
            direction = 1.0
    if direction == 0.0:
        return None
    return direction * volume


def _direction_sign(payload: Mapping[str, Any]) -> float:
    value = _string(_first_payload_value(payload, _DIRECTION_FIELDS)).lower()
    if value in {"buy", "bid", "b", "long", "1", "+1"}:
        return 1.0
    if value in {"sell", "ask", "offer", "s", "short", "-1"}:
        return -1.0
    numeric = _finite_float(value)
    if numeric is None:
        return 0.0
    if numeric > 0.0:
        return 1.0
    if numeric < 0.0:
        return -1.0
    return 0.0


def _autocorrelation(values: Sequence[float], *, lag: int) -> float:
    if len(values) <= lag or lag <= 0:
        return 0.0
    left = tuple(values[:-lag])
    right = tuple(values[lag:])
    return _correlation(left, right)


def _rough_path_score(values: Sequence[float]) -> float:
    if len(values) < 4:
        return 0.0
    normalized = tuple(log(1.0 + abs(item)) for item in values)
    diffs = tuple(
        abs(next_item - item) for item, next_item in zip(normalized, normalized[1:])
    )
    level = _mean(tuple(abs(item) for item in normalized))
    if level <= 0.0:
        return 0.0
    return min(1.0, _mean(diffs) / (level + 1e-9))


def _absolute_coupling(left: Sequence[float], right: Sequence[float]) -> float:
    count = min(len(left), len(right))
    if count < 4:
        return 0.0
    return abs(_correlation(tuple(left[:count]), tuple(right[:count])))


def _impact_power_law_exponent(
    signed_flows: Sequence[float], returns: Sequence[float]
) -> float:
    count = min(len(signed_flows), len(returns))
    if count < 6:
        return 0.0
    magnitudes: list[float] = []
    horizons: list[float] = []
    for horizon in (1, 2, 3, 4):
        if count <= horizon + 1:
            continue
        impacts: list[float] = []
        for index in range(horizon, count):
            flow = sum(signed_flows[index - horizon : index])
            ret = returns[index]
            if flow == 0.0:
                continue
            impacts.append(abs(flow * ret))
        median_impact = _median(impacts)
        if median_impact > 0.0:
            horizons.append(float(horizon))
            magnitudes.append(median_impact)
    if len(magnitudes) < 2:
        return 0.0
    log_h = tuple(log(item) for item in horizons)
    log_i = tuple(log(item) for item in magnitudes)
    slope = _linear_slope(log_h, log_i)
    return min(2.0, max(0.0, slope))


def _poisson_arrival_irregularity(event_times: Sequence[float]) -> float:
    if len(event_times) < 4:
        return 0.0
    gaps = tuple(
        max(0.0, next_time - time)
        for time, next_time in zip(event_times, event_times[1:])
        if next_time >= time
    )
    if len(gaps) < 3:
        return 0.0
    avg = _mean(gaps)
    if avg <= 0.0:
        return 0.0
    variance = _mean(tuple((gap - avg) ** 2 for gap in gaps))
    coefficient_of_variation = (variance**0.5) / avg
    return min(1.0, abs(coefficient_of_variation - 1.0))


def _correlation(left: Sequence[float], right: Sequence[float]) -> float:
    count = min(len(left), len(right))
    if count < 2:
        return 0.0
    left_values = tuple(left[:count])
    right_values = tuple(right[:count])
    left_mean = _mean(left_values)
    right_mean = _mean(right_values)
    numerator = sum(
        (left_item - left_mean) * (right_item - right_mean)
        for left_item, right_item in zip(left_values, right_values)
    )
    left_variance = sum((item - left_mean) ** 2 for item in left_values)
    right_variance = sum((item - right_mean) ** 2 for item in right_values)
    denominator = (left_variance * right_variance) ** 0.5
    if denominator <= 0.0:
        return 0.0
    return max(-1.0, min(1.0, numerator / denominator))


def _linear_slope(x_values: Sequence[float], y_values: Sequence[float]) -> float:
    count = min(len(x_values), len(y_values))
    if count < 2:
        return 0.0
    xs = tuple(x_values[:count])
    ys = tuple(y_values[:count])
    x_mean = _mean(xs)
    y_mean = _mean(ys)
    denominator = sum((item - x_mean) ** 2 for item in xs)
    if denominator <= 0.0:
        return 0.0
    numerator = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
    return numerator / denominator


def _first_payload_value(payload: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        if key in payload:
            return payload[key]
    return None


def _finite_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(result):
        return None
    return result


def _positive_float(value: Any) -> float | None:
    result = _finite_float(value)
    if result is None or result <= 0.0:
        return None
    return result


def _nonnegative_float(value: Any) -> float | None:
    result = _finite_float(value)
    if result is None or result < 0.0:
        return None
    return result


def _string(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _median(values: Sequence[float]) -> float:
    clean = sorted(item for item in values if isfinite(item))
    if not clean:
        return 0.0
    midpoint = len(clean) // 2
    if len(clean) % 2:
        return clean[midpoint]
    return (clean[midpoint - 1] + clean[midpoint]) / 2.0


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 8)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

"""Preview-only dynamic lead-lag cross-asset stress for replay rows.

This module actualizes recent dynamic lead-lag and cross-market microstructure
papers into deterministic replay harness inputs.  It intentionally does not
turn lead-lag correlations into alpha proof, does not simulate broker fills,
does not write ledgers, and never carries promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from itertools import permutations
from math import isfinite, log
from statistics import mean
from typing import Any

from app.trading.models import SignalEnvelope

LEAD_LAG_CROSS_ASSET_STRESS_SCHEMA_VERSION = "torghut.lead-lag-cross-asset-stress.v1"
LEAD_LAG_CROSS_ASSET_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.lead-lag-cross-asset-stress-contract.v1"
)
LEAD_LAG_CROSS_ASSET_STRESS_PROOF_SEMANTICS_LABEL = "lead_lag_cross_asset_stress_preview_only_exact_tick_replay_route_tca_runtime_ledger_required"
LEAD_LAG_CROSS_ASSET_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2511.00390",
        "url": "https://arxiv.org/abs/2511.00390",
        "mechanism": "dynamic_pair_specific_lead_lag_detection_for_portfolio_construction",
    },
    {
        "source_id": "ssrn-5523878",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5523878",
        "mechanism": "cross_market_lob_order_flow_short_horizon_predictability_screen",
    },
    {
        "source_id": "arxiv-2508.06788",
        "url": "https://arxiv.org/abs/2508.06788",
        "mechanism": "one_second_price_flow_dissipation_and_intraday_ofi_endogeneity_guard",
    },
)

_RETURN_FIELDS = (
    "return_bps",
    "returns_bps",
    "signed_return_bps",
    "mid_return_bps",
    "price_return_bps",
    "microprice_return_bps",
    "log_return_bps",
    "future_return_bps",
)
_PRICE_FIELDS = (
    "mid_price",
    "microprice",
    "price",
    "last_price",
    "close",
    "mark_price",
)
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "ofi_pressure_score",
    "signed_order_flow_imbalance",
    "queue_imbalance",
    "book_imbalance",
)
_MAX_LAG_STEPS = 3
_MIN_CORRELATION_OBS = 3


@dataclass(frozen=True)
class _LagCandidate:
    leader: str
    lagger: str
    lag_steps: int
    abs_corr: float
    signed_corr: float
    observation_count: int
    ofi_abs_corr: float


@dataclass(frozen=True)
class LeadLagCrossAssetStressSummary:
    row_count: int
    symbol_count: int
    timestamp_count: int
    observed_return_count: int
    observed_ofi_count: int
    evaluated_pair_count: int
    best_leader_symbol: str
    best_lagger_symbol: str
    best_lag_steps: int
    best_lagged_abs_corr: float
    best_lagged_signed_corr: float
    best_lagged_observation_count: int
    zero_lag_abs_corr: float
    lag_correlation_uplift: float
    stale_alignment_score: float
    lag_direction_reversal_share: float
    dynamic_lag_dispersion: float
    ofi_confirmation_gap: float
    source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": LEAD_LAG_CROSS_ASSET_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_lead_lag_cross_asset_stress_ranking",
            "source_papers": [
                dict(item) for item in LEAD_LAG_CROSS_ASSET_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "symbol_count": self.symbol_count,
            "timestamp_count": self.timestamp_count,
            "observed_return_count": self.observed_return_count,
            "observed_ofi_count": self.observed_ofi_count,
            "evaluated_pair_count": self.evaluated_pair_count,
            "best_lead_lag_pair": {
                "leader_symbol": self.best_leader_symbol,
                "lagger_symbol": self.best_lagger_symbol,
                "lag_steps": self.best_lag_steps,
                "abs_corr": _stable_float(self.best_lagged_abs_corr),
                "signed_corr": _stable_float(self.best_lagged_signed_corr),
                "observation_count": self.best_lagged_observation_count,
            },
            "zero_lag_abs_corr": _stable_float(self.zero_lag_abs_corr),
            "lag_correlation_uplift": _stable_float(self.lag_correlation_uplift),
            "stale_alignment_score": _stable_float(self.stale_alignment_score),
            "lag_direction_reversal_share": _stable_float(
                self.lag_direction_reversal_share
            ),
            "dynamic_lag_dispersion": _stable_float(self.dynamic_lag_dispersion),
            "ofi_confirmation_gap": _stable_float(self.ofi_confirmation_gap),
            "source_gap_score": _stable_float(self.source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "best_lagged_abs_corr": _stable_float(self.best_lagged_abs_corr),
                "zero_lag_abs_corr": _stable_float(self.zero_lag_abs_corr),
                "lag_correlation_uplift": _stable_float(self.lag_correlation_uplift),
                "stale_alignment_score": _stable_float(self.stale_alignment_score),
                "lag_direction_reversal_share": _stable_float(
                    self.lag_direction_reversal_share
                ),
                "dynamic_lag_dispersion": _stable_float(self.dynamic_lag_dispersion),
                "ofi_confirmation_gap": _stable_float(self.ofi_confirmation_gap),
                "source_gap_score": _stable_float(self.source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "dynamic_pair_specific_lead_lag_preview": True,
            "cross_asset_causality_guard_preview": True,
            "lead_lag_is_not_directional_alpha_proof": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": LEAD_LAG_CROSS_ASSET_STRESS_PROOF_SEMANTICS_LABEL,
        }


def lead_lag_cross_asset_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": LEAD_LAG_CROSS_ASSET_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": LEAD_LAG_CROSS_ASSET_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in LEAD_LAG_CROSS_ASSET_STRESS_PRIMARY_SOURCES
        ],
        "lag_policy": "deterministic_event_grid_pairwise_lags_up_to_three_steps",
        "stress_components": [
            "lag_correlation_uplift",
            "stale_alignment_score",
            "lag_direction_reversal_share",
            "dynamic_lag_dispersion",
            "ofi_confirmation_gap",
            "source_gap_score",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "lead_lag_is_not_directional_alpha_proof": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_tick_replay": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
        },
    }


def build_lead_lag_cross_asset_stress_schema_hash() -> str:
    return _stable_hash(lead_lag_cross_asset_stress_contract())


def extract_lead_lag_cross_asset_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: float = 1.0,
    max_lag_steps: int = _MAX_LAG_STEPS,
) -> LeadLagCrossAssetStressSummary:
    """Extract deterministic dynamic lead-lag replay stress.

    The returned score is only a replay-ranking stress input.  Exact tick replay,
    route TCA, and runtime-ledger proof remain authoritative.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    symbol_series = _symbol_series(ordered)
    symbols = tuple(sorted(symbol_series))
    timestamps = tuple(
        sorted({timestamp for series in symbol_series.values() for timestamp in series})
    )
    timestamp_index = {timestamp: index for index, timestamp in enumerate(timestamps)}
    return_by_symbol = {
        symbol: {
            timestamp_index[timestamp]: point["return_bps"]
            for timestamp, point in series.items()
            if point.get("return_bps") is not None
        }
        for symbol, series in symbol_series.items()
    }
    ofi_by_symbol = {
        symbol: {
            timestamp_index[timestamp]: point["ofi"]
            for timestamp, point in series.items()
            if point.get("ofi") is not None
        }
        for symbol, series in symbol_series.items()
    }
    observed_return_count = sum(len(values) for values in return_by_symbol.values())
    observed_ofi_count = sum(len(values) for values in ofi_by_symbol.values())

    zero_lag_abs_corr = _max_zero_lag_abs_corr(return_by_symbol, symbols)
    lag_candidates = _lag_candidates(
        return_by_symbol=return_by_symbol,
        ofi_by_symbol=ofi_by_symbol,
        symbols=symbols,
        timestamp_count=len(timestamps),
        max_lag_steps=max_lag_steps,
    )
    best = max(lag_candidates, key=lambda item: item.abs_corr, default=None)
    best_lagged_abs_corr = best.abs_corr if best is not None else 0.0
    best_lagged_signed_corr = best.signed_corr if best is not None else 0.0
    best_lagged_observation_count = best.observation_count if best is not None else 0
    best_leader_symbol = best.leader if best is not None else ""
    best_lagger_symbol = best.lagger if best is not None else ""
    best_lag_steps = best.lag_steps if best is not None else 0
    best_ofi_abs_corr = best.ofi_abs_corr if best is not None else 0.0
    lag_correlation_uplift = max(0.0, best_lagged_abs_corr - zero_lag_abs_corr)
    stale_alignment_score = _clamp(
        lag_correlation_uplift
        * _coverage_scale(best_lagged_observation_count, len(timestamps))
        * (1.0 + min(max_lag_steps, max(0, best_lag_steps)) / max(1, max_lag_steps))
    )
    lag_direction_reversal_share = _lag_direction_reversal_share(
        return_by_symbol=return_by_symbol,
        symbols=symbols,
        timestamp_count=len(timestamps),
        max_lag_steps=max_lag_steps,
    )
    strong_lags = {item.lag_steps for item in lag_candidates if item.abs_corr >= 0.20}
    dynamic_lag_dispersion = _clamp(len(strong_lags) / max(1, max_lag_steps))
    ofi_confirmation_gap = _clamp(max(0.0, best_lagged_abs_corr - best_ofi_abs_corr))

    warnings: list[str] = []
    if len(ordered) < 4:
        warnings.append("insufficient_lead_lag_rows")
    if len(symbols) < 2:
        warnings.append("insufficient_cross_asset_symbols")
    if len(timestamps) < max_lag_steps + _MIN_CORRELATION_OBS:
        warnings.append("insufficient_timestamp_grid_for_lags")
    if observed_return_count < _MIN_CORRELATION_OBS * 2:
        warnings.append("missing_cross_asset_return_observations")
    if observed_ofi_count < _MIN_CORRELATION_OBS:
        warnings.append("missing_order_flow_confirmation_observations")
    if not lag_candidates:
        warnings.append("missing_evaluable_lead_lag_pairs")

    source_gap_score = _clamp(
        0.18 * len(warnings)
        + (0.20 if len(symbols) < 2 else 0.0)
        + (0.18 if observed_return_count == 0 else 0.0)
        + (0.12 if observed_ofi_count == 0 else 0.0)
    )
    direction_stress = 0.0
    if direction < 0 and best_lagged_signed_corr > 0:
        direction_stress = min(0.10, best_lagged_abs_corr * 0.10)
    if direction > 0 and best_lagged_signed_corr < 0:
        direction_stress = min(0.10, best_lagged_abs_corr * 0.10)
    replay_rank_penalty_bps = (
        stale_alignment_score * 18.0
        + lag_direction_reversal_share * 10.0
        + dynamic_lag_dispersion * 5.0
        + ofi_confirmation_gap * 8.0
        + source_gap_score * 12.0
        + direction_stress * 6.0
    )

    return LeadLagCrossAssetStressSummary(
        row_count=len(ordered),
        symbol_count=len(symbols),
        timestamp_count=len(timestamps),
        observed_return_count=observed_return_count,
        observed_ofi_count=observed_ofi_count,
        evaluated_pair_count=len(lag_candidates),
        best_leader_symbol=best_leader_symbol,
        best_lagger_symbol=best_lagger_symbol,
        best_lag_steps=best_lag_steps,
        best_lagged_abs_corr=best_lagged_abs_corr,
        best_lagged_signed_corr=best_lagged_signed_corr,
        best_lagged_observation_count=best_lagged_observation_count,
        zero_lag_abs_corr=zero_lag_abs_corr,
        lag_correlation_uplift=lag_correlation_uplift,
        stale_alignment_score=stale_alignment_score,
        lag_direction_reversal_share=lag_direction_reversal_share,
        dynamic_lag_dispersion=dynamic_lag_dispersion,
        ofi_confirmation_gap=ofi_confirmation_gap,
        source_gap_score=source_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_lead_lag_cross_asset_stress_schema_hash(),
    )


def _symbol_series(
    records: Sequence[SignalEnvelope],
) -> dict[str, dict[datetime, dict[str, float]]]:
    grouped: dict[str, list[SignalEnvelope]] = {}
    for row in records:
        grouped.setdefault(row.symbol, []).append(row)

    output: dict[str, dict[datetime, dict[str, float]]] = {}
    for symbol, rows in grouped.items():
        last_price: float | None = None
        points: dict[datetime, list[dict[str, float]]] = {}
        for row in sorted(rows, key=lambda item: (item.event_ts, item.seq or 0)):
            price = _first_float(row.payload, _PRICE_FIELDS)
            return_bps = _first_float(row.payload, _RETURN_FIELDS)
            if (
                return_bps is None
                and price is not None
                and last_price not in (None, 0.0)
            ):
                return_bps = ((price - last_price) / last_price) * 10_000.0
            if price is not None and price > 0.0:
                last_price = price
            ofi = _first_float(row.payload, _OFI_FIELDS)
            point: dict[str, float] = {}
            if return_bps is not None and isfinite(return_bps):
                point["return_bps"] = return_bps
            if ofi is not None and isfinite(ofi):
                point["ofi"] = ofi
            if point:
                points.setdefault(row.event_ts, []).append(point)
        if points:
            output[symbol] = {
                timestamp: _average_point(values)
                for timestamp, values in points.items()
            }
    return output


def _average_point(points: Sequence[Mapping[str, float]]) -> dict[str, float]:
    output: dict[str, float] = {}
    returns = [point["return_bps"] for point in points if "return_bps" in point]
    ofis = [point["ofi"] for point in points if "ofi" in point]
    if returns:
        output["return_bps"] = mean(returns)
    if ofis:
        output["ofi"] = mean(ofis)
    return output


def _lag_candidates(
    *,
    return_by_symbol: Mapping[str, Mapping[int, float]],
    ofi_by_symbol: Mapping[str, Mapping[int, float]],
    symbols: Sequence[str],
    timestamp_count: int,
    max_lag_steps: int,
) -> tuple[_LagCandidate, ...]:
    candidates: list[_LagCandidate] = []
    for leader, lagger in permutations(symbols, 2):
        leader_returns = return_by_symbol.get(leader, {})
        lagger_returns = return_by_symbol.get(lagger, {})
        leader_ofi = ofi_by_symbol.get(leader, {})
        for lag_steps in range(1, max_lag_steps + 1):
            left: list[float] = []
            right: list[float] = []
            ofi_left: list[float] = []
            ofi_right: list[float] = []
            for index in range(0, max(0, timestamp_count - lag_steps)):
                if index in leader_returns and index + lag_steps in lagger_returns:
                    left.append(leader_returns[index])
                    right.append(lagger_returns[index + lag_steps])
                if index in leader_ofi and index + lag_steps in lagger_returns:
                    ofi_left.append(leader_ofi[index])
                    ofi_right.append(lagger_returns[index + lag_steps])
            signed_corr = _corr(left, right)
            if signed_corr is None:
                continue
            ofi_corr = _corr(ofi_left, ofi_right)
            candidates.append(
                _LagCandidate(
                    leader=leader,
                    lagger=lagger,
                    lag_steps=lag_steps,
                    abs_corr=abs(signed_corr),
                    signed_corr=signed_corr,
                    observation_count=len(left),
                    ofi_abs_corr=abs(ofi_corr) if ofi_corr is not None else 0.0,
                )
            )
    return tuple(candidates)


def _max_zero_lag_abs_corr(
    return_by_symbol: Mapping[str, Mapping[int, float]], symbols: Sequence[str]
) -> float:
    best = 0.0
    for left_symbol, right_symbol in permutations(symbols, 2):
        left_returns = return_by_symbol.get(left_symbol, {})
        right_returns = return_by_symbol.get(right_symbol, {})
        common = sorted(set(left_returns) & set(right_returns))
        corr = _corr(
            [left_returns[index] for index in common],
            [right_returns[index] for index in common],
        )
        if corr is not None:
            best = max(best, abs(corr))
    return best


def _lag_direction_reversal_share(
    *,
    return_by_symbol: Mapping[str, Mapping[int, float]],
    symbols: Sequence[str],
    timestamp_count: int,
    max_lag_steps: int,
) -> float:
    if timestamp_count < (max_lag_steps + _MIN_CORRELATION_OBS) * 2:
        return 0.0
    midpoint = timestamp_count // 2
    reversals = 0
    evaluated = 0
    for left_symbol, right_symbol in permutations(symbols, 2):
        if left_symbol > right_symbol:
            continue
        first = _best_direction_for_window(
            return_by_symbol=return_by_symbol,
            left_symbol=left_symbol,
            right_symbol=right_symbol,
            start=0,
            stop=midpoint,
            max_lag_steps=max_lag_steps,
        )
        second = _best_direction_for_window(
            return_by_symbol=return_by_symbol,
            left_symbol=left_symbol,
            right_symbol=right_symbol,
            start=midpoint,
            stop=timestamp_count,
            max_lag_steps=max_lag_steps,
        )
        if first is None or second is None:
            continue
        evaluated += 1
        if first != second:
            reversals += 1
    if evaluated <= 0:
        return 0.0
    return _clamp(reversals / evaluated)


def _best_direction_for_window(
    *,
    return_by_symbol: Mapping[str, Mapping[int, float]],
    left_symbol: str,
    right_symbol: str,
    start: int,
    stop: int,
    max_lag_steps: int,
) -> str | None:
    best_direction = ""
    best_abs_corr = 0.0
    for leader, lagger in ((left_symbol, right_symbol), (right_symbol, left_symbol)):
        leader_returns = return_by_symbol.get(leader, {})
        lagger_returns = return_by_symbol.get(lagger, {})
        for lag_steps in range(1, max_lag_steps + 1):
            left: list[float] = []
            right: list[float] = []
            for index in range(start, max(start, stop - lag_steps)):
                if index in leader_returns and index + lag_steps in lagger_returns:
                    left.append(leader_returns[index])
                    right.append(lagger_returns[index + lag_steps])
            corr = _corr(left, right)
            if corr is None:
                continue
            abs_corr = abs(corr)
            if abs_corr > best_abs_corr:
                best_abs_corr = abs_corr
                best_direction = f"{leader}->{lagger}"
    if best_abs_corr < 0.25:
        return None
    return best_direction


def _corr(left: Sequence[float], right: Sequence[float]) -> float | None:
    if len(left) != len(right) or len(left) < _MIN_CORRELATION_OBS:
        return None
    left_mean = mean(left)
    right_mean = mean(right)
    left_centered = [value - left_mean for value in left]
    right_centered = [value - right_mean for value in right]
    numerator = sum(lval * rval for lval, rval in zip(left_centered, right_centered))
    left_denominator = sum(value * value for value in left_centered) ** 0.5
    right_denominator = sum(value * value for value in right_centered) ** 0.5
    denominator = left_denominator * right_denominator
    if denominator <= 0.0:
        return None
    return _clamp(numerator / denominator, low=-1.0, high=1.0)


def _coverage_scale(observation_count: int, timestamp_count: int) -> float:
    if observation_count <= 0 or timestamp_count <= 0:
        return 0.0
    raw = min(1.0, observation_count / max(_MIN_CORRELATION_OBS, timestamp_count / 2.0))
    return _clamp(log(1.0 + raw * 3.0) / log(4.0))


def _first_float(payload: Mapping[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        if key not in payload:
            continue
        value = _float_or_none(payload.get(key))
        if value is not None:
            return value
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 6)


def _clamp(value: float, *, low: float = 0.0, high: float = 1.0) -> float:
    if not isfinite(value):
        return low
    return max(low, min(high, value))


def _stable_hash(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode(
            "utf-8"
        )
    ).hexdigest()


__all__ = [
    "LEAD_LAG_CROSS_ASSET_STRESS_PRIMARY_SOURCES",
    "LEAD_LAG_CROSS_ASSET_STRESS_PROOF_SEMANTICS_LABEL",
    "LEAD_LAG_CROSS_ASSET_STRESS_SCHEMA_VERSION",
    "LeadLagCrossAssetStressSummary",
    "build_lead_lag_cross_asset_stress_schema_hash",
    "extract_lead_lag_cross_asset_stress",
    "lead_lag_cross_asset_stress_contract",
]

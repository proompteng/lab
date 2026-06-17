# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Preview-only microstructure regime/tokenization replay stress.

This module converts current 2025-2026 market-microstructure papers into
executable replay-ranking inputs. It checks whether a candidate's local replay
rows contain enough event-time, scale-invariant, multi-modal order-flow, and
structured LOB message-lifecycle context to support early latent-regime
detection and realistic trade-flow/token replay.

The output is a deterministic offline prefilter only. It never generates
synthetic market paths, treats model rollouts as PnL proof, writes runtime
ledgers, relaxes promotion gates, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope

# ruff: noqa: F401,F811,F821

from .shared_context import (
    MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_CONTRACT_SCHEMA_VERSION,
    MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES,
    MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL,
    MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION,
    MicrostructureRegimeTokenizationStressSummary,
    BINNED_FIELD_TOKENS as _BINNED_FIELD_TOKENS,
    DEPTH_FIELDS as _DEPTH_FIELDS,
    EARLY_WARNING_LOOKAHEAD as _EARLY_WARNING_LOOKAHEAD,
    EVENT_TYPE_FIELDS as _EVENT_TYPE_FIELDS,
    LOBERT_LIFECYCLE_ACTIONS as _LOBERT_LIFECYCLE_ACTIONS,
    MESSAGE_TIME_DELTA_FIELDS as _MESSAGE_TIME_DELTA_FIELDS,
    MIN_EARLY_WARNING_ROWS as _MIN_EARLY_WARNING_ROWS,
    OFI_FIELDS as _OFI_FIELDS,
    ORDER_ID_FIELDS as _ORDER_ID_FIELDS,
    POST_MESSAGE_SNAPSHOT_PRICE_FIELDS as _POST_MESSAGE_SNAPSHOT_PRICE_FIELDS,
    PRICE_FIELDS as _PRICE_FIELDS,
    RAW_EVENT_FIELDS as _RAW_EVENT_FIELDS,
    RETURN_BPS_FIELDS as _RETURN_BPS_FIELDS,
    SIDE_FIELDS as _SIDE_FIELDS,
    SIZE_FIELDS as _SIZE_FIELDS,
    SPREAD_FIELDS as _SPREAD_FIELDS,
    build_microstructure_regime_tokenization_stress_schema_hash,
    extract_microstructure_regime_tokenization_stress,
    microstructure_regime_tokenization_stress_contract,
)


@dataclass(frozen=True)
class _MicrostructureObservation:
    price: float | None
    spread_bps: float | None
    depth: float | None
    ofi: float | None
    explicit_return_bps: float | None
    computed_return_bps: float = 0.0


@dataclass(frozen=True)
class _EarlyWarningSummary:
    trigger_count: int
    stress_event_count: int
    lead_coverage: float
    mean_positive_lead_steps: float
    reactive_gap_score: float


@dataclass(frozen=True)
class _StylizedFactSummary:
    gap_score: float
    signed_return_autocorr_abs: float
    abs_return_clustering_score: float
    tail_event_share: float


def _attach_computed_returns(
    by_symbol: Mapping[str, Sequence[_MicrostructureObservation]],
    direction: float,
) -> dict[str, list[float]]:
    returns_by_symbol: dict[str, list[float]] = {}
    for symbol, observations in by_symbol.items():
        symbol_returns: list[float] = []
        prior_price: float | None = None
        for observation in observations:
            value = observation.explicit_return_bps
            if value is None and observation.price is not None:
                if prior_price is not None and prior_price > 0.0:
                    value = (
                        direction
                        * (observation.price - prior_price)
                        / prior_price
                        * 10_000.0
                    )
                prior_price = observation.price
            elif observation.price is not None:
                prior_price = observation.price
            if value is not None and isfinite(value):
                symbol_returns.append(float(value))
        returns_by_symbol[symbol] = symbol_returns
    return returns_by_symbol


def _latent_regime_early_warning(
    by_symbol: Mapping[str, Sequence[_MicrostructureObservation]],
) -> _EarlyWarningSummary:
    trigger_count = 0
    stress_event_count = 0
    covered_stress_events = 0
    positive_leads: list[int] = []

    for observations in by_symbol.values():
        if len(observations) < _MIN_EARLY_WARNING_ROWS:
            continue
        returns = _series_returns(observations)
        if len(returns) != len(observations):
            continue
        channel_values = _regime_channel_values(observations)
        channel_threshold = min(0.75, _robust_threshold(channel_values, floor=0.35))
        return_threshold = _robust_threshold([abs(item) for item in returns], floor=6.0)
        spread_values = [
            item.spread_bps for item in observations if item.spread_bps is not None
        ]
        spread_threshold = (
            _robust_threshold(spread_values, floor=4.0) if spread_values else 0.0
        )

        trigger_indices: list[int] = []
        for index, value in enumerate(channel_values):
            prior = channel_values[index - 1] if index > 0 else 0.0
            if value >= channel_threshold and value > prior * 1.05:
                trigger_indices.append(index)
        trigger_count += len(trigger_indices)

        stress_indices = [
            index
            for index, (observation, return_bps) in enumerate(
                zip(observations, returns, strict=True)
            )
            if abs(return_bps) >= return_threshold
            or (
                spread_threshold > 0.0
                and observation.spread_bps is not None
                and observation.spread_bps >= spread_threshold
            )
        ]
        stress_event_count += len(stress_indices)
        for stress_index in stress_indices:
            lead_candidates = [
                stress_index - trigger_index
                for trigger_index in trigger_indices
                if 0 < stress_index - trigger_index <= _EARLY_WARNING_LOOKAHEAD
            ]
            if lead_candidates:
                covered_stress_events += 1
                positive_leads.append(min(lead_candidates))

    lead_coverage = covered_stress_events / max(1, stress_event_count)
    mean_positive_lead_steps = median(positive_leads) if positive_leads else 0.0
    lead_depth_score = min(1.0, mean_positive_lead_steps / _EARLY_WARNING_LOOKAHEAD)
    if stress_event_count == 0:
        reactive_gap_score = 0.35
    else:
        reactive_gap_score = min(
            1.0, (1.0 - lead_coverage) * 0.75 + (1.0 - lead_depth_score) * 0.25
        )
    return _EarlyWarningSummary(
        trigger_count=trigger_count,
        stress_event_count=stress_event_count,
        lead_coverage=lead_coverage,
        mean_positive_lead_steps=mean_positive_lead_steps,
        reactive_gap_score=reactive_gap_score,
    )


def _series_returns(observations: Sequence[_MicrostructureObservation]) -> list[float]:
    returns: list[float] = []
    prior_price: float | None = None
    for observation in observations:
        if observation.explicit_return_bps is not None:
            returns.append(observation.explicit_return_bps)
            if observation.price is not None:
                prior_price = observation.price
            continue
        if observation.price is None or prior_price is None or prior_price <= 0.0:
            returns.append(0.0)
        else:
            returns.append((observation.price - prior_price) / prior_price * 10_000.0)
        if observation.price is not None:
            prior_price = observation.price
    return returns


def _regime_channel_values(
    observations: Sequence[_MicrostructureObservation],
) -> list[float]:
    spreads = [item.spread_bps or 0.0 for item in observations]
    depths = [item.depth or 0.0 for item in observations]
    ofis = [abs(item.ofi or 0.0) for item in observations]
    median_spread = (
        median([item for item in spreads if item > 0.0]) if any(spreads) else 1.0
    )
    median_depth = (
        median([item for item in depths if item > 0.0]) if any(depths) else 1.0
    )
    channel_values: list[float] = []
    prior_depth: float | None = None
    for spread, depth, ofi in zip(spreads, depths, ofis, strict=True):
        spread_channel = min(1.0, max(0.0, spread / max(1.0, median_spread * 2.0)))
        ofi_channel = min(1.0, ofi if ofi <= 1.0 else ofi / 10.0)
        depth_erosion = 0.0
        if prior_depth is not None and prior_depth > 0.0 and depth > 0.0:
            depth_erosion = min(
                1.0, max(0.0, (prior_depth - depth) / max(prior_depth, median_depth))
            )
        if depth > 0.0:
            prior_depth = depth
        channel_values.append(max(ofi_channel, spread_channel, depth_erosion))
    return channel_values


def _stylized_fact_gap(returns_bps: Sequence[float]) -> _StylizedFactSummary:
    clean = [float(item) for item in returns_bps if isfinite(float(item))]
    if len(clean) < 4:
        return _StylizedFactSummary(
            gap_score=0.45,
            signed_return_autocorr_abs=0.0,
            abs_return_clustering_score=0.0,
            tail_event_share=0.0,
        )
    signed_autocorr_abs = abs(_lag1_corr(clean))
    abs_returns = [abs(item) for item in clean]
    abs_clustering = max(0.0, _lag1_corr(abs_returns))
    median_abs = median(abs_returns) if abs_returns else 0.0
    tail_threshold = max(2.0, median_abs * 3.0)
    tail_event_share = sum(1 for item in abs_returns if item >= tail_threshold) / len(
        abs_returns
    )
    autocorr_gap = min(1.0, signed_autocorr_abs / 0.45)
    clustering_gap = max(0.0, 0.08 - abs_clustering) / 0.08
    if tail_event_share < 0.02:
        tail_gap = (0.02 - tail_event_share) / 0.02
    elif tail_event_share > 0.45:
        tail_gap = (tail_event_share - 0.45) / 0.55
    else:
        tail_gap = 0.0
    return _StylizedFactSummary(
        gap_score=min(
            1.0, autocorr_gap * 0.40 + clustering_gap * 0.35 + tail_gap * 0.25
        ),
        signed_return_autocorr_abs=signed_autocorr_abs,
        abs_return_clustering_score=abs_clustering,
        tail_event_share=tail_event_share,
    )


def _robust_threshold(values: Sequence[float], *, floor: float) -> float:
    clean = [float(value) for value in values if isfinite(float(value))]
    if not clean:
        return floor
    center = median(clean)
    deviations = [abs(value - center) for value in clean]
    mad = median(deviations) if deviations else 0.0
    return max(floor, center + max(mad * 1.5, center * 0.10))


def _lag1_corr(values: Sequence[float]) -> float:
    if len(values) < 3:
        return 0.0
    left = list(values[:-1])
    right = list(values[1:])
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum(
        (a - left_mean) * (b - right_mean) for a, b in zip(left, right, strict=True)
    )
    left_var = sum((a - left_mean) ** 2 for a in left)
    right_var = sum((b - right_mean) ** 2 for b in right)
    denominator = (left_var * right_var) ** 0.5
    if denominator <= 0.0:
        return 0.0
    return numerator / denominator


def _event_type(payload: Mapping[str, Any]) -> str:
    value = _first_value(payload, _EVENT_TYPE_FIELDS)
    return str(value).strip().lower() if value is not None else ""


def _has_lobert_lifecycle_action(event_type: str) -> bool:
    normalized = event_type.strip().lower()
    if not normalized:
        return False
    return any(action in normalized for action in _LOBERT_LIFECYCLE_ACTIONS)


def _has_post_message_snapshot(
    payload: Mapping[str, Any], *, spread: float | None, depth: float | None
) -> bool:
    if spread is not None and depth is not None:
        return True
    return (
        _first_number(payload, _POST_MESSAGE_SNAPSHOT_PRICE_FIELDS) is not None
        and _depth_proxy(payload) is not None
    )


def _depth_proxy(payload: Mapping[str, Any]) -> float | None:
    explicit = _first_number(payload, _DEPTH_FIELDS)
    if explicit is not None:
        return explicit
    bid = _first_number(payload, ("bid_size", "bid_qty", "best_bid_size", "bid_depth"))
    ask = _first_number(payload, ("ask_size", "ask_qty", "best_ask_size", "ask_depth"))
    if bid is not None or ask is not None:
        return max(0.0, (bid or 0.0) + (ask or 0.0))
    return None


def _first_value(payload: Mapping[str, Any], fields: Sequence[str]) -> Any | None:
    for field in fields:
        if field in payload and payload[field] is not None:
            return payload[field]
    return None


def _first_number(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    value = _first_value(payload, fields)
    return _number_or_none(value)


def _number_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(number):
        return None
    return number


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


# Public aliases used by split-module consumers.
MicrostructureObservation = _MicrostructureObservation
attach_computed_returns = _attach_computed_returns
depth_proxy = _depth_proxy
event_type = _event_type
first_number = _first_number
first_value = _first_value
has_lobert_lifecycle_action = _has_lobert_lifecycle_action
has_post_message_snapshot = _has_post_message_snapshot
latent_regime_early_warning = _latent_regime_early_warning
number_or_none = _number_or_none
stable_float = _stable_float
stable_hash = _stable_hash
stylized_fact_gap = _stylized_fact_gap
__all__ = [
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION",
    "MicrostructureRegimeTokenizationStressSummary",
    "build_microstructure_regime_tokenization_stress_schema_hash",
    "extract_microstructure_regime_tokenization_stress",
    "microstructure_regime_tokenization_stress_contract",
]


__all__ = [name for name in globals() if not name.startswith("__")]

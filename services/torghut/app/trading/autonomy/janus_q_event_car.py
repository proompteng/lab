"""Event/CAR assembly helpers for Janus-Q artifacts."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from ..features import extract_price
from ..models import SignalEnvelope
from .janus_q import (
    JANUS_EVENT_CAR_IMPL_VERSION,
    JANUS_SCAFFOLD_BLOCKED_REASON,
    JanusEventCarArtifactV1,
    JanusEventCarRecordV1,
    car_direction,
    decimal_str,
    event_dataset_snapshot_hash,
    event_schema_hash,
    event_type,
    factor_neutralized_return,
    hash_payload,
    janus_scaffold_authority,
    safe_decimal,
    strength_label,
    to_utc_iso,
)


@dataclass(frozen=True)
class _JanusEventSeries:
    ordered: list[SignalEnvelope]
    prices_by_index: dict[int, Decimal]
    next_price_by_index: dict[int, Decimal]
    raw_returns_by_index: dict[int, Decimal]
    market_mean_by_ts: dict[str, Decimal]


@dataclass(frozen=True)
class _JanusEventReturns:
    raw_return: Decimal
    abnormal_return: Decimal
    risk_neutralized_return: Decimal
    car: Decimal


def build_janus_event_car_artifact_v1_impl(
    *,
    run_id: str,
    signals: list[SignalEnvelope],
    generated_at: datetime | None = None,
    strong_threshold: Decimal = Decimal("0.0025"),
    event_window_policy: str = "next_signal_same_symbol",
    abnormal_return_model: str = "cross_sectional_market_mean",
    risk_neutralization_model: str = "factor_linear_v1",
) -> JanusEventCarArtifactV1:
    _validate_janus_event_car_models(
        event_window_policy=event_window_policy,
        abnormal_return_model=abnormal_return_model,
        risk_neutralization_model=risk_neutralization_model,
    )
    series = _janus_event_series(signals)
    records = _janus_event_records(
        series=series,
        strong_threshold=strong_threshold,
        abnormal_return_model=abnormal_return_model,
        risk_neutralization_model=risk_neutralization_model,
    )
    manifest = hash_payload([item.to_payload() for item in records])
    return JanusEventCarArtifactV1(
        schema_version="janus-event-car-v1",
        run_id=run_id,
        generated_at=generated_at or datetime.now(timezone.utc),
        methodology=_janus_event_methodology(
            event_window_policy=event_window_policy,
            abnormal_return_model=abnormal_return_model,
            risk_neutralization_model=risk_neutralization_model,
        ),
        lineage=_janus_event_lineage(
            ordered=series.ordered,
            strong_threshold=strong_threshold,
            event_window_policy=event_window_policy,
            abnormal_return_model=abnormal_return_model,
            risk_neutralization_model=risk_neutralization_model,
        ),
        records=records,
        summary=_janus_event_summary(records),
        manifest_hash=manifest,
        artifact_authority=janus_scaffold_authority(
            notes="Janus event/CAR artifact is currently deterministic scaffold output."
        )
        | {"blocking_reason": JANUS_SCAFFOLD_BLOCKED_REASON},
    )


def _validate_janus_event_car_models(
    *,
    event_window_policy: str,
    abnormal_return_model: str,
    risk_neutralization_model: str,
) -> None:
    if event_window_policy != "next_signal_same_symbol":
        raise ValueError("unsupported_event_window_policy")
    if abnormal_return_model not in {"cross_sectional_market_mean", "identity"}:
        raise ValueError("unsupported_abnormal_return_model")
    if risk_neutralization_model not in {"factor_linear_v1", "identity"}:
        raise ValueError("unsupported_risk_neutralization_model")


def _janus_event_series(signals: list[SignalEnvelope]) -> _JanusEventSeries:
    ordered = sorted(
        signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0)
    )
    if not ordered:
        raise ValueError("janus_event_car_requires_signals")
    prices, indices_by_symbol = _janus_event_prices_and_indices(ordered)
    next_prices = _janus_event_next_prices(indices_by_symbol, prices)
    raw_returns, returns_by_ts = _janus_event_raw_returns(ordered, prices, next_prices)
    return _JanusEventSeries(
        ordered=ordered,
        prices_by_index=prices,
        next_price_by_index=next_prices,
        raw_returns_by_index=raw_returns,
        market_mean_by_ts=_janus_market_mean_by_ts(returns_by_ts),
    )


def _janus_event_prices_and_indices(
    ordered: list[SignalEnvelope],
) -> tuple[dict[int, Decimal], dict[str, list[int]]]:
    prices_by_index: dict[int, Decimal] = {}
    indices_by_symbol: dict[str, list[int]] = {}
    for index, signal in enumerate(ordered):
        indices_by_symbol.setdefault(signal.symbol, []).append(index)
        prices_by_index[index] = extract_price(signal.payload or {}) or Decimal("0")
    return prices_by_index, indices_by_symbol


def _janus_event_next_prices(
    indices_by_symbol: dict[str, list[int]],
    prices_by_index: dict[int, Decimal],
) -> dict[int, Decimal]:
    next_price_by_index: dict[int, Decimal] = {}
    for indexes in indices_by_symbol.values():
        for offset, current_index in enumerate(indexes):
            current_price = prices_by_index.get(current_index, Decimal("0"))
            next_price_by_index[current_index] = _janus_next_symbol_price(
                indexes,
                offset=offset,
                current_price=current_price,
                prices_by_index=prices_by_index,
            )
    return next_price_by_index


def _janus_next_symbol_price(
    indexes: list[int],
    *,
    offset: int,
    current_price: Decimal,
    prices_by_index: dict[int, Decimal],
) -> Decimal:
    if offset + 1 >= len(indexes):
        return current_price
    return prices_by_index.get(indexes[offset + 1], current_price)


def _janus_event_raw_returns(
    ordered: list[SignalEnvelope],
    prices_by_index: dict[int, Decimal],
    next_price_by_index: dict[int, Decimal],
) -> tuple[dict[int, Decimal], dict[str, list[Decimal]]]:
    raw_returns_by_index: dict[int, Decimal] = {}
    raw_returns_by_ts: dict[str, list[Decimal]] = {}
    for index, signal in enumerate(ordered):
        raw_return = _janus_raw_return(
            prices_by_index.get(index, Decimal("0")),
            next_price_by_index.get(index, Decimal("0")),
        )
        raw_returns_by_index[index] = raw_return
        raw_returns_by_ts.setdefault(to_utc_iso(signal.event_ts), []).append(raw_return)
    return raw_returns_by_index, raw_returns_by_ts


def _janus_raw_return(price_t: Decimal, price_t1: Decimal) -> Decimal:
    if price_t > 0:
        return (price_t1 - price_t) / price_t
    return Decimal("0")


def _janus_market_mean_by_ts(
    raw_returns_by_ts: dict[str, list[Decimal]],
) -> dict[str, Decimal]:
    return {
        key: sum(values, Decimal("0")) / Decimal(len(values))
        if values
        else Decimal("0")
        for key, values in raw_returns_by_ts.items()
    }


def _janus_event_records(
    *,
    series: _JanusEventSeries,
    strong_threshold: Decimal,
    abnormal_return_model: str,
    risk_neutralization_model: str,
) -> list[JanusEventCarRecordV1]:
    return [
        _janus_event_record(
            signal=signal,
            index=index,
            series=series,
            strong_threshold=strong_threshold,
            abnormal_return_model=abnormal_return_model,
            risk_neutralization_model=risk_neutralization_model,
        )
        for index, signal in enumerate(series.ordered)
    ]


def _janus_event_record(
    *,
    signal: SignalEnvelope,
    index: int,
    series: _JanusEventSeries,
    strong_threshold: Decimal,
    abnormal_return_model: str,
    risk_neutralization_model: str,
) -> JanusEventCarRecordV1:
    payload = signal.payload or {}
    returns = _janus_event_returns(
        signal=signal,
        index=index,
        payload=payload,
        series=series,
        abnormal_return_model=abnormal_return_model,
        risk_neutralization_model=risk_neutralization_model,
    )
    resolved_event_type = event_type(payload)
    seq = int(signal.seq or 0)
    return JanusEventCarRecordV1(
        event_id=_janus_event_id(signal=signal, payload=payload, seq=seq),
        event_ts=signal.event_ts,
        symbol=signal.symbol,
        seq=seq,
        event_type=resolved_event_type,
        semantic_direction=car_direction(returns.car),
        strength_label=strength_label(returns.car, threshold=strong_threshold),
        price_t=decimal_str(series.prices_by_index.get(index, Decimal("0"))),
        price_t_plus_1=decimal_str(series.next_price_by_index.get(index, Decimal("0"))),
        raw_return=decimal_str(returns.raw_return),
        abnormal_return=decimal_str(returns.abnormal_return),
        risk_neutralized_return=decimal_str(returns.risk_neutralized_return),
        car=decimal_str(returns.car),
        payload_hash=hash_payload(payload),
        source=str(signal.source or "unknown"),
    )


def _janus_event_returns(
    *,
    signal: SignalEnvelope,
    index: int,
    payload: dict[str, Any],
    series: _JanusEventSeries,
    abnormal_return_model: str,
    risk_neutralization_model: str,
) -> _JanusEventReturns:
    raw_return = series.raw_returns_by_index.get(index, Decimal("0"))
    market_return = series.market_mean_by_ts.get(
        to_utc_iso(signal.event_ts), Decimal("0")
    )
    abnormal = (
        raw_return - market_return
        if abnormal_return_model == "cross_sectional_market_mean"
        else raw_return
    )
    risk_neutralized = (
        factor_neutralized_return(
            raw_return=raw_return,
            market_return=market_return,
            payload=payload,
        )
        if risk_neutralization_model == "factor_linear_v1"
        else abnormal
    )
    return _JanusEventReturns(
        raw_return=raw_return,
        abnormal_return=abnormal,
        risk_neutralized_return=risk_neutralized,
        car=risk_neutralized,
    )


def _janus_event_id(
    *,
    signal: SignalEnvelope,
    payload: dict[str, Any],
    seq: int,
) -> str:
    event_payload = {
        "event_ts": to_utc_iso(signal.event_ts),
        "symbol": signal.symbol,
        "seq": seq,
        "source": signal.source,
        "payload": payload,
    }
    return hashlib.sha256(
        json.dumps(
            event_payload,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()[:24]


def _janus_event_summary(records: list[JanusEventCarRecordV1]) -> dict[str, object]:
    return {
        "event_count": len(records),
        "positive_direction_count": sum(
            1 for record in records if record.semantic_direction == "long"
        ),
        "negative_direction_count": sum(
            1 for record in records if record.semantic_direction == "short"
        ),
        "neutral_direction_count": sum(
            1 for record in records if record.semantic_direction == "neutral"
        ),
        "strong_event_count": sum(
            1 for record in records if record.strength_label == "strong"
        ),
        "unknown_event_type_count": sum(
            1 for record in records if record.event_type == "unknown_event"
        ),
        "mean_abs_car": decimal_str(
            sum((abs(safe_decimal(record.car)) for record in records), Decimal("0"))
            / Decimal(len(records))
            if records
            else Decimal("0")
        ),
    }


def _janus_event_methodology(
    *,
    event_window_policy: str,
    abnormal_return_model: str,
    risk_neutralization_model: str,
) -> dict[str, object]:
    return {
        "stage": "m1_fidelity_upgrade",
        "event_window_policy": event_window_policy,
        "abnormal_return_model": abnormal_return_model,
        "risk_neutralization_model": risk_neutralization_model,
        "paper_alignment": {
            "car_reference": "janus_q_sec_3_1_eq_1_to_5",
            "label_reference": "janus_q_sec_3_1_2",
        },
    }


def _janus_event_lineage(
    *,
    ordered: list[SignalEnvelope],
    strong_threshold: Decimal,
    event_window_policy: str,
    abnormal_return_model: str,
    risk_neutralization_model: str,
) -> dict[str, object]:
    return {
        "dataset_snapshot_hash": event_dataset_snapshot_hash(ordered),
        "schema_hash": event_schema_hash(),
        "generation_code_hash": hash_payload(
            {
                "impl_version": JANUS_EVENT_CAR_IMPL_VERSION,
                "function": "build_janus_event_car_artifact_v1",
            }
        ),
        "run_config_hash": hash_payload(
            {
                "strong_threshold": decimal_str(strong_threshold),
                "event_window_policy": event_window_policy,
                "abnormal_return_model": abnormal_return_model,
                "risk_neutralization_model": risk_neutralization_model,
            }
        ),
    }


__all__ = ["build_janus_event_car_artifact_v1_impl"]

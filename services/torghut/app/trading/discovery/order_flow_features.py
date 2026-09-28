"""Deterministic H-PAIRS order-flow feature primitives for replay tapes.

These features are offline candidate-discovery metadata only.  They are cheap
enough for local fast-preview ranking, deterministic for fixture/replay rows,
and deliberately carry no promotion or runtime-ledger authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from math import exp, isfinite, tanh
from typing import Any, TypeAlias, cast

from app.trading.models import SignalEnvelope

HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION = "torghut.hpairs-order-flow-features.v1"
HPAIRS_ORDER_FLOW_FEATURE_CONTRACT_SCHEMA_VERSION = (
    "torghut.hpairs-order-flow-feature-contract.v1"
)
HPAIRS_ORDER_FLOW_PROOF_SEMANTICS_LABEL = (
    "hpairs_order_flow_features_preview_only_exact_replay_and_runtime_ledger_required"
)
DEFAULT_OFI_HORIZON_BUCKETS: tuple[int, ...] = (1, 3, 12, 36)

ReplayFeatureRecord: TypeAlias = SignalEnvelope | Mapping[str, Any]

_OFI_FIELDS: tuple[str, ...] = (
    "ofi_pressure_score",
    "order_flow_imbalance",
    "ofi",
    "signed_order_flow_imbalance",
    "queue_imbalance",
    "book_imbalance",
    "depth_imbalance",
)
_SIGNED_VOLUME_FIELDS: tuple[str, ...] = (
    "signed_volume",
    "signed_qty",
    "signed_quantity",
    "signed_size",
    "aggressor_signed_volume",
)
_VOLUME_FIELDS: tuple[str, ...] = (
    "microbar_volume",
    "volume",
    "qty",
    "quantity",
    "size",
    "trade_size",
    "last_size",
)
_BID_SIZE_FIELDS: tuple[str, ...] = ("bid_size", "bid_qty", "best_bid_size")
_ASK_SIZE_FIELDS: tuple[str, ...] = ("ask_size", "ask_qty", "best_ask_size")


@dataclass(frozen=True)
class OrderFlowEvent:
    index: int
    signed_volume: float
    absolute_volume: float
    normalized_imbalance: float
    source_fields: tuple[str, ...]
    missing: bool


@dataclass(frozen=True)
class OrderFlowHorizonBucket:
    horizon: int
    bucket_index: int
    row_count: int
    signed_volume: float
    absolute_volume: float
    imbalance: float

    def to_payload(self) -> dict[str, Any]:
        return {
            "horizon": self.horizon,
            "bucket_index": self.bucket_index,
            "row_count": self.row_count,
            "signed_volume": _stable_float(self.signed_volume),
            "absolute_volume": _stable_float(self.absolute_volume),
            "imbalance": _stable_float(self.imbalance),
        }


@dataclass(frozen=True)
class OrderFlowHorizonSummary:
    horizon: int
    bucket_count: int
    observed_event_count: int
    signed_volume: float
    absolute_volume: float
    mean_bucket_imbalance: float
    tail_bucket_imbalance: float
    decayed_imbalance: float

    def to_payload(self) -> dict[str, Any]:
        return {
            "horizon": self.horizon,
            "bucket_count": self.bucket_count,
            "observed_event_count": self.observed_event_count,
            "signed_volume": _stable_float(self.signed_volume),
            "absolute_volume": _stable_float(self.absolute_volume),
            "mean_bucket_imbalance": _stable_float(self.mean_bucket_imbalance),
            "tail_bucket_imbalance": _stable_float(self.tail_bucket_imbalance),
            "decayed_imbalance": _stable_float(self.decayed_imbalance),
        }


@dataclass(frozen=True)
class OrderFlowFeatureSet:
    row_count: int
    horizons: tuple[int, ...]
    source_fields: tuple[str, ...]
    warnings: tuple[str, ...]
    signed_volume_total: float
    absolute_volume_total: float
    imbalance_mean: float
    imbalance_abs_mean: float
    directional_alignment_score: float
    horizon_summaries: tuple[OrderFlowHorizonSummary, ...]
    horizon_buckets: tuple[OrderFlowHorizonBucket, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_research_ranking",
            "row_count": self.row_count,
            "horizons": list(self.horizons),
            "source_fields": list(self.source_fields),
            "warnings": list(self.warnings),
            "signed_volume_total": _stable_float(self.signed_volume_total),
            "absolute_volume_total": _stable_float(self.absolute_volume_total),
            "imbalance_mean": _stable_float(self.imbalance_mean),
            "imbalance_abs_mean": _stable_float(self.imbalance_abs_mean),
            "directional_alignment_score": _stable_float(
                self.directional_alignment_score
            ),
            "horizon_summaries": [
                summary.to_payload() for summary in self.horizon_summaries
            ],
            "horizon_buckets": [bucket.to_payload() for bucket in self.horizon_buckets],
            "ranking_features": {
                "directional_alignment_score": _stable_float(
                    self.directional_alignment_score
                ),
                "imbalance_abs_mean": _stable_float(self.imbalance_abs_mean),
                "missing_data_penalty": _stable_float(
                    1.0 if "missing_order_flow_inputs" in self.warnings else 0.0
                ),
            },
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": HPAIRS_ORDER_FLOW_PROOF_SEMANTICS_LABEL,
        }


def order_flow_feature_contract(
    *, horizons: Sequence[int] = DEFAULT_OFI_HORIZON_BUCKETS
) -> dict[str, Any]:
    normalized_horizons = _normalize_horizons(horizons)
    return {
        "schema_version": HPAIRS_ORDER_FLOW_FEATURE_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION,
        "horizon_buckets": list(normalized_horizons),
        "ofi_fields": list(_OFI_FIELDS),
        "signed_volume_fields": list(_SIGNED_VOLUME_FIELDS),
        "volume_fields": list(_VOLUME_FIELDS),
        "quote_depth_fields": {
            "bid": list(_BID_SIZE_FIELDS),
            "ask": list(_ASK_SIZE_FIELDS),
        },
        "bucket_policy": "deterministic_non_overlapping_event_count_buckets",
        "decay_policy": "deterministic_exponential_tail_weighted_imbalance",
        "proof_neutrality": {
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_runtime_ledger": True,
        },
    }


def build_order_flow_feature_schema_hash(
    *, horizons: Sequence[int] = DEFAULT_OFI_HORIZON_BUCKETS
) -> str:
    return _stable_hash(order_flow_feature_contract(horizons=horizons))


def extract_order_flow_features(
    records: Sequence[ReplayFeatureRecord],
    *,
    horizons: Sequence[int] = DEFAULT_OFI_HORIZON_BUCKETS,
) -> OrderFlowFeatureSet:
    """Extract deterministic horizon/bucket OFI features from replay records."""

    normalized_horizons = _normalize_horizons(horizons)
    ordered = tuple(sorted(records, key=_record_sort_key))
    events = tuple(
        _order_flow_event(index=index, record=record)
        for index, record in enumerate(ordered)
    )
    source_fields = tuple(
        sorted({field for event in events for field in event.source_fields})
    )
    warnings: list[str] = []
    if any(event.missing for event in events):
        warnings.append("missing_order_flow_inputs")
    if not events:
        warnings.append("empty_order_flow_records")

    signed_total = sum(event.signed_volume for event in events)
    absolute_total = sum(event.absolute_volume for event in events)
    imbalances = [event.normalized_imbalance for event in events if not event.missing]
    imbalance_mean = _safe_mean(imbalances)
    imbalance_abs_mean = _safe_mean([abs(value) for value in imbalances])
    horizon_buckets: list[OrderFlowHorizonBucket] = []
    horizon_summaries: list[OrderFlowHorizonSummary] = []
    for horizon in normalized_horizons:
        buckets = _horizon_buckets(events=events, horizon=horizon)
        horizon_buckets.extend(buckets)
        horizon_summaries.append(
            _horizon_summary(events=events, horizon=horizon, buckets=buckets)
        )

    directional_alignment_score = _directional_alignment_score(horizon_summaries)
    return OrderFlowFeatureSet(
        row_count=len(ordered),
        horizons=normalized_horizons,
        source_fields=source_fields,
        warnings=tuple(warnings),
        signed_volume_total=signed_total,
        absolute_volume_total=absolute_total,
        imbalance_mean=imbalance_mean,
        imbalance_abs_mean=imbalance_abs_mean,
        directional_alignment_score=directional_alignment_score,
        horizon_summaries=tuple(horizon_summaries),
        horizon_buckets=tuple(horizon_buckets),
        feature_schema_hash=build_order_flow_feature_schema_hash(
            horizons=normalized_horizons
        ),
    )


def _horizon_buckets(
    *, events: Sequence[OrderFlowEvent], horizon: int
) -> tuple[OrderFlowHorizonBucket, ...]:
    buckets: list[OrderFlowHorizonBucket] = []
    for bucket_index, start in enumerate(range(0, len(events), horizon)):
        bucket_events = events[start : start + horizon]
        signed_volume = sum(event.signed_volume for event in bucket_events)
        absolute_volume = sum(event.absolute_volume for event in bucket_events)
        buckets.append(
            OrderFlowHorizonBucket(
                horizon=horizon,
                bucket_index=bucket_index,
                row_count=len(bucket_events),
                signed_volume=signed_volume,
                absolute_volume=absolute_volume,
                imbalance=_ratio(signed_volume, absolute_volume),
            )
        )
    return tuple(buckets)


def _horizon_summary(
    *,
    events: Sequence[OrderFlowEvent],
    horizon: int,
    buckets: Sequence[OrderFlowHorizonBucket],
) -> OrderFlowHorizonSummary:
    signed_volume = sum(bucket.signed_volume for bucket in buckets)
    absolute_volume = sum(bucket.absolute_volume for bucket in buckets)
    return OrderFlowHorizonSummary(
        horizon=horizon,
        bucket_count=len(buckets),
        observed_event_count=len(events),
        signed_volume=signed_volume,
        absolute_volume=absolute_volume,
        mean_bucket_imbalance=_safe_mean([bucket.imbalance for bucket in buckets]),
        tail_bucket_imbalance=buckets[-1].imbalance if buckets else 0.0,
        decayed_imbalance=_decayed_imbalance(events=events, horizon=horizon),
    )


def _decayed_imbalance(*, events: Sequence[OrderFlowEvent], horizon: int) -> float:
    if not events:
        return 0.0
    half_life = max(1.0, float(horizon) / 2.0)
    weighted_signed = 0.0
    weighted_absolute = 0.0
    newest_index = len(events) - 1
    for index, event in enumerate(events):
        age = newest_index - index
        weight = exp(-float(age) / half_life)
        weighted_signed += event.signed_volume * weight
        weighted_absolute += event.absolute_volume * weight
    return _ratio(weighted_signed, weighted_absolute)


def _directional_alignment_score(
    summaries: Sequence[OrderFlowHorizonSummary],
) -> float:
    if not summaries:
        return 0.0
    by_horizon = {summary.horizon: summary for summary in summaries}
    shortest = by_horizon[min(by_horizon)]
    longest = by_horizon[max(by_horizon)]
    short_signal = (
        0.55 * shortest.decayed_imbalance + 0.45 * shortest.tail_bucket_imbalance
    )
    long_signal = (
        0.50 * longest.decayed_imbalance + 0.50 * longest.mean_bucket_imbalance
    )
    return _clip((short_signal * 0.65) + (long_signal * 0.35), -1.0, 1.0)


def _order_flow_event(*, index: int, record: ReplayFeatureRecord) -> OrderFlowEvent:
    source_fields: list[str] = []
    signed_volume = _first_float(
        record, _SIGNED_VOLUME_FIELDS, source_fields=source_fields
    )
    if signed_volume is not None:
        absolute_volume = abs(signed_volume)
        explicit_abs = _first_float(record, _VOLUME_FIELDS, source_fields=source_fields)
        if explicit_abs is not None:
            absolute_volume = max(absolute_volume, abs(explicit_abs))
        return OrderFlowEvent(
            index=index,
            signed_volume=signed_volume,
            absolute_volume=max(absolute_volume, 1.0),
            normalized_imbalance=_clip(
                _ratio(signed_volume, max(absolute_volume, 1.0)), -1.0, 1.0
            ),
            source_fields=tuple(source_fields),
            missing=False,
        )

    ofi = _first_float(record, _OFI_FIELDS, source_fields=source_fields)
    volume = _first_float(record, _VOLUME_FIELDS, source_fields=source_fields)
    if ofi is not None:
        normalized = _normalize_imbalance(ofi)
        absolute_volume = max(abs(volume) if volume is not None else 1.0, 1.0)
        return OrderFlowEvent(
            index=index,
            signed_volume=normalized * absolute_volume,
            absolute_volume=absolute_volume,
            normalized_imbalance=normalized,
            source_fields=tuple(source_fields),
            missing=False,
        )

    side_sign = _side_sign(record, source_fields=source_fields)
    if side_sign is not None and volume is not None:
        absolute_volume = max(abs(volume), 1.0)
        return OrderFlowEvent(
            index=index,
            signed_volume=side_sign * absolute_volume,
            absolute_volume=absolute_volume,
            normalized_imbalance=side_sign,
            source_fields=tuple(source_fields),
            missing=False,
        )

    bid_size = _first_float(record, _BID_SIZE_FIELDS, source_fields=source_fields)
    ask_size = _first_float(record, _ASK_SIZE_FIELDS, source_fields=source_fields)
    if (
        bid_size is not None
        and ask_size is not None
        and bid_size >= 0.0
        and ask_size >= 0.0
    ):
        absolute_depth = max(bid_size + ask_size, 1.0)
        imbalance = _ratio(bid_size - ask_size, absolute_depth)
        return OrderFlowEvent(
            index=index,
            signed_volume=imbalance * absolute_depth,
            absolute_volume=absolute_depth,
            normalized_imbalance=_clip(imbalance, -1.0, 1.0),
            source_fields=tuple(source_fields),
            missing=False,
        )

    return OrderFlowEvent(
        index=index,
        signed_volume=0.0,
        absolute_volume=0.0,
        normalized_imbalance=0.0,
        source_fields=tuple(source_fields),
        missing=True,
    )


def _normalize_horizons(horizons: Sequence[int]) -> tuple[int, ...]:
    normalized = tuple(sorted({max(1, int(item)) for item in horizons}))
    return normalized or DEFAULT_OFI_HORIZON_BUCKETS


def _record_sort_key(record: ReplayFeatureRecord) -> tuple[str, str, int]:
    event_ts = _record_value(record, "event_ts")
    seq = _record_value(record, "seq")
    symbol = str(_record_value(record, "symbol") or "").upper()
    if isinstance(event_ts, datetime):
        event_key = event_ts.isoformat()
    else:
        event_key = str(event_ts or "")
    seq_value = int(seq) if isinstance(seq, int) else 0
    return (event_key, symbol, seq_value)


def _record_value(record: ReplayFeatureRecord, key: str) -> Any:
    if isinstance(record, SignalEnvelope):
        if key == "event_ts":
            return record.event_ts
        if key == "symbol":
            return record.symbol
        if key == "seq":
            return record.seq
        return record.payload.get(key)
    if key in record:
        return record.get(key)
    payload = record.get("payload")
    if isinstance(payload, Mapping):
        payload_mapping = cast(Mapping[str, Any], payload)
        return payload_mapping.get(key)
    return None


def _first_float(
    record: ReplayFeatureRecord,
    keys: Sequence[str],
    *,
    source_fields: list[str],
) -> float | None:
    for key in keys:
        value = _float_or_none(_record_value(record, key))
        if value is not None:
            source_fields.append(key)
            return value
    return None


def _side_sign(
    record: ReplayFeatureRecord, *, source_fields: list[str]
) -> float | None:
    for key in ("side", "aggressor_side", "trade_side", "liquidity_side"):
        raw = _record_value(record, key)
        text = str(raw or "").strip().lower()
        if not text:
            continue
        source_fields.append(key)
        if text in {"buy", "bid", "b", "long", "ask_lift", "lift"}:
            return 1.0
        if text in {"sell", "ask", "s", "short", "bid_hit", "hit"}:
            return -1.0
    trade_sign = _float_or_none(_record_value(record, "trade_sign"))
    if trade_sign is not None:
        source_fields.append("trade_sign")
        return 1.0 if trade_sign > 0.0 else -1.0 if trade_sign < 0.0 else 0.0
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
    elif isinstance(value, Decimal):
        parsed = float(value)
    else:
        try:
            parsed = float(str(value).strip())
        except ValueError:
            return None
    return parsed if isfinite(parsed) else None


def _normalize_imbalance(value: float) -> float:
    if -1.0 <= value <= 1.0:
        return value
    return tanh(value / 100.0)


def _ratio(numerator: float, denominator: float) -> float:
    if denominator <= 0.0:
        return 0.0
    return numerator / denominator


def _safe_mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / float(len(values))


def _clip(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _stable_float(value: float) -> str:
    if not isfinite(value):
        return "0"
    return f"{value:.12g}"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


__all__ = [
    "DEFAULT_OFI_HORIZON_BUCKETS",
    "HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION",
    "HPAIRS_ORDER_FLOW_PROOF_SEMANTICS_LABEL",
    "OrderFlowFeatureSet",
    "ReplayFeatureRecord",
    "build_order_flow_feature_schema_hash",
    "extract_order_flow_features",
    "order_flow_feature_contract",
]

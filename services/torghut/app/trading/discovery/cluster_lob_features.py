"""ClusterLOB-style replay-tape feature extraction for H-PAIRS discovery.

The extractor accepts replay ``SignalEnvelope`` rows or plain fixture mappings.
It never reaches live cluster services and its payloads are explicitly
preview-only research-ranking metadata.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from math import isfinite, log
from typing import Any, cast

from app.trading.discovery.order_flow_features import (
    DEFAULT_OFI_HORIZON_BUCKETS,
    HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION,
    ReplayFeatureRecord,
    build_order_flow_feature_schema_hash,
    extract_order_flow_features,
)
from app.trading.models import SignalEnvelope

HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION = "torghut.hpairs-clusterlob-features.v1"
HPAIRS_CLUSTER_LOB_FEATURE_CONTRACT_SCHEMA_VERSION = (
    "torghut.hpairs-clusterlob-feature-contract.v1"
)
HPAIRS_CLUSTER_LOB_PROOF_SEMANTICS_LABEL = "hpairs_clusterlob_order_flow_features_preview_only_exact_replay_and_runtime_ledger_required"

_EXPLICIT_CLUSTER_FIELDS: tuple[str, ...] = (
    "cluster_lob_bucket",
    "cluster_bucket",
    "participant_bucket",
    "behavior_bucket",
    "cluster_lob_label",
    "cluster_label",
    "order_cluster",
)
_EVENT_FIELDS: tuple[str, ...] = (
    "lob_event_type",
    "event_type",
    "order_event_type",
    "side",
    "aggressor_side",
    "trade_side",
    "liquidity_side",
)


@dataclass(frozen=True)
class ClusterLOBFeatureSet:
    row_count: int
    symbol_count: int
    source_fields: tuple[str, ...]
    warnings: tuple[str, ...]
    cluster_bins: Mapping[str, int]
    dominant_cluster_bin: str
    cluster_entropy: float
    cluster_switch_rate: float
    order_flow_payload: Mapping[str, Any]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        ranking_features = self.ranking_features()
        return {
            "schema_version": HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_research_ranking",
            "row_count": self.row_count,
            "symbol_count": self.symbol_count,
            "source_fields": list(self.source_fields),
            "warnings": list(self.warnings),
            "cluster_bins": dict(sorted(self.cluster_bins.items())),
            "dominant_cluster_bin": self.dominant_cluster_bin,
            "cluster_entropy": _stable_float(self.cluster_entropy),
            "cluster_switch_rate": _stable_float(self.cluster_switch_rate),
            "order_flow": dict(self.order_flow_payload),
            "ranking_features": ranking_features,
            "prefilter_only": True,
            "research_ranking_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": HPAIRS_CLUSTER_LOB_PROOF_SEMANTICS_LABEL,
        }

    def ranking_features(self) -> dict[str, Any]:
        order_flow_ranking = _mapping(self.order_flow_payload.get("ranking_features"))
        directional_alignment = _float_or_zero(
            order_flow_ranking.get("directional_alignment_score")
        )
        imbalance_abs_mean = _float_or_zero(
            order_flow_ranking.get("imbalance_abs_mean")
        )
        missing_penalty = _float_or_zero(order_flow_ranking.get("missing_data_penalty"))
        return {
            "directional_alignment_score": _stable_float(directional_alignment),
            "imbalance_abs_mean": _stable_float(imbalance_abs_mean),
            "cluster_entropy": _stable_float(self.cluster_entropy),
            "cluster_switch_rate": _stable_float(self.cluster_switch_rate),
            "missing_data_penalty": _stable_float(missing_penalty),
            "preview_rank_feature_score": _stable_float(
                (abs(directional_alignment) * 18.0)
                + (imbalance_abs_mean * 10.0)
                + (self.cluster_entropy * 4.0)
                + (self.cluster_switch_rate * 2.0)
                - (missing_penalty * 8.0)
            ),
        }


def cluster_lob_feature_contract(
    *, horizons: Sequence[int] = DEFAULT_OFI_HORIZON_BUCKETS
) -> dict[str, Any]:
    return {
        "schema_version": HPAIRS_CLUSTER_LOB_FEATURE_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
        "order_flow_schema_version": HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION,
        "order_flow_schema_hash": build_order_flow_feature_schema_hash(
            horizons=horizons
        ),
        "horizon_buckets": [int(item) for item in horizons],
        "explicit_cluster_fields": list(_EXPLICIT_CLUSTER_FIELDS),
        "event_fields": list(_EVENT_FIELDS),
        "bin_policy": "deterministic_explicit_bucket_or_order_event_fallback",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_runtime_ledger": True,
        },
    }


def build_cluster_lob_feature_schema_hash(
    *, horizons: Sequence[int] = DEFAULT_OFI_HORIZON_BUCKETS
) -> str:
    return _stable_hash(cluster_lob_feature_contract(horizons=horizons))


def extract_cluster_lob_features(
    records: Sequence[ReplayFeatureRecord],
    *,
    horizons: Sequence[int] = DEFAULT_OFI_HORIZON_BUCKETS,
) -> ClusterLOBFeatureSet:
    ordered = tuple(sorted(records, key=_record_sort_key))
    source_fields: set[str] = set()
    bins = tuple(
        _cluster_bin(record, source_fields=source_fields) for record in ordered
    )
    counts: Counter[str] = Counter(bins)
    order_flow = extract_order_flow_features(ordered, horizons=horizons)
    warnings = list(order_flow.warnings)
    if not ordered:
        warnings.append("empty_cluster_lob_records")
    if "unknown_event_cluster" in counts:
        warnings.append("missing_cluster_lob_inputs")
    symbols = {
        symbol
        for record in ordered
        if (symbol := str(_record_value(record, "symbol") or "").strip().upper())
    }
    return ClusterLOBFeatureSet(
        row_count=len(ordered),
        symbol_count=len(symbols),
        source_fields=tuple(sorted(source_fields | set(order_flow.source_fields))),
        warnings=tuple(dict.fromkeys(warnings)),
        cluster_bins=dict(counts),
        dominant_cluster_bin=_dominant_bin(counts),
        cluster_entropy=_normalized_entropy(counts),
        cluster_switch_rate=_switch_rate(bins),
        order_flow_payload=order_flow.to_payload(),
        feature_schema_hash=build_cluster_lob_feature_schema_hash(horizons=horizons),
    )


def _cluster_bin(record: ReplayFeatureRecord, *, source_fields: set[str]) -> str:
    for key in _EXPLICIT_CLUSTER_FIELDS:
        raw = _record_value(record, key)
        text = _normalize_label(raw)
        if text:
            source_fields.add(key)
            return text

    event_text = ""
    for key in _EVENT_FIELDS:
        raw = _record_value(record, key)
        text = _normalize_label(raw)
        if text:
            source_fields.add(key)
            event_text = text
            break

    side = _side_label(record, source_fields=source_fields)
    if event_text in {"trade", "fill", "execution"} and side == "buy":
        return "aggressive_buy_trade"
    if event_text in {"trade", "fill", "execution"} and side == "sell":
        return "aggressive_sell_trade"
    if event_text in {"add", "new", "open", "quote"} and side == "buy":
        return "bid_liquidity_add"
    if event_text in {"add", "new", "open", "quote"} and side == "sell":
        return "ask_liquidity_add"
    if event_text in {"cancel", "delete", "remove"} and side == "buy":
        return "bid_liquidity_remove"
    if event_text in {"cancel", "delete", "remove"} and side == "sell":
        return "ask_liquidity_remove"
    if event_text:
        return f"event_{event_text}"

    depth_imbalance = _quote_depth_imbalance(record, source_fields=source_fields)
    if depth_imbalance > 0.25:
        return "bid_depth_dominant"
    if depth_imbalance < -0.25:
        return "ask_depth_dominant"
    if depth_imbalance != 0.0:
        return "balanced_depth"
    return "unknown_event_cluster"


def _dominant_bin(counts: Counter[str]) -> str:
    if not counts:
        return "none"
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]


def _normalized_entropy(counts: Counter[str]) -> float:
    total = sum(counts.values())
    if total <= 0 or len(counts) <= 1:
        return 0.0
    entropy = 0.0
    for count in counts.values():
        probability = count / total
        entropy -= probability * log(probability)
    return min(1.0, entropy / log(len(counts)))


def _switch_rate(bins: Sequence[str]) -> float:
    if len(bins) <= 1:
        return 0.0
    switches = sum(
        1 for previous, current in zip(bins, bins[1:]) if previous != current
    )
    return switches / float(len(bins) - 1)


def _record_sort_key(record: ReplayFeatureRecord) -> tuple[str, str, int]:
    event_ts = _record_value(record, "event_ts")
    seq = _record_value(record, "seq")
    symbol = str(_record_value(record, "symbol") or "").upper()
    event_key = (
        event_ts.isoformat() if hasattr(event_ts, "isoformat") else str(event_ts or "")
    )
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


def _side_label(record: ReplayFeatureRecord, *, source_fields: set[str]) -> str:
    for key in ("side", "aggressor_side", "trade_side", "liquidity_side"):
        text = _normalize_label(_record_value(record, key))
        if not text:
            continue
        source_fields.add(key)
        if text in {"buy", "bid", "b", "long", "ask_lift", "lift"}:
            return "buy"
        if text in {"sell", "ask", "s", "short", "bid_hit", "hit"}:
            return "sell"
    return ""


def _quote_depth_imbalance(
    record: ReplayFeatureRecord, *, source_fields: set[str]
) -> float:
    bid_size = _first_float(
        record, ("bid_size", "bid_qty", "best_bid_size"), source_fields=source_fields
    )
    ask_size = _first_float(
        record, ("ask_size", "ask_qty", "best_ask_size"), source_fields=source_fields
    )
    if bid_size is None or ask_size is None:
        return 0.0
    total = bid_size + ask_size
    if total <= 0.0:
        return 0.0
    return (bid_size - ask_size) / total


def _first_float(
    record: ReplayFeatureRecord, keys: Sequence[str], *, source_fields: set[str]
) -> float | None:
    for key in keys:
        value = _float_or_none(_record_value(record, key))
        if value is not None:
            source_fields.add(key)
            return value
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


def _float_or_zero(value: Any) -> float:
    parsed = _float_or_none(value)
    return parsed if parsed is not None else 0.0


def _mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _normalize_label(value: Any) -> str:
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return "_".join(part for part in text.split("_") if part)


def _stable_float(value: float) -> str:
    if not isfinite(value):
        return "0"
    return f"{value:.12g}"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


__all__ = [
    "HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION",
    "HPAIRS_CLUSTER_LOB_PROOF_SEMANTICS_LABEL",
    "ClusterLOBFeatureSet",
    "build_cluster_lob_feature_schema_hash",
    "cluster_lob_feature_contract",
    "extract_cluster_lob_features",
]

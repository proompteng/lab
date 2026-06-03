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
from datetime import datetime
from decimal import Decimal
from math import exp, isfinite, log
from typing import Any, cast

from app.trading.discovery.order_flow_features import (
    DEFAULT_OFI_HORIZON_BUCKETS,
    HPAIRS_ORDER_FLOW_FEATURE_SCHEMA_VERSION,
    ReplayFeatureRecord,
    build_order_flow_feature_schema_hash,
    extract_order_flow_features,
)
from app.trading.models import SignalEnvelope

HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION = "torghut.hpairs-clusterlob-features.v2"
HPAIRS_CLUSTER_LOB_FEATURE_CONTRACT_SCHEMA_VERSION = (
    "torghut.hpairs-clusterlob-feature-contract.v2"
)
HPAIRS_CLUSTER_LOB_PROOF_SEMANTICS_LABEL = "hpairs_clusterlob_order_flow_features_preview_only_exact_replay_and_runtime_ledger_required"
HAWKES_EXCITATION_KERNEL_SECONDS = 5.0
HAWKES_EXCITATION_LOOKBACK_SECONDS = 30.0
HPAIRS_CLUSTER_LOB_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2510.08085",
        "url": "https://arxiv.org/abs/2510.08085",
        "mechanism": "deterministic_lob_hawkes_order_flow_clustering",
    },
    {
        "source_id": "arxiv-2604.23961",
        "url": "https://arxiv.org/abs/2604.23961",
        "mechanism": "state_dependent_hawkes_volatility_signature_stability",
    },
    {
        "source_id": "arxiv-2502.17417",
        "url": "https://arxiv.org/abs/2502.17417",
        "mechanism": "neural_hawkes_lob_event_interaction_fill_stress",
    },
)

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
class HawkesExcitationSummary:
    observed_event_time_count: int
    mean_interarrival_seconds: float
    p10_interarrival_seconds: float
    burst_event_share: float
    same_cluster_max_run: int
    mean_self_excitation: float
    hawkes_branching_proxy: float
    local_supercriticality_flag: bool
    replay_stress_score: float

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": "torghut.hpairs-hawkes-excitation-summary.v1",
            "source_papers": [
                dict(item) for item in HPAIRS_CLUSTER_LOB_PRIMARY_SOURCES
            ],
            "kernel_policy": {
                "decay_kernel": "exp(-delta_seconds / 5)",
                "lookback_seconds": _stable_float(HAWKES_EXCITATION_LOOKBACK_SECONDS),
                "branching_proxy_cap": "1.5",
                "local_supercriticality_threshold": "1.0",
            },
            "observed_event_time_count": self.observed_event_time_count,
            "mean_interarrival_seconds": _stable_float(self.mean_interarrival_seconds),
            "p10_interarrival_seconds": _stable_float(self.p10_interarrival_seconds),
            "burst_event_share": _stable_float(self.burst_event_share),
            "same_cluster_max_run": self.same_cluster_max_run,
            "mean_self_excitation": _stable_float(self.mean_self_excitation),
            "hawkes_branching_proxy": _stable_float(self.hawkes_branching_proxy),
            "local_supercriticality_flag": self.local_supercriticality_flag,
            "replay_stress_score": _stable_float(self.replay_stress_score),
            "prefilter_only": True,
            "research_ranking_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
        }


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
    hawkes_excitation_summary: HawkesExcitationSummary
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
            "hawkes_excitation": self.hawkes_excitation_summary.to_payload(),
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
        hawkes_stress_score = self.hawkes_excitation_summary.replay_stress_score
        return {
            "directional_alignment_score": _stable_float(directional_alignment),
            "imbalance_abs_mean": _stable_float(imbalance_abs_mean),
            "cluster_entropy": _stable_float(self.cluster_entropy),
            "cluster_switch_rate": _stable_float(self.cluster_switch_rate),
            "hawkes_excitation_stress_score": _stable_float(hawkes_stress_score),
            "missing_data_penalty": _stable_float(missing_penalty),
            "preview_rank_feature_score": _stable_float(
                (abs(directional_alignment) * 18.0)
                + (imbalance_abs_mean * 10.0)
                + (self.cluster_entropy * 4.0)
                + (self.cluster_switch_rate * 2.0)
                + (hawkes_stress_score * 3.0)
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
        "hawkes_excitation_policy": {
            "source_papers": [
                dict(item) for item in HPAIRS_CLUSTER_LOB_PRIMARY_SOURCES
            ],
            "event_time_required_for_excitation": True,
            "decay_kernel": "exp(-delta_seconds / 5)",
            "lookback_seconds": _stable_float(HAWKES_EXCITATION_LOOKBACK_SECONDS),
            "output_scope": "preview_replay_stress_ranking_only",
        },
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
    hawkes_summary = extract_hawkes_excitation_summary(ordered, cluster_bins=bins)
    order_flow = extract_order_flow_features(ordered, horizons=horizons)
    warnings = list(order_flow.warnings)
    if not ordered:
        warnings.append("empty_cluster_lob_records")
    if "unknown_event_cluster" in counts:
        warnings.append("missing_cluster_lob_inputs")
    if hawkes_summary.observed_event_time_count < 2:
        warnings.append("insufficient_hawkes_event_timestamps")
    symbols = {
        symbol
        for record in ordered
        if (symbol := str(_record_value(record, "symbol") or "").strip().upper())
    }
    return ClusterLOBFeatureSet(
        row_count=len(ordered),
        symbol_count=len(symbols),
        source_fields=tuple(
            sorted(
                source_fields
                | set(order_flow.source_fields)
                | ({"event_ts"} if hawkes_summary.observed_event_time_count else set())
            )
        ),
        warnings=tuple(dict.fromkeys(warnings)),
        cluster_bins=dict(counts),
        dominant_cluster_bin=_dominant_bin(counts),
        cluster_entropy=_normalized_entropy(counts),
        cluster_switch_rate=_switch_rate(bins),
        hawkes_excitation_summary=hawkes_summary,
        order_flow_payload=order_flow.to_payload(),
        feature_schema_hash=build_cluster_lob_feature_schema_hash(horizons=horizons),
    )


def extract_hawkes_excitation_summary(
    records: Sequence[ReplayFeatureRecord],
    *,
    cluster_bins: Sequence[str] | None = None,
) -> HawkesExcitationSummary:
    """Build a deterministic Hawkes-style clustering proxy for replay stress.

    This is not a fitted Hawkes model and never authorizes promotion. It actualizes
    recent Hawkes/LOB papers into a cheap event-time stress feature: bursty
    inter-arrivals and high self-excitation increase preview ranking pressure,
    while exact replay, route TCA, and runtime-ledger proof remain mandatory.
    """

    ordered = tuple(sorted(records, key=_record_sort_key))
    bins = (
        tuple(cluster_bins)
        if cluster_bins is not None
        else tuple(_cluster_bin(record, source_fields=set()) for record in ordered)
    )
    event_pairs = tuple(
        (timestamp, bins[index] if index < len(bins) else "unknown_event_cluster")
        for index, record in enumerate(ordered)
        if (timestamp := _event_time_seconds(record)) is not None
    )
    event_times = tuple(timestamp for timestamp, _ in event_pairs)
    interarrivals = tuple(
        max(0.001, current - previous)
        for previous, current in zip(event_times, event_times[1:])
        if current >= previous
    )
    mean_interarrival = _safe_mean(interarrivals)
    p10_interarrival = _percentile(interarrivals, 10.0)
    burst_threshold = min(1.0, max(0.001, mean_interarrival * 0.5))
    burst_event_share = (
        sum(1 for value in interarrivals if value <= burst_threshold)
        / len(interarrivals)
        if interarrivals
        else 0.0
    )
    same_cluster_max_run = _same_cluster_max_run(
        tuple(label for _, label in event_pairs)
    )
    excitations = tuple(
        _hawkes_excitation_at(index, event_pairs) for index in range(len(event_pairs))
    )
    mean_self_excitation = _safe_mean(excitations)
    hawkes_branching_proxy = min(1.5, mean_self_excitation / 3.0)
    same_cluster_run_score = min(1.0, max(0, same_cluster_max_run - 1) / 5.0)
    replay_stress_score = min(
        1.0,
        max(
            0.0,
            (min(1.0, hawkes_branching_proxy) * 0.55)
            + (burst_event_share * 0.30)
            + (same_cluster_run_score * 0.15),
        ),
    )
    return HawkesExcitationSummary(
        observed_event_time_count=len(event_pairs),
        mean_interarrival_seconds=mean_interarrival,
        p10_interarrival_seconds=p10_interarrival,
        burst_event_share=burst_event_share,
        same_cluster_max_run=same_cluster_max_run,
        mean_self_excitation=mean_self_excitation,
        hawkes_branching_proxy=hawkes_branching_proxy,
        local_supercriticality_flag=hawkes_branching_proxy >= 1.0,
        replay_stress_score=replay_stress_score,
    )


def _hawkes_excitation_at(
    index: int, event_pairs: Sequence[tuple[float, str]]
) -> float:
    current_time, current_label = event_pairs[index]
    excitation = 0.0
    for previous_time, previous_label in reversed(event_pairs[:index]):
        delta_seconds = current_time - previous_time
        if delta_seconds < 0.0:
            continue
        if delta_seconds > HAWKES_EXCITATION_LOOKBACK_SECONDS:
            break
        same_cluster_weight = 1.2 if previous_label == current_label else 1.0
        excitation += same_cluster_weight * exp(
            -delta_seconds / HAWKES_EXCITATION_KERNEL_SECONDS
        )
    return excitation


def _same_cluster_max_run(labels: Sequence[str]) -> int:
    if not labels:
        return 0
    max_run = 1
    current_run = 1
    for previous, current in zip(labels, labels[1:]):
        if previous == current:
            current_run += 1
        else:
            max_run = max(max_run, current_run)
            current_run = 1
    return max(max_run, current_run)


def _percentile(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    clipped_percentile = max(0.0, min(100.0, percentile))
    index = int(round((len(ordered) - 1) * clipped_percentile / 100.0))
    return ordered[index]


def _safe_mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _event_time_seconds(record: ReplayFeatureRecord) -> float | None:
    value = _record_value(record, "event_ts")
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
        return parsed if isfinite(parsed) else None
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


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
    "HawkesExcitationSummary",
    "HPAIRS_CLUSTER_LOB_PRIMARY_SOURCES",
    "build_cluster_lob_feature_schema_hash",
    "cluster_lob_feature_contract",
    "extract_cluster_lob_features",
    "extract_hawkes_excitation_summary",
]

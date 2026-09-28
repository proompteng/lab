"""Preview-only order-transition and latent-regime stress for replay rows.

This module actualizes recent order-transition and latent microstructure-regime
papers into deterministic replay harness inputs.  It does not simulate broker
fills, write ledgers, or carry promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log2
from typing import Any, cast

from app.trading.models import SignalEnvelope

ORDER_TRANSITION_STRESS_SCHEMA_VERSION = "torghut.order-transition-stress.v1"
ORDER_TRANSITION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.order-transition-stress-contract.v1"
)
ORDER_TRANSITION_STRESS_PROOF_SEMANTICS_LABEL = "order_transition_stress_preview_only_exact_replay_route_tca_runtime_ledger_required"
ORDER_TRANSITION_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2502.07625",
        "url": "https://arxiv.org/abs/2502.07625",
        "mechanism": "first_order_markov_order_transition_dynamics_degree_of_inertia",
    },
    {
        "source_id": "arxiv-2604.20949",
        "url": "https://arxiv.org/abs/2604.20949",
        "mechanism": "latent_microstructure_build_up_rising_edge_detector",
    },
)

_KNOWN_STATES: tuple[str, ...] = (
    "limit_add",
    "limit_cancel",
    "limit_modify",
    "buy_execution",
    "sell_execution",
    "unknown",
)
_EXECUTION_STATES = frozenset(("buy_execution", "sell_execution"))
_LIMIT_MODIFICATION_STATES = frozenset(("limit_cancel", "limit_modify"))
_SPREAD_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "ofi_pressure_score",
    "signed_order_flow_imbalance",
    "queue_imbalance",
    "book_imbalance",
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
_BID_SIZE_FIELDS = ("bid_size", "bid_qty", "best_bid_size")
_ASK_SIZE_FIELDS = ("ask_size", "ask_qty", "best_ask_size")


@dataclass(frozen=True)
class OrderTransitionStressSummary:
    row_count: int
    observed_state_count: int
    transition_count: int
    state_counts: Mapping[str, int]
    transition_counts: Mapping[str, int]
    normalized_transition_entropy: float
    degree_of_inertia: float
    execution_cluster_share: float
    limit_modification_share: float
    latent_build_up_score: float
    rising_edge_trigger_count: int
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": ORDER_TRANSITION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_order_transition_stress_ranking",
            "source_papers": [
                dict(item) for item in ORDER_TRANSITION_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_state_count": self.observed_state_count,
            "transition_count": self.transition_count,
            "state_counts": dict(self.state_counts),
            "transition_counts": dict(self.transition_counts),
            "normalized_transition_entropy": _stable_float(
                self.normalized_transition_entropy
            ),
            "degree_of_inertia": _stable_float(self.degree_of_inertia),
            "execution_cluster_share": _stable_float(self.execution_cluster_share),
            "limit_modification_share": _stable_float(self.limit_modification_share),
            "latent_build_up_score": _stable_float(self.latent_build_up_score),
            "rising_edge_trigger_count": self.rising_edge_trigger_count,
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "normalized_transition_entropy": _stable_float(
                    self.normalized_transition_entropy
                ),
                "degree_of_inertia": _stable_float(self.degree_of_inertia),
                "execution_cluster_share": _stable_float(self.execution_cluster_share),
                "limit_modification_share": _stable_float(
                    self.limit_modification_share
                ),
                "latent_build_up_score": _stable_float(self.latent_build_up_score),
                "rising_edge_trigger_count": self.rising_edge_trigger_count,
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "markov_transition_matrix_preview": True,
            "latent_regime_rising_edge_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": ORDER_TRANSITION_STRESS_PROOF_SEMANTICS_LABEL,
        }


def order_transition_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ORDER_TRANSITION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ORDER_TRANSITION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in ORDER_TRANSITION_STRESS_PRIMARY_SOURCES
        ],
        "transition_policy": "first_order_markov_state_counts_over_replay_event_order",
        "latent_regime_policy": "adaptive_threshold_rising_edge_max_channel_detector",
        "state_space": list(_KNOWN_STATES),
        "stress_components": [
            "normalized_transition_entropy",
            "degree_of_inertia",
            "execution_cluster_share",
            "limit_modification_share",
            "latent_build_up_score",
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
            "requires_runtime_ledger": True,
        },
    }


def build_order_transition_stress_schema_hash() -> str:
    return _stable_hash(order_transition_stress_contract())


def extract_order_transition_stress(
    records: Sequence[SignalEnvelope],
) -> OrderTransitionStressSummary:
    """Extract deterministic order-transition and latent-regime stress.

    The returned score is only a cheap replay-ranking stress input. Exact
    replay, route TCA, and runtime-ledger proof remain authoritative.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    states = tuple(_event_state(row) for row in ordered)
    observed_state_count = sum(1 for state in states if state != "unknown")
    transition_pairs = tuple(
        (left, right)
        for left, right in zip(states, states[1:])
        if left != "unknown" and right != "unknown"
    )
    state_counts = Counter(states)
    transition_counts = Counter(f"{left}->{right}" for left, right in transition_pairs)
    transition_count = len(transition_pairs)
    normalized_transition_entropy = _normalized_transition_entropy(transition_counts)
    degree_of_inertia = _degree_of_inertia(transition_pairs)
    execution_cluster_share = _execution_cluster_share(transition_pairs)
    limit_modification_share = _limit_modification_share(states)
    latent_channel = tuple(_latent_stress_channel(row) for row in ordered)
    latent_build_up_score, rising_edge_trigger_count = _latent_build_up_score(
        latent_channel
    )

    warnings: list[str] = []
    if len(ordered) < 3:
        warnings.append("insufficient_order_transition_rows")
    if observed_state_count < 2:
        warnings.append("insufficient_observed_order_transition_states")
    if transition_count < 1:
        warnings.append("missing_order_transition_pairs")
    if not any(item > 0.0 for item in latent_channel):
        warnings.append("missing_latent_regime_channels")

    missing_penalty_bps = 5.0 * len(warnings)
    replay_rank_penalty_bps = (
        normalized_transition_entropy * 8.0
        + max(0.0, 0.45 - degree_of_inertia) * 10.0
        + execution_cluster_share * 9.0
        + limit_modification_share * 7.0
        + latent_build_up_score * 14.0
        + missing_penalty_bps
    )
    return OrderTransitionStressSummary(
        row_count=len(ordered),
        observed_state_count=observed_state_count,
        transition_count=transition_count,
        state_counts={
            state: int(state_counts.get(state, 0)) for state in _KNOWN_STATES
        },
        transition_counts=dict(sorted(transition_counts.items())),
        normalized_transition_entropy=normalized_transition_entropy,
        degree_of_inertia=degree_of_inertia,
        execution_cluster_share=execution_cluster_share,
        limit_modification_share=limit_modification_share,
        latent_build_up_score=latent_build_up_score,
        rising_edge_trigger_count=rising_edge_trigger_count,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_order_transition_stress_schema_hash(),
    )


def _event_state(row: SignalEnvelope) -> str:
    payload = row.payload
    raw_type = str(
        _first_payload_value(
            payload,
            (
                "event_type",
                "order_event_type",
                "lob_event_type",
                "order_action",
                "action",
                "type",
            ),
        )
        or ""
    ).lower()
    side = str(
        _first_payload_value(payload, ("side", "trade_side", "aggressor_side")) or ""
    ).lower()
    signed_volume = _float_or_none(
        _first_payload_value(
            payload,
            (
                "signed_volume",
                "signed_qty",
                "signed_quantity",
                "signed_size",
                "aggressor_signed_volume",
            ),
        )
    )
    if any(token in raw_type for token in ("cancel", "delete", "remove")):
        return "limit_cancel"
    if any(token in raw_type for token in ("modify", "replace", "update")):
        return "limit_modify"
    if any(
        token in raw_type
        for token in ("execute", "execution", "trade", "fill", "market")
    ):
        return _execution_state(side=side, signed_volume=signed_volume)
    if any(token in raw_type for token in ("add", "place", "submit", "limit")):
        return "limit_add"
    if signed_volume is not None and signed_volume != 0.0:
        return _execution_state(side=side, signed_volume=signed_volume)
    return "unknown"


def _execution_state(*, side: str, signed_volume: float | None) -> str:
    if side in {"buy", "bid", "b"}:
        return "buy_execution"
    if side in {"sell", "ask", "s"}:
        return "sell_execution"
    if signed_volume is not None:
        return "buy_execution" if signed_volume > 0.0 else "sell_execution"
    return "buy_execution"


def _normalized_transition_entropy(transition_counts: Mapping[str, int]) -> float:
    total = sum(transition_counts.values())
    if total <= 0:
        return 0.0
    probabilities = [count / total for count in transition_counts.values() if count > 0]
    entropy = -sum(probability * log2(probability) for probability in probabilities)
    max_entropy = log2(max(2, min(len(_KNOWN_STATES) ** 2, total)))
    if max_entropy <= 0.0:
        return 0.0
    return min(1.0, max(0.0, entropy / max_entropy))


def _degree_of_inertia(transition_pairs: Sequence[tuple[str, str]]) -> float:
    if not transition_pairs:
        return 0.0
    same_count = sum(1 for left, right in transition_pairs if left == right)
    return same_count / len(transition_pairs)


def _execution_cluster_share(transition_pairs: Sequence[tuple[str, str]]) -> float:
    if not transition_pairs:
        return 0.0
    clustered = sum(
        1
        for left, right in transition_pairs
        if left in _EXECUTION_STATES and right in _EXECUTION_STATES
    )
    return clustered / len(transition_pairs)


def _limit_modification_share(states: Sequence[str]) -> float:
    observed = [state for state in states if state != "unknown"]
    if not observed:
        return 0.0
    return sum(1 for state in observed if state in _LIMIT_MODIFICATION_STATES) / len(
        observed
    )


def _latent_stress_channel(row: SignalEnvelope) -> float:
    payload = row.payload
    spread = _nonnegative_float(_first_payload_value(payload, _SPREAD_FIELDS))
    ofi = abs(_float_or_none(_first_payload_value(payload, _OFI_FIELDS)) or 0.0)
    volume = _nonnegative_float(_first_payload_value(payload, _VOLUME_FIELDS))
    bid_size = _nonnegative_float(_first_payload_value(payload, _BID_SIZE_FIELDS))
    ask_size = _nonnegative_float(_first_payload_value(payload, _ASK_SIZE_FIELDS))
    displayed_depth = bid_size + ask_size
    depth_fragility = (
        1.0 / (1.0 + displayed_depth / 1_000.0) if displayed_depth > 0.0 else 0.0
    )
    low_volume_fragility = 1.0 / (1.0 + volume / 10_000.0) if volume > 0.0 else 0.0
    spread_channel = min(1.0, spread / 20.0) if spread > 0.0 else 0.0
    ofi_channel = min(1.0, ofi)
    return min(
        1.0,
        spread_channel * 0.35
        + depth_fragility * 0.25
        + ofi_channel * 0.25
        + low_volume_fragility * 0.15,
    )


def _latent_build_up_score(channel: Sequence[float]) -> tuple[float, int]:
    if len(channel) < 3:
        return 0.0, 0
    baseline = _median(channel)
    deviations = [abs(item - baseline) for item in channel]
    threshold = min(1.0, baseline + _median(deviations) + 0.04)
    rising_edges = [
        max(0.0, current - previous)
        for previous, current in zip(channel, channel[1:])
        if current >= threshold and current > previous
    ]
    if not rising_edges:
        return 0.0, 0
    tail_mean = _mean(channel[max(0, len(channel) - 3) :])
    head_mean = _mean(channel[: min(3, len(channel))])
    build_up = max(0.0, tail_mean - head_mean)
    score = min(1.0, build_up + max(rising_edges))
    return score, len(rising_edges)


def _first_payload_value(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> Any | None:
    for field in fields:
        value = payload.get(field)
        if value is not None:
            return value
    return None


def _nonnegative_float(value: object) -> float:
    parsed = _float_or_none(value)
    if parsed is None or parsed < 0.0:
        return 0.0
    return parsed


def _float_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(cast(Any, value))
    except (TypeError, ValueError):
        return None
    return parsed if isfinite(parsed) else None


def _median(values: Sequence[float]) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    midpoint = len(clean) // 2
    if len(clean) % 2:
        return clean[midpoint]
    return (clean[midpoint - 1] + clean[midpoint]) / 2.0


def _mean(values: Sequence[float]) -> float:
    clean = [value for value in values if isfinite(value)]
    return sum(clean) / len(clean) if clean else 0.0


def _stable_float(value: float) -> str:
    return f"{value:.10f}".rstrip("0").rstrip(".") or "0"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        cast(dict[str, Any], payload),
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

"""Preview-only order-flow entropy and latent-regime stress for replay rows.

This module actualizes recent order-flow entropy / Hidden Markov regime papers
into deterministic replay harness inputs.  It only produces candidate-ranking
stress features; it never simulates fills, writes ledgers, authorizes
promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log2
from typing import Any

from app.trading.models import SignalEnvelope

ORDER_FLOW_ENTROPY_REGIME_STRESS_SCHEMA_VERSION = (
    "torghut.order-flow-entropy-regime-stress.v1"
)
ORDER_FLOW_ENTROPY_REGIME_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.order-flow-entropy-regime-stress-contract.v1"
)
ORDER_FLOW_ENTROPY_REGIME_STRESS_PROOF_SEMANTICS_LABEL = "order_flow_entropy_regime_stress_preview_only_exact_tick_replay_route_tca_runtime_ledger_required"
ORDER_FLOW_ENTROPY_REGIME_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "ssrn-5315733",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5315733",
        "title": "Asymmetric Hidden Markov Modeling of Order Flow Imbalances for Microstructure-Aware Market Regime Detection",
        "date": "2025-06-23",
        "mechanism": "asymmetric_hmm_ofi_latent_liquidity_regime_detection",
    },
    {
        "source_id": "arxiv-2512.15720",
        "url": "https://arxiv.org/abs/2512.15720",
        "title": "Hidden Order in Trades Predicts the Size of Price Moves",
        "date": "2025-12-02",
        "mechanism": "order_flow_entropy_predicts_intraday_absolute_returns_not_direction",
    },
    {
        "source_id": "arxiv-2603.20456",
        "url": "https://arxiv.org/abs/2603.20456",
        "title": "Neural Hidden Markov Model with Adaptive Granularity Attention for High-Frequency Order Flow Modeling",
        "date": "2026-03-20",
        "mechanism": "multi_scale_order_flow_latent_regime_attention_gated_by_volatility_and_intensity",
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "ofi_pressure_score",
    "signed_order_flow_imbalance",
    "queue_imbalance",
    "book_imbalance",
    "depth_imbalance",
)
_SIGNED_VOLUME_FIELDS = (
    "signed_volume",
    "signed_qty",
    "signed_quantity",
    "signed_size",
    "aggressor_signed_volume",
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
_SIDE_FIELDS = ("side", "trade_side", "aggressor_side", "order_side")
_EVENT_FIELDS = ("event_type", "order_event_type", "lob_event_type", "action", "type")
_SPREAD_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_BUY_TOKENS = frozenset(("buy", "bid", "b", "lift", "ask_hit"))
_SELL_TOKENS = frozenset(("sell", "ask", "offer", "s", "hit", "bid_hit"))
_VOLATILITY_FIELDS = (
    "realized_volatility_bps",
    "intraday_volatility_bps",
    "volatility_bps",
    "abs_return_bps",
)


@dataclass(frozen=True)
class OrderFlowEntropyRegimeStressSummary:
    row_count: int
    observed_order_flow_count: int
    observed_price_count: int
    transition_count: int
    state_counts: Mapping[str, int]
    transition_counts: Mapping[str, int]
    normalized_transition_entropy: float
    low_entropy_hidden_order_score: float
    entropy_directionality_gap: float
    asymmetric_regime_persistence: float
    abrupt_regime_flip_share: float
    multi_scale_regime_disagreement: float
    volatility_intensity_gate: float
    source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": ORDER_FLOW_ENTROPY_REGIME_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_order_flow_entropy_regime_stress_ranking",
            "source_papers": [
                dict(item) for item in ORDER_FLOW_ENTROPY_REGIME_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_order_flow_count": self.observed_order_flow_count,
            "observed_price_count": self.observed_price_count,
            "transition_count": self.transition_count,
            "state_counts": dict(self.state_counts),
            "transition_counts": dict(self.transition_counts),
            "normalized_transition_entropy": _stable_float(
                self.normalized_transition_entropy
            ),
            "low_entropy_hidden_order_score": _stable_float(
                self.low_entropy_hidden_order_score
            ),
            "entropy_directionality_gap": _stable_float(
                self.entropy_directionality_gap
            ),
            "asymmetric_regime_persistence": _stable_float(
                self.asymmetric_regime_persistence
            ),
            "abrupt_regime_flip_share": _stable_float(self.abrupt_regime_flip_share),
            "multi_scale_regime_disagreement": _stable_float(
                self.multi_scale_regime_disagreement
            ),
            "volatility_intensity_gate": _stable_float(self.volatility_intensity_gate),
            "source_gap_score": _stable_float(self.source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "normalized_transition_entropy": _stable_float(
                    self.normalized_transition_entropy
                ),
                "low_entropy_hidden_order_score": _stable_float(
                    self.low_entropy_hidden_order_score
                ),
                "entropy_directionality_gap": _stable_float(
                    self.entropy_directionality_gap
                ),
                "asymmetric_regime_persistence": _stable_float(
                    self.asymmetric_regime_persistence
                ),
                "abrupt_regime_flip_share": _stable_float(
                    self.abrupt_regime_flip_share
                ),
                "multi_scale_regime_disagreement": _stable_float(
                    self.multi_scale_regime_disagreement
                ),
                "volatility_intensity_gate": _stable_float(
                    self.volatility_intensity_gate
                ),
                "source_gap_score": _stable_float(self.source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "order_flow_markov_transition_entropy_preview": True,
            "latent_hmm_regime_proxy_preview": True,
            "entropy_is_volatility_state_not_directional_alpha": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                ORDER_FLOW_ENTROPY_REGIME_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def order_flow_entropy_regime_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ORDER_FLOW_ENTROPY_REGIME_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ORDER_FLOW_ENTROPY_REGIME_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in ORDER_FLOW_ENTROPY_REGIME_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "order_flow_markov_entropy_asymmetric_hmm_regime_proxy",
        "stress_components": [
            "normalized_transition_entropy",
            "low_entropy_hidden_order_score",
            "entropy_directionality_gap",
            "asymmetric_regime_persistence",
            "abrupt_regime_flip_share",
            "multi_scale_regime_disagreement",
            "volatility_intensity_gate",
            "source_gap_score",
        ],
        "state_policy": "deterministic_sign_intensity_volatility_event_state_buckets",
        "input_fields": {
            "price": list(_PRICE_FIELDS),
            "order_flow": list(_OFI_FIELDS + _SIGNED_VOLUME_FIELDS + _SIDE_FIELDS),
            "volume": list(_VOLUME_FIELDS),
            "volatility": list(_VOLATILITY_FIELDS),
        },
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
            "rejects_entropy_as_directional_alpha_proof": True,
            "rejects_latent_regime_proxy_as_pnl_authority": True,
        },
    }


def build_order_flow_entropy_regime_stress_schema_hash() -> str:
    return _stable_hash(order_flow_entropy_regime_stress_contract())


def extract_order_flow_entropy_regime_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> OrderFlowEntropyRegimeStressSummary:
    """Extract deterministic OFI entropy / latent-regime stress.

    The returned payload is a replay-ranking feature only. Exact replay, route
    TCA, and runtime-ledger proof remain authoritative.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    prices = tuple(
        _positive_float(_first_payload_value(row.payload, _PRICE_FIELDS))
        for row in ordered
    )
    flows = tuple(_order_flow_value(row.payload) for row in ordered)
    volumes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _VOLUME_FIELDS))
        for row in ordered
    )
    returns_bps = _forward_returns_bps(prices)
    abs_returns = tuple(abs(item) for item in returns_bps)
    median_volume = _median([item for item in volumes if item > 0.0])
    median_abs_return = _median([item for item in abs_returns if item > 0.0])
    volatility_channels = tuple(
        _volatility_channel(row.payload, fallback_abs_return=abs_return)
        for row, abs_return in zip(ordered, abs_returns)
    )
    states = tuple(
        _state_bucket(
            row=row,
            flow=flow,
            volume=volume,
            median_volume=median_volume,
            abs_return=abs_return,
            median_abs_return=median_abs_return,
            volatility_channel=volatility_channel,
        )
        for row, flow, volume, abs_return, volatility_channel in zip(
            ordered, flows, volumes, abs_returns, volatility_channels
        )
    )
    transition_pairs = tuple(
        (left, right)
        for left, right in zip(states, states[1:])
        if left != "unknown" and right != "unknown"
    )
    state_counts = Counter(states)
    transition_counts = Counter(f"{left}->{right}" for left, right in transition_pairs)
    transition_count = len(transition_pairs)
    normalized_transition_entropy = _normalized_entropy(transition_counts)
    low_entropy_hidden_order_score = _low_entropy_hidden_order_score(
        normalized_transition_entropy=normalized_transition_entropy,
        abs_returns=abs_returns,
        volatility_channels=volatility_channels,
    )
    entropy_directionality_gap = _entropy_directionality_gap(
        flows=flows,
        returns_bps=returns_bps,
        low_entropy_hidden_order_score=low_entropy_hidden_order_score,
        direction=signed_direction,
    )
    asymmetric_regime_persistence = _asymmetric_regime_persistence(transition_pairs)
    abrupt_regime_flip_share = _abrupt_regime_flip_share(transition_pairs)
    multi_scale_regime_disagreement = _multi_scale_regime_disagreement(
        flows=flows,
        volumes=volumes,
        volatility_channels=volatility_channels,
    )
    volatility_intensity_gate = _volatility_intensity_gate(
        volumes=volumes,
        median_volume=median_volume,
        volatility_channels=volatility_channels,
    )

    observed_order_flow_count = sum(1 for item in flows if item is not None)
    observed_price_count = sum(1 for item in prices if item is not None)
    warnings: list[str] = []
    if len(ordered) < 4:
        warnings.append("insufficient_order_flow_entropy_rows")
    if observed_order_flow_count < max(2, len(ordered) // 2):
        warnings.append("missing_order_flow_entropy_inputs")
    if observed_price_count < max(2, len(ordered) // 2):
        warnings.append("missing_price_path_for_entropy_directionality")
    if transition_count < 2:
        warnings.append("insufficient_order_flow_entropy_transitions")
    if low_entropy_hidden_order_score > 0.25:
        warnings.append("low_entropy_hidden_order_volatility_state_not_direction")
    if entropy_directionality_gap > 0.20:
        warnings.append("entropy_directionality_gap_requires_exact_replay")

    source_gap_score = min(
        1.0,
        (1.0 - (observed_order_flow_count / len(ordered)) if ordered else 1.0) * 0.65
        + (1.0 - (observed_price_count / len(ordered)) if ordered else 1.0) * 0.35,
    )
    missing_penalty_bps = 4.0 * len(warnings)
    replay_rank_penalty_bps = (
        low_entropy_hidden_order_score * 13.0
        + entropy_directionality_gap * 10.0
        + asymmetric_regime_persistence * 4.0
        + abrupt_regime_flip_share * 8.0
        + multi_scale_regime_disagreement * 9.0
        + volatility_intensity_gate * 5.0
        + source_gap_score * 14.0
        + missing_penalty_bps
    )
    return OrderFlowEntropyRegimeStressSummary(
        row_count=len(ordered),
        observed_order_flow_count=observed_order_flow_count,
        observed_price_count=observed_price_count,
        transition_count=transition_count,
        state_counts=dict(sorted(state_counts.items())),
        transition_counts=dict(sorted(transition_counts.items())),
        normalized_transition_entropy=normalized_transition_entropy,
        low_entropy_hidden_order_score=low_entropy_hidden_order_score,
        entropy_directionality_gap=entropy_directionality_gap,
        asymmetric_regime_persistence=asymmetric_regime_persistence,
        abrupt_regime_flip_share=abrupt_regime_flip_share,
        multi_scale_regime_disagreement=multi_scale_regime_disagreement,
        volatility_intensity_gate=volatility_intensity_gate,
        source_gap_score=source_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_order_flow_entropy_regime_stress_schema_hash(),
    )


def _order_flow_value(payload: Mapping[str, Any]) -> float | None:
    signed = _float_or_none(_first_payload_value(payload, _SIGNED_VOLUME_FIELDS))
    volume = _nonnegative_float(_first_payload_value(payload, _VOLUME_FIELDS))
    if signed is not None and volume > 0.0:
        return _clamp(signed / max(volume, abs(signed), 1.0), -1.0, 1.0)
    ofi = _float_or_none(_first_payload_value(payload, _OFI_FIELDS))
    if ofi is not None:
        return _clamp(ofi, -1.0, 1.0)
    side = str(_first_payload_value(payload, _SIDE_FIELDS) or "").strip().lower()
    if side in _BUY_TOKENS:
        return 1.0
    if side in _SELL_TOKENS:
        return -1.0
    return None


def _state_bucket(
    *,
    row: SignalEnvelope,
    flow: float | None,
    volume: float,
    median_volume: float,
    abs_return: float,
    median_abs_return: float,
    volatility_channel: float,
) -> str:
    if flow is None:
        return "unknown"
    sign_bucket = "neutral"
    if flow >= 0.20:
        sign_bucket = "buy"
    elif flow <= -0.20:
        sign_bucket = "sell"
    intensity_bucket = "normal"
    if median_volume > 0.0:
        if volume >= median_volume * 1.75:
            intensity_bucket = "high"
        elif 0.0 < volume <= median_volume * 0.50:
            intensity_bucket = "low"
    volatility_bucket = (
        "volatile"
        if max(abs_return, volatility_channel) >= max(5.0, median_abs_return * 1.75)
        else "calm"
    )
    event_bucket = _event_bucket(row.payload)
    return f"{sign_bucket}_{intensity_bucket}_{volatility_bucket}_{event_bucket}"


def _event_bucket(payload: Mapping[str, Any]) -> str:
    raw = str(_first_payload_value(payload, _EVENT_FIELDS) or "").strip().lower()
    if any(token in raw for token in ("cancel", "delete", "remove")):
        return "cancel"
    if any(token in raw for token in ("add", "new", "quote", "limit")):
        return "add"
    if any(token in raw for token in ("trade", "fill", "execution")):
        return "trade"
    return "event"


def _forward_returns_bps(prices: Sequence[float | None]) -> tuple[float, ...]:
    returns: list[float] = []
    previous: float | None = None
    for price in prices:
        if price is None or previous is None or previous <= 0.0:
            returns.append(0.0)
        else:
            returns.append(((price - previous) / previous) * 10_000.0)
        if price is not None and price > 0.0:
            previous = price
    return tuple(returns)


def _low_entropy_hidden_order_score(
    *,
    normalized_transition_entropy: float,
    abs_returns: Sequence[float],
    volatility_channels: Sequence[float],
) -> float:
    high_move_share = _share(
        value >= max(5.0, _median([item for item in abs_returns if item > 0.0]) * 1.5)
        for value in abs_returns
    )
    explicit_vol_share = _share(value >= 5.0 for value in volatility_channels)
    return _clamp(
        (1.0 - normalized_transition_entropy)
        * max(high_move_share, explicit_vol_share),
        0.0,
        1.0,
    )


def _entropy_directionality_gap(
    *,
    flows: Sequence[float | None],
    returns_bps: Sequence[float],
    low_entropy_hidden_order_score: float,
    direction: float,
) -> float:
    observations: list[bool] = []
    for flow, ret in zip(flows, returns_bps):
        if flow is None or ret == 0.0:
            continue
        observations.append((flow * direction) * ret > 0.0)
    if len(observations) < 2:
        return low_entropy_hidden_order_score
    directional_accuracy = sum(1 for item in observations if item) / len(observations)
    return _clamp(
        low_entropy_hidden_order_score * max(0.0, 0.58 - directional_accuracy) / 0.58,
        0.0,
        1.0,
    )


def _asymmetric_regime_persistence(
    transition_pairs: Sequence[tuple[str, str]],
) -> float:
    buy_pairs = [pair for pair in transition_pairs if pair[0].startswith("buy")]
    sell_pairs = [pair for pair in transition_pairs if pair[0].startswith("sell")]
    buy_persistence = _share(right.startswith("buy") for _, right in buy_pairs)
    sell_persistence = _share(right.startswith("sell") for _, right in sell_pairs)
    if not buy_pairs and not sell_pairs:
        return 0.0
    return _clamp(abs(buy_persistence - sell_persistence), 0.0, 1.0)


def _abrupt_regime_flip_share(transition_pairs: Sequence[tuple[str, str]]) -> float:
    return _share(
        (left.startswith("buy") and right.startswith("sell"))
        or (left.startswith("sell") and right.startswith("buy"))
        for left, right in transition_pairs
    )


def _multi_scale_regime_disagreement(
    *,
    flows: Sequence[float | None],
    volumes: Sequence[float],
    volatility_channels: Sequence[float],
) -> float:
    observed = [value for value in flows if value is not None]
    if len(observed) < 4:
        return 0.0
    long_mean = sum(observed) / len(observed)
    window = max(2, min(6, len(observed) // 3))
    short_mean = sum(observed[-window:]) / window
    sign_disagreement = 1.0 if long_mean * short_mean < 0.0 else 0.0
    magnitude_gap = _clamp(abs(short_mean - long_mean), 0.0, 1.0)
    intensity_gate = _volatility_intensity_gate(
        volumes=volumes,
        median_volume=_median([item for item in volumes if item > 0.0]),
        volatility_channels=volatility_channels,
    )
    return _clamp(
        (sign_disagreement * 0.6 + magnitude_gap * 0.4) * max(0.25, intensity_gate),
        0.0,
        1.0,
    )


def _volatility_intensity_gate(
    *,
    volumes: Sequence[float],
    median_volume: float,
    volatility_channels: Sequence[float],
) -> float:
    if not volumes and not volatility_channels:
        return 0.0
    high_volume_share = (
        _share(value >= median_volume * 1.75 for value in volumes)
        if median_volume > 0.0
        else 0.0
    )
    high_vol_share = _share(value >= 5.0 for value in volatility_channels)
    return _clamp(high_volume_share * 0.45 + high_vol_share * 0.55, 0.0, 1.0)


def _volatility_channel(
    payload: Mapping[str, Any], *, fallback_abs_return: float
) -> float:
    explicit = _nonnegative_float(_first_payload_value(payload, _VOLATILITY_FIELDS))
    return max(explicit, fallback_abs_return)


def _normalized_entropy(counts: Counter[str]) -> float:
    total = sum(counts.values())
    if total <= 0 or len(counts) <= 1:
        return 0.0
    entropy = 0.0
    for count in counts.values():
        probability = count / total
        entropy -= probability * log2(probability)
    return _clamp(entropy / log2(len(counts)), 0.0, 1.0)


def _first_payload_value(payload: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        value = payload.get(key)
        if value is not None:
            return value
    return None


def _positive_float(value: Any) -> float | None:
    parsed = _float_or_none(value)
    if parsed is None or parsed <= 0.0:
        return None
    return parsed


def _nonnegative_float(value: Any) -> float:
    parsed = _float_or_none(value)
    if parsed is None:
        return 0.0
    return max(0.0, parsed)


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _share(values: Sequence[bool] | Any) -> float:
    materialized = tuple(values)
    if not materialized:
        return 0.0
    return sum(1 for item in materialized if item) / len(materialized)


def _clamp(value: float, lower: float, upper: float) -> float:
    if value < lower:
        return lower
    if value > upper:
        return upper
    return value


def _stable_float(value: float, *, digits: int = 6) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), digits)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


__all__ = [
    "ORDER_FLOW_ENTROPY_REGIME_STRESS_PRIMARY_SOURCES",
    "ORDER_FLOW_ENTROPY_REGIME_STRESS_PROOF_SEMANTICS_LABEL",
    "ORDER_FLOW_ENTROPY_REGIME_STRESS_SCHEMA_VERSION",
    "OrderFlowEntropyRegimeStressSummary",
    "build_order_flow_entropy_regime_stress_schema_hash",
    "extract_order_flow_entropy_regime_stress",
    "order_flow_entropy_regime_stress_contract",
]

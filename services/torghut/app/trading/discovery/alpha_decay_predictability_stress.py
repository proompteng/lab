"""Preview-only alpha-decay predictability stress for replay candidate ranking.

This module converts recent high-frequency LOB alpha-decay and short-run market
efficiency papers into deterministic replay-ranking inputs. It never simulates
fills, writes ledgers, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope

ALPHA_DECAY_PREDICTABILITY_STRESS_SCHEMA_VERSION = (
    "torghut.alpha-decay-predictability-stress.v1"
)
ALPHA_DECAY_PREDICTABILITY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.alpha-decay-predictability-stress-contract.v1"
)
ALPHA_DECAY_PREDICTABILITY_STRESS_PROOF_SEMANTICS_LABEL = (
    "alpha_decay_predictability_stress_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
ALPHA_DECAY_PREDICTABILITY_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2601.02310",
        "url": "https://arxiv.org/abs/2601.02310",
        "title": "Temporal Kolmogorov-Arnold Networks (T-KAN) for High-Frequency Limit Order Book Forecasting: Efficiency, Interpretability, and Alpha Decay",
        "date": "2026-01-05",
        "mechanism": "multi_horizon_lob_alpha_decay_curve_with_spread_adjusted_cost_crossover",
    },
    {
        "source_id": "ssrn-6608199",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6608199",
        "title": "Learning from the Book: AI Evidence on Short-Run Market Efficiency",
        "date": "2026-05-01",
        "mechanism": "tight_spread_heavy_trading_algorithmic_activity_predictability_compression",
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
_ALGO_ACTIVITY_FIELDS = (
    "algo_activity_score",
    "algorithmic_activity_score",
    "hft_activity_score",
    "message_to_trade_ratio",
    "quote_update_rate",
    "order_update_rate",
)
_INFERENCE_LATENCY_MS_FIELDS = (
    "model_inference_latency_ms",
    "inference_latency_ms",
    "feature_latency_ms",
    "decision_latency_ms",
)
_DEFAULT_HORIZON_STEPS = (1, 2, 3, 5, 8)
_MIN_OBSERVED_HORIZON_COUNT = 2


@dataclass(frozen=True)
class AlphaDecayPredictabilityStressSummary:
    row_count: int
    observed_price_count: int
    observed_spread_count: int
    observed_volume_count: int
    observed_horizon_count: int
    horizon_observation_count: int
    horizon_curve: tuple[Mapping[str, Any], ...]
    first_horizon_steps: int
    best_horizon_steps: int
    first_horizon_spread_adjusted_net_bps: float
    longest_horizon_spread_adjusted_net_bps: float
    best_horizon_spread_adjusted_net_bps: float
    net_positive_horizon_share: float
    alpha_decay_bps: float
    cost_crossover_share: float
    tight_spread_heavy_volume_share: float
    algorithmic_activity_intensity: float
    inference_latency_ms: float
    latency_horizon_mismatch_share: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": ALPHA_DECAY_PREDICTABILITY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_alpha_decay_predictability_ranking",
            "source_papers": [
                dict(item) for item in ALPHA_DECAY_PREDICTABILITY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_price_count": self.observed_price_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_volume_count": self.observed_volume_count,
            "observed_horizon_count": self.observed_horizon_count,
            "horizon_observation_count": self.horizon_observation_count,
            "horizon_curve": [dict(item) for item in self.horizon_curve],
            "first_horizon_steps": self.first_horizon_steps,
            "best_horizon_steps": self.best_horizon_steps,
            "first_horizon_spread_adjusted_net_bps": _stable_float(
                self.first_horizon_spread_adjusted_net_bps
            ),
            "longest_horizon_spread_adjusted_net_bps": _stable_float(
                self.longest_horizon_spread_adjusted_net_bps
            ),
            "best_horizon_spread_adjusted_net_bps": _stable_float(
                self.best_horizon_spread_adjusted_net_bps
            ),
            "net_positive_horizon_share": _stable_float(
                self.net_positive_horizon_share
            ),
            "alpha_decay_bps": _stable_float(self.alpha_decay_bps),
            "cost_crossover_share": _stable_float(self.cost_crossover_share),
            "tight_spread_heavy_volume_share": _stable_float(
                self.tight_spread_heavy_volume_share
            ),
            "algorithmic_activity_intensity": _stable_float(
                self.algorithmic_activity_intensity
            ),
            "inference_latency_ms": _stable_float(self.inference_latency_ms),
            "latency_horizon_mismatch_share": _stable_float(
                self.latency_horizon_mismatch_share
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "observed_horizon_count": self.observed_horizon_count,
                "best_horizon_steps": self.best_horizon_steps,
                "first_horizon_spread_adjusted_net_bps": _stable_float(
                    self.first_horizon_spread_adjusted_net_bps
                ),
                "longest_horizon_spread_adjusted_net_bps": _stable_float(
                    self.longest_horizon_spread_adjusted_net_bps
                ),
                "best_horizon_spread_adjusted_net_bps": _stable_float(
                    self.best_horizon_spread_adjusted_net_bps
                ),
                "net_positive_horizon_share": _stable_float(
                    self.net_positive_horizon_share
                ),
                "alpha_decay_bps": _stable_float(self.alpha_decay_bps),
                "cost_crossover_share": _stable_float(self.cost_crossover_share),
                "tight_spread_heavy_volume_share": _stable_float(
                    self.tight_spread_heavy_volume_share
                ),
                "algorithmic_activity_intensity": _stable_float(
                    self.algorithmic_activity_intensity
                ),
                "latency_horizon_mismatch_share": _stable_float(
                    self.latency_horizon_mismatch_share
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "multi_horizon_alpha_decay_preview": True,
            "spread_adjusted_label_preview": True,
            "efficiency_regime_compression_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                ALPHA_DECAY_PREDICTABILITY_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def alpha_decay_predictability_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ALPHA_DECAY_PREDICTABILITY_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ALPHA_DECAY_PREDICTABILITY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in ALPHA_DECAY_PREDICTABILITY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "multi_horizon_alpha_decay_spread_adjusted_efficiency_regime_stress",
        "stress_components": [
            "horizon_curve",
            "alpha_decay_bps",
            "cost_crossover_share",
            "tight_spread_heavy_volume_share",
            "algorithmic_activity_intensity",
            "latency_horizon_mismatch_share",
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
            "rejects_single_horizon_lob_alpha_promotion": True,
            "rejects_classification_accuracy_without_costs": True,
            "rejects_preview_decay_curve_as_profit_proof": True,
        },
    }


def build_alpha_decay_predictability_stress_schema_hash() -> str:
    return _stable_hash(alpha_decay_predictability_stress_contract())


def extract_alpha_decay_predictability_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    horizon_steps: Sequence[int] = _DEFAULT_HORIZON_STEPS,
) -> AlphaDecayPredictabilityStressSummary:
    """Extract deterministic multi-horizon alpha-decay stress from replay rows."""

    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    horizons = tuple(sorted({int(value) for value in horizon_steps if int(value) > 0}))
    rows_by_symbol = _rows_by_symbol(records)
    prices = tuple(
        price
        for rows in rows_by_symbol.values()
        for row in rows
        if (price := _price(row)) is not None
    )
    spreads = tuple(
        spread
        for rows in rows_by_symbol.values()
        for row in rows
        if (spread := _spread_bps(row)) is not None
    )
    volumes = tuple(
        volume
        for rows in rows_by_symbol.values()
        for row in rows
        if (volume := _volume(row)) is not None
    )
    median_spread = median(spreads) if spreads else 0.0
    median_volume = median(volumes) if volumes else 0.0

    horizon_curve: list[Mapping[str, Any]] = []
    for horizon in horizons:
        observations = _horizon_observations(
            rows_by_symbol.values(), horizon=horizon, direction=signed_direction
        )
        if not observations:
            continue
        spread_adjusted = tuple(item[1] for item in observations)
        signed_returns = tuple(item[0] for item in observations)
        horizon_curve.append(
            {
                "horizon_steps": horizon,
                "observation_count": len(observations),
                "median_signed_return_bps": _stable_float(median(signed_returns)),
                "median_spread_adjusted_net_bps": _stable_float(
                    median(spread_adjusted)
                ),
                "net_positive_share": _stable_float(
                    sum(1 for value in spread_adjusted if value > 0.0)
                    / max(1, len(spread_adjusted))
                ),
            }
        )

    observed_horizon_count = len(horizon_curve)
    horizon_observation_count = sum(
        int(item.get("observation_count") or 0) for item in horizon_curve
    )
    net_values = tuple(
        float(item["median_spread_adjusted_net_bps"]) for item in horizon_curve
    )
    first_horizon_steps = int(horizon_curve[0]["horizon_steps"]) if horizon_curve else 0
    first_net = net_values[0] if net_values else 0.0
    longest_net = net_values[-1] if net_values else 0.0
    best_index = _best_index(net_values)
    best_horizon_steps = (
        int(horizon_curve[best_index]["horizon_steps"]) if horizon_curve else 0
    )
    best_net = net_values[best_index] if net_values else 0.0
    alpha_decay_bps = max(0.0, best_net - longest_net)
    cost_crossover_share = sum(1 for value in net_values if value <= 0.0) / max(
        1, len(net_values)
    )
    net_positive_horizon_share = sum(1 for value in net_values if value > 0.0) / max(
        1, len(net_values)
    )
    tight_heavy_share = _tight_spread_heavy_volume_share(
        rows_by_symbol.values(),
        median_spread=median_spread,
        median_volume=median_volume,
    )
    algorithmic_activity_intensity = _algorithmic_activity_intensity(
        row for rows in rows_by_symbol.values() for row in rows
    )
    inference_latency_ms = _median_latency_ms(
        row for rows in rows_by_symbol.values() for row in rows
    )
    latency_mismatch_share = _latency_horizon_mismatch_share(
        rows_by_symbol.values(),
        inference_latency_ms=inference_latency_ms,
        best_horizon_steps=best_horizon_steps,
    )

    replay_rank_penalty_bps = (
        alpha_decay_bps * 0.40
        + cost_crossover_share * 5.0
        + max(0.0, -longest_net) * 0.35
        + tight_heavy_share * 2.0
        + algorithmic_activity_intensity * 2.0
        + latency_mismatch_share * 3.0
    )
    if observed_horizon_count < _MIN_OBSERVED_HORIZON_COUNT:
        replay_rank_penalty_bps += 4.0

    warnings: list[str] = []
    if not prices:
        warnings.append("missing_price_inputs")
    if not spreads:
        warnings.append("missing_spread_inputs")
    if not volumes:
        warnings.append("missing_volume_inputs")
    if observed_horizon_count < _MIN_OBSERVED_HORIZON_COUNT:
        warnings.append("insufficient_multi_horizon_alpha_decay_curve")

    return AlphaDecayPredictabilityStressSummary(
        row_count=sum(len(rows) for rows in rows_by_symbol.values()),
        observed_price_count=len(prices),
        observed_spread_count=len(spreads),
        observed_volume_count=len(volumes),
        observed_horizon_count=observed_horizon_count,
        horizon_observation_count=horizon_observation_count,
        horizon_curve=tuple(horizon_curve),
        first_horizon_steps=first_horizon_steps,
        best_horizon_steps=best_horizon_steps,
        first_horizon_spread_adjusted_net_bps=first_net,
        longest_horizon_spread_adjusted_net_bps=longest_net,
        best_horizon_spread_adjusted_net_bps=best_net,
        net_positive_horizon_share=net_positive_horizon_share,
        alpha_decay_bps=alpha_decay_bps,
        cost_crossover_share=cost_crossover_share,
        tight_spread_heavy_volume_share=tight_heavy_share,
        algorithmic_activity_intensity=algorithmic_activity_intensity,
        inference_latency_ms=inference_latency_ms,
        latency_horizon_mismatch_share=latency_mismatch_share,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(warnings),
        feature_schema_hash=build_alpha_decay_predictability_stress_schema_hash(),
    )


def _rows_by_symbol(
    records: Sequence[SignalEnvelope],
) -> dict[str, tuple[SignalEnvelope, ...]]:
    grouped: dict[str, list[SignalEnvelope]] = {}
    for row in records:
        grouped.setdefault(row.symbol, []).append(row)
    return {
        symbol: tuple(sorted(rows, key=lambda item: (item.event_ts, item.seq)))
        for symbol, rows in grouped.items()
    }


def _horizon_observations(
    grouped_rows: Iterable[Sequence[SignalEnvelope]], *, horizon: int, direction: float
) -> tuple[tuple[float, float], ...]:
    observations: list[tuple[float, float]] = []
    for rows in grouped_rows:
        for index, row in enumerate(rows[:-horizon]):
            current = _price(row)
            future = _price(rows[index + horizon])
            if current is None or future is None or current <= 0.0:
                continue
            signed_return_bps = direction * ((future - current) / current) * 10_000.0
            spread_adjusted = signed_return_bps - (_spread_bps(row) or 0.0)
            observations.append((signed_return_bps, spread_adjusted))
    return tuple(observations)


def _payload(row: SignalEnvelope) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], row.payload)


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if isfinite(parsed) else None


def _first_number(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = _number(payload.get(field))
        if value is not None:
            return value
    return None


def _price(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    price = _first_number(payload, _PRICE_FIELDS)
    if price is not None and price > 0.0:
        return price
    bid = _first_number(payload, _BID_FIELDS)
    ask = _first_number(payload, _ASK_FIELDS)
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def _spread_bps(row: SignalEnvelope) -> float | None:
    payload = _payload(row)
    explicit = _first_number(payload, _SPREAD_BPS_FIELDS)
    if explicit is not None:
        return max(0.0, explicit)
    bid = _first_number(payload, _BID_FIELDS)
    ask = _first_number(payload, _ASK_FIELDS)
    if bid is None or ask is None or bid <= 0.0 or ask <= bid:
        return None
    mid = (bid + ask) / 2.0
    return ((ask - bid) / mid) * 10_000.0 if mid > 0.0 else None


def _volume(row: SignalEnvelope) -> float | None:
    return _first_number(_payload(row), _VOLUME_FIELDS)


def _algo_activity(row: SignalEnvelope) -> float | None:
    value = _first_number(_payload(row), _ALGO_ACTIVITY_FIELDS)
    if value is None:
        return None
    if value > 1.0:
        return min(1.0, value / 100.0)
    return max(0.0, min(1.0, value))


def _inference_latency_ms(row: SignalEnvelope) -> float | None:
    value = _first_number(_payload(row), _INFERENCE_LATENCY_MS_FIELDS)
    return max(0.0, value) if value is not None else None


def _tight_spread_heavy_volume_share(
    grouped_rows: Iterable[Sequence[SignalEnvelope]],
    *,
    median_spread: float,
    median_volume: float,
) -> float:
    observations = 0
    hits = 0
    for rows in grouped_rows:
        for row in rows:
            spread = _spread_bps(row)
            volume = _volume(row)
            if spread is None or volume is None:
                continue
            observations += 1
            if spread <= median_spread and volume >= median_volume:
                hits += 1
    return hits / max(1, observations)


def _algorithmic_activity_intensity(rows: Iterable[SignalEnvelope]) -> float:
    values = tuple(value for row in rows if (value := _algo_activity(row)) is not None)
    return median(values) if values else 0.0


def _median_latency_ms(rows: Iterable[SignalEnvelope]) -> float:
    values = tuple(
        value for row in rows if (value := _inference_latency_ms(row)) is not None
    )
    return median(values) if values else 0.0


def _latency_horizon_mismatch_share(
    grouped_rows: Iterable[Sequence[SignalEnvelope]],
    *,
    inference_latency_ms: float,
    best_horizon_steps: int,
) -> float:
    if inference_latency_ms <= 0.0 or best_horizon_steps <= 0:
        return 0.0
    observations = 0
    mismatches = 0
    for rows in grouped_rows:
        if len(rows) < 2:
            continue
        deltas = [
            max(
                0.0,
                (rows[index + 1].event_ts - rows[index].event_ts).total_seconds()
                * 1000.0,
            )
            for index in range(len(rows) - 1)
        ]
        if not deltas:
            continue
        estimated_horizon_ms = median(deltas) * best_horizon_steps
        observations += 1
        if estimated_horizon_ms > 0.0 and inference_latency_ms > estimated_horizon_ms:
            mismatches += 1
    return mismatches / max(1, observations)


def _best_index(values: Sequence[float]) -> int:
    if not values:
        return 0
    best = 0
    for index, value in enumerate(values):
        if value > values[best]:
            best = index
    return best


def _stable_float(value: float) -> float:
    return round(float(value), 8) if isfinite(float(value)) else 0.0


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

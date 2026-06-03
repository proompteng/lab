"""Preview-only nonlinear impact execution stress for replay candidate ranking.

This module converts recent market-impact and execution-realism papers into
deterministic replay-ranking inputs. It never simulates fills, writes ledgers,
authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, sqrt
from statistics import median
from typing import Any, Callable, cast

from app.trading.models import SignalEnvelope

NONLINEAR_IMPACT_EXECUTION_STRESS_SCHEMA_VERSION = (
    "torghut.nonlinear-impact-execution-stress.v1"
)
NONLINEAR_IMPACT_EXECUTION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.nonlinear-impact-execution-stress-contract.v1"
)
NONLINEAR_IMPACT_EXECUTION_STRESS_PROOF_SEMANTICS_LABEL = (
    "nonlinear_impact_execution_stress_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
NONLINEAR_IMPACT_EXECUTION_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2603.29086",
        "url": "https://arxiv.org/abs/2603.29086",
        "title": "Realistic Market Impact Modeling for Reinforcement Learning Trading Environments",
        "date": "2026-04-04",
        "mechanism": "nonlinear_market_impact_cost_model_with_permanent_impact_decay_and_trade_level_logging",
    },
    {
        "source_id": "arxiv-2502.16246",
        "url": "https://arxiv.org/abs/2502.16246",
        "title": 'The "double" square-root law: Evidence for the mechanical origin of market impact using Tokyo Stock Exchange data',
        "date": "2025-08-04",
        "mechanism": "child_order_square_root_impact_with_inverse_square_root_time_decay",
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_VOLUME_FIELDS = (
    "microbar_volume",
    "bar_volume",
    "trade_volume",
    "volume",
    "trade_size",
    "trade_qty",
    "qty",
    "size",
)
_NOTIONAL_FIELDS = (
    "microbar_notional",
    "bar_notional",
    "trade_notional",
    "dollar_volume",
    "notional",
)
_EXECUTION_NOTIONAL_FIELDS = (
    "target_implied_notional",
    "candidate_notional",
    "max_notional",
    "order_notional",
)
_IMPACT_DECAY_FIELDS = (
    "impact_decay_half_life_events",
    "permanent_impact_decay_half_life_events",
    "market_impact_decay_half_life_events",
)
_DEFAULT_DECAY_HALF_LIFE_EVENTS = 8.0
_IMPACT_SCALE_BPS = 12.0
_HIGH_PARTICIPATION_RATE = 0.10
_EXTREME_PARTICIPATION_RATE = 0.25


@dataclass(frozen=True)
class NonlinearImpactExecutionStressSummary:
    row_count: int
    observed_price_count: int
    observed_volume_count: int
    observed_notional_count: int
    max_notional: float
    child_order_count: int
    child_notional: float
    median_event_notional: float
    median_participation_rate: float
    p90_participation_rate: float
    high_participation_share: float
    extreme_participation_share: float
    square_root_impact_cost_bps: float
    linear_cost_bps: float
    nonlinear_cost_uplift_bps: float
    permanent_impact_residual_bps: float
    impact_decay_shortfall_bps: float
    adverse_decay_reversal_share: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": NONLINEAR_IMPACT_EXECUTION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_nonlinear_impact_execution_stress_ranking",
            "source_papers": [
                dict(item) for item in NONLINEAR_IMPACT_EXECUTION_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_price_count": self.observed_price_count,
            "observed_volume_count": self.observed_volume_count,
            "observed_notional_count": self.observed_notional_count,
            "max_notional": _stable_float(self.max_notional),
            "child_order_count": self.child_order_count,
            "child_notional": _stable_float(self.child_notional),
            "median_event_notional": _stable_float(self.median_event_notional),
            "median_participation_rate": _stable_float(self.median_participation_rate),
            "p90_participation_rate": _stable_float(self.p90_participation_rate),
            "high_participation_share": _stable_float(self.high_participation_share),
            "extreme_participation_share": _stable_float(
                self.extreme_participation_share
            ),
            "square_root_impact_cost_bps": _stable_float(
                self.square_root_impact_cost_bps
            ),
            "linear_cost_bps": _stable_float(self.linear_cost_bps),
            "nonlinear_cost_uplift_bps": _stable_float(self.nonlinear_cost_uplift_bps),
            "permanent_impact_residual_bps": _stable_float(
                self.permanent_impact_residual_bps
            ),
            "impact_decay_shortfall_bps": _stable_float(
                self.impact_decay_shortfall_bps
            ),
            "adverse_decay_reversal_share": _stable_float(
                self.adverse_decay_reversal_share
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "median_participation_rate": _stable_float(
                    self.median_participation_rate
                ),
                "p90_participation_rate": _stable_float(self.p90_participation_rate),
                "high_participation_share": _stable_float(
                    self.high_participation_share
                ),
                "extreme_participation_share": _stable_float(
                    self.extreme_participation_share
                ),
                "square_root_impact_cost_bps": _stable_float(
                    self.square_root_impact_cost_bps
                ),
                "linear_cost_bps": _stable_float(self.linear_cost_bps),
                "nonlinear_cost_uplift_bps": _stable_float(
                    self.nonlinear_cost_uplift_bps
                ),
                "permanent_impact_residual_bps": _stable_float(
                    self.permanent_impact_residual_bps
                ),
                "impact_decay_shortfall_bps": _stable_float(
                    self.impact_decay_shortfall_bps
                ),
                "adverse_decay_reversal_share": _stable_float(
                    self.adverse_decay_reversal_share
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "square_root_market_impact_preview": True,
            "permanent_impact_decay_preview": True,
            "participation_rate_capacity_preview": True,
            "trade_level_logging_required_downstream": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                NONLINEAR_IMPACT_EXECUTION_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def nonlinear_impact_execution_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": NONLINEAR_IMPACT_EXECUTION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": NONLINEAR_IMPACT_EXECUTION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in NONLINEAR_IMPACT_EXECUTION_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "nonlinear_market_impact_participation_and_permanent_decay_stress",
        "stress_components": [
            "square_root_impact_cost_bps",
            "participation_rate_tail",
            "nonlinear_cost_uplift_bps",
            "permanent_impact_residual_bps",
            "impact_decay_shortfall_bps",
            "adverse_decay_reversal_share",
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
            "requires_trade_level_logging": True,
            "rejects_model_cost_as_realized_pnl_authority": True,
            "rejects_synthetic_fill_authority": True,
        },
    }


def build_nonlinear_impact_execution_stress_schema_hash() -> str:
    return _stable_hash(nonlinear_impact_execution_stress_contract())


def extract_nonlinear_impact_execution_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    max_notional: int | float = 0,
) -> NonlinearImpactExecutionStressSummary:
    """Extract deterministic nonlinear impact execution stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    observed_prices: list[float] = []
    event_notional_values: list[float] = []
    spread_values: list[float] = []
    decay_half_life_values: list[float] = []
    returns_bps: list[float] = []
    previous_price: float | None = None

    for row in ordered:
        price = _extract_price(row)
        if price is not None:
            observed_prices.append(price)
            if previous_price is not None and previous_price > 0.0:
                returns_bps.append((price - previous_price) / previous_price * 10_000.0)
            previous_price = price
        event_notional = _extract_event_notional(row, price=price)
        if event_notional is not None:
            event_notional_values.append(event_notional)
        spread_bps = _first_float(row.payload, _SPREAD_BPS_FIELDS)
        if spread_bps is not None:
            spread_values.append(max(0.0, spread_bps))
        decay_half_life = _first_float(row.payload, _IMPACT_DECAY_FIELDS, positive=True)
        if decay_half_life is not None:
            decay_half_life_values.append(decay_half_life)

    inferred_max_notional = _first_payload_float(ordered, _EXECUTION_NOTIONAL_FIELDS)
    candidate_notional = _float_or_none(max_notional) or 0.0
    candidate_notional = max(0.0, candidate_notional)
    if candidate_notional <= 0.0 and inferred_max_notional is not None:
        candidate_notional = inferred_max_notional

    child_order_count = min(max(1, len(event_notional_values)), 20)
    child_notional = (
        candidate_notional / child_order_count if candidate_notional > 0.0 else 0.0
    )
    if child_notional <= 0.0 and event_notional_values:
        child_notional = median(event_notional_values) * 0.02

    participation_rates = tuple(
        min(1.0, child_notional / event_notional)
        for event_notional in event_notional_values
        if event_notional > 0.0 and child_notional > 0.0
    )
    median_participation_rate = (
        median(participation_rates) if participation_rates else 0.0
    )
    p90_participation_rate = _percentile(participation_rates, 90.0)
    high_participation_share = _share(
        participation_rates, lambda item: item >= _HIGH_PARTICIPATION_RATE
    )
    extreme_participation_share = _share(
        participation_rates, lambda item: item >= _EXTREME_PARTICIPATION_RATE
    )
    median_spread_bps = median(spread_values) if spread_values else 0.0
    volatility_bps = _percentile(tuple(abs(item) for item in returns_bps), 75.0)
    impact_scale_bps = max(_IMPACT_SCALE_BPS, median_spread_bps + volatility_bps)
    square_root_costs = tuple(
        impact_scale_bps * sqrt(max(0.0, rate)) for rate in participation_rates
    )
    linear_costs = tuple(
        impact_scale_bps * max(0.0, rate) for rate in participation_rates
    )
    square_root_impact_cost_bps = (
        _weighted_average(square_root_costs) if square_root_costs else 0.0
    )
    linear_cost_bps = _weighted_average(linear_costs) if linear_costs else 0.0
    nonlinear_cost_uplift_bps = max(0.0, square_root_impact_cost_bps - linear_cost_bps)

    half_life_events = (
        median(decay_half_life_values)
        if decay_half_life_values
        else _DEFAULT_DECAY_HALF_LIFE_EVENTS
    )
    decay_rate = 0.5 ** (1.0 / max(1.0, half_life_events))
    impact_memory = 0.0
    memory_values: list[float] = []
    adverse_reversal_count = 0
    reversal_observation_count = 0
    for index, impact_cost in enumerate(square_root_costs):
        impact_memory = impact_memory * decay_rate + signed_direction * impact_cost
        memory_values.append(abs(impact_memory))
        if index < len(returns_bps):
            reversal_observation_count += 1
            if returns_bps[index] * signed_direction < 0.0 and abs(impact_memory) > 0.0:
                adverse_reversal_count += 1

    permanent_impact_residual_bps = (
        _percentile(tuple(memory_values), 75.0) if memory_values else 0.0
    )
    impact_decay_shortfall_bps = max(
        0.0, permanent_impact_residual_bps - square_root_impact_cost_bps
    )
    adverse_decay_reversal_share = (
        adverse_reversal_count / reversal_observation_count
        if reversal_observation_count
        else 0.0
    )
    replay_rank_penalty_bps = max(
        0.0,
        square_root_impact_cost_bps * 0.65
        + nonlinear_cost_uplift_bps * 0.80
        + permanent_impact_residual_bps * 0.25
        + impact_decay_shortfall_bps * 0.35
        + high_participation_share * 10.0
        + extreme_participation_share * 18.0
        + adverse_decay_reversal_share * 7.0,
    )
    warnings: list[str] = []
    if not observed_prices:
        warnings.append("missing_price_fields")
    if not event_notional_values:
        warnings.append("missing_event_notional_or_volume_fields")
    if candidate_notional <= 0.0:
        warnings.append("candidate_notional_missing_used_tape_proxy")
    if not spread_values:
        warnings.append("missing_spread_fields")

    return NonlinearImpactExecutionStressSummary(
        row_count=len(ordered),
        observed_price_count=len(observed_prices),
        observed_volume_count=len(event_notional_values),
        observed_notional_count=len(event_notional_values),
        max_notional=candidate_notional,
        child_order_count=child_order_count,
        child_notional=child_notional,
        median_event_notional=median(event_notional_values)
        if event_notional_values
        else 0.0,
        median_participation_rate=median_participation_rate,
        p90_participation_rate=p90_participation_rate,
        high_participation_share=high_participation_share,
        extreme_participation_share=extreme_participation_share,
        square_root_impact_cost_bps=square_root_impact_cost_bps,
        linear_cost_bps=linear_cost_bps,
        nonlinear_cost_uplift_bps=nonlinear_cost_uplift_bps,
        permanent_impact_residual_bps=permanent_impact_residual_bps,
        impact_decay_shortfall_bps=impact_decay_shortfall_bps,
        adverse_decay_reversal_share=adverse_decay_reversal_share,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=build_nonlinear_impact_execution_stress_schema_hash(),
    )


def _extract_price(row: SignalEnvelope) -> float | None:
    price = _first_float(row.payload, _PRICE_FIELDS, positive=True)
    if price is not None:
        return price
    bid = _first_float(row.payload, ("bid", "best_bid", "bid_price"), positive=True)
    ask = _first_float(row.payload, ("ask", "best_ask", "ask_price"), positive=True)
    if bid is None or ask is None or ask < bid:
        return None
    return (bid + ask) / 2.0


def _extract_event_notional(
    row: SignalEnvelope, *, price: float | None
) -> float | None:
    explicit_notional = _first_float(row.payload, _NOTIONAL_FIELDS, positive=True)
    if explicit_notional is not None:
        return explicit_notional
    volume = _first_float(row.payload, _VOLUME_FIELDS, positive=True)
    if volume is None or price is None or price <= 0.0:
        return None
    return volume * price


def _first_payload_float(
    rows: Sequence[SignalEnvelope], keys: Sequence[str]
) -> float | None:
    for row in rows:
        value = _first_float(row.payload, keys, positive=True)
        if value is not None:
            return value
    return None


def _first_float(
    payload: Mapping[str, Any], keys: Sequence[str], *, positive: bool = False
) -> float | None:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        if positive and value <= 0.0:
            continue
        return value
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _percentile(values: Sequence[float], percentile: float) -> float:
    clean = sorted(item for item in values if isfinite(item))
    if not clean:
        return 0.0
    if len(clean) == 1:
        return clean[0]
    bounded = min(100.0, max(0.0, percentile))
    rank = (bounded / 100.0) * (len(clean) - 1)
    lower = int(rank)
    upper = min(len(clean) - 1, lower + 1)
    fraction = rank - lower
    return clean[lower] * (1.0 - fraction) + clean[upper] * fraction


def _share(values: Sequence[float], predicate: Callable[[float], bool]) -> float:
    clean = tuple(item for item in values if isfinite(item))
    if not clean:
        return 0.0
    return sum(1 for item in clean if predicate(item)) / len(clean)


def _weighted_average(values: Sequence[float]) -> float:
    clean = tuple(item for item in values if isfinite(item))
    if not clean:
        return 0.0
    return sum(clean) / len(clean)


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 8)


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
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    return value

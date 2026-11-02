"""Preview-only stochastic liquidity-resilience stress for replay ranking.

This module converts 2025-2026 stochastic market-depth and liquidity-resilience
execution papers into deterministic replay-ranking inputs. It never writes
runtime ledgers, creates fills, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SCHEMA_VERSION = (
    "torghut.stochastic-liquidity-resilience-stress.v1"
)
STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.stochastic-liquidity-resilience-stress-contract.v1"
)
STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL = (
    "stochastic_liquidity_resilience_stress_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PRIMARY_SOURCES: tuple[
    Mapping[str, str], ...
] = (
    {
        "source_id": "arxiv-2506.11813",
        "url": "https://arxiv.org/abs/2506.11813",
        "title": "Optimal Execution under Liquidity Uncertainty",
        "date": "2025-06-13; revised 2026-04-11",
        "mechanism": (
            "regime_switching_liquidity_resilience_lob_shape_execution_boundaries"
        ),
    },
    {
        "source_id": "ssrn-3798235",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3798235",
        "title": (
            "Constrained Optimal Execution Problem in Limit Order Book Market "
            "with Stochastic Market Depth"
        ),
        "date": "2025-01-22; revised 2025-02-17",
        "mechanism": (
            "markov_chain_stochastic_market_depth_shape_constrained_execution"
        ),
    },
)
STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SOURCE_MARKERS: tuple[str, ...] = (
    "optimal_execution_liquidity_uncertainty_arxiv_2506_11813_2025",
    "stochastic_market_depth_ssrn_3798235_2025",
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "qty",
    "quantity",
    "size",
    "trade_size",
    "last_size",
)
_BID_DEPTH_FIELDS = (
    "bid_depth",
    "bid_size",
    "bid_qty",
    "best_bid_size",
    "best_bid_qty",
    "bid_depth_qty",
)
_ASK_DEPTH_FIELDS = (
    "ask_depth",
    "ask_size",
    "ask_qty",
    "best_ask_size",
    "best_ask_qty",
    "ask_depth_qty",
)
_EXECUTION_SHORTFALL_BPS_FIELDS = (
    "execution_shortfall_bps",
    "shortfall_bps",
    "route_tca_bps",
    "slippage_bps",
)
_CHILD_PARTICIPATION_FIELDS = (
    "child_order_participation_rate",
    "participation_rate",
    "pov_rate",
)
_RECOVERY_FRACTION = 0.50
_SHOCK_DROP_FRACTION = 0.35


@dataclass(frozen=True)
class StochasticLiquidityResilienceStressSummary:
    row_count: int
    observed_price_count: int
    observed_depth_count: int
    observed_spread_count: int
    observed_volume_count: int
    observed_shortfall_count: int
    observed_participation_count: int
    median_lob_depth_notional: float
    median_spread_bps: float
    median_resilience_half_life_seconds: float
    liquidity_regime_transition_count: int
    liquidity_regime_instability_score: float
    lob_shape_imbalance_score: float
    stochastic_depth_shortfall_share: float
    depth_shock_recovery_gap_score: float
    execution_boundary_pressure_bps: float
    shortfall_by_liquidity_regime_bps: float
    source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_stochastic_liquidity_resilience_stress_ranking",
            "source_papers": [
                dict(item)
                for item in STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PRIMARY_SOURCES
            ],
            "source_markers": list(
                STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SOURCE_MARKERS
            ),
            "row_count": self.row_count,
            "observed_price_count": self.observed_price_count,
            "observed_depth_count": self.observed_depth_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_volume_count": self.observed_volume_count,
            "observed_shortfall_count": self.observed_shortfall_count,
            "observed_participation_count": self.observed_participation_count,
            "median_lob_depth_notional": _stable_float(self.median_lob_depth_notional),
            "median_spread_bps": _stable_float(self.median_spread_bps),
            "median_resilience_half_life_seconds": _stable_float(
                self.median_resilience_half_life_seconds
            ),
            "liquidity_regime_transition_count": self.liquidity_regime_transition_count,
            "liquidity_regime_instability_score": _stable_float(
                self.liquidity_regime_instability_score
            ),
            "lob_shape_imbalance_score": _stable_float(self.lob_shape_imbalance_score),
            "stochastic_depth_shortfall_share": _stable_float(
                self.stochastic_depth_shortfall_share
            ),
            "depth_shock_recovery_gap_score": _stable_float(
                self.depth_shock_recovery_gap_score
            ),
            "execution_boundary_pressure_bps": _stable_float(
                self.execution_boundary_pressure_bps
            ),
            "shortfall_by_liquidity_regime_bps": _stable_float(
                self.shortfall_by_liquidity_regime_bps
            ),
            "source_gap_score": _stable_float(self.source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "median_lob_depth_notional": _stable_float(
                    self.median_lob_depth_notional
                ),
                "median_resilience_half_life_seconds": _stable_float(
                    self.median_resilience_half_life_seconds
                ),
                "liquidity_regime_instability_score": _stable_float(
                    self.liquidity_regime_instability_score
                ),
                "lob_shape_imbalance_score": _stable_float(
                    self.lob_shape_imbalance_score
                ),
                "stochastic_depth_shortfall_share": _stable_float(
                    self.stochastic_depth_shortfall_share
                ),
                "depth_shock_recovery_gap_score": _stable_float(
                    self.depth_shock_recovery_gap_score
                ),
                "execution_boundary_pressure_bps": _stable_float(
                    self.execution_boundary_pressure_bps
                ),
                "shortfall_by_liquidity_regime_bps": _stable_float(
                    self.shortfall_by_liquidity_regime_bps
                ),
                "source_gap_score": _stable_float(self.source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "stochastic_liquidity_regime_preview": True,
            "lob_shape_depth_preview": True,
            "depth_recovery_resilience_preview": True,
            "execution_boundary_pressure_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def stochastic_liquidity_resilience_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item)
            for item in STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PRIMARY_SOURCES
        ],
        "source_markers": list(STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SOURCE_MARKERS),
        "stress_policy": (
            "stochastic_market_depth_regime_lob_shape_and_resilience_ranking"
        ),
        "stress_components": [
            "liquidity_regime_instability_score",
            "lob_shape_imbalance_score",
            "stochastic_depth_shortfall_share",
            "depth_shock_recovery_gap_score",
            "execution_boundary_pressure_bps",
            "shortfall_by_liquidity_regime_bps",
            "source_gap_score",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_event_replay": True,
            "requires_real_lob_depth_history": True,
            "requires_order_lifecycle": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "rejects_modeled_liquidity_resilience_as_pnl_authority": True,
            "rejects_synthetic_depth_recovery_as_fill_authority": True,
        },
        "proof_semantics_label": (
            STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL
        ),
    }


def extract_stochastic_liquidity_resilience_stress(
    rows: Sequence[SignalEnvelope], *, max_notional: float | None = None
) -> StochasticLiquidityResilienceStressSummary:
    ordered = sorted(rows, key=lambda row: (row.event_ts, row.seq))
    prices: list[float | None] = []
    depths: list[float | None] = []
    spreads: list[float] = []
    volumes: list[float] = []
    shape_imbalances: list[float] = []
    shortfalls: list[float] = []
    participation_rates: list[float] = []
    event_gap_seconds: list[float] = []
    warnings: list[str] = []

    previous_ts = None
    for row in ordered:
        payload = row.payload
        price = _first_finite(payload, _PRICE_FIELDS)
        bid_depth = _first_finite(payload, _BID_DEPTH_FIELDS)
        ask_depth = _first_finite(payload, _ASK_DEPTH_FIELDS)
        depth = _depth_notional(price=price, bid_depth=bid_depth, ask_depth=ask_depth)
        prices.append(price)
        depths.append(depth)
        if bid_depth is not None and ask_depth is not None:
            denominator = abs(bid_depth) + abs(ask_depth)
            if denominator > 0.0:
                shape_imbalances.append(abs(bid_depth - ask_depth) / denominator)
        spread = _first_finite(payload, _SPREAD_BPS_FIELDS)
        if spread is not None:
            spreads.append(max(0.0, spread))
        volume = _first_finite(payload, _VOLUME_FIELDS)
        if volume is not None:
            volumes.append(max(0.0, volume))
        shortfall = _first_finite(payload, _EXECUTION_SHORTFALL_BPS_FIELDS)
        if shortfall is not None:
            shortfalls.append(max(0.0, shortfall))
        participation = _first_finite(payload, _CHILD_PARTICIPATION_FIELDS)
        if participation is not None:
            participation_rates.append(max(0.0, min(1.0, participation)))
        if previous_ts is not None:
            event_gap_seconds.append(
                max(0.0, (row.event_ts - previous_ts).total_seconds())
            )
        previous_ts = row.event_ts

    observed_price_count = sum(1 for value in prices if value is not None)
    depth_values = [value for value in depths if value is not None]
    if observed_price_count < 2:
        warnings.append("missing_price_path_for_liquidity_resilience")
    if not depth_values:
        warnings.append("missing_lob_depth_for_stochastic_liquidity_resilience")
    if not shape_imbalances:
        warnings.append("missing_two_sided_lob_shape_for_resilience_stress")
    if not spreads:
        warnings.append("missing_spread_context_for_execution_boundary")
    if not volumes:
        warnings.append("missing_volume_context_for_liquidity_regime")
    if not shortfalls:
        warnings.append("missing_execution_shortfall_by_liquidity_regime")
    if not participation_rates:
        warnings.append("missing_child_order_participation_rate_context")

    regime_labels = _liquidity_regime_labels(depths)
    transition_count = _transition_count(regime_labels)
    instability = _regime_instability_score(regime_labels)
    recovery_gap, half_life_seconds = _depth_recovery_metrics(
        depths=depths,
        event_gap_seconds=event_gap_seconds,
    )
    median_depth = _median(depth_values)
    depth_floor = max_notional if max_notional is not None else median_depth
    depth_shortfall = _depth_shortfall_share(depth_values, depth_floor=depth_floor)
    boundary_pressure = _execution_boundary_pressure_bps(
        max_notional=max_notional,
        median_depth=median_depth,
        median_spread_bps=_median(spreads),
        median_participation_rate=_median(participation_rates),
    )
    shortfall_by_regime = _shortfall_by_liquidity_regime_bps(
        shortfalls=shortfalls,
        regime_labels=tuple(label for label in regime_labels if label is not None),
    )
    source_gap = _source_gap_score(
        row_count=len(ordered),
        observed_price_count=observed_price_count,
        observed_depth_count=len(depth_values),
        observed_spread_count=len(spreads),
        observed_volume_count=len(volumes),
        observed_shortfall_count=len(shortfalls),
    )
    penalty = (
        instability * 12.0
        + _mean(shape_imbalances) * 10.0
        + depth_shortfall * 18.0
        + recovery_gap * 16.0
        + min(24.0, boundary_pressure) * 0.85
        + shortfall_by_regime * 0.55
        + source_gap * 20.0
    )

    return StochasticLiquidityResilienceStressSummary(
        row_count=len(ordered),
        observed_price_count=observed_price_count,
        observed_depth_count=len(depth_values),
        observed_spread_count=len(spreads),
        observed_volume_count=len(volumes),
        observed_shortfall_count=len(shortfalls),
        observed_participation_count=len(participation_rates),
        median_lob_depth_notional=median_depth,
        median_spread_bps=_median(spreads),
        median_resilience_half_life_seconds=half_life_seconds,
        liquidity_regime_transition_count=transition_count,
        liquidity_regime_instability_score=instability,
        lob_shape_imbalance_score=_mean(shape_imbalances),
        stochastic_depth_shortfall_share=depth_shortfall,
        depth_shock_recovery_gap_score=recovery_gap,
        execution_boundary_pressure_bps=boundary_pressure,
        shortfall_by_liquidity_regime_bps=shortfall_by_regime,
        source_gap_score=source_gap,
        replay_rank_penalty_bps=float(min(250.0, max(0.0, penalty))),
        warnings=tuple(sorted(set(warnings))),
        feature_schema_hash=build_stochastic_liquidity_resilience_stress_schema_hash(),
    )


def build_stochastic_liquidity_resilience_stress_schema_hash() -> str:
    payload = {
        "schema_version": STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_SCHEMA_VERSION,
        "price_fields": _PRICE_FIELDS,
        "spread_fields": _SPREAD_BPS_FIELDS,
        "volume_fields": _VOLUME_FIELDS,
        "bid_depth_fields": _BID_DEPTH_FIELDS,
        "ask_depth_fields": _ASK_DEPTH_FIELDS,
        "execution_shortfall_fields": _EXECUTION_SHORTFALL_BPS_FIELDS,
        "participation_fields": _CHILD_PARTICIPATION_FIELDS,
        "source_ids": tuple(
            source["source_id"]
            for source in STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PRIMARY_SOURCES
        ),
        "proof_semantics_label": (
            STOCHASTIC_LIQUIDITY_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL
        ),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _depth_notional(
    *, price: float | None, bid_depth: float | None, ask_depth: float | None
) -> float | None:
    if bid_depth is None or ask_depth is None:
        return None
    units = max(0.0, bid_depth) + max(0.0, ask_depth)
    if units <= 0.0:
        return None
    return units * price if price is not None and price > 0.0 else units


def _liquidity_regime_labels(depths: Sequence[float | None]) -> tuple[str | None, ...]:
    values = [value for value in depths if value is not None]
    if not values:
        return tuple(None for _ in depths)
    low = _percentile(values, 0.33)
    high = _percentile(values, 0.67)
    labels: list[str | None] = []
    for depth in depths:
        if depth is None:
            labels.append(None)
        elif depth <= low:
            labels.append("thin")
        elif depth >= high:
            labels.append("deep")
        else:
            labels.append("normal")
    return tuple(labels)


def _transition_count(labels: Sequence[str | None]) -> int:
    transitions = 0
    previous: str | None = None
    for label in labels:
        if label is None:
            continue
        if previous is not None and label != previous:
            transitions += 1
        previous = label
    return transitions


def _regime_instability_score(labels: Sequence[str | None]) -> float:
    observed = [label for label in labels if label is not None]
    if len(observed) <= 1:
        return 0.0
    return min(1.0, _transition_count(observed) / max(1, len(observed) - 1))


def _depth_recovery_metrics(
    *, depths: Sequence[float | None], event_gap_seconds: Sequence[float]
) -> tuple[float, float]:
    values = [value for value in depths if value is not None]
    if len(values) < 3:
        return 0.0, 0.0
    baseline = _median(values)
    if baseline <= 0.0:
        return 0.0, 0.0
    gaps: list[float] = []
    half_lives: list[float] = []
    for idx in range(1, len(depths)):
        previous = depths[idx - 1]
        current = depths[idx]
        if previous is None or current is None or previous <= 0.0:
            continue
        drop_fraction = (previous - current) / previous
        if drop_fraction < _SHOCK_DROP_FRACTION or current >= baseline:
            continue
        target = current + (baseline - current) * _RECOVERY_FRACTION
        recovered_at: int | None = None
        best_recovery = current
        for next_idx in range(idx + 1, len(depths)):
            next_depth = depths[next_idx]
            if next_depth is None:
                continue
            best_recovery = max(best_recovery, next_depth)
            if next_depth >= target:
                recovered_at = next_idx
                break
        recovery_fraction = (best_recovery - current) / max(1.0, baseline - current)
        gaps.append(max(0.0, 1.0 - min(1.0, recovery_fraction)))
        if recovered_at is not None:
            half_lives.append(_elapsed_seconds(idx, recovered_at, event_gap_seconds))
    if not gaps:
        return 0.0, 0.0
    return _mean(gaps), _median(half_lives)


def _elapsed_seconds(
    start_idx: int, end_idx: int, event_gap_seconds: Sequence[float]
) -> float:
    if end_idx <= start_idx:
        return 0.0
    gaps = event_gap_seconds[start_idx:end_idx]
    if not gaps:
        return float(end_idx - start_idx)
    return sum(gaps)


def _depth_shortfall_share(values: Sequence[float], *, depth_floor: float) -> float:
    if not values or depth_floor <= 0.0:
        return 0.0 if values else 1.0
    return sum(1 for value in values if value < depth_floor) / len(values)


def _execution_boundary_pressure_bps(
    *,
    max_notional: float | None,
    median_depth: float,
    median_spread_bps: float,
    median_participation_rate: float,
) -> float:
    if max_notional is None or max_notional <= 0.0 or median_depth <= 0.0:
        return 0.0
    pressure = max_notional / median_depth
    participation_pressure = max(0.0, median_participation_rate - 0.05) * 40.0
    return max(0.0, pressure * max(1.0, median_spread_bps) + participation_pressure)


def _shortfall_by_liquidity_regime_bps(
    *, shortfalls: Sequence[float], regime_labels: Sequence[str]
) -> float:
    if not shortfalls:
        return 0.0
    count = min(len(shortfalls), len(regime_labels))
    if count <= 0:
        return _mean(shortfalls)
    thin = [shortfalls[idx] for idx in range(count) if regime_labels[idx] == "thin"]
    non_thin = [shortfalls[idx] for idx in range(count) if regime_labels[idx] != "thin"]
    if thin and non_thin:
        return max(0.0, _mean(thin) - _mean(non_thin))
    return _mean(shortfalls)


def _source_gap_score(
    *,
    row_count: int,
    observed_price_count: int,
    observed_depth_count: int,
    observed_spread_count: int,
    observed_volume_count: int,
    observed_shortfall_count: int,
) -> float:
    if row_count <= 0:
        return 1.0
    coverages = (
        observed_price_count / row_count,
        observed_depth_count / row_count,
        observed_spread_count / row_count,
        observed_volume_count / row_count,
        observed_shortfall_count / row_count,
    )
    return max(0.0, 1.0 - sum(coverages) / len(coverages))


def _first_finite(payload: Mapping[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        if key not in payload:
            continue
        parsed = _float_or_none(payload.get(key))
        if parsed is not None:
            return parsed
    nested = payload.get("features")
    if isinstance(nested, Mapping):
        nested_payload = cast(Mapping[str, Any], nested)
        for key in keys:
            if key not in nested_payload:
                continue
            parsed = _float_or_none(nested_payload.get(key))
            if parsed is not None:
                return parsed
    return None


def _float_or_none(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(cast(Any, value))
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0


def _percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * quantile))))
    return ordered[idx]


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return float(round(value, 8))

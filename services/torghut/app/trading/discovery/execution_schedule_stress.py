"""Preview-only execution schedule stress features for replay candidate ranking.

The helpers in this module actualize recent optimal-execution papers into a
cheap, deterministic replay harness input. They do not simulate broker fills,
do not write ledgers, and deliberately carry no promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from math import isfinite, sqrt
from typing import Any, cast

from app.trading.models import SignalEnvelope

EXECUTION_SCHEDULE_STRESS_SCHEMA_VERSION = "torghut.execution-schedule-stress.v1"
EXECUTION_SCHEDULE_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.execution-schedule-stress-contract.v1"
)
EXECUTION_SCHEDULE_STRESS_PROOF_SEMANTICS_LABEL = "execution_schedule_stress_preview_only_exact_replay_route_tca_runtime_ledger_required"
EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2603.28898",
        "url": "https://arxiv.org/abs/2603.28898",
        "mechanism": "mpc_execution_schedule_completion_impact_opportunity_cost",
    },
    {
        "source_id": "arxiv-2507.06345",
        "url": "https://arxiv.org/abs/2507.06345",
        "mechanism": "market_limit_order_mix_allocation_fill_shortfall_tradeoff",
    },
)


@dataclass(frozen=True)
class ExecutionScheduleStressSummary:
    row_count: int
    observed_event_time_count: int
    observed_window_seconds: float
    schedule_deviation_bps: float
    opportunity_cost_bps: float
    impact_cost_bps: float
    market_order_share: float
    limit_order_share: float
    shortfall_stress_bps: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": EXECUTION_SCHEDULE_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_execution_stress_ranking",
            "source_papers": [
                dict(item) for item in EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_event_time_count": self.observed_event_time_count,
            "observed_window_seconds": _stable_float(self.observed_window_seconds),
            "schedule_deviation_bps": _stable_float(self.schedule_deviation_bps),
            "opportunity_cost_bps": _stable_float(self.opportunity_cost_bps),
            "impact_cost_bps": _stable_float(self.impact_cost_bps),
            "market_order_share": _stable_float(self.market_order_share),
            "limit_order_share": _stable_float(self.limit_order_share),
            "shortfall_stress_bps": _stable_float(self.shortfall_stress_bps),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "schedule_deviation_bps": _stable_float(self.schedule_deviation_bps),
                "opportunity_cost_bps": _stable_float(self.opportunity_cost_bps),
                "impact_cost_bps": _stable_float(self.impact_cost_bps),
                "market_order_share": _stable_float(self.market_order_share),
                "limit_order_share": _stable_float(self.limit_order_share),
                "shortfall_stress_bps": _stable_float(self.shortfall_stress_bps),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "mpc_schedule_trace_preview": True,
            "market_limit_mix_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": EXECUTION_SCHEDULE_STRESS_PROOF_SEMANTICS_LABEL,
        }


def execution_schedule_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": EXECUTION_SCHEDULE_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": EXECUTION_SCHEDULE_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES
        ],
        "schedule_policy": "twap_baseline_vs_observed_volume_curve",
        "stress_components": [
            "schedule_deviation_bps",
            "opportunity_cost_bps",
            "impact_cost_bps",
            "market_limit_order_mix_proxy",
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


def build_execution_schedule_stress_schema_hash() -> str:
    return _stable_hash(execution_schedule_stress_contract())


def extract_execution_schedule_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    max_notional: Decimal | int | float | str | None = None,
) -> ExecutionScheduleStressSummary:
    """Extract deterministic MPC-style schedule stress from replay rows.

    ``direction`` is +1 for buy/long execution and -1 for sell/short execution.
    The output is a ranking/stress input only; exact replay, route TCA, and
    runtime-ledger proof still decide promotion.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    event_times = tuple(_event_time_seconds(row.event_ts) for row in ordered)
    observed_event_time_count = sum(1 for item in event_times if item is not None)
    prices = tuple(_positive_float(row.payload.get("price")) for row in ordered)
    volumes = tuple(
        _nonnegative_float(_first_payload_value(row, _VOLUME_FIELDS)) for row in ordered
    )
    spreads = tuple(
        _nonnegative_float(row.payload.get("spread_bps")) for row in ordered
    )
    notional = _nonnegative_float(max_notional)
    warnings: list[str] = []
    if len(ordered) < 2:
        warnings.append("insufficient_execution_schedule_rows")
    if observed_event_time_count < 2:
        warnings.append("insufficient_execution_schedule_timestamps")
    valid_prices = tuple(price for price in prices if price is not None and price > 0.0)
    if len(valid_prices) < 2:
        warnings.append("missing_execution_price_path")
    positive_volumes = tuple(volume for volume in volumes if volume > 0.0)
    if not positive_volumes:
        warnings.append("missing_execution_volume_curve")
    if notional <= 0.0:
        warnings.append("missing_candidate_notional_for_execution_stress")

    observed_window_seconds = _observed_window_seconds(event_times)
    schedule_deviation_bps = _schedule_deviation_bps(positive_volumes)
    opportunity_cost_bps = _opportunity_cost_bps(valid_prices, direction=direction)
    median_spread_bps = _median(spreads)
    median_price = _median(valid_prices)
    median_volume = _median(positive_volumes)
    impact_cost_bps = _impact_cost_bps(
        notional=notional,
        median_price=median_price,
        median_volume=median_volume,
        median_spread_bps=median_spread_bps,
    )
    shortfall_stress_bps = (
        schedule_deviation_bps * 0.25 + opportunity_cost_bps + impact_cost_bps
    )
    urgency_score = min(
        1.0, max(0.0, (opportunity_cost_bps + schedule_deviation_bps * 0.2) / 25.0)
    )
    liquidity_score = (
        min(1.0, median_spread_bps / 12.0) if median_spread_bps > 0.0 else 0.0
    )
    market_order_share = min(
        0.95, max(0.05, 0.30 + urgency_score * 0.45 - liquidity_score * 0.20)
    )
    limit_order_share = 1.0 - market_order_share
    missing_penalty_bps = 6.0 * len(warnings)
    replay_rank_penalty_bps = shortfall_stress_bps + missing_penalty_bps
    return ExecutionScheduleStressSummary(
        row_count=len(ordered),
        observed_event_time_count=observed_event_time_count,
        observed_window_seconds=observed_window_seconds,
        schedule_deviation_bps=schedule_deviation_bps,
        opportunity_cost_bps=opportunity_cost_bps,
        impact_cost_bps=impact_cost_bps,
        market_order_share=market_order_share,
        limit_order_share=limit_order_share,
        shortfall_stress_bps=shortfall_stress_bps,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_execution_schedule_stress_schema_hash(),
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


def _schedule_deviation_bps(volumes: Sequence[float]) -> float:
    if len(volumes) < 2:
        return 0.0
    total = sum(volumes)
    if total <= 0.0:
        return 0.0
    cumulative = 0.0
    deviations: list[float] = []
    for index, volume in enumerate(volumes, start=1):
        cumulative += volume
        observed_fraction = cumulative / total
        twap_fraction = index / len(volumes)
        deviations.append(abs(observed_fraction - twap_fraction))
    return min(100.0, _mean(deviations) * 100.0)


def _opportunity_cost_bps(prices: Sequence[float], *, direction: int | float) -> float:
    if len(prices) < 2:
        return 0.0
    arrival = prices[0]
    terminal = prices[-1]
    if arrival <= 0.0:
        return 0.0
    signed_move_bps = float(direction) * (terminal - arrival) / arrival * 10_000.0
    return max(0.0, signed_move_bps)


def _impact_cost_bps(
    *,
    notional: float,
    median_price: float,
    median_volume: float,
    median_spread_bps: float,
) -> float:
    if notional <= 0.0:
        return 0.0
    dollar_volume = max(0.0, median_price) * max(0.0, median_volume)
    if dollar_volume <= 0.0:
        return 25.0 + median_spread_bps
    participation = notional / dollar_volume
    return min(500.0, sqrt(max(0.0, participation)) * 75.0 + median_spread_bps * 0.35)


def _observed_window_seconds(event_times: Sequence[float | None]) -> float:
    values = tuple(item for item in event_times if item is not None)
    if len(values) < 2:
        return 0.0
    return max(0.0, values[-1] - values[0])


def _event_time_seconds(value: datetime | None) -> float | None:
    if value is None:
        return None
    return value.timestamp()


def _first_payload_value(record: SignalEnvelope, keys: Sequence[str]) -> Any:
    for key in keys:
        if key in record.payload:
            return record.payload.get(key)
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
    if isinstance(value, Decimal):
        parsed = float(value)
    elif isinstance(value, (int, float)):
        parsed = float(value)
    else:
        try:
            parsed = float(str(value).strip())
        except ValueError:
            return None
    return parsed if isfinite(parsed) else None


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _stable_float(value: float) -> str:
    if not isfinite(value):
        return "0"
    return f"{value:.12g}"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(_json_ready(payload), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
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


__all__ = [
    "EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES",
    "EXECUTION_SCHEDULE_STRESS_PROOF_SEMANTICS_LABEL",
    "EXECUTION_SCHEDULE_STRESS_SCHEMA_VERSION",
    "ExecutionScheduleStressSummary",
    "build_execution_schedule_stress_schema_hash",
    "execution_schedule_stress_contract",
    "extract_execution_schedule_stress",
]

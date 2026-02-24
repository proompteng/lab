"""Microstructure and execution-advice contracts for bounded execution policy."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

@dataclass(frozen=True)
class MicrostructureStateV5:
    schema_version: str
    symbol: str
    event_ts: datetime
    spread_bps: Decimal
    depth_top5_usd: Decimal
    order_flow_imbalance: Decimal
    latency_ms_estimate: int
    fill_hazard: Decimal
    liquidity_regime: str

@dataclass(frozen=True)
class ExecutionAdviceV1:
    urgency_tier: str
    max_participation_rate: Decimal | None
    preferred_order_type: str | None
    quote_offset_bps: Decimal | None
    adverse_selection_risk: Decimal | None
    event_ts: datetime | None
    latency_ms: int | None
    simulator_version: str | None
    expected_shortfall_bps_p50: Decimal | None
    expected_shortfall_bps_p95: Decimal | None

def parse_microstructure_state(payload: Any, *, expected_symbol: str | None = None) -> MicrostructureStateV5 | None:
    if not isinstance(payload, Mapping):
        return None
    data = cast(Mapping[str, Any], payload)
    symbol = str(data.get('symbol') or '').strip().upper()
    if str(data.get('schema_version') or '').strip() != 'microstructure_state_v1' or not symbol:
        return None
    if expected_symbol and symbol != expected_symbol.strip().upper():
        return None

    event_ts = _dt(data.get('event_ts'))
    spread_bps = _dec(data.get('spread_bps'))
    depth_top5_usd = _dec(data.get('depth_top5_usd'))
    imbalance = _dec(data.get('order_flow_imbalance'))
    latency_ms_estimate = _int(data.get('latency_ms_estimate'))
    fill_hazard = _dec(data.get('fill_hazard'))
    liquidity_regime = str(data.get('liquidity_regime') or '').strip().lower()
    if None in (event_ts, spread_bps, depth_top5_usd, imbalance, latency_ms_estimate, fill_hazard):
        return None
    if liquidity_regime not in {'normal', 'compressed', 'stressed'}:
        return None
    return MicrostructureStateV5(
        'microstructure_state_v1',
        symbol,
        cast(datetime, event_ts),
        cast(Decimal, spread_bps),
        cast(Decimal, depth_top5_usd),
        cast(Decimal, imbalance),
        cast(int, latency_ms_estimate),
        cast(Decimal, fill_hazard),
        liquidity_regime,
    )

def parse_execution_advice(payload: Any) -> ExecutionAdviceV1 | None:
    if not isinstance(payload, Mapping):
        return None
    data = cast(Mapping[str, Any], payload)
    urgency = str(data.get('urgency_tier') or '').strip().lower()
    preferred = data.get('preferred_order_type')
    preferred_str = str(preferred).strip().lower() if preferred is not None else None
    if urgency not in {'low', 'normal', 'high'}:
        return None
    if preferred_str is not None and preferred_str not in {'market', 'limit', 'stop', 'stop_limit'}:
        return None
    return ExecutionAdviceV1(
        urgency,
        _dec(data.get('max_participation_rate')),
        preferred_str,
        _dec(data.get('quote_offset_bps')),
        _dec(data.get('adverse_selection_risk')),
        _dt(data.get('event_ts')),
        _int(data.get('latency_ms')),
        _text(data.get('simulator_version')),
        _dec(data.get('expected_shortfall_bps_p50')),
        _dec(data.get('expected_shortfall_bps_p95')),
    )

def is_microstructure_stale(state: MicrostructureStateV5 | None, *, reference_ts: datetime, max_staleness_seconds: int) -> bool:
    if state is None:
        return True
    age = (reference_ts.astimezone(timezone.utc) - state.event_ts.astimezone(timezone.utc)).total_seconds()
    return age > max(max_staleness_seconds, 0)

def _dec(value: Any) -> Decimal | None:
    try:
        return None if value is None else Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None

def _int(value: Any) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None

def _dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None

def _text(value: Any) -> str | None:
    if value is None:
        return None
    value_str = str(value).strip()
    return value_str or None

__all__ = ['ExecutionAdviceV1', 'MicrostructureStateV5', 'is_microstructure_stale', 'parse_execution_advice', 'parse_microstructure_state']

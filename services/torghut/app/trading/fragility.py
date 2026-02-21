"""Fragility monitor and deterministic stability-mode allocation controls."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Optional, cast

from .models import StrategyDecision

FragilityMode = Literal["off", "observe", "enforce"]
FragilityState = Literal["normal", "elevated", "stress", "crisis"]

_STATE_ORDER: dict[FragilityState, int] = {
    "normal": 0,
    "elevated": 1,
    "stress": 2,
    "crisis": 3,
}
@dataclass(frozen=True)
class FragilityMonitorConfig:
    mode: FragilityMode
    unknown_state: FragilityState
    elevated_threshold: Decimal
    stress_threshold: Decimal
    crisis_threshold: Decimal
    state_budget_multipliers: dict[FragilityState, Decimal]
    state_capacity_multipliers: dict[FragilityState, Decimal]
    state_participation_clamps: dict[FragilityState, Decimal]
    state_abstain_bias: dict[FragilityState, Decimal]
@dataclass(frozen=True)
class FragilitySnapshot:
    schema_version: str
    symbol: str
    spread_acceleration: Decimal
    liquidity_compression: Decimal
    crowding_proxy: Decimal
    correlation_concentration: Decimal
    fragility_score: Decimal
    fragility_state: FragilityState

    def to_payload(self) -> dict[str, str]:
        return {
            "schema_version": self.schema_version,
            "symbol": self.symbol,
            "spread_acceleration": str(self.spread_acceleration),
            "liquidity_compression": str(self.liquidity_compression),
            "crowding_proxy": str(self.crowding_proxy),
            "correlation_concentration": str(self.correlation_concentration),
            "fragility_score": str(self.fragility_score),
            "fragility_state": self.fragility_state,
        }
@dataclass(frozen=True)
class FragilityAllocationAdjustment:
    snapshot: FragilitySnapshot
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    max_participation_rate_override: Optional[Decimal]
    abstain_probability_bias: Decimal
    stability_mode_active: bool
    clamp_reasons: tuple[str, ...]

    def to_allocator_payload(self) -> dict[str, Any]:
        return {
            "fragility_state": self.snapshot.fragility_state,
            "fragility_score": str(self.snapshot.fragility_score),
            "stability_mode_active": self.stability_mode_active,
            "applied_multipliers": {
                "budget_multiplier": str(self.budget_multiplier),
                "capacity_multiplier": str(self.capacity_multiplier),
            },
            "max_participation_rate_override": (
                str(self.max_participation_rate_override)
                if self.max_participation_rate_override is not None
                else None
            ),
            "abstain_probability_bias": str(self.abstain_probability_bias),
            "clamp_reasons": list(self.clamp_reasons),
        }
class FragilityMonitor:
    """Compute deterministic fragility state and allocation clamps."""

    def __init__(self, config: FragilityMonitorConfig) -> None:
        self.config = config

    def evaluate(self, decision: StrategyDecision) -> FragilityAllocationAdjustment:
        snapshot = self._snapshot_from_decision(decision)
        state = snapshot.fragility_state
        budget_multiplier = self.config.state_budget_multipliers.get(state, Decimal("1"))
        capacity_multiplier = self.config.state_capacity_multipliers.get(
            state, Decimal("1")
        )
        budget_multiplier = _clamp_unit_interval(budget_multiplier)
        capacity_multiplier = _clamp_unit_interval(capacity_multiplier)
        participation_override = self.config.state_participation_clamps.get(state)
        if participation_override is not None:
            participation_override = _clamp_unit_interval(participation_override)
        abstain_bias = self.config.state_abstain_bias.get(state, Decimal("0"))
        if abstain_bias < 0:
            abstain_bias = Decimal("0")
        if abstain_bias > 1:
            abstain_bias = Decimal("1")

        stability_mode = state in {"stress", "crisis"}
        reasons: list[str] = []
        if stability_mode:
            reasons.append(f"stability_mode_{state}")
            if participation_override is not None:
                reasons.append("participation_clamp_applied")
        if state == "crisis":
            reasons.append("crisis_entry_restrictions")

        return FragilityAllocationAdjustment(
            snapshot=snapshot,
            budget_multiplier=budget_multiplier,
            capacity_multiplier=capacity_multiplier,
            max_participation_rate_override=participation_override,
            abstain_probability_bias=abstain_bias,
            stability_mode_active=stability_mode,
            clamp_reasons=tuple(sorted(set(reasons))),
        )

    def worst_state(self, states: list[FragilityState]) -> FragilityState:
        if not states:
            return self.config.unknown_state
        return max(states, key=lambda state: _STATE_ORDER[state])

    def _snapshot_from_decision(self, decision: StrategyDecision) -> FragilitySnapshot:
        params = decision.params
        snapshot_payload = params.get("fragility_snapshot")
        snapshot_map: dict[str, Any]
        if isinstance(snapshot_payload, dict):
            raw_map = cast(dict[str, Any], snapshot_payload)
            snapshot_map = dict(raw_map)
        else:
            snapshot_map = {}
        spread_acceleration = _indicator(
            _resolve_snapshot_value(snapshot_map, params, "spread_acceleration")
        )
        liquidity_compression = _indicator(
            _resolve_snapshot_value(snapshot_map, params, "liquidity_compression")
        )
        crowding_proxy = _indicator(
            _resolve_snapshot_value(snapshot_map, params, "crowding_proxy")
        )
        correlation_concentration = _indicator(
            _resolve_snapshot_value(snapshot_map, params, "correlation_concentration")
        )
        provided_score = _optional_decimal(
            _resolve_snapshot_value(snapshot_map, params, "fragility_score")
        )
        if provided_score is not None:
            score = _clamp_unit_interval(provided_score)
        else:
            score = (
                spread_acceleration
                + liquidity_compression
                + crowding_proxy
                + correlation_concentration
            ) / Decimal("4")
        derived_state = _state_from_score(
            score,
            elevated=self.config.elevated_threshold,
            stress=self.config.stress_threshold,
            crisis=self.config.crisis_threshold,
        )
        provided_state = _normalize_state(
            _resolve_snapshot_value(snapshot_map, params, "fragility_state")
        )
        if provided_state is None:
            state = _max_state(derived_state, self.config.unknown_state)
        else:
            state = _max_state(derived_state, provided_state)
        return FragilitySnapshot(
            schema_version="fragility_snapshot_v1",
            symbol=decision.symbol,
            spread_acceleration=spread_acceleration,
            liquidity_compression=liquidity_compression,
            crowding_proxy=crowding_proxy,
            correlation_concentration=correlation_concentration,
            fragility_score=score,
            fragility_state=state,
        )


def _indicator(value: Any) -> Decimal:
    parsed = _optional_decimal(value)
    if parsed is None:
        return Decimal("0.5")
    return _clamp_unit_interval(parsed)


def _resolve_snapshot_value(
    snapshot_map: dict[str, Any], params: dict[str, Any], key: str
) -> Any:
    if key in snapshot_map and snapshot_map.get(key) is not None:
        return snapshot_map.get(key)
    return params.get(key)
def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
def _state_from_score(
    score: Decimal,
    *,
    elevated: Decimal,
    stress: Decimal,
    crisis: Decimal,
) -> FragilityState:
    if score >= crisis:
        return "crisis"
    if score >= stress:
        return "stress"
    if score >= elevated:
        return "elevated"
    return "normal"
def _normalize_state(value: Any) -> Optional[FragilityState]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized == "normal":
        return "normal"
    if normalized == "elevated":
        return "elevated"
    if normalized == "stress":
        return "stress"
    if normalized == "crisis":
        return "crisis"
    return None
def _max_state(left: FragilityState, right: FragilityState) -> FragilityState:
    if _STATE_ORDER[left] >= _STATE_ORDER[right]:
        return left
    return right
def _clamp_unit_interval(value: Decimal) -> Decimal:
    if value < 0:
        return Decimal("0")
    if value > 1:
        return Decimal("1")
    return value


__all__ = [
    "FragilityAllocationAdjustment",
    "FragilityMode",
    "FragilityMonitor",
    "FragilityMonitorConfig",
    "FragilitySnapshot",
    "FragilityState",
]

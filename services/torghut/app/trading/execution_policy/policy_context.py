"""Typed request and context objects for execution policy evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone
from decimal import Decimal
from typing import Any, Optional

from ...config import settings
from ...models import Strategy
from ..microstructure import MicrostructureStateV5, is_microstructure_stale
from ..models import StrategyDecision
from ..prices import MarketSnapshot
from ..tca import AdaptiveExecutionPolicyDecision

from .policy_types import (
    MICROSTRUCTURE_CRUMBLING_QUOTE_EXECUTION_SCALE,
    MICROSTRUCTURE_CRUMBLING_QUOTE_RATE_SCALE,
    AdaptiveExecutionApplication,
    ExecutionPolicyConfig,
)


@dataclass(frozen=True)
class ExecutionPolicyEvaluateRequest:
    decision: StrategyDecision
    strategy: Optional[Strategy]
    positions: tuple[dict[str, Any], ...]
    market_snapshot: Optional[MarketSnapshot]
    kill_switch_enabled: Optional[bool]
    adaptive_policy: AdaptiveExecutionPolicyDecision | None

    @classmethod
    def from_kwargs(
        cls, decision: StrategyDecision, values: dict[str, Any]
    ) -> ExecutionPolicyEvaluateRequest:
        positions = values.pop("positions")
        request = cls(
            decision=decision,
            strategy=values.pop("strategy"),
            positions=tuple(positions),
            market_snapshot=values.pop("market_snapshot"),
            kill_switch_enabled=values.pop("kill_switch_enabled", None),
            adaptive_policy=values.pop("adaptive_policy", None),
        )
        if values:
            raise TypeError(f"unexpected_execution_policy_arguments:{sorted(values)}")
        return request


@dataclass
class ExecutionPolicyRuntimeContext:
    config: ExecutionPolicyConfig
    reasons: list[str]
    microstructure_state: MicrostructureStateV5 | None
    microstructure_metadata: dict[str, Any]
    microstructure_execution_scale: Decimal
    advisor_metadata: dict[str, Any]
    advisor_max_participation: Decimal | None
    adaptive_application: AdaptiveExecutionApplication | None


@dataclass(frozen=True)
class ExecutionPolicySelection:
    decision: StrategyDecision
    selected_order_type: str


@dataclass(frozen=True)
class ExecutionPolicySizing:
    price: Decimal | None
    position_qty: Decimal
    short_increasing: bool
    position_reducing: bool
    qty: Decimal
    notional: Decimal | None


@dataclass(frozen=True)
class ExecutionPolicyImpact:
    participation_rate: Decimal | None
    retry_delays: list[float]
    impact_assumptions: dict[str, Any]


@dataclass
class QuantityResolutionRequest:
    decision: StrategyDecision
    position_qty: Decimal
    short_increasing: bool
    allow_shorts: bool
    price: Decimal | None
    reasons: list[str]


@dataclass
class MicrostructureAdjustment:
    metadata: dict[str, Any]
    participation_rate_scale: Decimal = Decimal("1")
    execution_seconds_scale: Decimal = Decimal("1")

    def tighten_participation(self, scale: Decimal, reason: str | None = None) -> None:
        self.participation_rate_scale *= scale
        if reason is not None:
            self.metadata["tightening_reasons"].append(reason)

    def slow_execution(self, scale: Decimal, reason: str | None = None) -> None:
        self.execution_seconds_scale *= scale
        if reason is not None:
            self.metadata["tightening_reasons"].append(reason)

    def prefer_limit(self) -> None:
        self.metadata["prefer_limit"] = True


def apply_crumbling_quote_pressure(
    adjustment: MicrostructureAdjustment, reason: str
) -> None:
    adjustment.tighten_participation(MICROSTRUCTURE_CRUMBLING_QUOTE_RATE_SCALE, reason)
    adjustment.slow_execution(MICROSTRUCTURE_CRUMBLING_QUOTE_EXECUTION_SCALE)
    adjustment.prefer_limit()


def execution_advisor_input_fallback_reason(
    *,
    decision: StrategyDecision,
    state: MicrostructureStateV5 | None,
    advice: Any,
    max_staleness_seconds: int,
) -> str | None:
    if state is None or advice is None:
        return "advisor_missing_inputs"
    if is_microstructure_stale(
        state,
        reference_ts=decision.event_ts,
        max_staleness_seconds=max_staleness_seconds,
    ):
        return "advisor_state_stale"
    if advice.event_ts is not None:
        advice_age = (
            decision.event_ts.astimezone(timezone.utc)
            - advice.event_ts.astimezone(timezone.utc)
        ).total_seconds()
        if advice_age > max(max_staleness_seconds, 0):
            return "advisor_advice_stale"
    if (
        advice.latency_ms is not None
        and advice.latency_ms > settings.trading_execution_advisor_timeout_ms
    ):
        return "advisor_timeout"
    return None


__all__ = [
    "ExecutionPolicyEvaluateRequest",
    "ExecutionPolicyImpact",
    "ExecutionPolicyRuntimeContext",
    "ExecutionPolicySelection",
    "ExecutionPolicySizing",
    "MicrostructureAdjustment",
    "QuantityResolutionRequest",
    "apply_crumbling_quote_pressure",
    "execution_advisor_input_fallback_reason",
]

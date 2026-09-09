"""Execution policy enforcing order placement safety and impact assumptions."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
import hashlib
import json
from typing import Any, Optional

from ..models import StrategyDecision
from ..tca import AdaptiveExecutionPolicyDecision


DEFAULT_EXECUTION_SECONDS = 60

ADAPTIVE_PARTICIPATION_RATE_FLOOR = Decimal("0.05")

ADAPTIVE_EXECUTION_SECONDS_MIN = 10

ADAPTIVE_EXECUTION_SECONDS_MAX = 600

MICROSTRUCTURE_PARTICIPATION_FLOOR = Decimal("0.05")

MICROSTRUCTURE_EXECUTION_SCALE_MIN = Decimal("1.0")

MICROSTRUCTURE_EXECUTION_SCALE_MAX = Decimal("3.0")

MICROSTRUCTURE_SPREAD_BPS_PRESSURE = Decimal("8")

MICROSTRUCTURE_DEPTH_USD_PRESSURE = Decimal("800000")

MICROSTRUCTURE_HAZARD_PRESSURE = Decimal("0.8")

MICROSTRUCTURE_CRUMBLING_QUOTE_PROBABILITY_PRESSURE = Decimal("0.70")

MICROSTRUCTURE_LATENCY_PRESSURE_MS = 250

MICROSTRUCTURE_STRESSED_RATE_SCALE = Decimal("0.40")

MICROSTRUCTURE_COMPRESSED_RATE_SCALE = Decimal("0.65")

MICROSTRUCTURE_HIGH_SPREAD_RATE_SCALE = Decimal("0.70")

MICROSTRUCTURE_HAZARD_RATE_SCALE = Decimal("0.75")

MICROSTRUCTURE_CRUMBLING_QUOTE_RATE_SCALE = Decimal("0.65")

MICROSTRUCTURE_LOW_DEPTH_RATE_SCALE = Decimal("0.75")

MICROSTRUCTURE_STRESS_EXECUTION_SCALE = Decimal("1.40")

MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE = Decimal("1.10")

MICROSTRUCTURE_CRUMBLING_QUOTE_EXECUTION_SCALE = Decimal("1.15")

MICROSTRUCTURE_EXECUTION_SCALE_EPSILON = Decimal("0.01")

HIGH_CONVICTION_MARKET_SPREAD_BPS_MAX = Decimal("12")

HIGH_CONVICTION_BREAKOUT_CONTINUATION_RANK_MIN = Decimal("0.70")

HIGH_CONVICTION_BREAKOUT_MICROPRICE_BPS_MIN = Decimal("0.05")

HIGH_CONVICTION_WASHOUT_REVERSAL_RANK_MIN = Decimal("0.55")

HIGH_CONVICTION_WASHOUT_MICROPRICE_BPS_MIN = Decimal("0.05")

SIZING_LIMITING_CONSTRAINT_REASONS: frozenset[str] = frozenset(
    {
        "symbol_capacity_exhausted",
        "sell_inventory_unavailable",
        "gross_exposure_capacity_exhausted",
        "net_exposure_capacity_exhausted",
    }
)


def stringify_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


@dataclass(frozen=True)
class ExecutionPolicyConfig:
    min_notional: Optional[Decimal]
    max_notional: Optional[Decimal]
    max_participation_rate: Decimal
    allow_shorts: bool
    kill_switch_enabled: bool
    prefer_limit: bool


@dataclass(frozen=True)
class AdaptiveExecutionApplication:
    decision: AdaptiveExecutionPolicyDecision
    applied: bool
    reason: str

    def as_payload(self) -> dict[str, Any]:
        payload = self.decision.as_payload()
        payload["applied"] = self.applied
        payload["reason"] = self.reason
        return payload


@dataclass(frozen=True)
class ExecutionPolicyOutcome:
    approved: bool
    decision: StrategyDecision
    reasons: list[str]
    notional: Optional[Decimal]
    participation_rate: Optional[Decimal]
    impact_assumptions: dict[str, Any]
    selected_order_type: str
    adaptive: AdaptiveExecutionApplication | None
    advisor_metadata: dict[str, Any]
    microstructure_metadata: dict[str, Any]
    economic_policy_digest: str | None

    def params_update(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "execution_policy": {
                "approved": self.approved,
                "reasons": list(self.reasons),
                "notional": stringify_decimal(self.notional),
                "participation_rate": stringify_decimal(self.participation_rate),
                "selected_order_type": self.selected_order_type,
            },
            "impact_assumptions": self.impact_assumptions,
            "execution_advisor": self.advisor_metadata,
            "execution_microstructure": self.microstructure_metadata,
        }
        if self.adaptive is not None:
            payload["execution_policy"]["adaptive"] = self.adaptive.as_payload()
        pre_broker_intent = self.pre_broker_intent_payload()
        payload["economic_policy"] = {"digest": self.economic_policy_digest}
        payload["pre_broker_intent"] = pre_broker_intent
        return payload

    def pre_broker_intent_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": "torghut.pre-broker-intent.v1",
            "economic_policy_digest": self.economic_policy_digest,
            "symbol": self.decision.symbol.strip().upper(),
            "side": self.decision.action,
            "qty": str(self.decision.qty),
            "order_type": self.decision.order_type,
            "time_in_force": self.decision.time_in_force,
            "limit_price": stringify_decimal(self.decision.limit_price),
            "stop_price": stringify_decimal(self.decision.stop_price),
            "approved": self.approved,
            "reasons": list(self.reasons),
            "notional": stringify_decimal(self.notional),
            "participation_rate": stringify_decimal(self.participation_rate),
            "estimated_total_cost_bps": (
                self.impact_assumptions.get("estimate", {}).get("total_cost_bps")
            ),
        }
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        payload["digest"] = f"sha256:{hashlib.sha256(encoded).hexdigest()}"
        return payload


__all__ = [
    "ADAPTIVE_EXECUTION_SECONDS_MAX",
    "ADAPTIVE_EXECUTION_SECONDS_MIN",
    "ADAPTIVE_PARTICIPATION_RATE_FLOOR",
    "DEFAULT_EXECUTION_SECONDS",
    "HIGH_CONVICTION_BREAKOUT_CONTINUATION_RANK_MIN",
    "HIGH_CONVICTION_BREAKOUT_MICROPRICE_BPS_MIN",
    "HIGH_CONVICTION_MARKET_SPREAD_BPS_MAX",
    "HIGH_CONVICTION_WASHOUT_MICROPRICE_BPS_MIN",
    "HIGH_CONVICTION_WASHOUT_REVERSAL_RANK_MIN",
    "MICROSTRUCTURE_COMPRESSED_RATE_SCALE",
    "MICROSTRUCTURE_CRUMBLING_QUOTE_EXECUTION_SCALE",
    "MICROSTRUCTURE_CRUMBLING_QUOTE_PROBABILITY_PRESSURE",
    "MICROSTRUCTURE_CRUMBLING_QUOTE_RATE_SCALE",
    "MICROSTRUCTURE_DEPTH_USD_PRESSURE",
    "MICROSTRUCTURE_EXECUTION_SCALE_EPSILON",
    "MICROSTRUCTURE_EXECUTION_SCALE_MAX",
    "MICROSTRUCTURE_EXECUTION_SCALE_MIN",
    "MICROSTRUCTURE_HAZARD_PRESSURE",
    "MICROSTRUCTURE_HAZARD_RATE_SCALE",
    "MICROSTRUCTURE_HIGH_SPREAD_RATE_SCALE",
    "MICROSTRUCTURE_LATENCY_PRESSURE_MS",
    "MICROSTRUCTURE_LOW_DEPTH_RATE_SCALE",
    "MICROSTRUCTURE_PARTICIPATION_FLOOR",
    "MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE",
    "MICROSTRUCTURE_SPREAD_BPS_PRESSURE",
    "MICROSTRUCTURE_STRESSED_RATE_SCALE",
    "MICROSTRUCTURE_STRESS_EXECUTION_SCALE",
    "AdaptiveExecutionApplication",
    "ExecutionPolicyConfig",
    "ExecutionPolicyOutcome",
]

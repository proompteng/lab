"""Typed request and context objects for portfolio allocation."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

from ..fragility import FragilityAllocationAdjustment, FragilityState
from ..models import StrategyDecision

from .allocation_helpers import coerce_bool, mapping, optional_decimal
from .allocation_types import (
    AggregatedIntent,
    AllocationRuntime,
    StrategyFactoryAllocationProfile,
)


@dataclass(frozen=True)
class AllocationBatchContext:
    normalized_regime: str
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    fragility_adjustments: list[FragilityAllocationAdjustment]
    intents_and_fragility: list[tuple[AggregatedIntent, FragilityAllocationAdjustment]]
    enforce_fragility: bool
    portfolio_fragility_state: FragilityState


@dataclass(frozen=True)
class AllocationMultipliers:
    budget: Decimal
    capacity: Decimal


@dataclass(frozen=True)
class RegimeConfidence:
    multiplier: Decimal
    value: Optional[Decimal]
    low_confidence_applied: bool


@dataclass(frozen=True)
class IntentPlanBasics:
    decision: StrategyDecision
    price: Optional[Decimal]
    requested_notional: Optional[Decimal]
    correlation_group: str | None
    apply_fragility: bool


@dataclass(frozen=True)
class PlanMultiplierRequest:
    basics: IntentPlanBasics
    fragility_adjustment: FragilityAllocationAdjustment
    batch: AllocationBatchContext
    regime_confidence: RegimeConfidence
    strategy_factory_profile: StrategyFactoryAllocationProfile


@dataclass(frozen=True)
class IntentAllocationPlan:
    intent: AggregatedIntent
    fragility_adjustment: FragilityAllocationAdjustment
    decision: StrategyDecision
    price: Optional[Decimal]
    requested_notional: Optional[Decimal]
    correlation_group: str | None
    reason_codes: list[str]
    apply_fragility: bool
    multipliers: AllocationMultipliers
    regime_confidence: RegimeConfidence
    strategy_factory_profile: StrategyFactoryAllocationProfile
    normalized_regime: str
    portfolio_fragility_state: FragilityState


@dataclass(frozen=True)
class QuantityAllocationRequest:
    plan: IntentAllocationPlan
    runtime: AllocationRuntime


@dataclass(frozen=True)
class AllocationCapsRequest:
    plan: IntentAllocationPlan
    runtime: AllocationRuntime
    symbol_value: Decimal


@dataclass(frozen=True)
class FinalizeAllocationQtyRequest:
    decision: StrategyDecision
    price: Decimal
    approved_notional: Decimal
    current_qty: Decimal
    reason_codes: list[str]


@dataclass(frozen=True)
class AllocationQtyOutcome:
    adjusted_qty: Decimal
    approved: bool
    clipped: bool
    approved_notional: Decimal


@dataclass(frozen=True)
class AllocationUsageRequest:
    runtime: AllocationRuntime
    plan: IntentAllocationPlan
    approved_notional: Decimal


@dataclass(frozen=True)
class AllocationResultRequest:
    plan: IntentAllocationPlan
    adjusted_decision: StrategyDecision
    approved: bool
    clipped: bool
    approved_notional: Decimal


@dataclass(frozen=True)
class StrategyFactoryEvidence:
    posterior: dict[str, Any]
    comparator: dict[str, Any]
    sequential: dict[str, Any]
    calibration: dict[str, Any]

    @classmethod
    def from_params(cls, params: Mapping[str, Any]) -> StrategyFactoryEvidence:
        payload = mapping(params.get("strategy_factory"))
        if not payload:
            payload = mapping(params.get("research"))
        evidence = (
            mapping(payload.get("strategy_factory"))
            if payload.get("strategy_factory") is not None
            else payload
        )
        return cls(
            posterior=mapping(evidence.get("posterior_edge_summary")),
            comparator=mapping(evidence.get("null_comparator_summary")),
            sequential=mapping(evidence.get("sequential_trial")),
            calibration=mapping(evidence.get("cost_calibration")),
        )


@dataclass(frozen=True)
class StrategyFactoryScores:
    lower_bps: Decimal
    mean_bps: Decimal
    score: Decimal

    @classmethod
    def from_evidence(cls, evidence: StrategyFactoryEvidence) -> StrategyFactoryScores:
        lower_bps = optional_decimal(
            evidence.posterior.get("annualized_edge_lower_bps")
            or evidence.sequential.get("posterior_edge_lower")
        ) or Decimal("0")
        mean_bps = optional_decimal(
            evidence.posterior.get("annualized_edge_mean_bps")
            or evidence.sequential.get("posterior_edge_mean")
        ) or Decimal("0")
        score = max(lower_bps, Decimal("0")) + (
            max(mean_bps, Decimal("0")) / Decimal("2")
        )
        return cls(lower_bps=lower_bps, mean_bps=mean_bps, score=score)


@dataclass(frozen=True)
class StrategyFactoryStatus:
    sequential_status: str
    calibration_status: str
    baseline_outperformed: bool

    @classmethod
    def from_evidence(cls, evidence: StrategyFactoryEvidence) -> StrategyFactoryStatus:
        return cls(
            sequential_status=str(evidence.sequential.get("status") or "")
            .strip()
            .lower(),
            calibration_status=str(evidence.calibration.get("status") or "")
            .strip()
            .lower(),
            baseline_outperformed=coerce_bool(
                evidence.comparator.get("baseline_outperformed"),
                default=True,
            ),
        )


@dataclass(frozen=True)
class StrategyFactoryMultipliers:
    budget: Decimal
    capacity: Decimal
    reason_codes: list[str]


@dataclass(frozen=True)
class PassthroughResultRequest:
    decision: StrategyDecision
    batch: AllocationBatchContext
    fragility_adjustment: FragilityAllocationAdjustment
    multipliers: AllocationMultipliers


__all__ = [
    "AllocationBatchContext",
    "AllocationCapsRequest",
    "AllocationMultipliers",
    "AllocationQtyOutcome",
    "AllocationResultRequest",
    "AllocationUsageRequest",
    "FinalizeAllocationQtyRequest",
    "IntentAllocationPlan",
    "IntentPlanBasics",
    "PassthroughResultRequest",
    "PlanMultiplierRequest",
    "QuantityAllocationRequest",
    "RegimeConfidence",
    "StrategyFactoryEvidence",
    "StrategyFactoryMultipliers",
    "StrategyFactoryScores",
    "StrategyFactoryStatus",
]

"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Iterable, Optional

from ...config import settings
from ..fragility import (
    FragilityAllocationAdjustment,
    FragilityMonitor,
)
from ..models import StrategyDecision
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)


from .allocation_types import (
    ALLOCATOR_CLIP_CORRELATION_CAPACITY,
    ALLOCATOR_CLIP_GROSS_EXPOSURE,
    ALLOCATOR_CLIP_STRATEGY_BUDGET,
    ALLOCATOR_CLIP_SYMBOL_BUDGET,
    ALLOCATOR_CLIP_SYMBOL_CAPACITY,
    ALLOCATOR_REGIME_LOW_CONFIDENCE,
    ALLOCATOR_REJECT_GROSS_EXPOSURE,
    ALLOCATOR_REJECT_NO_PRICE,
    ALLOCATOR_REJECT_QTY_BELOW_MIN,
    ALLOCATOR_REJECT_SYMBOL_CAPACITY,
    ALLOCATOR_REJECT_ZERO_QTY,
    ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL,
    ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY,
    ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY,
    ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED,
    AggregatedIntent,
    AllocationConfig,
    AllocationResult,
    IntentAggregator,
    AllocationRuntime,
    StrategyFactoryAllocationProfile,
)
from .allocation_helpers import (
    decimal_str,
    extract_decision_price,
    has_fragility_signal,
    is_risk_increasing_trade,
    mapping,
    min_decimal,
    normalize_regime_label,
    optional_decimal,
    pct_equity_cap,
    portfolio_exposure,
    position_summary,
    resolve_regime_confidence_multiplier,
    strategy_weights,
    tighten_multiplier,
)
from .allocation_context import (
    AllocationBatchContext,
    AllocationCapsRequest,
    AllocationMultipliers,
    AllocationQtyOutcome,
    AllocationResultRequest,
    AllocationUsageRequest,
    FinalizeAllocationQtyRequest,
    IntentAllocationPlan,
    IntentPlanBasics,
    PassthroughResultRequest,
    PlanMultiplierRequest,
    QuantityAllocationRequest,
    RegimeConfidence,
    StrategyFactoryEvidence,
    StrategyFactoryMultipliers,
    StrategyFactoryScores,
    StrategyFactoryStatus,
)
from .fragility_settings import fragility_monitor_from_settings


class PortfolioAllocator:
    """Apply deterministic concentration/capacity clipping before hard risk checks."""

    def __init__(
        self,
        config: AllocationConfig,
        *,
        intent_aggregator: IntentAggregator | None = None,
        fragility_monitor: FragilityMonitor | None = None,
    ) -> None:
        self.config = config
        self.intent_aggregator = intent_aggregator or IntentAggregator()
        self.fragility_monitor = fragility_monitor or fragility_monitor_from_settings()

    def allocate(
        self,
        decisions: Iterable[StrategyDecision],
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
        regime_label: str | None = None,
    ) -> list[AllocationResult]:
        intents = self.intent_aggregator.aggregate(decisions)
        if not intents:
            return []

        batch = self._allocation_batch_context(intents, regime_label)
        if not self.config.enabled:
            return self._passthrough_results(batch)

        runtime = self._allocation_runtime(account=account, positions=positions)
        return [
            self._allocate_intent(
                QuantityAllocationRequest(
                    plan=self._intent_allocation_plan(
                        intent=intent,
                        fragility_adjustment=fragility_adjustment,
                        batch=batch,
                    ),
                    runtime=runtime,
                )
            )
            for intent, fragility_adjustment in batch.intents_and_fragility
        ]

    def _allocation_batch_context(
        self,
        intents: list[AggregatedIntent],
        regime_label: str | None,
    ) -> AllocationBatchContext:
        normalized_regime = normalize_regime_label(
            regime_label, default=self.config.default_regime
        )
        budget_multiplier = self._resolve_multiplier(
            self.config.regime_budget_multipliers,
            normalized_regime,
            self.config.default_budget_multiplier,
        )
        capacity_multiplier = self._resolve_multiplier(
            self.config.regime_capacity_multipliers,
            normalized_regime,
            self.config.default_capacity_multiplier,
        )
        fragility_adjustments = [
            self.fragility_monitor.evaluate(intent.decision) for intent in intents
        ]
        intents_and_fragility = sorted(
            zip(intents, fragility_adjustments, strict=False),
            key=lambda item: (
                self._strategy_factory_profile(item[0].decision.params).score
            ),
            reverse=True,
        )
        enforce_fragility = self.fragility_monitor.config.mode == "enforce"
        portfolio_fragility_state = self.fragility_monitor.worst_state(
            [item.snapshot.fragility_state for item in fragility_adjustments]
        )
        return AllocationBatchContext(
            normalized_regime=normalized_regime,
            budget_multiplier=budget_multiplier,
            capacity_multiplier=capacity_multiplier,
            fragility_adjustments=fragility_adjustments,
            intents_and_fragility=intents_and_fragility,
            enforce_fragility=enforce_fragility,
            portfolio_fragility_state=portfolio_fragility_state,
        )

    def _passthrough_results(
        self,
        batch: AllocationBatchContext,
    ) -> list[AllocationResult]:
        passthrough_results: list[AllocationResult] = []
        for aggregated_intent, fragility_adjustment in batch.intents_and_fragility:
            apply_fragility = batch.enforce_fragility and has_fragility_signal(
                aggregated_intent.decision
            )
            effective_budget, effective_capacity = (
                self._effective_allocation_multipliers(
                    apply_fragility=apply_fragility,
                    fragility_adjustment=fragility_adjustment,
                    base_budget_multiplier=batch.budget_multiplier,
                    base_capacity_multiplier=batch.capacity_multiplier,
                )
            )
            passthrough_results.append(
                self._result_from_passthrough(
                    PassthroughResultRequest(
                        decision=aggregated_intent.decision,
                        batch=batch,
                        fragility_adjustment=fragility_adjustment,
                        multipliers=AllocationMultipliers(
                            budget=effective_budget,
                            capacity=effective_capacity,
                        ),
                    ),
                )
            )
        return passthrough_results

    def _allocation_runtime(
        self,
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
    ) -> AllocationRuntime:
        current_positions = list(positions)
        current_gross_exposure, _ = portfolio_exposure(current_positions)
        return AllocationRuntime(
            equity=optional_decimal(account.get("equity")),
            current_positions=current_positions,
            current_gross_exposure=current_gross_exposure,
            approved_gross_delta=Decimal("0"),
            strategy_usage={},
            symbol_usage={},
            correlation_usage={},
        )

    def _allocate_intent(
        self,
        request: QuantityAllocationRequest,
    ) -> AllocationResult:
        outcome = self._allocate_intent_qty(request)
        adjusted_decision = request.plan.decision.model_copy(
            update={"qty": outcome.adjusted_qty}
        )
        if outcome.approved:
            self._record_allocation_usage(
                AllocationUsageRequest(
                    runtime=request.runtime,
                    plan=request.plan,
                    approved_notional=outcome.approved_notional,
                )
            )
        return self._allocation_result(
            AllocationResultRequest(
                plan=request.plan,
                adjusted_decision=adjusted_decision,
                approved=outcome.approved,
                clipped=outcome.clipped,
                approved_notional=outcome.approved_notional,
            )
        )

    def _intent_allocation_plan(
        self,
        *,
        intent: AggregatedIntent,
        fragility_adjustment: FragilityAllocationAdjustment,
        batch: AllocationBatchContext,
    ) -> IntentAllocationPlan:
        basics = self._intent_plan_basics(intent, batch)
        regime_confidence = self._regime_confidence(
            basics.decision, batch.normalized_regime
        )
        strategy_factory_profile = self._strategy_factory_profile(
            basics.decision.params
        )
        multipliers = self._plan_multipliers(
            PlanMultiplierRequest(
                basics=basics,
                fragility_adjustment=fragility_adjustment,
                batch=batch,
                regime_confidence=regime_confidence,
                strategy_factory_profile=strategy_factory_profile,
            )
        )
        reason_codes = self._plan_reason_codes(
            strategy_factory_profile=strategy_factory_profile,
            regime_confidence=regime_confidence,
            fragility_adjustment=fragility_adjustment,
            apply_fragility=basics.apply_fragility,
        )

        return IntentAllocationPlan(
            intent=intent,
            fragility_adjustment=fragility_adjustment,
            decision=basics.decision,
            price=basics.price,
            requested_notional=basics.requested_notional,
            correlation_group=basics.correlation_group,
            reason_codes=reason_codes,
            apply_fragility=basics.apply_fragility,
            multipliers=multipliers,
            regime_confidence=regime_confidence,
            strategy_factory_profile=strategy_factory_profile,
            normalized_regime=batch.normalized_regime,
            portfolio_fragility_state=batch.portfolio_fragility_state,
        )

    def _intent_plan_basics(
        self,
        intent: AggregatedIntent,
        batch: AllocationBatchContext,
    ) -> IntentPlanBasics:
        decision = intent.decision
        price = extract_decision_price(decision)
        requested_notional = None if price is None else abs(price * decision.qty)
        return IntentPlanBasics(
            decision=decision,
            price=price,
            requested_notional=requested_notional,
            correlation_group=self._resolve_correlation_group(decision),
            apply_fragility=batch.enforce_fragility and has_fragility_signal(decision),
        )

    def _regime_confidence(
        self,
        decision: StrategyDecision,
        normalized_regime: str,
    ) -> RegimeConfidence:
        multiplier, confidence, low_confidence_applied = (
            resolve_regime_confidence_multiplier(
                decision.params,
                regime_label=normalized_regime,
                threshold=self.config.regime_low_confidence_threshold,
                low_confidence_multiplier=self.config.regime_low_confidence_multiplier,
            )
        )
        return RegimeConfidence(
            multiplier=multiplier,
            value=confidence,
            low_confidence_applied=low_confidence_applied,
        )

    def _plan_multipliers(
        self,
        request: PlanMultiplierRequest,
    ) -> AllocationMultipliers:
        base_budget, base_capacity = self._effective_allocation_multipliers(
            apply_fragility=request.basics.apply_fragility,
            fragility_adjustment=request.fragility_adjustment,
            base_budget_multiplier=request.batch.budget_multiplier,
            base_capacity_multiplier=request.batch.capacity_multiplier,
        )
        return AllocationMultipliers(
            budget=self._effective_multiplier(
                base_budget * request.regime_confidence.multiplier,
                request.strategy_factory_profile.budget_multiplier,
            ),
            capacity=self._effective_multiplier(
                base_capacity * request.regime_confidence.multiplier,
                request.strategy_factory_profile.capacity_multiplier,
            ),
        )

    @staticmethod
    def _plan_reason_codes(
        *,
        strategy_factory_profile: StrategyFactoryAllocationProfile,
        regime_confidence: RegimeConfidence,
        fragility_adjustment: FragilityAllocationAdjustment,
        apply_fragility: bool,
    ) -> list[str]:
        reason_codes = list(strategy_factory_profile.reason_codes)
        if regime_confidence.low_confidence_applied:
            reason_codes.append(ALLOCATOR_REGIME_LOW_CONFIDENCE)
        if fragility_adjustment.stability_mode_active and apply_fragility:
            reason_codes.append("allocator_stability_mode_active")
        return reason_codes

    def _effective_allocation_multipliers(
        self,
        *,
        apply_fragility: bool,
        fragility_adjustment: FragilityAllocationAdjustment,
        base_budget_multiplier: Decimal,
        base_capacity_multiplier: Decimal,
    ) -> tuple[Decimal, Decimal]:
        fragility_budget = (
            fragility_adjustment.budget_multiplier if apply_fragility else Decimal("1")
        )
        fragility_capacity = (
            fragility_adjustment.capacity_multiplier
            if apply_fragility
            else Decimal("1")
        )
        return (
            self._effective_multiplier(base_budget_multiplier, fragility_budget),
            self._effective_multiplier(base_capacity_multiplier, fragility_capacity),
        )

    def _allocate_intent_qty(
        self,
        request: QuantityAllocationRequest,
    ) -> AllocationQtyOutcome:
        plan = request.plan
        rejected, adjusted_decision = self._reject_invalid_allocation(
            plan.decision, plan.price, plan.reason_codes
        )
        if rejected:
            return AllocationQtyOutcome(
                adjusted_qty=adjusted_decision.qty,
                approved=False,
                clipped=False,
                approved_notional=Decimal("0"),
            )
        if plan.price is None:
            raise RuntimeError("allocator_price_missing_after_validation")

        symbol_qty, symbol_value = position_summary(
            plan.decision.symbol, request.runtime.current_positions
        )
        if self._should_reject_crisis_entry(
            plan.apply_fragility,
            plan.fragility_adjustment,
            plan.decision.action,
            symbol_value,
        ):
            plan.reason_codes.append("allocator_reject_crisis_entry")
            return AllocationQtyOutcome(
                adjusted_qty=Decimal("0"),
                approved=False,
                clipped=False,
                approved_notional=Decimal("0"),
            )

        caps = self._allocation_caps(
            AllocationCapsRequest(
                plan=plan,
                runtime=request.runtime,
                symbol_value=symbol_value,
            )
        )
        approved_notional = self._approved_notional_after_caps(
            requested_notional=plan.requested_notional,
            caps=caps,
            reason_codes=plan.reason_codes,
        )
        return self._finalize_allocation_qty(
            FinalizeAllocationQtyRequest(
                decision=plan.decision,
                price=plan.price,
                approved_notional=approved_notional,
                current_qty=symbol_qty,
                reason_codes=plan.reason_codes,
            )
        )

    def _reject_invalid_allocation(
        self,
        decision: StrategyDecision,
        price: Optional[Decimal],
        reason_codes: list[str],
    ) -> tuple[bool, StrategyDecision]:
        if price is None or price <= 0:
            reason_codes.append(ALLOCATOR_REJECT_NO_PRICE)
            return True, decision.model_copy(update={"qty": Decimal("0")})
        if decision.qty <= 0:
            reason_codes.append(ALLOCATOR_REJECT_ZERO_QTY)
            return True, decision.model_copy(update={"qty": Decimal("0")})
        return False, decision

    def _should_reject_crisis_entry(
        self,
        apply_fragility: bool,
        fragility_adjustment: FragilityAllocationAdjustment,
        action: str,
        symbol_value: Decimal,
    ) -> bool:
        return (
            apply_fragility
            and fragility_adjustment.snapshot.fragility_state == "crisis"
            and is_risk_increasing_trade(action, symbol_value)
        )

    def _allocation_caps(
        self,
        request: AllocationCapsRequest,
    ) -> dict[str, Optional[Decimal]]:
        plan = request.plan
        decision = plan.decision
        base_symbol_cap = self._symbol_cap(request.runtime.equity)
        effective_symbol_cap: Optional[Decimal] = None
        if base_symbol_cap is not None:
            effective_symbol_cap = (
                base_symbol_cap * plan.multipliers.budget * plan.multipliers.capacity
            )

        return {
            ALLOCATOR_CLIP_SYMBOL_CAPACITY: effective_symbol_cap,
            ALLOCATOR_CLIP_GROSS_EXPOSURE: self._gross_cap(
                current_gross_exposure=request.runtime.current_gross_exposure,
                approved_gross_delta=request.runtime.approved_gross_delta,
                symbol_value=request.symbol_value,
                budget_multiplier=plan.multipliers.budget,
            ),
            ALLOCATOR_CLIP_STRATEGY_BUDGET: self._strategy_budget_cap(
                strategy_signed_qty=plan.intent.strategy_signed_qty,
                action=decision.action,
                strategy_usage=request.runtime.strategy_usage,
                budget_multiplier=plan.multipliers.budget,
            ),
            ALLOCATOR_CLIP_SYMBOL_BUDGET: self._symbol_budget_cap(
                symbol=decision.symbol,
                symbol_usage=request.runtime.symbol_usage,
                budget_multiplier=plan.multipliers.budget,
            ),
            ALLOCATOR_CLIP_CORRELATION_CAPACITY: self._correlation_budget_cap(
                group=plan.correlation_group,
                correlation_usage=request.runtime.correlation_usage,
                budget_multiplier=plan.multipliers.budget,
            ),
        }

    def _approved_notional_after_caps(
        self,
        *,
        requested_notional: Optional[Decimal],
        caps: dict[str, Optional[Decimal]],
        reason_codes: list[str],
    ) -> Decimal:
        approved_notional = requested_notional or Decimal("0")
        for reason_code, cap in caps.items():
            if cap is None:
                continue
            if cap <= 0:
                approved_notional = Decimal("0")
                reason_codes.append(reason_code.replace("_clip_", "_reject_"))
                continue
            if approved_notional > cap:
                approved_notional = cap
                reason_codes.append(reason_code)
        return approved_notional

    def _finalize_allocation_qty(
        self,
        request: FinalizeAllocationQtyRequest,
    ) -> AllocationQtyOutcome:
        target_qty = request.approved_notional / request.price
        resolution = resolve_quantity_resolution(
            request.decision.symbol,
            action=request.decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=request.current_qty,
            requested_qty=target_qty,
        )
        adjusted_qty = quantize_qty_for_symbol(
            request.decision.symbol,
            target_qty,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        min_qty = min_qty_for_symbol(
            request.decision.symbol,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        if adjusted_qty < min_qty:
            if request.approved_notional > 0:
                request.reason_codes.append(ALLOCATOR_REJECT_QTY_BELOW_MIN)
            elif (
                ALLOCATOR_REJECT_SYMBOL_CAPACITY not in request.reason_codes
                and ALLOCATOR_REJECT_GROSS_EXPOSURE not in request.reason_codes
            ):
                request.reason_codes.append(ALLOCATOR_REJECT_SYMBOL_CAPACITY)
            return AllocationQtyOutcome(
                adjusted_qty=Decimal("0"),
                approved=False,
                clipped=False,
                approved_notional=Decimal("0"),
            )

        return AllocationQtyOutcome(
            adjusted_qty=adjusted_qty,
            approved=True,
            clipped=adjusted_qty != request.decision.qty,
            approved_notional=request.price * adjusted_qty,
        )

    def _record_allocation_usage(
        self,
        request: AllocationUsageRequest,
    ) -> None:
        request.runtime.approved_gross_delta += request.approved_notional
        allocation_weights = strategy_weights(
            request.plan.intent.strategy_signed_qty,
            request.plan.decision.action,
        )
        for strategy_id, weight in allocation_weights:
            if weight <= 0:
                continue
            request.runtime.strategy_usage[strategy_id] = (
                request.runtime.strategy_usage.get(strategy_id, Decimal("0"))
                + (request.approved_notional * weight)
            )
        symbol_key = request.plan.decision.symbol.strip().upper()
        request.runtime.symbol_usage[symbol_key] = (
            request.runtime.symbol_usage.get(symbol_key, Decimal("0"))
            + request.approved_notional
        )
        if request.plan.correlation_group:
            request.runtime.correlation_usage[request.plan.correlation_group] = (
                request.runtime.correlation_usage.get(
                    request.plan.correlation_group, Decimal("0")
                )
                + request.approved_notional
            )

    def _allocation_result(
        self,
        request: AllocationResultRequest,
    ) -> AllocationResult:
        plan = request.plan
        unique_reason_codes = sorted(set(plan.reason_codes))
        params = dict(plan.decision.params)
        allocator_payload: dict[str, Any] = {
            "enabled": self.config.enabled,
            "regime_label": plan.normalized_regime,
            "budget_multiplier": decimal_str(plan.multipliers.budget),
            "capacity_multiplier": decimal_str(plan.multipliers.capacity),
            "requested_qty": str(plan.decision.qty),
            "approved_qty": str(request.adjusted_decision.qty),
            "requested_notional": decimal_str(plan.requested_notional),
            "approved_notional": decimal_str(request.approved_notional),
            "status": "approved" if request.approved else "rejected",
            "clipped": request.clipped,
            "regime_confidence": decimal_str(plan.regime_confidence.value),
            "regime_low_confidence_threshold": decimal_str(
                self.config.regime_low_confidence_threshold
            ),
            "regime_low_confidence_multiplier": decimal_str(
                self.config.regime_low_confidence_multiplier
            ),
            "regime_low_confidence_applied": plan.regime_confidence.low_confidence_applied,
            "reason_codes": unique_reason_codes,
            "correlation_group": plan.correlation_group,
            "strategy_factory_score": decimal_str(plan.strategy_factory_profile.score),
        }
        allocator_payload["strategy_factory"] = plan.strategy_factory_profile.payload
        allocator_payload.update(plan.fragility_adjustment.to_allocator_payload())
        allocator_payload["portfolio_fragility_state"] = plan.portfolio_fragility_state
        params["fragility_snapshot"] = plan.fragility_adjustment.snapshot.to_payload()
        current_allocator = dict(mapping(params.get("allocator")))
        current_allocator.update(allocator_payload)
        params["allocator"] = current_allocator
        adjusted_decision = request.adjusted_decision.model_copy(
            update={"params": params}
        )
        return AllocationResult(
            decision=adjusted_decision,
            approved=request.approved,
            clipped=request.clipped,
            reason_codes=tuple(unique_reason_codes),
            regime_label=plan.normalized_regime,
            fragility_state=plan.fragility_adjustment.snapshot.fragility_state,
            fragility_score=plan.fragility_adjustment.snapshot.fragility_score,
            stability_mode_active=plan.fragility_adjustment.stability_mode_active,
            budget_multiplier=plan.multipliers.budget,
            capacity_multiplier=plan.multipliers.capacity,
            requested_notional=plan.requested_notional,
            approved_notional=request.approved_notional,
        )

    def _resolve_multiplier(
        self,
        values: dict[str, Decimal],
        regime_label: str,
        default: Decimal,
    ) -> Decimal:
        raw = values.get(regime_label, values.get("default", default))
        return min(
            self.config.max_multiplier,
            max(self.config.min_multiplier, raw),
        )

    def _effective_multiplier(
        self, base_multiplier: Decimal, fragility_multiplier: Decimal
    ) -> Decimal:
        combined = base_multiplier * tighten_multiplier(fragility_multiplier)
        return min(
            self.config.max_multiplier,
            max(self.config.min_multiplier, combined),
        )

    def _strategy_factory_profile(
        self, params: Mapping[str, Any]
    ) -> StrategyFactoryAllocationProfile:
        evidence = StrategyFactoryEvidence.from_params(params)
        scores = StrategyFactoryScores.from_evidence(evidence)
        status = StrategyFactoryStatus.from_evidence(evidence)
        multipliers = self._strategy_factory_multipliers(status, scores)
        strategy_payload = self._strategy_factory_payload(
            status=status,
            scores=scores,
            multipliers=multipliers,
        )
        return StrategyFactoryAllocationProfile(
            score=scores.score,
            budget_multiplier=multipliers.budget,
            capacity_multiplier=multipliers.capacity,
            reason_codes=tuple(sorted(set(multipliers.reason_codes))),
            payload=strategy_payload,
        )

    @staticmethod
    def _strategy_factory_multipliers(
        status: StrategyFactoryStatus,
        scores: StrategyFactoryScores,
    ) -> StrategyFactoryMultipliers:
        reason_codes: list[str] = []
        budget_multiplier = Decimal("1")
        capacity_multiplier = Decimal("1")
        if not status.baseline_outperformed:
            reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL)
            budget_multiplier = Decimal("0")
            capacity_multiplier = Decimal("0")
        elif status.sequential_status == "observe_only":
            reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY)
            budget_multiplier = Decimal("0")
            capacity_multiplier = Decimal("0")
        else:
            if status.sequential_status == "paper_only":
                reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY)
                budget_multiplier = Decimal("0.50")
                capacity_multiplier = Decimal("0.50")
            if status.calibration_status and status.calibration_status != "calibrated":
                reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED)
                budget_multiplier = min(budget_multiplier, Decimal("0.75"))
                capacity_multiplier = min(capacity_multiplier, Decimal("0.75"))
            if not reason_codes and scores.score > 0:
                uplift = min(scores.score / Decimal("100"), Decimal("0.50"))
                budget_multiplier = Decimal("1") + uplift
                capacity_multiplier = Decimal("1") + min(
                    max(scores.mean_bps, Decimal("0")) / Decimal("150"),
                    Decimal("0.50"),
                )
        return StrategyFactoryMultipliers(
            budget=budget_multiplier,
            capacity=capacity_multiplier,
            reason_codes=reason_codes,
        )

    @staticmethod
    def _strategy_factory_payload(
        *,
        status: StrategyFactoryStatus,
        scores: StrategyFactoryScores,
        multipliers: StrategyFactoryMultipliers,
    ) -> dict[str, Any]:
        return {
            "sequential_status": status.sequential_status or None,
            "cost_calibration_status": status.calibration_status or None,
            "baseline_outperformed": status.baseline_outperformed,
            "annualized_edge_mean_bps": decimal_str(scores.mean_bps),
            "annualized_edge_lower_bps": decimal_str(scores.lower_bps),
            "budget_multiplier": decimal_str(multipliers.budget),
            "capacity_multiplier": decimal_str(multipliers.capacity),
            "reason_codes": sorted(set(multipliers.reason_codes)),
        }

    def _symbol_cap(self, equity: Optional[Decimal]) -> Optional[Decimal]:
        symbol_pct_cap = pct_equity_cap(self.config.max_symbol_pct_equity, equity)
        return min_decimal(self.config.max_symbol_notional, symbol_pct_cap)

    def _gross_cap(
        self,
        *,
        current_gross_exposure: Decimal,
        approved_gross_delta: Decimal,
        symbol_value: Decimal,
        budget_multiplier: Decimal,
    ) -> Optional[Decimal]:
        if self.config.max_gross_exposure is None:
            return None
        budget_cap = self.config.max_gross_exposure * budget_multiplier
        available = budget_cap - (
            current_gross_exposure + approved_gross_delta - abs(symbol_value)
        )
        if available <= 0:
            return Decimal("0")
        return available

    def _strategy_budget_cap(
        self,
        *,
        strategy_signed_qty: tuple[tuple[str, Decimal], ...],
        action: str,
        strategy_usage: dict[str, Decimal],
        budget_multiplier: Decimal,
    ) -> Optional[Decimal]:
        weights = strategy_weights(strategy_signed_qty, action)
        cap: Optional[Decimal] = None
        for strategy_id, weight in weights:
            strategy_cap = self.config.strategy_notional_caps.get(strategy_id)
            if strategy_cap is None:
                continue
            effective_cap = strategy_cap * budget_multiplier
            remaining = effective_cap - strategy_usage.get(strategy_id, Decimal("0"))
            candidate = Decimal("0") if remaining <= 0 else remaining / weight
            cap = candidate if cap is None else min(cap, candidate)
        return cap

    def _symbol_budget_cap(
        self,
        *,
        symbol: str,
        symbol_usage: dict[str, Decimal],
        budget_multiplier: Decimal,
    ) -> Optional[Decimal]:
        symbol_key = symbol.strip().upper()
        symbol_cap = self.config.symbol_notional_caps.get(symbol_key)
        if symbol_cap is None:
            return None
        effective_cap = symbol_cap * budget_multiplier
        remaining = effective_cap - symbol_usage.get(symbol_key, Decimal("0"))
        if remaining <= 0:
            return Decimal("0")
        return remaining

    def _correlation_budget_cap(
        self,
        *,
        group: Optional[str],
        correlation_usage: dict[str, Decimal],
        budget_multiplier: Decimal,
    ) -> Optional[Decimal]:
        if not group:
            return None
        group_cap = self.config.correlation_group_caps.get(group)
        if group_cap is None:
            return None
        effective_cap = group_cap * budget_multiplier
        remaining = effective_cap - correlation_usage.get(group, Decimal("0"))
        if remaining <= 0:
            return Decimal("0")
        return remaining

    def _resolve_correlation_group(self, decision: StrategyDecision) -> Optional[str]:
        params_group = decision.params.get("correlation_group")
        if isinstance(params_group, str) and params_group.strip():
            return params_group.strip().lower()
        symbol_key = decision.symbol.strip().upper()
        return self.config.symbol_correlation_groups.get(symbol_key)

    def _result_from_passthrough(
        self,
        request: PassthroughResultRequest,
    ) -> AllocationResult:
        decision = request.decision
        params = dict(decision.params)
        current_allocator = dict(mapping(params.get("allocator")))
        current_allocator.update(
            {
                "enabled": False,
                "status": "approved",
                "clipped": False,
                "reason_codes": [],
                "regime_label": request.batch.normalized_regime,
                "budget_multiplier": decimal_str(request.multipliers.budget),
                "capacity_multiplier": decimal_str(request.multipliers.capacity),
                "requested_qty": str(decision.qty),
                "approved_qty": str(decision.qty),
                "regime_confidence": None,
                "regime_low_confidence_threshold": None,
                "regime_low_confidence_multiplier": None,
                "regime_low_confidence_applied": False,
            }
        )
        current_allocator.update(request.fragility_adjustment.to_allocator_payload())
        current_allocator["portfolio_fragility_state"] = (
            request.batch.portfolio_fragility_state
        )
        params["fragility_snapshot"] = (
            request.fragility_adjustment.snapshot.to_payload()
        )
        params["allocator"] = current_allocator
        passthrough_decision = decision.model_copy(update={"params": params})
        price = extract_decision_price(passthrough_decision)
        requested_notional = (
            None if price is None else abs(price * passthrough_decision.qty)
        )
        return AllocationResult(
            decision=passthrough_decision,
            approved=True,
            clipped=False,
            reason_codes=(),
            regime_label=request.batch.normalized_regime,
            fragility_state=request.fragility_adjustment.snapshot.fragility_state,
            fragility_score=request.fragility_adjustment.snapshot.fragility_score,
            stability_mode_active=request.fragility_adjustment.stability_mode_active,
            budget_multiplier=request.multipliers.budget,
            capacity_multiplier=request.multipliers.capacity,
            requested_notional=requested_notional,
            approved_notional=requested_notional,
        )


__all__ = ["PortfolioAllocator"]

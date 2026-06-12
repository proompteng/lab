# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Mapping
from typing import Any, Callable, Iterable, Optional, cast

from ...config import settings
from ...models import Strategy
from ..fragility import (
    FragilityAllocationAdjustment,
    FragilityMonitor,
    FragilityMonitorConfig,
    FragilityState,
)
from ..regime_hmm import resolve_hmm_context
from ..models import StrategyDecision
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_26 import *


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

        normalized_regime = _normalize_regime_label(
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

        if not self.config.enabled:
            return self._passthrough_results(
                intents=intents,
                fragility_adjustments=fragility_adjustments,
                normalized_regime=normalized_regime,
                portfolio_fragility_state=portfolio_fragility_state,
                budget_multiplier=budget_multiplier,
                capacity_multiplier=capacity_multiplier,
                enforce_fragility=enforce_fragility,
            )

        runtime = self._allocation_runtime(account=account, positions=positions)
        results: list[AllocationResult] = []
        for intent, fragility_adjustment in intents_and_fragility:
            results.append(
                self._allocate_intent(
                    intent=intent,
                    fragility_adjustment=fragility_adjustment,
                    runtime=runtime,
                    normalized_regime=normalized_regime,
                    base_budget_multiplier=budget_multiplier,
                    base_capacity_multiplier=capacity_multiplier,
                    enforce_fragility=enforce_fragility,
                    portfolio_fragility_state=portfolio_fragility_state,
                )
            )
        return results

    def _passthrough_results(
        self,
        *,
        intents: list[AggregatedIntent],
        fragility_adjustments: list[FragilityAllocationAdjustment],
        normalized_regime: str,
        portfolio_fragility_state: FragilityState,
        budget_multiplier: Decimal,
        capacity_multiplier: Decimal,
        enforce_fragility: bool,
    ) -> list[AllocationResult]:
        passthrough_results: list[AllocationResult] = []
        for intent, fragility_adjustment in sorted(
            zip(intents, fragility_adjustments, strict=False),
            key=lambda item: (
                self._strategy_factory_profile(item[0].decision.params).score
            ),
            reverse=True,
        ):
            apply_fragility = enforce_fragility and _has_fragility_signal(
                intent.decision
            )
            effective_budget, effective_capacity = (
                self._effective_allocation_multipliers(
                    apply_fragility=apply_fragility,
                    fragility_adjustment=fragility_adjustment,
                    base_budget_multiplier=budget_multiplier,
                    base_capacity_multiplier=capacity_multiplier,
                )
            )
            passthrough_results.append(
                self._result_from_passthrough(
                    intent.decision,
                    regime_label=normalized_regime,
                    fragility_adjustment=fragility_adjustment,
                    portfolio_fragility_state=portfolio_fragility_state,
                    budget_multiplier=effective_budget,
                    capacity_multiplier=effective_capacity,
                )
            )
        return passthrough_results

    def _allocation_runtime(
        self,
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
    ) -> _AllocationRuntime:
        current_positions = list(positions)
        current_gross_exposure, _ = _portfolio_exposure(current_positions)
        return _AllocationRuntime(
            equity=_optional_decimal(account.get("equity")),
            current_positions=current_positions,
            current_gross_exposure=current_gross_exposure,
            approved_gross_delta=Decimal("0"),
            strategy_usage={},
            symbol_usage={},
            correlation_usage={},
        )

    def _allocate_intent(
        self,
        *,
        intent: AggregatedIntent,
        fragility_adjustment: FragilityAllocationAdjustment,
        runtime: _AllocationRuntime,
        normalized_regime: str,
        base_budget_multiplier: Decimal,
        base_capacity_multiplier: Decimal,
        enforce_fragility: bool,
        portfolio_fragility_state: FragilityState,
    ) -> AllocationResult:
        decision = intent.decision
        price = _extract_decision_price(decision)
        requested_notional = None if price is None else abs(price * decision.qty)
        correlation_group = self._resolve_correlation_group(decision)
        reason_codes: list[str] = []
        apply_fragility = enforce_fragility and _has_fragility_signal(decision)
        effective_budget_multiplier, effective_capacity_multiplier = (
            self._effective_allocation_multipliers(
                apply_fragility=apply_fragility,
                fragility_adjustment=fragility_adjustment,
                base_budget_multiplier=base_budget_multiplier,
                base_capacity_multiplier=base_capacity_multiplier,
            )
        )
        (
            confidence_multiplier,
            regime_confidence,
            low_confidence_applied,
        ) = _resolve_regime_confidence_multiplier(
            decision.params,
            regime_label=normalized_regime,
            threshold=self.config.regime_low_confidence_threshold,
            low_confidence_multiplier=self.config.regime_low_confidence_multiplier,
        )
        effective_budget_multiplier *= confidence_multiplier
        effective_capacity_multiplier *= confidence_multiplier
        strategy_factory_profile = self._strategy_factory_profile(decision.params)
        effective_budget_multiplier = self._effective_multiplier(
            effective_budget_multiplier, strategy_factory_profile.budget_multiplier
        )
        effective_capacity_multiplier = self._effective_multiplier(
            effective_capacity_multiplier, strategy_factory_profile.capacity_multiplier
        )
        reason_codes.extend(strategy_factory_profile.reason_codes)
        if low_confidence_applied:
            reason_codes.append(ALLOCATOR_REGIME_LOW_CONFIDENCE)
        if fragility_adjustment.stability_mode_active and apply_fragility:
            reason_codes.append("allocator_stability_mode_active")

        adjusted_decision, approved, clipped, approved_notional = (
            self._allocate_intent_qty(
                intent=intent,
                runtime=runtime,
                price=price,
                correlation_group=correlation_group,
                reason_codes=reason_codes,
                apply_fragility=apply_fragility,
                fragility_adjustment=fragility_adjustment,
                effective_budget_multiplier=effective_budget_multiplier,
                effective_capacity_multiplier=effective_capacity_multiplier,
                requested_notional=requested_notional,
            )
        )
        return self._allocation_result(
            decision=decision,
            adjusted_decision=adjusted_decision,
            approved=approved,
            clipped=clipped,
            reason_codes=reason_codes,
            requested_notional=requested_notional,
            approved_notional=approved_notional,
            correlation_group=correlation_group,
            normalized_regime=normalized_regime,
            fragility_adjustment=fragility_adjustment,
            portfolio_fragility_state=portfolio_fragility_state,
            effective_budget_multiplier=effective_budget_multiplier,
            effective_capacity_multiplier=effective_capacity_multiplier,
            regime_confidence=regime_confidence,
            regime_low_confidence_applied=low_confidence_applied,
            strategy_factory_profile=strategy_factory_profile,
        )

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
        *,
        intent: AggregatedIntent,
        runtime: _AllocationRuntime,
        price: Optional[Decimal],
        correlation_group: str | None,
        reason_codes: list[str],
        apply_fragility: bool,
        fragility_adjustment: FragilityAllocationAdjustment,
        effective_budget_multiplier: Decimal,
        effective_capacity_multiplier: Decimal,
        requested_notional: Optional[Decimal],
    ) -> tuple[StrategyDecision, bool, bool, Decimal]:
        decision = intent.decision
        rejected, adjusted_decision = self._reject_invalid_allocation(
            decision, price, reason_codes
        )
        if rejected:
            return adjusted_decision, False, False, Decimal("0")
        if price is None:
            raise RuntimeError("allocator_price_missing_after_validation")

        symbol_qty, symbol_value = _position_summary(
            decision.symbol, runtime.current_positions
        )
        if self._should_reject_crisis_entry(
            apply_fragility, fragility_adjustment, decision.action, symbol_value
        ):
            reason_codes.append("allocator_reject_crisis_entry")
            adjusted_decision = decision.model_copy(update={"qty": Decimal("0")})
            return adjusted_decision, False, False, Decimal("0")

        caps = self._allocation_caps(
            intent=intent,
            runtime=runtime,
            symbol_value=symbol_value,
            correlation_group=correlation_group,
            effective_budget_multiplier=effective_budget_multiplier,
            effective_capacity_multiplier=effective_capacity_multiplier,
        )
        approved_notional = self._approved_notional_after_caps(
            requested_notional=requested_notional,
            caps=caps,
            reason_codes=reason_codes,
        )
        adjusted_qty, approved, clipped, approved_notional = (
            self._finalize_allocation_qty(
                decision=decision,
                price=price,
                approved_notional=approved_notional,
                current_qty=symbol_qty,
                reason_codes=reason_codes,
            )
        )
        adjusted_decision = decision.model_copy(update={"qty": adjusted_qty})
        if approved:
            self._record_allocation_usage(
                runtime=runtime,
                decision=decision,
                intent=intent,
                correlation_group=correlation_group,
                approved_notional=approved_notional,
            )
        return adjusted_decision, approved, clipped, approved_notional

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
            and _is_risk_increasing_trade(action, symbol_value)
        )

    def _allocation_caps(
        self,
        *,
        intent: AggregatedIntent,
        runtime: _AllocationRuntime,
        symbol_value: Decimal,
        correlation_group: str | None,
        effective_budget_multiplier: Decimal,
        effective_capacity_multiplier: Decimal,
    ) -> dict[str, Optional[Decimal]]:
        decision = intent.decision
        base_symbol_cap = self._symbol_cap(runtime.equity)
        effective_symbol_cap: Optional[Decimal] = None
        if base_symbol_cap is not None:
            effective_symbol_cap = (
                base_symbol_cap
                * effective_budget_multiplier
                * effective_capacity_multiplier
            )

        return {
            ALLOCATOR_CLIP_SYMBOL_CAPACITY: effective_symbol_cap,
            ALLOCATOR_CLIP_GROSS_EXPOSURE: self._gross_cap(
                current_gross_exposure=runtime.current_gross_exposure,
                approved_gross_delta=runtime.approved_gross_delta,
                symbol_value=symbol_value,
                budget_multiplier=effective_budget_multiplier,
            ),
            ALLOCATOR_CLIP_STRATEGY_BUDGET: self._strategy_budget_cap(
                strategy_signed_qty=intent.strategy_signed_qty,
                action=decision.action,
                strategy_usage=runtime.strategy_usage,
                budget_multiplier=effective_budget_multiplier,
            ),
            ALLOCATOR_CLIP_SYMBOL_BUDGET: self._symbol_budget_cap(
                symbol=decision.symbol,
                symbol_usage=runtime.symbol_usage,
                budget_multiplier=effective_budget_multiplier,
            ),
            ALLOCATOR_CLIP_CORRELATION_CAPACITY: self._correlation_budget_cap(
                group=correlation_group,
                correlation_usage=runtime.correlation_usage,
                budget_multiplier=effective_budget_multiplier,
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
        *,
        decision: StrategyDecision,
        price: Decimal,
        approved_notional: Decimal,
        current_qty: Decimal,
        reason_codes: list[str],
    ) -> tuple[Decimal, bool, bool, Decimal]:
        target_qty = approved_notional / price
        resolution = resolve_quantity_resolution(
            decision.symbol,
            action=decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=current_qty,
            requested_qty=target_qty,
        )
        adjusted_qty = quantize_qty_for_symbol(
            decision.symbol,
            target_qty,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        min_qty = min_qty_for_symbol(
            decision.symbol, fractional_equities_enabled=resolution.fractional_allowed
        )
        if adjusted_qty < min_qty:
            if approved_notional > 0:
                reason_codes.append(ALLOCATOR_REJECT_QTY_BELOW_MIN)
            elif (
                ALLOCATOR_REJECT_SYMBOL_CAPACITY not in reason_codes
                and ALLOCATOR_REJECT_GROSS_EXPOSURE not in reason_codes
            ):
                reason_codes.append(ALLOCATOR_REJECT_SYMBOL_CAPACITY)
            return Decimal("0"), False, False, Decimal("0")

        clipped = adjusted_qty != decision.qty
        return adjusted_qty, True, clipped, price * adjusted_qty

    def _record_allocation_usage(
        self,
        *,
        runtime: _AllocationRuntime,
        decision: StrategyDecision,
        intent: AggregatedIntent,
        correlation_group: str | None,
        approved_notional: Decimal,
    ) -> None:
        runtime.approved_gross_delta += approved_notional
        allocation_weights = _strategy_weights(
            intent.strategy_signed_qty, decision.action
        )
        for strategy_id, weight in allocation_weights:
            if weight <= 0:
                continue
            runtime.strategy_usage[strategy_id] = runtime.strategy_usage.get(
                strategy_id, Decimal("0")
            ) + (approved_notional * weight)
        symbol_key = decision.symbol.strip().upper()
        runtime.symbol_usage[symbol_key] = (
            runtime.symbol_usage.get(symbol_key, Decimal("0")) + approved_notional
        )
        if correlation_group:
            runtime.correlation_usage[correlation_group] = (
                runtime.correlation_usage.get(correlation_group, Decimal("0"))
                + approved_notional
            )

    def _allocation_result(
        self,
        *,
        decision: StrategyDecision,
        adjusted_decision: StrategyDecision,
        approved: bool,
        clipped: bool,
        reason_codes: list[str],
        requested_notional: Optional[Decimal],
        approved_notional: Decimal,
        correlation_group: str | None,
        normalized_regime: str,
        fragility_adjustment: FragilityAllocationAdjustment,
        portfolio_fragility_state: FragilityState,
        effective_budget_multiplier: Decimal,
        effective_capacity_multiplier: Decimal,
        regime_confidence: Optional[Decimal],
        regime_low_confidence_applied: bool,
        strategy_factory_profile: _StrategyFactoryAllocationProfile,
    ) -> AllocationResult:
        unique_reason_codes = sorted(set(reason_codes))
        params = dict(decision.params)
        allocator_payload: dict[str, Any] = {
            "enabled": self.config.enabled,
            "regime_label": normalized_regime,
            "budget_multiplier": _decimal_str(effective_budget_multiplier),
            "capacity_multiplier": _decimal_str(effective_capacity_multiplier),
            "requested_qty": str(decision.qty),
            "approved_qty": str(adjusted_decision.qty),
            "requested_notional": _decimal_str(requested_notional),
            "approved_notional": _decimal_str(approved_notional),
            "status": "approved" if approved else "rejected",
            "clipped": clipped,
            "regime_confidence": _decimal_str(regime_confidence),
            "regime_low_confidence_threshold": _decimal_str(
                self.config.regime_low_confidence_threshold
            ),
            "regime_low_confidence_multiplier": _decimal_str(
                self.config.regime_low_confidence_multiplier
            ),
            "regime_low_confidence_applied": regime_low_confidence_applied,
            "reason_codes": unique_reason_codes,
            "correlation_group": correlation_group,
            "strategy_factory_score": _decimal_str(strategy_factory_profile.score),
        }
        allocator_payload["strategy_factory"] = strategy_factory_profile.payload
        allocator_payload.update(fragility_adjustment.to_allocator_payload())
        allocator_payload["portfolio_fragility_state"] = portfolio_fragility_state
        params["fragility_snapshot"] = fragility_adjustment.snapshot.to_payload()
        current_allocator = dict(_mapping(params.get("allocator")))
        current_allocator.update(allocator_payload)
        params["allocator"] = current_allocator
        adjusted_decision = adjusted_decision.model_copy(update={"params": params})
        return AllocationResult(
            decision=adjusted_decision,
            approved=approved,
            clipped=clipped,
            reason_codes=tuple(unique_reason_codes),
            regime_label=normalized_regime,
            fragility_state=fragility_adjustment.snapshot.fragility_state,
            fragility_score=fragility_adjustment.snapshot.fragility_score,
            stability_mode_active=fragility_adjustment.stability_mode_active,
            budget_multiplier=effective_budget_multiplier,
            capacity_multiplier=effective_capacity_multiplier,
            requested_notional=requested_notional,
            approved_notional=approved_notional,
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
        combined = base_multiplier * _tighten_multiplier(fragility_multiplier)
        return min(
            self.config.max_multiplier,
            max(self.config.min_multiplier, combined),
        )

    def _strategy_factory_profile(
        self, params: Mapping[str, Any]
    ) -> _StrategyFactoryAllocationProfile:
        payload = _mapping(params.get("strategy_factory"))
        if not payload:
            payload = _mapping(params.get("research"))
        evidence = (
            _mapping(payload.get("strategy_factory"))
            if payload.get("strategy_factory") is not None
            else payload
        )
        posterior = _mapping(evidence.get("posterior_edge_summary"))
        comparator = _mapping(evidence.get("null_comparator_summary"))
        sequential = _mapping(evidence.get("sequential_trial"))
        calibration = _mapping(evidence.get("cost_calibration"))
        reason_codes: list[str] = []

        lower_bps = _optional_decimal(
            posterior.get("annualized_edge_lower_bps")
            or sequential.get("posterior_edge_lower")
        ) or Decimal("0")
        mean_bps = _optional_decimal(
            posterior.get("annualized_edge_mean_bps")
            or sequential.get("posterior_edge_mean")
        ) or Decimal("0")
        score = max(lower_bps, Decimal("0")) + (
            max(mean_bps, Decimal("0")) / Decimal("2")
        )
        sequential_status = str(sequential.get("status") or "").strip().lower()
        calibration_status = str(calibration.get("status") or "").strip().lower()
        baseline_outperformed = _coerce_bool(
            comparator.get("baseline_outperformed"), default=True
        )

        budget_multiplier = Decimal("1")
        capacity_multiplier = Decimal("1")
        if not baseline_outperformed:
            reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL)
            budget_multiplier = Decimal("0")
            capacity_multiplier = Decimal("0")
        elif sequential_status == "observe_only":
            reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY)
            budget_multiplier = Decimal("0")
            capacity_multiplier = Decimal("0")
        else:
            if sequential_status == "paper_only":
                reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY)
                budget_multiplier = Decimal("0.50")
                capacity_multiplier = Decimal("0.50")
            if calibration_status and calibration_status != "calibrated":
                reason_codes.append(ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED)
                budget_multiplier = min(budget_multiplier, Decimal("0.75"))
                capacity_multiplier = min(capacity_multiplier, Decimal("0.75"))
            if not reason_codes and score > 0:
                uplift = min(score / Decimal("100"), Decimal("0.50"))
                budget_multiplier = Decimal("1") + uplift
                capacity_multiplier = Decimal("1") + min(
                    max(mean_bps, Decimal("0")) / Decimal("150"),
                    Decimal("0.50"),
                )

        strategy_payload = {
            "sequential_status": sequential_status or None,
            "cost_calibration_status": calibration_status or None,
            "baseline_outperformed": baseline_outperformed,
            "annualized_edge_mean_bps": _decimal_str(mean_bps),
            "annualized_edge_lower_bps": _decimal_str(lower_bps),
            "budget_multiplier": _decimal_str(budget_multiplier),
            "capacity_multiplier": _decimal_str(capacity_multiplier),
            "reason_codes": sorted(set(reason_codes)),
        }
        return _StrategyFactoryAllocationProfile(
            score=score,
            budget_multiplier=budget_multiplier,
            capacity_multiplier=capacity_multiplier,
            reason_codes=tuple(sorted(set(reason_codes))),
            payload=strategy_payload,
        )

    def _symbol_cap(self, equity: Optional[Decimal]) -> Optional[Decimal]:
        symbol_pct_cap = _pct_equity_cap(self.config.max_symbol_pct_equity, equity)
        return _min_decimal(self.config.max_symbol_notional, symbol_pct_cap)

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
        weights = _strategy_weights(strategy_signed_qty, action)
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

    @staticmethod
    def _result_from_passthrough(
        decision: StrategyDecision,
        *,
        regime_label: str,
        fragility_adjustment: FragilityAllocationAdjustment,
        portfolio_fragility_state: FragilityState,
        budget_multiplier: Decimal,
        capacity_multiplier: Decimal,
    ) -> AllocationResult:
        params = dict(decision.params)
        current_allocator = dict(_mapping(params.get("allocator")))
        current_allocator.update(
            {
                "enabled": False,
                "status": "approved",
                "clipped": False,
                "reason_codes": [],
                "regime_label": regime_label,
                "budget_multiplier": _decimal_str(budget_multiplier),
                "capacity_multiplier": _decimal_str(capacity_multiplier),
                "requested_qty": str(decision.qty),
                "approved_qty": str(decision.qty),
                "regime_confidence": None,
                "regime_low_confidence_threshold": None,
                "regime_low_confidence_multiplier": None,
                "regime_low_confidence_applied": False,
            }
        )
        current_allocator.update(fragility_adjustment.to_allocator_payload())
        current_allocator["portfolio_fragility_state"] = portfolio_fragility_state
        params["fragility_snapshot"] = fragility_adjustment.snapshot.to_payload()
        params["allocator"] = current_allocator
        passthrough_decision = decision.model_copy(update={"params": params})
        price = _extract_decision_price(passthrough_decision)
        requested_notional = (
            None if price is None else abs(price * passthrough_decision.qty)
        )
        return AllocationResult(
            decision=passthrough_decision,
            approved=True,
            clipped=False,
            reason_codes=(),
            regime_label=regime_label,
            fragility_state=fragility_adjustment.snapshot.fragility_state,
            fragility_score=fragility_adjustment.snapshot.fragility_score,
            stability_mode_active=fragility_adjustment.stability_mode_active,
            budget_multiplier=budget_multiplier,
            capacity_multiplier=capacity_multiplier,
            requested_notional=requested_notional,
            approved_notional=requested_notional,
        )


__all__ = [name for name in globals() if not name.startswith("__")]

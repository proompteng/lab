"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Mapping
from typing import Any, Callable, Iterable, Optional, cast

from ..config import settings
from ..models import Strategy
from .fragility import (
    FragilityAllocationAdjustment,
    FragilityMonitor,
    FragilityMonitorConfig,
    FragilityState,
)
from .models import StrategyDecision
from .quantity_rules import min_qty_for_symbol, quantize_qty_for_symbol

ALLOCATOR_REJECT_NO_PRICE = "allocator_reject_no_price"
ALLOCATOR_REJECT_ZERO_QTY = "allocator_reject_zero_qty"
ALLOCATOR_REJECT_SYMBOL_CAPACITY = "allocator_reject_symbol_capacity"
ALLOCATOR_REJECT_GROSS_EXPOSURE = "allocator_reject_gross_exposure"
ALLOCATOR_REJECT_QTY_BELOW_MIN = "allocator_reject_qty_below_min"
ALLOCATOR_REJECT_STRATEGY_BUDGET = "allocator_reject_strategy_budget"
ALLOCATOR_REJECT_SYMBOL_BUDGET = "allocator_reject_symbol_budget"
ALLOCATOR_REJECT_CORRELATION_CAPACITY = "allocator_reject_correlation_capacity"
ALLOCATOR_CLIP_SYMBOL_CAPACITY = "allocator_clip_symbol_capacity"
ALLOCATOR_CLIP_GROSS_EXPOSURE = "allocator_clip_gross_exposure"
ALLOCATOR_CLIP_STRATEGY_BUDGET = "allocator_clip_strategy_budget"
ALLOCATOR_CLIP_SYMBOL_BUDGET = "allocator_clip_symbol_budget"
ALLOCATOR_CLIP_CORRELATION_CAPACITY = "allocator_clip_correlation_capacity"


@dataclass(frozen=True)
class AggregatedIntent:
    decision: StrategyDecision
    source_strategy_ids: tuple[str, ...]
    source_decision_count: int
    had_conflict: bool
    strategy_signed_qty: tuple[tuple[str, Decimal], ...]


@dataclass(frozen=True)
class AllocationConfig:
    enabled: bool
    default_regime: str
    default_budget_multiplier: Decimal
    default_capacity_multiplier: Decimal
    min_multiplier: Decimal
    max_multiplier: Decimal
    max_symbol_pct_equity: Optional[Decimal]
    max_symbol_notional: Optional[Decimal]
    max_gross_exposure: Optional[Decimal]
    strategy_notional_caps: dict[str, Decimal]
    symbol_notional_caps: dict[str, Decimal]
    correlation_group_caps: dict[str, Decimal]
    symbol_correlation_groups: dict[str, str]
    regime_budget_multipliers: dict[str, Decimal]
    regime_capacity_multipliers: dict[str, Decimal]


@dataclass(frozen=True)
class AllocationResult:
    decision: StrategyDecision
    approved: bool
    clipped: bool
    reason_codes: tuple[str, ...]
    regime_label: str
    fragility_state: FragilityState
    fragility_score: Decimal
    stability_mode_active: bool
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    requested_notional: Optional[Decimal]
    approved_notional: Optional[Decimal]


@dataclass
class _AllocationRuntime:
    equity: Optional[Decimal]
    current_positions: list[dict[str, Any]]
    current_gross_exposure: Decimal
    approved_gross_delta: Decimal
    strategy_usage: dict[str, Decimal]
    symbol_usage: dict[str, Decimal]
    correlation_usage: dict[str, Decimal]


@dataclass(frozen=True)
class PortfolioSizingConfig:
    notional_per_position: Optional[Decimal]
    volatility_target: Optional[Decimal]
    volatility_floor: Decimal
    max_positions: Optional[int]
    max_notional_per_symbol: Optional[Decimal]
    max_position_pct_equity: Optional[Decimal]
    max_gross_exposure: Optional[Decimal]
    max_net_exposure: Optional[Decimal]


@dataclass(frozen=True)
class PortfolioSizingResult:
    decision: StrategyDecision
    approved: bool
    reasons: list[str]
    audit: dict[str, Any]


class PortfolioSizer:
    """Apply deterministic portfolio sizing rules."""

    def __init__(self, config: PortfolioSizingConfig) -> None:
        self.config = config

    def size(
        self,
        decision: StrategyDecision,
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
    ) -> PortfolioSizingResult:
        price = _extract_decision_price(decision)
        volatility = _optional_decimal(decision.params.get("volatility"))
        equity = _optional_decimal(account.get("equity"))

        current_positions = list(positions)
        current_count = _count_positions(current_positions)
        current_qty, current_value = _position_summary(
            decision.symbol, current_positions
        )
        gross_exposure, net_exposure = _portfolio_exposure(current_positions)

        audit = self._build_size_audit(
            decision=decision,
            price=price,
            volatility=volatility,
            equity=equity,
            current_count=current_count,
            current_qty=current_qty,
            current_value=current_value,
            gross_exposure=gross_exposure,
            net_exposure=net_exposure,
        )

        if price is None or price <= 0:
            return self._skipped_size_result(decision, audit, "missing_price")

        base_notional = price * decision.qty
        notional = self._resolve_base_notional(decision, base_notional)
        if notional is None or notional <= 0:
            return self._skipped_size_result(decision, audit, "missing_notional")

        notional, applied_methods = self._apply_sizing_methods(
            decision=decision,
            notional=notional,
            volatility=volatility,
        )
        caps, reasons = self._collect_size_caps(
            decision=decision,
            current_count=current_count,
            current_qty=current_qty,
            current_value=current_value,
            gross_exposure=gross_exposure,
            net_exposure=net_exposure,
            equity=equity,
        )

        if caps:
            notional, cap_methods = _apply_caps(notional, caps)
            applied_methods.extend(cap_methods)

        qty, notional, approved, reasons = self._finalize_sized_order(
            decision=decision,
            price=price,
            notional=notional,
            reasons=reasons,
        )

        audit["output"] = {
            "status": "approved" if approved else "rejected",
            "final_qty": _decimal_str(qty),
            "final_notional": _decimal_str(notional),
            "methods": applied_methods,
            "caps": {key: _decimal_str(value) for key, value in caps.items()},
            "reasons": list(reasons),
        }

        updated_params = dict(decision.params)
        updated_params["portfolio_sizing"] = audit
        updated_decision = decision.model_copy(
            update={"qty": qty, "params": updated_params}
        )
        return PortfolioSizingResult(
            decision=updated_decision, approved=approved, reasons=reasons, audit=audit
        )

    def _build_size_audit(
        self,
        *,
        decision: StrategyDecision,
        price: Optional[Decimal],
        volatility: Optional[Decimal],
        equity: Optional[Decimal],
        current_count: int,
        current_qty: Decimal,
        current_value: Decimal,
        gross_exposure: Decimal,
        net_exposure: Decimal,
    ) -> dict[str, Any]:
        return {
            "inputs": {
                "symbol": decision.symbol,
                "action": decision.action,
                "base_qty": str(decision.qty),
                "price": _decimal_str(price),
                "volatility": _decimal_str(volatility),
                "equity": _decimal_str(equity),
                "current_positions": current_count,
                "current_symbol_qty": _decimal_str(current_qty),
                "current_symbol_value": _decimal_str(current_value),
                "gross_exposure": _decimal_str(gross_exposure),
                "net_exposure": _decimal_str(net_exposure),
            },
            "config": _config_payload(self.config),
            "output": {},
        }

    def _skipped_size_result(
        self,
        decision: StrategyDecision,
        audit: dict[str, Any],
        reason: str,
    ) -> PortfolioSizingResult:
        audit["output"] = {"status": "skipped", "reason": reason}
        return PortfolioSizingResult(decision=decision, approved=True, reasons=[], audit=audit)

    def _apply_sizing_methods(
        self,
        *,
        decision: StrategyDecision,
        notional: Decimal,
        volatility: Optional[Decimal],
    ) -> tuple[Decimal, list[str]]:
        notional, regime_method = _apply_allocator_regime_multiplier(notional, decision.params)
        notional, vol_method = self._apply_volatility_scaling(notional, volatility)
        notional, allocator_cap_method = _cap_by_allocator_approved_notional(notional, decision.params)
        methods = [method for method in (regime_method, vol_method, allocator_cap_method) if method]
        return notional, methods

    def _collect_size_caps(
        self,
        *,
        decision: StrategyDecision,
        current_count: int,
        current_qty: Decimal,
        current_value: Decimal,
        gross_exposure: Decimal,
        net_exposure: Decimal,
        equity: Optional[Decimal],
    ) -> tuple[dict[str, Optional[Decimal]], list[str]]:
        reasons: list[str] = []
        if _should_block_new_position(self.config.max_positions, current_count, current_qty):
            reasons.append("max_positions_exceeded")

        caps: dict[str, Optional[Decimal]] = {}
        symbol_cap = _min_decimal(
            self.config.max_notional_per_symbol,
            _pct_equity_cap(self.config.max_position_pct_equity, equity),
        )
        per_symbol_cap = _remaining_symbol_capacity(
            symbol_cap,
            current_value=current_value,
            action=decision.action,
            allow_shorts=settings.trading_allow_shorts,
        )
        if per_symbol_cap is not None:
            caps["per_symbol"] = per_symbol_cap

        if decision.action == "sell" and not settings.trading_allow_shorts:
            if current_qty <= 0:
                reasons.append("shorts_not_allowed")
            caps["sell_inventory"] = max(current_value, Decimal("0"))

        gross_cap = _gross_cap_for_symbol(
            self.config.max_gross_exposure,
            gross_exposure,
            current_value,
            decision.action,
        )
        if gross_cap is not None:
            caps["gross_exposure"] = gross_cap

        net_cap = _net_cap_for_trade(self.config.max_net_exposure, net_exposure, decision.action)
        if net_cap is not None:
            caps["net_exposure"] = net_cap
        return caps, reasons

    def _finalize_sized_order(
        self,
        *,
        decision: StrategyDecision,
        price: Decimal,
        notional: Decimal,
        reasons: list[str],
    ) -> tuple[Decimal, Decimal, bool, list[str]]:
        qty = quantize_qty_for_symbol(decision.symbol, notional / price)
        min_qty = min_qty_for_symbol(decision.symbol)
        if qty < min_qty and "shorts_not_allowed" not in reasons:
            reasons.append("qty_below_min")

        approved = len(reasons) == 0
        if not approved:
            return Decimal("0"), Decimal("0"), False, reasons
        return qty, notional, True, reasons

    def _resolve_base_notional(
        self, decision: StrategyDecision, base_notional: Decimal
    ) -> Optional[Decimal]:
        if (
            self.config.notional_per_position is not None
            and self.config.notional_per_position > 0
        ):
            allocator_cap = _allocator_approved_notional(decision.params)
            if allocator_cap is not None and allocator_cap > 0:
                return min(self.config.notional_per_position, allocator_cap)
            return self.config.notional_per_position
        return base_notional

    def _apply_volatility_scaling(
        self,
        notional: Decimal,
        volatility: Optional[Decimal],
    ) -> tuple[Decimal, Optional[str]]:
        if self.config.volatility_target is None or self.config.volatility_target <= 0:
            return notional, None
        if volatility is None or volatility <= 0:
            return notional, "volatility_missing"
        effective_vol = max(volatility, self.config.volatility_floor)
        if effective_vol <= 0:
            return notional, "volatility_floor_zero"
        scaled = notional * (self.config.volatility_target / effective_vol)
        return scaled, "volatility_scaled"


class IntentAggregator:
    """Merge per-signal strategy decisions into deterministic symbol-level intents."""

    def aggregate(
        self, decisions: Iterable[StrategyDecision]
    ) -> list[AggregatedIntent]:
        grouped: dict[tuple[str, str, str, str], list[StrategyDecision]] = {}
        for decision in decisions:
            key = (
                decision.symbol,
                decision.timeframe,
                decision.order_type,
                decision.time_in_force,
            )
            grouped.setdefault(key, []).append(decision)

        aggregated: list[AggregatedIntent] = []
        for key in sorted(grouped):
            bucket = sorted(
                grouped[key],
                key=lambda item: (
                    item.strategy_id,
                    item.event_ts.isoformat(),
                    item.action,
                    item.symbol,
                    str(item.qty),
                ),
            )
            if not bucket:
                continue

            buy_qty = sum(
                (item.qty for item in bucket if item.action == "buy"), Decimal("0")
            )
            sell_qty = sum(
                (item.qty for item in bucket if item.action == "sell"), Decimal("0")
            )
            had_conflict = buy_qty > 0 and sell_qty > 0
            strategy_signed_qty: dict[str, Decimal] = {}
            for item in bucket:
                signed_qty = item.qty if item.action == "buy" else -item.qty
                strategy_signed_qty[item.strategy_id] = (
                    strategy_signed_qty.get(item.strategy_id, Decimal("0"))
                    + signed_qty
                )

            if buy_qty == sell_qty:
                # Deterministic tie-break avoids dropping throughput when intents cancel exactly.
                chosen_action = bucket[0].action
                chosen_qty = buy_qty if chosen_action == "buy" else sell_qty
            elif buy_qty > sell_qty:
                chosen_action = "buy"
                chosen_qty = buy_qty - sell_qty
            else:
                chosen_action = "sell"
                chosen_qty = sell_qty - buy_qty

            primary = bucket[0]
            chosen_qty = quantize_qty_for_symbol(primary.symbol, chosen_qty)
            params = dict(primary.params)
            allocator_meta = dict(_mapping(params.get("allocator")))
            allocator_meta.update(
                {
                    "intent_aggregated": True,
                    "intent_conflict_resolved": had_conflict,
                    "source_strategy_ids": [item.strategy_id for item in bucket],
                    "source_decision_count": len(bucket),
                }
            )
            params["allocator"] = allocator_meta

            aggregated_decision = primary.model_copy(
                update={
                    "action": chosen_action,
                    "qty": chosen_qty,
                    "params": params,
                }
            )
            aggregated.append(
                AggregatedIntent(
                    decision=aggregated_decision,
                    source_strategy_ids=tuple(item.strategy_id for item in bucket),
                    source_decision_count=len(bucket),
                    had_conflict=had_conflict,
                    strategy_signed_qty=tuple(
                        (strategy_id, qty)
                        for strategy_id, qty in sorted(strategy_signed_qty.items())
                    ),
                )
            )

        return aggregated


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
        fragility_adjustments = [self.fragility_monitor.evaluate(intent.decision) for intent in intents]
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
        for intent, fragility_adjustment in zip(intents, fragility_adjustments, strict=False):
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
        for intent, fragility_adjustment in zip(intents, fragility_adjustments, strict=False):
            apply_fragility = enforce_fragility and _has_fragility_signal(intent.decision)
            effective_budget, effective_capacity = self._effective_allocation_multipliers(
                apply_fragility=apply_fragility,
                fragility_adjustment=fragility_adjustment,
                base_budget_multiplier=budget_multiplier,
                base_capacity_multiplier=capacity_multiplier,
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
        effective_budget_multiplier, effective_capacity_multiplier = self._effective_allocation_multipliers(
            apply_fragility=apply_fragility,
            fragility_adjustment=fragility_adjustment,
            base_budget_multiplier=base_budget_multiplier,
            base_capacity_multiplier=base_capacity_multiplier,
        )
        if fragility_adjustment.stability_mode_active and apply_fragility:
            reason_codes.append("allocator_stability_mode_active")

        adjusted_decision, approved, clipped, approved_notional = self._allocate_intent_qty(
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
        )

    def _effective_allocation_multipliers(
        self,
        *,
        apply_fragility: bool,
        fragility_adjustment: FragilityAllocationAdjustment,
        base_budget_multiplier: Decimal,
        base_capacity_multiplier: Decimal,
    ) -> tuple[Decimal, Decimal]:
        fragility_budget = fragility_adjustment.budget_multiplier if apply_fragility else Decimal("1")
        fragility_capacity = fragility_adjustment.capacity_multiplier if apply_fragility else Decimal("1")
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
        rejected, adjusted_decision = self._reject_invalid_allocation(decision, price, reason_codes)
        if rejected:
            return adjusted_decision, False, False, Decimal("0")
        if price is None:
            raise RuntimeError("allocator_price_missing_after_validation")

        _, symbol_value = _position_summary(decision.symbol, runtime.current_positions)
        if self._should_reject_crisis_entry(apply_fragility, fragility_adjustment, decision.action, symbol_value):
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
        adjusted_qty, approved, clipped, approved_notional = self._finalize_allocation_qty(
            decision=decision,
            price=price,
            approved_notional=approved_notional,
            reason_codes=reason_codes,
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
            effective_symbol_cap = base_symbol_cap * effective_budget_multiplier * effective_capacity_multiplier

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
        reason_codes: list[str],
    ) -> tuple[Decimal, bool, bool, Decimal]:
        adjusted_qty = quantize_qty_for_symbol(decision.symbol, approved_notional / price)
        min_qty = min_qty_for_symbol(decision.symbol)
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
        allocation_weights = _strategy_weights(intent.strategy_signed_qty, decision.action)
        for strategy_id, weight in allocation_weights:
            if weight <= 0:
                continue
            runtime.strategy_usage[strategy_id] = (
                runtime.strategy_usage.get(strategy_id, Decimal("0")) + (approved_notional * weight)
            )
        symbol_key = decision.symbol.strip().upper()
        runtime.symbol_usage[symbol_key] = runtime.symbol_usage.get(symbol_key, Decimal("0")) + approved_notional
        if correlation_group:
            runtime.correlation_usage[correlation_group] = (
                runtime.correlation_usage.get(correlation_group, Decimal("0")) + approved_notional
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
    ) -> AllocationResult:
        unique_reason_codes = sorted(set(reason_codes))
        params = dict(decision.params)
        allocator_payload = {
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
            "reason_codes": unique_reason_codes,
            "correlation_group": correlation_group,
        }
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


def sizer_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizer:
    return PortfolioSizer(_config_from_settings(strategy, equity))


def allocator_from_settings(equity: Optional[Decimal]) -> PortfolioAllocator:
    max_gross_exposure = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_gross_exposure),
        _pct_equity_cap(
            _optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity),
            equity,
        ),
    )
    correlation_group_caps = dict(settings.trading_allocator_correlation_group_caps)
    correlation_group_caps.update(
        settings.trading_allocator_correlation_group_notional_caps
    )
    symbol_correlation_groups = dict(settings.trading_allocator_symbol_correlation_groups)
    symbol_correlation_groups.update(settings.trading_allocator_correlation_symbol_groups)
    return PortfolioAllocator(
        AllocationConfig(
            enabled=settings.trading_allocator_enabled,
            default_regime=_normalize_regime_label(
                settings.trading_allocator_default_regime,
                default="neutral",
            ),
            default_budget_multiplier=_optional_decimal(
                settings.trading_allocator_default_budget_multiplier
            )
            or Decimal("1"),
            default_capacity_multiplier=_optional_decimal(
                settings.trading_allocator_default_capacity_multiplier
            )
            or Decimal("1"),
            min_multiplier=_optional_decimal(settings.trading_allocator_min_multiplier)
            or Decimal("0"),
            max_multiplier=_optional_decimal(settings.trading_allocator_max_multiplier)
            or Decimal("2"),
            max_symbol_pct_equity=_min_decimal(
                _optional_decimal(settings.trading_allocator_max_symbol_pct_equity),
                _optional_decimal(settings.trading_max_position_pct_equity),
            ),
            max_symbol_notional=_min_decimal(
                _optional_decimal(settings.trading_allocator_max_symbol_notional),
                _optional_decimal(settings.trading_portfolio_max_notional_per_symbol),
            ),
            max_gross_exposure=max_gross_exposure,
            strategy_notional_caps=_decimal_map(
                settings.trading_allocator_strategy_notional_caps
            ),
            symbol_notional_caps=_decimal_map(
                settings.trading_allocator_symbol_notional_caps,
                normalize_key=lambda key: key.strip().upper(),
            ),
            correlation_group_caps=_decimal_map(
                correlation_group_caps,
                normalize_key=lambda key: key.strip().lower(),
            ),
            symbol_correlation_groups={
                str(key).strip().upper(): str(value).strip().lower()
                for key, value in symbol_correlation_groups.items()
                if str(key).strip() and str(value).strip()
            },
            regime_budget_multipliers=_decimal_map(
                settings.trading_allocator_regime_budget_multipliers
            ),
            regime_capacity_multipliers=_decimal_map(
                settings.trading_allocator_regime_capacity_multipliers
            ),
        )
    )


def fragility_monitor_from_settings() -> FragilityMonitor:
    return FragilityMonitor(
        FragilityMonitorConfig(
            mode=settings.trading_fragility_mode,
            unknown_state=settings.trading_fragility_unknown_state,
            elevated_threshold=_optional_decimal(
                settings.trading_fragility_elevated_threshold
            )
            or Decimal("0.35"),
            stress_threshold=_optional_decimal(
                settings.trading_fragility_stress_threshold
            )
            or Decimal("0.55"),
            crisis_threshold=_optional_decimal(
                settings.trading_fragility_crisis_threshold
            )
            or Decimal("0.80"),
            state_budget_multipliers={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_budget_multipliers
                ).items()
            },
            state_capacity_multipliers={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_capacity_multipliers
                ).items()
            },
            state_participation_clamps={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_participation_clamps
                ).items()
            },
            state_abstain_bias={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_abstain_bias
                ).items()
            },
        )
    )


def _config_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizingConfig:
    max_notional = _min_decimal(
        _optional_decimal(strategy.max_notional_per_trade),
        _optional_decimal(settings.trading_max_notional_per_trade),
        _optional_decimal(settings.trading_portfolio_max_notional_per_symbol),
    )
    max_pct_equity = _min_decimal(
        _optional_decimal(strategy.max_position_pct_equity),
        _optional_decimal(settings.trading_max_position_pct_equity),
    )
    gross_cap = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_gross_exposure),
        _pct_equity_cap(
            _optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity),
            equity,
        ),
    )
    net_cap = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_net_exposure),
        _pct_equity_cap(
            _optional_decimal(settings.trading_portfolio_max_net_exposure_pct_equity),
            equity,
        ),
    )
    return PortfolioSizingConfig(
        notional_per_position=_optional_decimal(
            settings.trading_portfolio_notional_per_position
        ),
        volatility_target=_optional_decimal(
            settings.trading_portfolio_volatility_target
        ),
        volatility_floor=_optional_decimal(settings.trading_portfolio_volatility_floor)
        or Decimal("0"),
        max_positions=settings.trading_portfolio_max_positions,
        max_notional_per_symbol=max_notional,
        max_position_pct_equity=max_pct_equity,
        max_gross_exposure=gross_cap,
        max_net_exposure=net_cap,
    )


def _should_block_new_position(
    max_positions: Optional[int],
    current_count: int,
    current_qty: Decimal,
) -> bool:
    if max_positions is None or max_positions <= 0:
        return False
    if current_qty != 0:
        return False
    return current_count >= max_positions


def _count_positions(positions: Iterable[dict[str, Any]]) -> int:
    count = 0
    for position in positions:
        qty = _optional_decimal(position.get("qty") or position.get("quantity"))
        if qty is None or qty == 0:
            continue
        count += 1
    return count


def _portfolio_exposure(positions: Iterable[dict[str, Any]]) -> tuple[Decimal, Decimal]:
    gross = Decimal("0")
    net = Decimal("0")
    for position in positions:
        value = _optional_decimal(position.get("market_value"))
        if value is None:
            continue
        gross += abs(value)
        net += value
    return gross, net


def _position_summary(
    symbol: str, positions: Iterable[dict[str, Any]]
) -> tuple[Decimal, Decimal]:
    total_qty = Decimal("0")
    total_value = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty") or position.get("quantity"))
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
        value = _optional_decimal(position.get("market_value"))
        if value is not None:
            total_value += value
    return total_qty, total_value


def _gross_cap_for_symbol(
    max_gross: Optional[Decimal],
    current_gross: Decimal,
    current_value: Decimal,
    action: str,
) -> Optional[Decimal]:
    if max_gross is None or max_gross <= 0:
        return None
    gross_cap_for_symbol = max_gross - (current_gross - abs(current_value))
    if gross_cap_for_symbol <= 0:
        return Decimal("0")
    if action == "buy":
        return gross_cap_for_symbol - current_value
    return gross_cap_for_symbol + current_value


def _net_cap_for_trade(
    max_net: Optional[Decimal], current_net: Decimal, action: str
) -> Optional[Decimal]:
    if max_net is None or max_net <= 0:
        return None
    if action == "buy":
        return max_net - current_net
    return max_net + current_net


def _apply_caps(
    notional: Decimal,
    caps: dict[str, Optional[Decimal]],
) -> tuple[Decimal, list[str]]:
    methods: list[str] = []
    capped = notional
    for key, value in caps.items():
        if value is None:
            continue
        if value <= 0:
            capped = Decimal("0")
            methods.append(f"cap_{key}_zero")
            continue
        if capped > value:
            capped = value
            methods.append(f"cap_{key}")
    return capped, methods


def _remaining_symbol_capacity(
    absolute_cap: Optional[Decimal],
    *,
    current_value: Decimal,
    action: str,
    allow_shorts: bool,
) -> Optional[Decimal]:
    if absolute_cap is None:
        return None
    if action == "buy":
        if current_value >= 0:
            return max(Decimal("0"), absolute_cap - current_value)
        return max(Decimal("0"), absolute_cap + abs(current_value))
    if allow_shorts:
        if current_value <= 0:
            return max(Decimal("0"), absolute_cap - abs(current_value))
        return max(Decimal("0"), current_value + absolute_cap)
    return max(Decimal("0"), current_value)


def _extract_decision_price(decision: StrategyDecision) -> Optional[Decimal]:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            try:
                return Decimal(str(value))
            except (ArithmeticError, ValueError):
                continue
    return None


def _config_payload(config: PortfolioSizingConfig) -> dict[str, Any]:
    return {
        "notional_per_position": _decimal_str(config.notional_per_position),
        "volatility_target": _decimal_str(config.volatility_target),
        "volatility_floor": _decimal_str(config.volatility_floor),
        "max_positions": config.max_positions,
        "max_notional_per_symbol": _decimal_str(config.max_notional_per_symbol),
        "max_position_pct_equity": _decimal_str(config.max_position_pct_equity),
        "max_gross_exposure": _decimal_str(config.max_gross_exposure),
        "max_net_exposure": _decimal_str(config.max_net_exposure),
    }


def _pct_equity_cap(
    max_pct: Optional[Decimal], equity: Optional[Decimal]
) -> Optional[Decimal]:
    if max_pct is None or equity is None:
        return None
    if max_pct <= 0 or equity <= 0:
        return None
    return equity * max_pct


def _min_decimal(*values: Optional[Decimal]) -> Optional[Decimal]:
    result: Optional[Decimal] = None
    for value in values:
        if value is None:
            continue
        if value <= 0:
            continue
        if result is None or value < result:
            result = value
    return result


def _optional_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _decimal_str(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _normalize_regime_label(value: str | None, *, default: str) -> str:
    if value is None:
        return default
    normalized = value.strip().lower()
    if not normalized:
        return default
    return normalized


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        mapped = cast(Mapping[str, Any], value)
        return {str(key): item for key, item in mapped.items()}
    return {}


def _decimal_map(
    values: dict[str, float], normalize_key: Callable[[str], str] | None = None
) -> dict[str, Decimal]:
    result: dict[str, Decimal] = {}
    for key in sorted(values):
        value = values[key]
        decimal_value = _optional_decimal(value)
        if decimal_value is None:
            continue
        normalized_key = key.strip().lower()
        if normalize_key is not None:
            normalized_key = normalize_key(key)
        if not normalized_key:
            continue
        result[normalized_key] = decimal_value
    return result


def _fragility_decimal_map(values: Mapping[str, float]) -> dict[FragilityState, Decimal]:
    result: dict[FragilityState, Decimal] = {}
    for key, value in values.items():
        normalized_key = key.strip().lower()
        if normalized_key not in {"normal", "elevated", "stress", "crisis"}:
            continue
        decimal_value = _optional_decimal(value)
        if decimal_value is None:
            continue
        result[cast(FragilityState, normalized_key)] = decimal_value
    return result


def _tighten_multiplier(value: Decimal) -> Decimal:
    if value < 0:
        return Decimal("0")
    if value > 1:
        return Decimal("1")
    return value


def _is_risk_increasing_trade(action: str, symbol_value: Decimal) -> bool:
    if action == "buy":
        return symbol_value >= 0
    return symbol_value <= 0


def _has_fragility_signal(decision: StrategyDecision) -> bool:
    keys = (
        "fragility_state",
        "fragility_score",
        "spread_acceleration",
        "liquidity_compression",
        "crowding_proxy",
        "correlation_concentration",
    )
    params = decision.params

    snapshot_payload = params.get("fragility_snapshot")
    if isinstance(snapshot_payload, Mapping):
        snapshot = cast(Mapping[str, Any], snapshot_payload)
        if any(snapshot.get(key) is not None for key in keys):
            return True

    allocator_payload = params.get("allocator")
    if isinstance(allocator_payload, Mapping):
        allocator = cast(Mapping[str, Any], allocator_payload)
        if allocator.get("fragility_state") is not None:
            return True
        if allocator.get("fragility_score") is not None:
            return True

    return any(params.get(key) is not None for key in keys)


def _strategy_weights(
    strategy_signed_qty: tuple[tuple[str, Decimal], ...], action: str
) -> tuple[tuple[str, Decimal], ...]:
    direction = Decimal("1") if action == "buy" else Decimal("-1")
    directional: list[tuple[str, Decimal]] = []
    total = Decimal("0")
    for strategy_id, signed_qty in strategy_signed_qty:
        directional_qty = signed_qty * direction
        if directional_qty <= 0:
            continue
        directional.append((strategy_id, directional_qty))
        total += directional_qty
    if total <= 0:
        return ()
    return tuple(
        (strategy_id, directional_qty / total)
        for strategy_id, directional_qty in directional
    )


def _allocator_approved_notional(params: Mapping[str, Any]) -> Optional[Decimal]:
    allocator = params.get("allocator")
    if not isinstance(allocator, Mapping):
        return None
    payload = cast(Mapping[str, Any], allocator)
    value = payload.get("approved_notional")
    if value is None:
        return None
    return _optional_decimal(value)


def _apply_allocator_regime_multiplier(
    notional: Decimal, params: Mapping[str, Any]
) -> tuple[Decimal, Optional[str]]:
    allocator = params.get("allocator")
    if not isinstance(allocator, Mapping):
        return notional, None
    payload = cast(Mapping[str, Any], allocator)
    enabled = payload.get("enabled")
    if isinstance(enabled, bool) and not enabled:
        return notional, None
    status = payload.get("status")
    if isinstance(status, str) and status.strip() and status.strip().lower() != "approved":
        return notional, None
    budget_multiplier = _optional_decimal(payload.get("budget_multiplier"))
    capacity_multiplier = _optional_decimal(payload.get("capacity_multiplier"))
    multiplier = Decimal("1")
    if budget_multiplier is not None and budget_multiplier > 0:
        multiplier *= budget_multiplier
    if capacity_multiplier is not None and capacity_multiplier > 0:
        multiplier *= capacity_multiplier
    if multiplier == Decimal("1"):
        return notional, None
    return notional * multiplier, "allocator_regime_multiplier"


def _cap_by_allocator_approved_notional(
    notional: Decimal, params: Mapping[str, Any]
) -> tuple[Decimal, Optional[str]]:
    approved_notional = _allocator_approved_notional(params)
    if approved_notional is None or approved_notional <= 0:
        return notional, None
    if notional > approved_notional:
        return approved_notional, "allocator_approved_notional_cap"
    return notional, None


__all__ = [
    "ALLOCATOR_CLIP_GROSS_EXPOSURE",
    "ALLOCATOR_CLIP_CORRELATION_CAPACITY",
    "ALLOCATOR_CLIP_SYMBOL_CAPACITY",
    "ALLOCATOR_CLIP_SYMBOL_BUDGET",
    "ALLOCATOR_CLIP_STRATEGY_BUDGET",
    "ALLOCATOR_REJECT_CORRELATION_CAPACITY",
    "ALLOCATOR_REJECT_GROSS_EXPOSURE",
    "ALLOCATOR_REJECT_NO_PRICE",
    "ALLOCATOR_REJECT_QTY_BELOW_MIN",
    "ALLOCATOR_REJECT_SYMBOL_CAPACITY",
    "ALLOCATOR_REJECT_SYMBOL_BUDGET",
    "ALLOCATOR_REJECT_STRATEGY_BUDGET",
    "ALLOCATOR_REJECT_ZERO_QTY",
    "AggregatedIntent",
    "AllocationConfig",
    "AllocationResult",
    "IntentAggregator",
    "PortfolioAllocator",
    "PortfolioSizingConfig",
    "PortfolioSizingResult",
    "PortfolioSizer",
    "allocator_from_settings",
    "fragility_monitor_from_settings",
    "sizer_from_settings",
]

"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable, Optional

from ...config import settings
from ..fragility import (
    FragilityState,
)
from ..models import StrategyDecision
from ..pair_intent import is_pair_entry
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)

from .allocation_helpers import (
    allocator_approved_notional,
    apply_allocator_regime_multiplier,
    apply_caps,
    cap_by_allocator_approved_notional,
    capacity_reason_from_methods,
    config_payload,
    count_positions,
    decimal_str,
    extract_decision_price,
    gross_cap_for_symbol,
    mapping,
    min_decimal,
    net_cap_for_trade,
    optional_decimal,
    pct_equity_cap,
    portfolio_exposure,
    position_summary,
    remaining_symbol_capacity,
    should_block_new_position,
)


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

ALLOCATOR_REGIME_LOW_CONFIDENCE = "allocator_regime_low_confidence"

ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY = "allocator_strategy_factory_observe_only"

ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY = "allocator_strategy_factory_paper_only"

ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED = "allocator_strategy_factory_uncalibrated"

ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL = "allocator_strategy_factory_baseline_fail"

_SIZING_CAP_ZERO_REASON_BY_METHOD: dict[str, str] = {
    "cap_per_symbol_zero": "symbol_capacity_exhausted",
    "cap_gross_exposure_zero": "gross_exposure_capacity_exhausted",
    "cap_net_exposure_zero": "net_exposure_capacity_exhausted",
    "cap_sell_inventory_zero": "sell_inventory_unavailable",
}


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
    regime_low_confidence_threshold: Decimal = Decimal("0.60")
    regime_low_confidence_multiplier: Decimal = Decimal("0.70")


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
class AllocationRuntime:
    equity: Optional[Decimal]
    current_positions: list[dict[str, Any]]
    current_gross_exposure: Decimal
    approved_gross_delta: Decimal
    strategy_usage: dict[str, Decimal]
    symbol_usage: dict[str, Decimal]
    correlation_usage: dict[str, Decimal]


@dataclass(frozen=True)
class StrategyFactoryAllocationProfile:
    score: Decimal
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    reason_codes: tuple[str, ...]
    payload: dict[str, Any]


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


@dataclass(frozen=True)
class _PortfolioSizingSnapshot:
    price: Optional[Decimal]
    volatility: Optional[Decimal]
    equity: Optional[Decimal]
    current_count: int
    current_qty: Decimal
    current_value: Decimal
    gross_exposure: Decimal
    net_exposure: Decimal

    @classmethod
    def from_inputs(
        cls,
        decision: StrategyDecision,
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
    ) -> _PortfolioSizingSnapshot:
        current_positions = list(positions)
        current_qty, current_value = position_summary(
            decision.symbol, current_positions
        )
        gross_exposure, net_exposure = portfolio_exposure(current_positions)
        return cls(
            price=extract_decision_price(decision),
            volatility=optional_decimal(decision.params.get("volatility")),
            equity=optional_decimal(account.get("equity")),
            current_count=count_positions(current_positions),
            current_qty=current_qty,
            current_value=current_value,
            gross_exposure=gross_exposure,
            net_exposure=net_exposure,
        )


@dataclass(frozen=True)
class _SizedOrderRequest:
    decision: StrategyDecision
    price: Decimal
    notional: Decimal
    current_qty: Decimal
    applied_methods: list[str]
    reasons: list[str]


@dataclass(frozen=True)
class _SizedOrderOutcome:
    qty: Decimal
    notional: Decimal
    approved: bool
    reasons: list[str]
    diagnostics: dict[str, Any]


@dataclass(frozen=True)
class _SignedIntentSummary:
    buy_qty: Decimal
    sell_qty: Decimal
    had_conflict: bool
    strategy_signed_qty: dict[str, Decimal]


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
        snapshot = _PortfolioSizingSnapshot.from_inputs(
            decision=decision,
            account=account,
            positions=positions,
        )
        audit = self._build_size_audit(decision, snapshot)

        if snapshot.price is None or snapshot.price <= 0:
            return self._skipped_size_result(decision, audit, "missing_price")

        base_notional = snapshot.price * decision.qty
        notional = self._resolve_base_notional(decision, base_notional)
        if notional is None or notional <= 0:
            return self._skipped_size_result(decision, audit, "missing_notional")

        notional, applied_methods = self._apply_sizing_methods(
            decision=decision,
            notional=notional,
            volatility=snapshot.volatility,
        )
        caps, reasons = self._collect_size_caps(decision, snapshot)

        if caps:
            notional, cap_methods = apply_caps(notional, caps)
            applied_methods.extend(cap_methods)

        outcome = self._finalize_sized_order(
            _SizedOrderRequest(
                decision=decision,
                price=snapshot.price,
                notional=notional,
                current_qty=snapshot.current_qty,
                applied_methods=applied_methods,
                reasons=reasons,
            )
        )

        audit["output"] = {
            "status": "approved" if outcome.approved else "rejected",
            "final_qty": decimal_str(outcome.qty),
            "final_notional": decimal_str(outcome.notional),
            "methods": applied_methods,
            "caps": {key: decimal_str(value) for key, value in caps.items()},
            "reasons": list(outcome.reasons),
            **outcome.diagnostics,
        }

        updated_params = dict(decision.params)
        updated_params["portfolio_sizing"] = audit
        updated_decision = decision.model_copy(
            update={"qty": outcome.qty, "params": updated_params}
        )
        return PortfolioSizingResult(
            decision=updated_decision,
            approved=outcome.approved,
            reasons=outcome.reasons,
            audit=audit,
        )

    def _build_size_audit(
        self,
        decision: StrategyDecision,
        snapshot: _PortfolioSizingSnapshot,
    ) -> dict[str, Any]:
        return {
            "inputs": {
                "symbol": decision.symbol,
                "action": decision.action,
                "base_qty": str(decision.qty),
                "price": decimal_str(snapshot.price),
                "volatility": decimal_str(snapshot.volatility),
                "equity": decimal_str(snapshot.equity),
                "current_positions": snapshot.current_count,
                "current_symbol_qty": decimal_str(snapshot.current_qty),
                "current_symbol_value": decimal_str(snapshot.current_value),
                "gross_exposure": decimal_str(snapshot.gross_exposure),
                "net_exposure": decimal_str(snapshot.net_exposure),
            },
            "config": config_payload(self.config),
            "output": {},
        }

    def _skipped_size_result(
        self,
        decision: StrategyDecision,
        audit: dict[str, Any],
        reason: str,
    ) -> PortfolioSizingResult:
        audit["output"] = {"status": "skipped", "reason": reason}
        return PortfolioSizingResult(
            decision=decision, approved=True, reasons=[], audit=audit
        )

    def _apply_sizing_methods(
        self,
        *,
        decision: StrategyDecision,
        notional: Decimal,
        volatility: Optional[Decimal],
    ) -> tuple[Decimal, list[str]]:
        notional, regime_method = apply_allocator_regime_multiplier(
            notional, decision.params
        )
        notional, vol_method = self._apply_volatility_scaling(notional, volatility)
        notional, allocator_cap_method = cap_by_allocator_approved_notional(
            notional, decision.params
        )
        methods = [
            method
            for method in (regime_method, vol_method, allocator_cap_method)
            if method
        ]
        return notional, methods

    def _collect_size_caps(
        self,
        decision: StrategyDecision,
        snapshot: _PortfolioSizingSnapshot,
    ) -> tuple[dict[str, Optional[Decimal]], list[str]]:
        reasons: list[str] = []
        if should_block_new_position(
            self.config.max_positions,
            snapshot.current_count,
            snapshot.current_qty,
        ):
            reasons.append("max_positions_exceeded")

        caps: dict[str, Optional[Decimal]] = {}
        symbol_cap = min_decimal(
            self.config.max_notional_per_symbol,
            pct_equity_cap(self.config.max_position_pct_equity, snapshot.equity),
        )
        per_symbol_cap = remaining_symbol_capacity(
            symbol_cap,
            current_value=snapshot.current_value,
            action=decision.action,
            allow_shorts=settings.trading_allow_shorts,
        )
        if per_symbol_cap is not None:
            caps["per_symbol"] = per_symbol_cap

        if decision.action == "sell" and not settings.trading_allow_shorts:
            if snapshot.current_qty <= 0:
                reasons.append("shorts_not_allowed")
            caps["sell_inventory"] = max(snapshot.current_value, Decimal("0"))

        gross_cap = gross_cap_for_symbol(
            self.config.max_gross_exposure,
            snapshot.gross_exposure,
            snapshot.current_value,
            decision.action,
        )
        if gross_cap is not None:
            caps["gross_exposure"] = gross_cap

        if not is_pair_entry(decision):
            net_cap = net_cap_for_trade(
                self.config.max_net_exposure,
                snapshot.net_exposure,
                decision.action,
            )
            if net_cap is not None:
                caps["net_exposure"] = net_cap
        return caps, reasons

    def _finalize_sized_order(
        self,
        request: _SizedOrderRequest,
    ) -> _SizedOrderOutcome:
        diagnostics: dict[str, Any] = {}
        for method in request.applied_methods:
            mapped_reason = _SIZING_CAP_ZERO_REASON_BY_METHOD.get(method)
            if mapped_reason is None:
                continue
            if (
                mapped_reason == "sell_inventory_unavailable"
                and "shorts_not_allowed" in request.reasons
            ):
                continue
            if mapped_reason not in request.reasons:
                request.reasons.append(mapped_reason)
        if request.reasons:
            diagnostics["limiting_constraint"] = request.reasons[0]
            return _SizedOrderOutcome(
                qty=Decimal("0"),
                notional=Decimal("0"),
                approved=False,
                reasons=request.reasons,
                diagnostics=diagnostics,
            )

        target_qty = request.notional / request.price
        resolution = resolve_quantity_resolution(
            request.decision.symbol,
            action=request.decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=request.current_qty,
            requested_qty=target_qty,
        )
        qty = quantize_qty_for_symbol(
            request.decision.symbol,
            target_qty,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        min_qty = min_qty_for_symbol(
            request.decision.symbol,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        diagnostics["fractional_allowed"] = resolution.fractional_allowed
        diagnostics["quantity_resolution"] = resolution.to_payload()
        diagnostics["min_executable_qty"] = decimal_str(min_qty)
        diagnostics["min_executable_notional"] = decimal_str(min_qty * request.price)
        diagnostics["remaining_room_notional"] = decimal_str(request.notional)
        if qty < min_qty and "shorts_not_allowed" not in request.reasons:
            capacity_reason = capacity_reason_from_methods(
                applied_methods=request.applied_methods,
                reasons=request.reasons,
            )
            if capacity_reason is not None:
                request.reasons.append(capacity_reason)
            else:
                request.reasons.append("qty_below_min")

        approved = len(request.reasons) == 0
        if not approved:
            diagnostics["limiting_constraint"] = request.reasons[0]
            return _SizedOrderOutcome(
                qty=Decimal("0"),
                notional=Decimal("0"),
                approved=False,
                reasons=request.reasons,
                diagnostics=diagnostics,
            )
        return _SizedOrderOutcome(
            qty=qty,
            notional=request.notional,
            approved=True,
            reasons=request.reasons,
            diagnostics=diagnostics,
        )

    def _resolve_base_notional(
        self, decision: StrategyDecision, base_notional: Decimal
    ) -> Optional[Decimal]:
        if (
            self.config.notional_per_position is not None
            and self.config.notional_per_position > 0
        ):
            allocator_cap = allocator_approved_notional(decision.params)
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
        grouped = self._group_decisions(decisions)
        return [
            self._aggregated_bucket(grouped[key])
            for key in sorted(grouped)
            if grouped[key]
        ]

    @staticmethod
    def _group_decisions(
        decisions: Iterable[StrategyDecision],
    ) -> dict[tuple[str, str, str, str], list[StrategyDecision]]:
        grouped: dict[tuple[str, str, str, str], list[StrategyDecision]] = {}
        for decision in decisions:
            key = (
                decision.symbol,
                decision.timeframe,
                decision.order_type,
                decision.time_in_force,
            )
            grouped.setdefault(key, []).append(decision)
        return grouped

    def _aggregated_bucket(
        self, unsorted_bucket: list[StrategyDecision]
    ) -> AggregatedIntent:
        bucket = self._sorted_bucket(unsorted_bucket)
        summary = self._signed_summary(bucket)
        chosen_action, chosen_qty = self._chosen_action_qty(bucket, summary)
        primary = bucket[0]
        params = self._aggregated_params(primary, bucket, summary)
        aggregated_decision = primary.model_copy(
            update={"action": chosen_action, "qty": chosen_qty, "params": params}
        )
        return AggregatedIntent(
            decision=aggregated_decision,
            source_strategy_ids=tuple(item.strategy_id for item in bucket),
            source_decision_count=len(bucket),
            had_conflict=summary.had_conflict,
            strategy_signed_qty=tuple(
                (strategy_id, qty)
                for strategy_id, qty in sorted(summary.strategy_signed_qty.items())
            ),
        )

    @staticmethod
    def _sorted_bucket(bucket: list[StrategyDecision]) -> list[StrategyDecision]:
        return sorted(
            bucket,
            key=lambda item: (
                item.strategy_id,
                item.event_ts.isoformat(),
                item.action,
                item.symbol,
                str(item.qty),
            ),
        )

    @staticmethod
    def _signed_summary(bucket: list[StrategyDecision]) -> _SignedIntentSummary:
        buy_qty = sum(
            (item.qty for item in bucket if item.action == "buy"), Decimal("0")
        )
        sell_qty = sum(
            (item.qty for item in bucket if item.action == "sell"), Decimal("0")
        )
        strategy_signed_qty: dict[str, Decimal] = {}
        for item in bucket:
            signed_qty = item.qty if item.action == "buy" else -item.qty
            strategy_signed_qty[item.strategy_id] = (
                strategy_signed_qty.get(item.strategy_id, Decimal("0")) + signed_qty
            )
        return _SignedIntentSummary(
            buy_qty=buy_qty,
            sell_qty=sell_qty,
            had_conflict=buy_qty > 0 and sell_qty > 0,
            strategy_signed_qty=strategy_signed_qty,
        )

    @staticmethod
    def _chosen_action_qty(
        bucket: list[StrategyDecision],
        summary: _SignedIntentSummary,
    ) -> tuple[str, Decimal]:
        if summary.buy_qty == summary.sell_qty:
            # Deterministic tie-break avoids dropping throughput when intents cancel exactly.
            chosen_action = bucket[0].action
            chosen_qty = summary.buy_qty if chosen_action == "buy" else summary.sell_qty
            return chosen_action, chosen_qty
        if summary.buy_qty > summary.sell_qty:
            return "buy", summary.buy_qty - summary.sell_qty
        return "sell", summary.sell_qty - summary.buy_qty

    @staticmethod
    def _aggregated_params(
        primary: StrategyDecision,
        bucket: list[StrategyDecision],
        summary: _SignedIntentSummary,
    ) -> dict[str, Any]:
        params = dict(primary.params)
        allocator_meta = dict(mapping(params.get("allocator")))
        allocator_meta.update(
            {
                "intent_aggregated": True,
                "intent_conflict_resolved": summary.had_conflict,
                "source_strategy_ids": [item.strategy_id for item in bucket],
                "source_decision_count": len(bucket),
            }
        )
        params["allocator"] = allocator_meta
        return params


__all__ = [
    "ALLOCATOR_CLIP_CORRELATION_CAPACITY",
    "ALLOCATOR_CLIP_GROSS_EXPOSURE",
    "ALLOCATOR_CLIP_STRATEGY_BUDGET",
    "ALLOCATOR_CLIP_SYMBOL_BUDGET",
    "ALLOCATOR_CLIP_SYMBOL_CAPACITY",
    "ALLOCATOR_REGIME_LOW_CONFIDENCE",
    "ALLOCATOR_REJECT_CORRELATION_CAPACITY",
    "ALLOCATOR_REJECT_GROSS_EXPOSURE",
    "ALLOCATOR_REJECT_NO_PRICE",
    "ALLOCATOR_REJECT_QTY_BELOW_MIN",
    "ALLOCATOR_REJECT_STRATEGY_BUDGET",
    "ALLOCATOR_REJECT_SYMBOL_BUDGET",
    "ALLOCATOR_REJECT_SYMBOL_CAPACITY",
    "ALLOCATOR_REJECT_ZERO_QTY",
    "ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL",
    "ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY",
    "ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY",
    "ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED",
    "AggregatedIntent",
    "AllocationConfig",
    "AllocationResult",
    "IntentAggregator",
    "PortfolioSizer",
    "PortfolioSizingConfig",
    "PortfolioSizingResult",
]

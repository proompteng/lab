"""Execution policy enforcing order placement safety and impact assumptions."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable, Optional

from ..config import settings
from ..models import Strategy
from .costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel
from .models import StrategyDecision
from .prices import MarketSnapshot

DEFAULT_EXECUTION_SECONDS = 60


@dataclass(frozen=True)
class ExecutionPolicyConfig:
    min_notional: Optional[Decimal]
    max_notional: Optional[Decimal]
    max_participation_rate: Decimal
    allow_shorts: bool
    kill_switch_enabled: bool
    prefer_limit: bool
    max_retries: int
    backoff_base_seconds: float
    backoff_multiplier: float
    backoff_max_seconds: float


@dataclass(frozen=True)
class ExecutionPolicyOutcome:
    approved: bool
    decision: StrategyDecision
    reasons: list[str]
    notional: Optional[Decimal]
    participation_rate: Optional[Decimal]
    retry_delays: list[float]
    impact_assumptions: dict[str, Any]
    selected_order_type: str

    def params_update(self) -> dict[str, Any]:
        return {
            "execution_policy": {
                "approved": self.approved,
                "reasons": list(self.reasons),
                "notional": _stringify_decimal(self.notional),
                "participation_rate": _stringify_decimal(self.participation_rate),
                "selected_order_type": self.selected_order_type,
                "retry_delays": self.retry_delays,
            },
            "impact_assumptions": self.impact_assumptions,
        }


class ExecutionPolicy:
    """Centralize order placement decisions and impact metadata."""

    def __init__(
        self,
        config: Optional[ExecutionPolicyConfig] = None,
        cost_model_config: Optional[CostModelConfig] = None,
    ) -> None:
        self.config = config
        self.cost_model = TransactionCostModel(cost_model_config or CostModelConfig())

    def evaluate(
        self,
        decision: StrategyDecision,
        *,
        strategy: Optional[Strategy],
        positions: Iterable[dict[str, Any]],
        market_snapshot: Optional[MarketSnapshot],
        kill_switch_enabled: Optional[bool] = None,
    ) -> ExecutionPolicyOutcome:
        config = self._sanitize_config(self._resolve_config(strategy=strategy, kill_switch_enabled=kill_switch_enabled))
        reasons: list[str] = []

        if config.kill_switch_enabled:
            reasons.append("kill_switch_enabled")

        decision, selected_order_type = self._select_order_type(
            decision,
            market_snapshot,
            prefer_limit=config.prefer_limit,
        )

        price = _resolve_price(decision, market_snapshot)
        qty = _optional_decimal(decision.qty)
        notional = price * qty if price is not None and qty is not None else None

        min_notional = config.min_notional
        if min_notional is not None and notional is not None and notional < min_notional:
            reasons.append("min_notional_not_met")

        max_notional = config.max_notional
        if max_notional is not None and notional is not None and notional > max_notional:
            reasons.append("max_notional_exceeded")

        if _is_short_increasing(decision, positions) and not config.allow_shorts:
            reasons.append("shorts_not_allowed")

        impact_inputs = _build_impact_inputs(decision, market_snapshot)
        execution_seconds = impact_inputs["execution_seconds"]
        cost_inputs = CostModelInputs(
            price=impact_inputs["price"],
            spread=impact_inputs.get("spread"),
            volatility=impact_inputs.get("volatility"),
            adv=impact_inputs.get("adv"),
            execution_seconds=execution_seconds,
        )
        estimate = self.cost_model.estimate_costs(
            OrderIntent(
                symbol=decision.symbol,
                side="buy" if decision.action == "buy" else "sell",
                qty=qty or Decimal("0"),
                price=impact_inputs["price"],
                order_type=decision.order_type,
                time_in_force=decision.time_in_force,
            ),
            cost_inputs,
        )

        max_participation = config.max_participation_rate
        participation_rate = estimate.participation_rate
        if participation_rate is not None and participation_rate > max_participation:
            reasons.append("participation_exceeds_max")

        retry_delays = _build_retry_delays(config)
        impact_assumptions = _build_impact_assumptions(
            estimate=estimate,
            config=self.cost_model.config,
            max_participation=max_participation,
            execution_seconds=execution_seconds,
            impact_inputs=impact_inputs,
        )

        approved = len(reasons) == 0
        return ExecutionPolicyOutcome(
            approved=approved,
            decision=decision,
            reasons=reasons,
            notional=notional,
            participation_rate=participation_rate,
            retry_delays=retry_delays,
            impact_assumptions=impact_assumptions,
            selected_order_type=selected_order_type,
        )

    def _sanitize_config(self, config: ExecutionPolicyConfig) -> ExecutionPolicyConfig:
        max_participation_rate = config.max_participation_rate
        if max_participation_rate <= 0:
            max_participation_rate = self.cost_model.config.max_participation_rate
        if max_participation_rate > 1:
            max_participation_rate = Decimal("1")

        max_retries = max(config.max_retries, 0)
        backoff_base_seconds = config.backoff_base_seconds if config.backoff_base_seconds > 0 else 0.1
        backoff_multiplier = config.backoff_multiplier if config.backoff_multiplier >= 1 else 1.0
        backoff_max_seconds = config.backoff_max_seconds
        if backoff_max_seconds < backoff_base_seconds:
            backoff_max_seconds = backoff_base_seconds

        return ExecutionPolicyConfig(
            min_notional=config.min_notional,
            max_notional=config.max_notional,
            max_participation_rate=max_participation_rate,
            allow_shorts=config.allow_shorts,
            kill_switch_enabled=config.kill_switch_enabled,
            prefer_limit=config.prefer_limit,
            max_retries=max_retries,
            backoff_base_seconds=backoff_base_seconds,
            backoff_multiplier=backoff_multiplier,
            backoff_max_seconds=backoff_max_seconds,
        )

    def _resolve_config(
        self, *, strategy: Optional[Strategy], kill_switch_enabled: Optional[bool]
    ) -> ExecutionPolicyConfig:
        if self.config is not None:
            return self.config

        min_notional = _optional_decimal(settings.trading_min_notional_per_trade)
        max_notional = _optional_decimal(strategy.max_notional_per_trade if strategy else None)
        if max_notional is None:
            max_notional = _optional_decimal(settings.trading_max_notional_per_trade)

        max_participation = _optional_decimal(settings.trading_max_participation_rate)
        if max_participation is None:
            max_participation = self.cost_model.config.max_participation_rate

        if kill_switch_enabled is None:
            kill_switch_enabled = settings.trading_kill_switch_enabled

        return ExecutionPolicyConfig(
            min_notional=min_notional,
            max_notional=max_notional,
            max_participation_rate=max_participation,
            allow_shorts=settings.trading_allow_shorts,
            kill_switch_enabled=kill_switch_enabled,
            prefer_limit=settings.trading_execution_prefer_limit,
            max_retries=settings.trading_execution_max_retries,
            backoff_base_seconds=settings.trading_execution_backoff_base_seconds,
            backoff_multiplier=settings.trading_execution_backoff_multiplier,
            backoff_max_seconds=settings.trading_execution_backoff_max_seconds,
        )

    def _select_order_type(
        self,
        decision: StrategyDecision,
        market_snapshot: Optional[MarketSnapshot],
        *,
        prefer_limit: bool,
    ) -> tuple[StrategyDecision, str]:
        price = _resolve_price(decision, market_snapshot)
        spread = _optional_decimal(decision.params.get("spread"))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread

        selected_order_type = decision.order_type
        limit_price = decision.limit_price
        stop_price = decision.stop_price

        if decision.order_type == "market" and prefer_limit and price is not None:
            selected_order_type = "limit"
            limit_price = _near_touch_limit_price(price, spread, decision.action)

        if selected_order_type in {"limit", "stop_limit"} and limit_price is None and price is not None:
            limit_price = price

        if selected_order_type in {"stop", "stop_limit"} and stop_price is None and price is not None:
            stop_price = price

        updated = decision.model_copy(
            update={
                "order_type": selected_order_type,
                "limit_price": limit_price,
                "stop_price": stop_price,
            }
        )
        return updated, selected_order_type


def _near_touch_limit_price(price: Decimal, spread: Optional[Decimal], action: str) -> Decimal:
    if spread is None or spread <= 0:
        return price
    half_spread = spread / Decimal("2")
    if action == "buy":
        return price + half_spread
    return price - half_spread


def _build_retry_delays(config: ExecutionPolicyConfig) -> list[float]:
    if config.max_retries <= 0:
        return []
    delays: list[float] = []
    delay = config.backoff_base_seconds
    for _ in range(config.max_retries):
        delays.append(min(delay, config.backoff_max_seconds))
        delay *= config.backoff_multiplier
    return delays


def should_retry_order_error(error: Exception) -> bool:
    name = type(error).__name__.lower()
    if "timeout" in name or "connection" in name:
        return True
    message = str(error).lower()
    retryable_tokens = ("timeout", "temporarily", "try again", "connection", "503", "rate limit")
    non_retryable_tokens = ("reject", "insufficient", "invalid", "unknown symbol", "not allowed")
    if any(token in message for token in non_retryable_tokens):
        return False
    return any(token in message for token in retryable_tokens)


def _build_impact_inputs(
    decision: StrategyDecision, market_snapshot: Optional[MarketSnapshot]
) -> dict[str, Any]:
    resolved_price = _resolve_price(decision, market_snapshot)
    price = resolved_price if resolved_price is not None else Decimal("0")
    spread = _optional_decimal(decision.params.get("spread"))
    if spread is None and market_snapshot is not None:
        spread = market_snapshot.spread
    volatility = _optional_decimal(decision.params.get("volatility"))
    adv = _optional_decimal(
        decision.params.get("adv")
        or decision.params.get("avg_dollar_volume")
        or decision.params.get("avg_daily_dollar_volume")
        or decision.params.get("average_daily_volume")
    )
    execution_seconds = decision.params.get("execution_seconds")
    if execution_seconds is None:
        execution_seconds = DEFAULT_EXECUTION_SECONDS
    try:
        execution_seconds = int(execution_seconds)
    except (TypeError, ValueError):
        execution_seconds = DEFAULT_EXECUTION_SECONDS
    return {
        "price": price,
        "price_present": resolved_price is not None,
        "spread": spread,
        "volatility": volatility,
        "adv": adv,
        "execution_seconds": execution_seconds,
    }


def _build_impact_assumptions(
    *,
    estimate: Any,
    config: CostModelConfig,
    max_participation: Decimal,
    execution_seconds: int,
    impact_inputs: dict[str, Any],
) -> dict[str, Any]:
    price = impact_inputs.get("price")
    price_present = impact_inputs.get("price_present")
    adv = impact_inputs.get("adv")
    spread = impact_inputs.get("spread")
    volatility = impact_inputs.get("volatility")
    return {
        "inputs": {
            "price": _stringify_decimal(price) if price_present else None,
            "spread": _stringify_decimal(spread),
            "volatility": _stringify_decimal(volatility),
            "adv": _stringify_decimal(adv),
            "execution_seconds": execution_seconds,
        },
        "model": {
            "commission_bps": str(config.commission_bps),
            "commission_per_share": str(config.commission_per_share),
            "min_commission": str(config.min_commission),
            "max_participation_rate": str(max_participation),
            "impact_bps_at_full_participation": str(config.impact_bps_at_full_participation),
        },
        "estimate": {
            "notional": str(estimate.notional),
            "spread_cost_bps": str(estimate.spread_cost_bps),
            "volatility_cost_bps": str(estimate.volatility_cost_bps),
            "impact_cost_bps": str(estimate.impact_cost_bps),
            "commission_cost_bps": str(estimate.commission_cost_bps),
            "total_cost_bps": str(estimate.total_cost_bps),
            "participation_rate": _stringify_decimal(estimate.participation_rate),
            "capacity_ok": estimate.capacity_ok,
            "warnings": list(estimate.warnings),
        },
    }


def _resolve_price(decision: StrategyDecision, market_snapshot: Optional[MarketSnapshot]) -> Optional[Decimal]:
    candidate = decision.params.get("price")
    if candidate is None:
        candidate = decision.limit_price
    if candidate is None:
        candidate = decision.stop_price
    if candidate is None and market_snapshot is not None:
        candidate = market_snapshot.price
    return _optional_decimal(candidate)


def _position_summary(symbol: str, positions: Iterable[dict[str, Any]]) -> Decimal:
    total_qty = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty")) or _optional_decimal(position.get("quantity"))
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
    return total_qty


def _is_short_increasing(decision: StrategyDecision, positions: Iterable[dict[str, Any]]) -> bool:
    if decision.action == "buy":
        return False
    qty = _optional_decimal(decision.qty)
    if qty is None:
        return False
    position_qty = _position_summary(decision.symbol, positions)
    if position_qty <= 0:
        return True
    return qty > position_qty


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return None


def _stringify_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


__all__ = ["ExecutionPolicy", "ExecutionPolicyOutcome", "ExecutionPolicyConfig", "should_retry_order_error"]

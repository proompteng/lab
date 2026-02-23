"""Execution policy enforcing order placement safety and impact assumptions."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Optional, cast

from ..config import settings
from ..models import Strategy
from .costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel
from .microstructure import (
    is_microstructure_stale,
    parse_execution_advice,
    parse_microstructure_state,
)
from .models import StrategyDecision
from .prices import MarketSnapshot
from .quantity_rules import (
    min_qty_for_symbol,
    qty_has_valid_increment,
    quantize_qty_for_symbol,
)
from .tca import AdaptiveExecutionPolicyDecision

DEFAULT_EXECUTION_SECONDS = 60
ADAPTIVE_PARTICIPATION_RATE_FLOOR = Decimal('0.05')
ADAPTIVE_EXECUTION_SECONDS_MIN = 10
ADAPTIVE_EXECUTION_SECONDS_MAX = 600


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
class AdaptiveExecutionApplication:
    decision: AdaptiveExecutionPolicyDecision
    applied: bool
    reason: str

    def as_payload(self) -> dict[str, Any]:
        payload = self.decision.as_payload()
        payload['applied'] = self.applied
        payload['reason'] = self.reason
        return payload


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
    adaptive: AdaptiveExecutionApplication | None
    advisor_metadata: dict[str, Any]

    def params_update(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            'execution_policy': {
                'approved': self.approved,
                'reasons': list(self.reasons),
                'notional': _stringify_decimal(self.notional),
                'participation_rate': _stringify_decimal(self.participation_rate),
                'selected_order_type': self.selected_order_type,
                'retry_delays': self.retry_delays,
            },
            "impact_assumptions": self.impact_assumptions,
            "execution_advisor": self.advisor_metadata,
        }
        if self.adaptive is not None:
            payload['execution_policy']['adaptive'] = self.adaptive.as_payload()
        return payload


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
        adaptive_policy: AdaptiveExecutionPolicyDecision | None = None,
    ) -> ExecutionPolicyOutcome:
        config = self._sanitize_config(
            self._resolve_config(
                strategy=strategy, kill_switch_enabled=kill_switch_enabled
            )
        )
        reasons: list[str] = []
        allocator_meta = _allocator_payload(decision)
        participation_override = _optional_decimal(
            allocator_meta.get("max_participation_rate_override")
        )
        if participation_override is not None:
            config = self._sanitize_config(
                replace(
                    config,
                    max_participation_rate=min(
                        config.max_participation_rate, participation_override
                    ),
                )
            )
        advisor_metadata, advisor_max_participation = self._evaluate_advisor(
            decision=decision,
            baseline_max_participation=config.max_participation_rate,
        )

        if config.kill_switch_enabled:
            reasons.append('kill_switch_enabled')

        adaptive_application = self._resolve_adaptive_application(adaptive_policy)
        if adaptive_application is not None and adaptive_application.applied:
            config = self._apply_adaptive_config(config, adaptive_application.decision)

        decision, selected_order_type = self._select_order_type(
            decision,
            market_snapshot,
            prefer_limit=config.prefer_limit,
        )
        decision, selected_order_type = self._apply_advisor_order_type(
            decision=decision,
            selected_order_type=selected_order_type,
            advice=advisor_metadata,
            market_snapshot=market_snapshot,
        )

        price = _resolve_price(decision, market_snapshot)
        qty = _optional_decimal(decision.qty)
        min_qty = min_qty_for_symbol(decision.symbol)
        if qty is None or qty <= 0:
            reasons.append("qty_non_positive")
            qty = Decimal("0")
        elif qty < min_qty:
            reasons.append("qty_below_min")
        elif not qty_has_valid_increment(decision.symbol, qty):
            quantized = quantize_qty_for_symbol(decision.symbol, qty)
            reasons.append(f"qty_invalid_increment:step={_stringify_decimal(min_qty)}")
            qty = quantized
        notional = price * qty if price is not None and qty is not None else None

        min_notional = config.min_notional
        if (
            min_notional is not None
            and notional is not None
            and notional < min_notional
        ):
            reasons.append("min_notional_not_met")

        max_notional = config.max_notional
        if (
            max_notional is not None
            and notional is not None
            and notional > max_notional
        ):
            reasons.append("max_notional_exceeded")

        if _is_short_increasing(decision, positions) and not config.allow_shorts:
            reasons.append('shorts_not_allowed')

        impact_inputs = _build_impact_inputs(
            decision,
            market_snapshot,
            execution_seconds_scale=(
                adaptive_application.decision.execution_seconds_scale
                if adaptive_application is not None and adaptive_application.applied
                else None
            ),
        )
        execution_seconds = impact_inputs['execution_seconds']
        cost_inputs = CostModelInputs(
            price=impact_inputs['price'],
            spread=impact_inputs.get('spread'),
            volatility=impact_inputs.get('volatility'),
            adv=impact_inputs.get('adv'),
            execution_seconds=execution_seconds,
        )
        estimate = self.cost_model.estimate_costs(
            OrderIntent(
                symbol=decision.symbol,
                side='buy' if decision.action == 'buy' else 'sell',
                qty=qty or Decimal('0'),
                price=impact_inputs['price'],
                order_type=decision.order_type,
                time_in_force=decision.time_in_force,
            ),
            cost_inputs,
        )

        max_participation = advisor_max_participation or config.max_participation_rate
        participation_rate = estimate.participation_rate
        if participation_rate is not None and participation_rate > max_participation:
            reasons.append('participation_exceeds_max')

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
            adaptive=adaptive_application,
            advisor_metadata=advisor_metadata,
        )

    def _resolve_adaptive_application(
        self,
        adaptive_policy: AdaptiveExecutionPolicyDecision | None,
    ) -> AdaptiveExecutionApplication | None:
        if adaptive_policy is None:
            return None
        if adaptive_policy.fallback_active:
            reason = adaptive_policy.fallback_reason or 'adaptive_policy_fallback'
            return AdaptiveExecutionApplication(
                decision=adaptive_policy,
                applied=False,
                reason=reason,
            )
        if not adaptive_policy.has_override:
            return AdaptiveExecutionApplication(
                decision=adaptive_policy,
                applied=False,
                reason='insufficient_signal',
            )
        return AdaptiveExecutionApplication(
            decision=adaptive_policy,
            applied=True,
            reason='applied',
        )

    def _apply_adaptive_config(
        self,
        config: ExecutionPolicyConfig,
        adaptive_policy: AdaptiveExecutionPolicyDecision,
    ) -> ExecutionPolicyConfig:
        participation_scale = adaptive_policy.participation_rate_scale
        if participation_scale <= 0:
            participation_scale = Decimal('1')
        adjusted_participation = config.max_participation_rate * participation_scale
        if adjusted_participation < ADAPTIVE_PARTICIPATION_RATE_FLOOR:
            adjusted_participation = ADAPTIVE_PARTICIPATION_RATE_FLOOR
        if adjusted_participation > config.max_participation_rate:
            adjusted_participation = config.max_participation_rate

        prefer_limit = config.prefer_limit
        if adaptive_policy.prefer_limit is not None:
            prefer_limit = adaptive_policy.prefer_limit

        return ExecutionPolicyConfig(
            min_notional=config.min_notional,
            max_notional=config.max_notional,
            max_participation_rate=adjusted_participation,
            allow_shorts=config.allow_shorts,
            kill_switch_enabled=config.kill_switch_enabled,
            prefer_limit=prefer_limit,
            max_retries=config.max_retries,
            backoff_base_seconds=config.backoff_base_seconds,
            backoff_multiplier=config.backoff_multiplier,
            backoff_max_seconds=config.backoff_max_seconds,
        )

    def _evaluate_advisor(
        self,
        *,
        decision: StrategyDecision,
        baseline_max_participation: Decimal,
    ) -> tuple[dict[str, Any], Decimal | None]:
        metadata: dict[str, Any] = {
            "enabled": settings.trading_execution_advisor_enabled,
            "applied": False,
            "fallback_reason": None,
            "tightening_reasons": [],
            "max_participation_rate": None,
            "urgency_tier": None,
            "preferred_order_type": None,
            "adverse_selection_risk": None,
            "simulator_version": None,
            "expected_shortfall_bps_p50": None,
            "expected_shortfall_bps_p95": None,
        }
        tightening_reasons: list[str] = []
        if not settings.trading_execution_advisor_enabled:
            metadata["fallback_reason"] = "advisor_disabled"
            return metadata, None

        state = parse_microstructure_state(
            decision.params.get("microstructure_state"), expected_symbol=decision.symbol
        )
        advice = parse_execution_advice(decision.params.get("execution_advice"))
        if state is None or advice is None:
            metadata["fallback_reason"] = "advisor_missing_inputs"
            return metadata, None

        max_staleness_seconds = settings.trading_execution_advisor_max_staleness_seconds
        if is_microstructure_stale(
            state,
            reference_ts=decision.event_ts,
            max_staleness_seconds=max_staleness_seconds,
        ):
            metadata["fallback_reason"] = "advisor_state_stale"
            return metadata, None
        if advice.event_ts is not None:
            advice_age = (
                decision.event_ts.astimezone(timezone.utc)
                - advice.event_ts.astimezone(timezone.utc)
            ).total_seconds()
            if advice_age > max(max_staleness_seconds, 0):
                metadata["fallback_reason"] = "advisor_advice_stale"
                return metadata, None
        if (
            advice.latency_ms is not None
            and advice.latency_ms > settings.trading_execution_advisor_timeout_ms
        ):
            metadata["fallback_reason"] = "advisor_timeout"
            return metadata, None

        metadata["urgency_tier"] = advice.urgency_tier
        metadata["preferred_order_type"] = advice.preferred_order_type
        metadata["adverse_selection_risk"] = _stringify_decimal(
            advice.adverse_selection_risk
        )
        metadata["simulator_version"] = advice.simulator_version
        metadata["expected_shortfall_bps_p50"] = _stringify_decimal(
            advice.expected_shortfall_bps_p50
        )
        metadata["expected_shortfall_bps_p95"] = _stringify_decimal(
            advice.expected_shortfall_bps_p95
        )

        tightened_max: Decimal | None = None
        if (
            advice.max_participation_rate is not None
            and advice.max_participation_rate > 0
        ):
            candidate = min(advice.max_participation_rate, baseline_max_participation)
            metadata["max_participation_rate"] = _stringify_decimal(candidate)
            if candidate < baseline_max_participation:
                tightened_max = candidate
                tightening_reasons.append("participation_rate_tightened")
            else:
                tightening_reasons.append("participation_rate_not_tightened")

        if advice.urgency_tier in {"low", "normal"}:
            tightening_reasons.append("urgency_tier_bounded")

        metadata["applied"] = True
        metadata["tightening_reasons"] = tightening_reasons
        return metadata, tightened_max

    def _apply_advisor_order_type(
        self,
        *,
        decision: StrategyDecision,
        selected_order_type: str,
        advice: dict[str, Any],
        market_snapshot: Optional[MarketSnapshot],
    ) -> tuple[StrategyDecision, str]:
        if not advice.get("applied"):
            return decision, selected_order_type
        preferred = advice.get("preferred_order_type")
        if preferred != "limit" or selected_order_type != "market":
            return decision, selected_order_type
        price = _resolve_price(decision, market_snapshot)
        if price is None:
            return decision, selected_order_type
        spread = _optional_decimal(decision.params.get("spread"))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread
        return (
            decision.model_copy(
                update={
                    "order_type": "limit",
                    "limit_price": _near_touch_limit_price(
                        price, spread, decision.action
                    ),
                    "stop_price": None,
                }
            ),
            "limit",
        )

    def _sanitize_config(self, config: ExecutionPolicyConfig) -> ExecutionPolicyConfig:
        max_participation_rate = config.max_participation_rate
        if max_participation_rate <= 0:
            max_participation_rate = self.cost_model.config.max_participation_rate
        if max_participation_rate > 1:
            max_participation_rate = Decimal('1')

        max_retries = max(config.max_retries, 0)
        backoff_base_seconds = (
            config.backoff_base_seconds if config.backoff_base_seconds > 0 else 0.1
        )
        backoff_multiplier = (
            config.backoff_multiplier if config.backoff_multiplier >= 1 else 1.0
        )
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
        max_notional = _optional_decimal(
            strategy.max_notional_per_trade if strategy else None
        )
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
        spread = _optional_decimal(decision.params.get('spread'))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread

        selected_order_type = decision.order_type
        limit_price = decision.limit_price
        stop_price = decision.stop_price

        if decision.order_type == 'market' and prefer_limit and price is not None:
            selected_order_type = 'limit'
            limit_price = _near_touch_limit_price(price, spread, decision.action)

        if (
            selected_order_type in {"limit", "stop_limit"}
            and limit_price is None
            and price is not None
        ):
            limit_price = _normalize_price_for_trading(price)
        elif limit_price is not None:
            limit_price = _normalize_price_for_trading(limit_price)

        if (
            selected_order_type in {"stop", "stop_limit"}
            and stop_price is None
            and price is not None
        ):
            stop_price = _normalize_price_for_trading(price)
        elif stop_price is not None:
            stop_price = _normalize_price_for_trading(stop_price)

        updated = decision.model_copy(
            update={
                'order_type': selected_order_type,
                'limit_price': limit_price,
                'stop_price': stop_price,
            }
        )
        return updated, selected_order_type


def _near_touch_limit_price(
    price: Decimal, spread: Optional[Decimal], action: str
) -> Decimal:
    if spread is None or spread <= 0:
        return _normalize_price_for_trading(price)
    half_spread = spread / Decimal('2')
    if action == 'buy':
        return _normalize_price_for_trading(price + half_spread)
    return _normalize_price_for_trading(price - half_spread)


def _normalize_price_for_trading(price: Decimal) -> Decimal:
    """Align broker-facing prices to common US-equity tick sizes.

    This keeps order pricing deterministic and avoids sub-penny rejects from
    downstream execution adapters.
    """

    tick_size = _tick_size_for_price(price)
    return price.quantize(tick_size, rounding=ROUND_HALF_UP)


def _tick_size_for_price(price: Decimal) -> Decimal:
    if price.copy_abs() < Decimal('1'):
        return Decimal('0.0001')
    return Decimal('0.01')


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
    if 'timeout' in name or 'connection' in name:
        return True
    message = str(error).lower()
    retryable_tokens = (
        "timeout",
        "temporarily",
        "try again",
        "connection",
        "503",
        "rate limit",
    )
    non_retryable_tokens = (
        "reject",
        "insufficient",
        "invalid",
        "unknown symbol",
        "not allowed",
    )
    if any(token in message for token in non_retryable_tokens):
        return False
    return any(token in message for token in retryable_tokens)


def _build_impact_inputs(
    decision: StrategyDecision,
    market_snapshot: Optional[MarketSnapshot],
    *,
    execution_seconds_scale: Decimal | None = None,
) -> dict[str, Any]:
    resolved_price = _resolve_price(decision, market_snapshot)
    price = resolved_price if resolved_price is not None else Decimal('0')
    spread = _optional_decimal(decision.params.get('spread'))
    if spread is None and market_snapshot is not None:
        spread = market_snapshot.spread
    volatility = _optional_decimal(decision.params.get('volatility'))
    adv = _optional_decimal(
        decision.params.get('adv')
        or decision.params.get('avg_dollar_volume')
        or decision.params.get('avg_daily_dollar_volume')
        or decision.params.get('average_daily_volume')
    )
    execution_seconds = decision.params.get('execution_seconds')
    if execution_seconds is None:
        execution_seconds = DEFAULT_EXECUTION_SECONDS
    try:
        execution_seconds = int(execution_seconds)
    except (TypeError, ValueError):
        execution_seconds = DEFAULT_EXECUTION_SECONDS

    if execution_seconds_scale is not None and execution_seconds_scale > 0:
        scaled = int(round(float(execution_seconds) * float(execution_seconds_scale)))
        execution_seconds = min(ADAPTIVE_EXECUTION_SECONDS_MAX, max(ADAPTIVE_EXECUTION_SECONDS_MIN, scaled))

    return {
        'price': price,
        'price_present': resolved_price is not None,
        'spread': spread,
        'volatility': volatility,
        'adv': adv,
        'execution_seconds': execution_seconds,
    }


def _build_impact_assumptions(
    *,
    estimate: Any,
    config: CostModelConfig,
    max_participation: Decimal,
    execution_seconds: int,
    impact_inputs: dict[str, Any],
) -> dict[str, Any]:
    price = impact_inputs.get('price')
    price_present = impact_inputs.get('price_present')
    adv = impact_inputs.get('adv')
    spread = impact_inputs.get('spread')
    volatility = impact_inputs.get('volatility')
    return {
        'inputs': {
            'price': _stringify_decimal(price) if price_present else None,
            'spread': _stringify_decimal(spread),
            'volatility': _stringify_decimal(volatility),
            'adv': _stringify_decimal(adv),
            'execution_seconds': execution_seconds,
        },
        "model": {
            "commission_bps": str(config.commission_bps),
            "commission_per_share": str(config.commission_per_share),
            "min_commission": str(config.min_commission),
            "max_participation_rate": str(max_participation),
            "impact_bps_at_full_participation": str(
                config.impact_bps_at_full_participation
            ),
        },
        'estimate': {
            'notional': str(estimate.notional),
            'spread_cost_bps': str(estimate.spread_cost_bps),
            'volatility_cost_bps': str(estimate.volatility_cost_bps),
            'impact_cost_bps': str(estimate.impact_cost_bps),
            'commission_cost_bps': str(estimate.commission_cost_bps),
            'total_cost_bps': str(estimate.total_cost_bps),
            'participation_rate': _stringify_decimal(estimate.participation_rate),
            'capacity_ok': estimate.capacity_ok,
            'warnings': list(estimate.warnings),
        },
    }


def _resolve_price(
    decision: StrategyDecision, market_snapshot: Optional[MarketSnapshot]
) -> Optional[Decimal]:
    candidate = decision.params.get("price")
    if candidate is None:
        candidate = decision.limit_price
    if candidate is None:
        candidate = decision.stop_price
    if candidate is None and market_snapshot is not None:
        candidate = market_snapshot.price
    return _optional_decimal(candidate)


def _position_summary(symbol: str, positions: Iterable[dict[str, Any]]) -> Decimal:
    total_qty = Decimal('0')
    for position in positions:
        if position.get('symbol') != symbol:
            continue
        qty = _optional_decimal(position.get("qty")) or _optional_decimal(
            position.get("quantity")
        )
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
    return total_qty


def _is_short_increasing(
    decision: StrategyDecision, positions: Iterable[dict[str, Any]]
) -> bool:
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


def _allocator_payload(decision: StrategyDecision) -> dict[str, object]:
    raw = decision.params.get("allocator")
    if not isinstance(raw, dict):
        return {}
    payload = cast(dict[object, object], raw)
    return {str(key): value for key, value in payload.items()}


def _stringify_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


__all__ = [
    "ExecutionPolicy",
    "ExecutionPolicyOutcome",
    "ExecutionPolicyConfig",
    "should_retry_order_error",
]

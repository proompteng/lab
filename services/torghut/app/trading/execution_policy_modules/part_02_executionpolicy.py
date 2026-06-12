# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Execution policy enforcing order placement safety and impact assumptions."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Mapping, Optional, cast

from ...config import settings
from ...models import Strategy
from ..costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel
from ..microstructure import (
    MicrostructureStateV5,
    is_microstructure_stale,
    parse_execution_advice,
    parse_microstructure_state,
)
from ..models import StrategyDecision
from ..prices import MarketSnapshot, resolve_execution_reference_price
from ..quantity_rules import (
    min_qty_for_symbol,
    qty_has_valid_increment,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from ..tca import AdaptiveExecutionPolicyDecision

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_29 import *


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
        microstructure_state = parse_microstructure_state(
            decision.params.get("microstructure_state")
            or decision.params.get("microstructure_signal"),
            expected_symbol=decision.symbol,
        )
        (
            microstructure_metadata,
            microstructure_participation_scale,
            microstructure_execution_scale,
        ) = self._evaluate_microstructure_state(
            decision=decision,
            state=microstructure_state,
        )
        reasons: list[str] = []
        config = self._apply_allocator_participation_override(config, decision)
        config = self._apply_microstructure_config(
            config=config,
            participation_scale=microstructure_participation_scale,
            micro_prefer_limit=bool(microstructure_metadata.get("prefer_limit")),
        )
        advisor_metadata, advisor_max_participation = self._evaluate_advisor(
            decision=decision,
            baseline_max_participation=config.max_participation_rate,
            microstructure_state=microstructure_state,
        )

        if config.kill_switch_enabled:
            reasons.append("kill_switch_enabled")

        adaptive_application = self._resolve_adaptive_application(adaptive_policy)
        if adaptive_application is not None and adaptive_application.applied:
            config = self._apply_adaptive_config(config, adaptive_application.decision)

        decision, selected_order_type = self._select_order_type(
            decision,
            market_snapshot,
            prefer_limit=config.prefer_limit,
        )
        decision, selected_order_type = self._apply_microstructure_order_type(
            decision=decision,
            selected_order_type=selected_order_type,
            microstructure_metadata=microstructure_metadata,
            market_snapshot=market_snapshot,
        )
        decision, selected_order_type = self._apply_advisor_order_type(
            decision=decision,
            selected_order_type=selected_order_type,
            advice=advisor_metadata,
            market_snapshot=market_snapshot,
        )

        price = _resolve_price(decision, market_snapshot)
        position_qty = _position_summary(decision.symbol, positions)
        prechecked_reducing_position_qty = _prechecked_reducing_position_qty(decision)
        if prechecked_reducing_position_qty is not None:
            position_qty = prechecked_reducing_position_qty
            short_increasing = False
        else:
            short_increasing = _is_short_increasing(decision, positions)
        position_reducing = _is_position_reducing(decision, position_qty)
        qty, notional = self._resolve_qty_and_notional(
            decision=decision,
            position_qty=position_qty,
            short_increasing=short_increasing,
            allow_shorts=config.allow_shorts,
            price=price,
            reasons=reasons,
        )

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
            and not position_reducing
        ):
            reasons.append("max_notional_exceeded")

        if short_increasing and not config.allow_shorts:
            reasons.append("shorts_not_allowed")

        impact_inputs = _build_impact_inputs(
            decision,
            market_snapshot,
            execution_seconds_scale=(
                _combined_execution_seconds_scale(
                    adaptive_application=adaptive_application,
                    microstructure_execution_scale=microstructure_execution_scale,
                )
            ),
        )
        execution_seconds = impact_inputs["execution_seconds"]
        estimate = self._estimate_execution_costs(
            decision=decision,
            qty=qty,
            impact_inputs=impact_inputs,
            execution_seconds=execution_seconds,
        )

        max_participation = advisor_max_participation or config.max_participation_rate
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
            adaptive=adaptive_application,
            advisor_metadata=advisor_metadata,
            microstructure_metadata=microstructure_metadata,
        )

    def _apply_allocator_participation_override(
        self,
        config: ExecutionPolicyConfig,
        decision: StrategyDecision,
    ) -> ExecutionPolicyConfig:
        allocator_meta = _allocator_payload(decision)
        participation_override = _optional_decimal(
            allocator_meta.get("max_participation_rate_override")
        )
        if participation_override is None:
            return config
        return self._sanitize_config(
            replace(
                config,
                max_participation_rate=min(
                    config.max_participation_rate, participation_override
                ),
            )
        )

    def _resolve_qty_and_notional(
        self,
        *,
        decision: StrategyDecision,
        position_qty: Decimal,
        short_increasing: bool,
        allow_shorts: bool,
        price: Decimal | None,
        reasons: list[str],
    ) -> tuple[Decimal, Decimal | None]:
        qty = _optional_decimal(decision.qty)
        resolution = resolve_quantity_resolution(
            decision.symbol,
            action=decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=allow_shorts,
            position_qty=position_qty,
            requested_qty=qty,
        )
        fractional_equities_enabled = (
            resolution.fractional_allowed and not short_increasing
        )
        min_qty = min_qty_for_symbol(
            decision.symbol, fractional_equities_enabled=fractional_equities_enabled
        )
        if qty is None or qty <= 0:
            reasons.append("qty_non_positive")
            qty = Decimal("0")
        elif qty < min_qty:
            reasons.append(_resolve_qty_below_min_reason(decision))
        elif not qty_has_valid_increment(
            decision.symbol,
            qty,
            fractional_equities_enabled=fractional_equities_enabled,
        ):
            quantized = quantize_qty_for_symbol(
                decision.symbol,
                qty,
                fractional_equities_enabled=fractional_equities_enabled,
            )
            reasons.append(f"qty_invalid_increment:step={_stringify_decimal(min_qty)}")
            qty = quantized
        notional = price * qty if price is not None else None
        return qty, notional

    def _estimate_execution_costs(
        self,
        *,
        decision: StrategyDecision,
        qty: Decimal,
        impact_inputs: dict[str, Any],
        execution_seconds: int,
    ) -> Any:
        cost_inputs = CostModelInputs(
            price=impact_inputs["price"],
            spread=impact_inputs.get("spread"),
            volatility=impact_inputs.get("volatility"),
            adv=impact_inputs.get("adv"),
            execution_seconds=execution_seconds,
        )
        return self.cost_model.estimate_costs(
            OrderIntent(
                symbol=decision.symbol,
                side="buy" if decision.action == "buy" else "sell",
                qty=qty,
                price=impact_inputs["price"],
                order_type=decision.order_type,
                time_in_force=decision.time_in_force,
            ),
            cost_inputs,
        )

    def _resolve_adaptive_application(
        self,
        adaptive_policy: AdaptiveExecutionPolicyDecision | None,
    ) -> AdaptiveExecutionApplication | None:
        if adaptive_policy is None:
            return None
        if adaptive_policy.fallback_active:
            reason = adaptive_policy.fallback_reason or "adaptive_policy_fallback"
            return AdaptiveExecutionApplication(
                decision=adaptive_policy,
                applied=False,
                reason=reason,
            )
        if not adaptive_policy.has_override:
            return AdaptiveExecutionApplication(
                decision=adaptive_policy,
                applied=False,
                reason="insufficient_signal",
            )
        return AdaptiveExecutionApplication(
            decision=adaptive_policy,
            applied=True,
            reason="applied",
        )

    def _evaluate_microstructure_state(
        self,
        *,
        decision: StrategyDecision,
        state: MicrostructureStateV5 | None,
    ) -> tuple[dict[str, Any], Decimal, Decimal]:
        metadata: dict[str, Any] = {
            "applied": False,
            "fallback_reason": None,
            "prefer_limit": None,
            "participation_rate_scale": "1",
            "execution_seconds_scale": "1",
            "tightening_reasons": [],
            "liquidity_regime": None,
            "spread_bps": None,
            "depth_top5_usd": None,
            "order_flow_imbalance": None,
            "fill_hazard": None,
            "crumbling_quote_probability": None,
            "mechanical_liquidity_withdrawal_probability": None,
            "latency_ms_estimate": None,
            "event_ts": None,
            "state_valid": False,
        }
        if state is None:
            metadata["fallback_reason"] = "microstructure_state_unavailable"
            return metadata, Decimal("1"), Decimal("1")

        metadata.update(
            {
                "liquidity_regime": state.liquidity_regime,
                "spread_bps": str(state.spread_bps),
                "depth_top5_usd": str(state.depth_top5_usd),
                "order_flow_imbalance": str(state.order_flow_imbalance),
                "fill_hazard": str(state.fill_hazard),
                "crumbling_quote_probability": _stringify_decimal(
                    state.crumbling_quote_probability
                ),
                "mechanical_liquidity_withdrawal_probability": _stringify_decimal(
                    state.mechanical_liquidity_withdrawal_probability
                ),
                "latency_ms_estimate": state.latency_ms_estimate,
                "event_ts": state.event_ts.isoformat(),
                "state_valid": True,
            }
        )
        if is_microstructure_stale(
            state,
            reference_ts=decision.event_ts,
            max_staleness_seconds=settings.trading_execution_advisor_max_staleness_seconds,
        ):
            metadata["fallback_reason"] = "microstructure_state_stale"
            return metadata, Decimal("1"), Decimal("1")

        participation_rate_scale = Decimal("1")
        execution_seconds_scale = Decimal("1")

        if state.liquidity_regime == "stressed":
            participation_rate_scale *= MICROSTRUCTURE_STRESSED_RATE_SCALE
            execution_seconds_scale *= MICROSTRUCTURE_STRESS_EXECUTION_SCALE
            metadata["prefer_limit"] = True
            metadata["tightening_reasons"].append("microstructure_regime_stressed")
        elif state.liquidity_regime == "compressed":
            participation_rate_scale *= MICROSTRUCTURE_COMPRESSED_RATE_SCALE
            metadata["tightening_reasons"].append("microstructure_regime_compressed")

        if state.spread_bps >= MICROSTRUCTURE_SPREAD_BPS_PRESSURE:
            participation_rate_scale *= MICROSTRUCTURE_HIGH_SPREAD_RATE_SCALE
            execution_seconds_scale *= MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE
            metadata["prefer_limit"] = True
            metadata["tightening_reasons"].append(
                "microstructure_spread_bps_above_pressure"
            )

        if state.depth_top5_usd < MICROSTRUCTURE_DEPTH_USD_PRESSURE:
            participation_rate_scale *= MICROSTRUCTURE_LOW_DEPTH_RATE_SCALE
            metadata["prefer_limit"] = True
            metadata["tightening_reasons"].append("microstructure_depth_compressed")

        if state.fill_hazard >= MICROSTRUCTURE_HAZARD_PRESSURE:
            participation_rate_scale *= MICROSTRUCTURE_HAZARD_RATE_SCALE
            metadata["prefer_limit"] = True
            metadata["tightening_reasons"].append(
                "microstructure_fill_hazard_above_pressure"
            )

        if (
            state.crumbling_quote_probability is not None
            and state.crumbling_quote_probability
            >= MICROSTRUCTURE_CRUMBLING_QUOTE_PROBABILITY_PRESSURE
        ):
            participation_rate_scale *= MICROSTRUCTURE_CRUMBLING_QUOTE_RATE_SCALE
            execution_seconds_scale *= MICROSTRUCTURE_CRUMBLING_QUOTE_EXECUTION_SCALE
            metadata["prefer_limit"] = True
            metadata["tightening_reasons"].append(
                "microstructure_crumbling_quote_probability_above_pressure"
            )

        if (
            state.mechanical_liquidity_withdrawal_probability is not None
            and state.mechanical_liquidity_withdrawal_probability
            >= MICROSTRUCTURE_CRUMBLING_QUOTE_PROBABILITY_PRESSURE
        ):
            participation_rate_scale *= MICROSTRUCTURE_CRUMBLING_QUOTE_RATE_SCALE
            execution_seconds_scale *= MICROSTRUCTURE_CRUMBLING_QUOTE_EXECUTION_SCALE
            metadata["prefer_limit"] = True
            metadata["tightening_reasons"].append(
                "microstructure_mechanical_liquidity_withdrawal_above_pressure"
            )

        if state.latency_ms_estimate >= MICROSTRUCTURE_LATENCY_PRESSURE_MS:
            execution_seconds_scale *= MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE
            metadata["tightening_reasons"].append(
                "microstructure_latency_ms_above_pressure"
            )

        abs_imbalance = abs(state.order_flow_imbalance)
        if abs_imbalance >= Decimal("0.55"):
            participation_rate_scale *= Decimal("0.85")
            metadata["tightening_reasons"].append(
                "microstructure_order_flow_imbalance_pressure"
            )
        if abs_imbalance >= Decimal("0.85"):
            participation_rate_scale *= Decimal("0.90")
            metadata["prefer_limit"] = True

        participation_rate_scale = min(Decimal("1"), participation_rate_scale)
        execution_seconds_scale = max(
            MICROSTRUCTURE_EXECUTION_SCALE_MIN,
            min(MICROSTRUCTURE_EXECUTION_SCALE_MAX, execution_seconds_scale),
        )

        if participation_rate_scale < Decimal("1") or execution_seconds_scale > Decimal(
            "1"
        ):
            metadata["applied"] = True
        metadata["participation_rate_scale"] = str(participation_rate_scale)
        metadata["execution_seconds_scale"] = str(execution_seconds_scale)
        return metadata, participation_rate_scale, execution_seconds_scale

    def _apply_microstructure_config(
        self,
        *,
        config: ExecutionPolicyConfig,
        participation_scale: Decimal,
        micro_prefer_limit: bool,
    ) -> ExecutionPolicyConfig:
        prefer_limit = config.prefer_limit or micro_prefer_limit
        if participation_scale >= Decimal("1"):
            return replace(config, prefer_limit=prefer_limit)

        adjusted_participation = config.max_participation_rate * participation_scale
        if adjusted_participation < MICROSTRUCTURE_PARTICIPATION_FLOOR:
            adjusted_participation = MICROSTRUCTURE_PARTICIPATION_FLOOR
        if adjusted_participation > config.max_participation_rate:
            adjusted_participation = config.max_participation_rate

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

    def _apply_microstructure_order_type(
        self,
        *,
        decision: StrategyDecision,
        selected_order_type: str,
        microstructure_metadata: dict[str, Any],
        market_snapshot: Optional[MarketSnapshot],
    ) -> tuple[StrategyDecision, str]:
        if not (
            selected_order_type == "market"
            and bool(microstructure_metadata.get("prefer_limit"))
        ):
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

    def _apply_adaptive_config(
        self,
        config: ExecutionPolicyConfig,
        adaptive_policy: AdaptiveExecutionPolicyDecision,
    ) -> ExecutionPolicyConfig:
        participation_scale = adaptive_policy.participation_rate_scale
        if participation_scale <= 0:
            participation_scale = Decimal("1")
        adjusted_participation = config.max_participation_rate * participation_scale
        if adjusted_participation < ADAPTIVE_PARTICIPATION_RATE_FLOOR:
            adjusted_participation = ADAPTIVE_PARTICIPATION_RATE_FLOOR
        if adjusted_participation > config.max_participation_rate:
            adjusted_participation = config.max_participation_rate

        prefer_limit = config.prefer_limit
        if adaptive_policy.prefer_limit is not None:
            if adaptive_policy.prefer_limit:
                prefer_limit = True

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
        microstructure_state: MicrostructureStateV5 | None,
    ) -> tuple[dict[str, Any], Decimal | None]:
        metadata: dict[str, Any] = {
            "enabled": settings.trading_execution_advisor_enabled,
            "live_apply_enabled": settings.trading_execution_advisor_live_apply_enabled,
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

        state = microstructure_state
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

        if not settings.trading_execution_advisor_live_apply_enabled:
            metadata["fallback_reason"] = "advisor_live_apply_disabled"
            metadata["tightening_reasons"] = ["live_apply_disabled"]
            metadata["preferred_order_type"] = None
            metadata["adverse_selection_risk"] = None
            metadata["max_participation_rate"] = None
            return metadata, None

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
            max_participation_rate = Decimal("1")

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
        spread = _optional_decimal(decision.params.get("spread"))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread

        selected_order_type = decision.order_type
        limit_price = decision.limit_price
        stop_price = decision.stop_price

        if (
            decision.order_type == "market"
            and prefer_limit
            and price is not None
            and not _should_keep_market_order_for_high_conviction_entry(
                decision,
                price=price,
                spread=spread,
            )
            and not _should_keep_market_order_for_pair_runtime_exit(
                decision,
                price=price,
                spread=spread,
            )
        ):
            selected_order_type = "limit"
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
                "order_type": selected_order_type,
                "limit_price": limit_price,
                "stop_price": stop_price,
            }
        )
        return updated, selected_order_type


__all__ = [name for name in globals() if not name.startswith("__")]

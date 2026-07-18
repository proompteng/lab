"""Execution policy enforcing order placement safety and impact assumptions."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any, Optional

from ...config import settings
from ...models import Strategy
from ..costs import (
    CostModelConfig,
    CostModelInputs,
    OrderIntent,
    TransactionCostModel,
)
from ..economic_policy import EconomicPolicy, load_runtime_economic_policy
from ..microstructure import (
    MicrostructureStateV5,
    is_microstructure_stale,
    parse_execution_advice,
    parse_microstructure_state,
)
from ..models import StrategyDecision
from ..prices import MarketSnapshot
from ..quantity_rules import (
    min_qty_for_symbol,
    qty_has_valid_increment,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from ..tca import AdaptiveExecutionPolicyDecision


from .policy_types import (
    ADAPTIVE_PARTICIPATION_RATE_FLOOR,
    MICROSTRUCTURE_COMPRESSED_RATE_SCALE,
    MICROSTRUCTURE_CRUMBLING_QUOTE_PROBABILITY_PRESSURE,
    MICROSTRUCTURE_DEPTH_USD_PRESSURE,
    MICROSTRUCTURE_EXECUTION_SCALE_MAX,
    MICROSTRUCTURE_EXECUTION_SCALE_MIN,
    MICROSTRUCTURE_HAZARD_PRESSURE,
    MICROSTRUCTURE_HAZARD_RATE_SCALE,
    MICROSTRUCTURE_HIGH_SPREAD_RATE_SCALE,
    MICROSTRUCTURE_LATENCY_PRESSURE_MS,
    MICROSTRUCTURE_LOW_DEPTH_RATE_SCALE,
    MICROSTRUCTURE_PARTICIPATION_FLOOR,
    MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE,
    MICROSTRUCTURE_SPREAD_BPS_PRESSURE,
    MICROSTRUCTURE_STRESSED_RATE_SCALE,
    MICROSTRUCTURE_STRESS_EXECUTION_SCALE,
    AdaptiveExecutionApplication,
    DEFAULT_EXECUTION_SECONDS,
    ExecutionPolicyConfig,
    ExecutionPolicyOutcome,
)
from .policy_context import (
    ExecutionPolicyEvaluateRequest,
    ExecutionPolicyImpact,
    ExecutionPolicyRuntimeContext,
    ExecutionPolicySelection,
    ExecutionPolicySizing,
    MicrostructureAdjustment,
    QuantityResolutionRequest,
    apply_crumbling_quote_pressure,
    execution_advisor_input_fallback_reason,
)
from .order_rules import (
    allocator_payload,
    build_impact_assumptions,
    build_impact_inputs,
    combined_execution_seconds_scale,
    is_position_reducing,
    is_short_increasing,
    near_touch_limit_price,
    normalize_price_for_trading,
    optional_decimal,
    position_summary,
    prechecked_reducing_position_qty,
    resolve_price,
    resolve_qty_below_min_reason,
    should_keep_market_order_for_high_conviction_entry,
    should_keep_market_order_for_pair_runtime_exit,
    stringify_decimal,
)


class ExecutionPolicy:
    """Centralize order placement decisions and impact metadata."""

    def __init__(
        self,
        config: Optional[ExecutionPolicyConfig] = None,
        cost_model_config: Optional[CostModelConfig] = None,
        economic_policy: EconomicPolicy | None = None,
    ) -> None:
        if economic_policy is None and config is None and cost_model_config is None:
            economic_policy = load_runtime_economic_policy(
                settings,
                required=(
                    settings.trading_enabled
                    and settings.process_role in {"scheduler", "simulation"}
                ),
            )
        if economic_policy is not None and cost_model_config is None:
            cost_model_config = economic_policy.cost_model_config()
        self.economic_policy = economic_policy
        self.config = config
        self.cost_model = TransactionCostModel(cost_model_config or CostModelConfig())

    def evaluate(
        self,
        decision: StrategyDecision,
        **kwargs: Any,
    ) -> ExecutionPolicyOutcome:
        request = ExecutionPolicyEvaluateRequest.from_kwargs(decision, dict(kwargs))
        runtime = self._evaluation_runtime(request)
        selection = self._execution_selection(request, runtime)
        sizing = self._execution_sizing(request, runtime, selection)
        self._append_notional_reasons(runtime, sizing)
        impact = self._execution_impact(request, runtime, selection, sizing)
        return ExecutionPolicyOutcome(
            approved=len(runtime.reasons) == 0,
            decision=selection.decision,
            reasons=runtime.reasons,
            notional=sizing.notional,
            participation_rate=impact.participation_rate,
            impact_assumptions=impact.impact_assumptions,
            selected_order_type=selection.selected_order_type,
            adaptive=runtime.adaptive_application,
            advisor_metadata=runtime.advisor_metadata,
            microstructure_metadata=runtime.microstructure_metadata,
            economic_policy_digest=(
                self.economic_policy.digest
                if self.economic_policy is not None
                else None
            ),
        )

    def _evaluation_runtime(
        self, request: ExecutionPolicyEvaluateRequest
    ) -> ExecutionPolicyRuntimeContext:
        config = self._sanitize_config(
            self._resolve_config(
                strategy=request.strategy,
                kill_switch_enabled=request.kill_switch_enabled,
            )
        )
        microstructure_state = parse_microstructure_state(
            request.decision.params.get("microstructure_state")
            or request.decision.params.get("microstructure_signal"),
            expected_symbol=request.decision.symbol,
        )
        microstructure_metadata, participation_scale, execution_scale = (
            self._evaluate_microstructure_state(
                decision=request.decision,
                state=microstructure_state,
            )
        )
        config = self._apply_allocator_participation_override(config, request.decision)
        config = self._apply_microstructure_config(
            config=config,
            participation_scale=participation_scale,
            micro_prefer_limit=bool(microstructure_metadata.get("prefer_limit")),
        )
        advisor_metadata, advisor_max_participation = self._evaluate_advisor(
            decision=request.decision,
            baseline_max_participation=config.max_participation_rate,
            microstructure_state=microstructure_state,
        )
        reasons = ["kill_switch_enabled"] if config.kill_switch_enabled else []
        adaptive_application = self._resolve_adaptive_application(
            request.adaptive_policy
        )
        if adaptive_application is not None and adaptive_application.applied:
            config = self._apply_adaptive_config(config, adaptive_application.decision)
        return ExecutionPolicyRuntimeContext(
            config=config,
            reasons=reasons,
            microstructure_state=microstructure_state,
            microstructure_metadata=microstructure_metadata,
            microstructure_execution_scale=execution_scale,
            advisor_metadata=advisor_metadata,
            advisor_max_participation=advisor_max_participation,
            adaptive_application=adaptive_application,
        )

    def _execution_selection(
        self,
        request: ExecutionPolicyEvaluateRequest,
        runtime: ExecutionPolicyRuntimeContext,
    ) -> ExecutionPolicySelection:
        decision, selected_order_type = self._select_order_type(
            request.decision,
            request.market_snapshot,
            prefer_limit=runtime.config.prefer_limit,
        )
        decision, selected_order_type = self._apply_microstructure_order_type(
            decision=decision,
            selected_order_type=selected_order_type,
            microstructure_metadata=runtime.microstructure_metadata,
            market_snapshot=request.market_snapshot,
        )
        decision, selected_order_type = self._apply_advisor_order_type(
            decision=decision,
            selected_order_type=selected_order_type,
            advice=runtime.advisor_metadata,
            market_snapshot=request.market_snapshot,
        )
        return ExecutionPolicySelection(
            decision=decision, selected_order_type=selected_order_type
        )

    def _execution_sizing(
        self,
        request: ExecutionPolicyEvaluateRequest,
        runtime: ExecutionPolicyRuntimeContext,
        selection: ExecutionPolicySelection,
    ) -> ExecutionPolicySizing:
        decision = selection.decision
        price = resolve_price(decision, request.market_snapshot)
        position_qty = position_summary(decision.symbol, request.positions)
        prechecked_qty = prechecked_reducing_position_qty(decision)
        short_increasing = False
        if prechecked_qty is not None:
            position_qty = prechecked_qty
        else:
            short_increasing = is_short_increasing(decision, request.positions)
        qty, notional = self._resolve_qty_and_notional(
            QuantityResolutionRequest(
                decision=decision,
                position_qty=position_qty,
                short_increasing=short_increasing,
                allow_shorts=runtime.config.allow_shorts,
                price=price,
                reasons=runtime.reasons,
            )
        )
        return ExecutionPolicySizing(
            price=price,
            position_qty=position_qty,
            short_increasing=short_increasing,
            position_reducing=is_position_reducing(decision, position_qty),
            qty=qty,
            notional=notional,
        )

    @staticmethod
    def _append_notional_reasons(
        runtime: ExecutionPolicyRuntimeContext, sizing: ExecutionPolicySizing
    ) -> None:
        config = runtime.config
        if (
            config.min_notional is not None
            and sizing.notional is not None
            and sizing.notional < config.min_notional
        ):
            runtime.reasons.append("min_notional_not_met")
        if (
            config.max_notional is not None
            and sizing.notional is not None
            and sizing.notional > config.max_notional
            and not sizing.position_reducing
        ):
            runtime.reasons.append("max_notional_exceeded")
        if sizing.short_increasing and not config.allow_shorts:
            runtime.reasons.append("shorts_not_allowed")

    def _execution_impact(
        self,
        request: ExecutionPolicyEvaluateRequest,
        runtime: ExecutionPolicyRuntimeContext,
        selection: ExecutionPolicySelection,
        sizing: ExecutionPolicySizing,
    ) -> ExecutionPolicyImpact:
        impact_inputs = build_impact_inputs(
            selection.decision,
            request.market_snapshot,
            default_execution_seconds=(
                self.economic_policy.latency.assumed_execution_seconds
                if self.economic_policy is not None
                else DEFAULT_EXECUTION_SECONDS
            ),
            execution_seconds_scale=combined_execution_seconds_scale(
                adaptive_application=runtime.adaptive_application,
                microstructure_execution_scale=runtime.microstructure_execution_scale,
            ),
        )
        execution_seconds = impact_inputs["execution_seconds"]
        estimate = self._estimate_execution_costs(
            decision=selection.decision,
            qty=sizing.qty,
            impact_inputs=impact_inputs,
            execution_seconds=execution_seconds,
        )
        max_participation = runtime.config.max_participation_rate
        if runtime.advisor_max_participation is not None:
            max_participation = min(
                max_participation,
                runtime.advisor_max_participation,
            )
        participation_rate = estimate.participation_rate
        if participation_rate is not None and participation_rate > max_participation:
            runtime.reasons.append("participation_exceeds_max")
        return ExecutionPolicyImpact(
            participation_rate=participation_rate,
            impact_assumptions=build_impact_assumptions(
                estimate=estimate,
                config=self.cost_model.config,
                max_participation=max_participation,
                execution_seconds=execution_seconds,
                impact_inputs=impact_inputs,
            ),
        )

    def _apply_allocator_participation_override(
        self,
        config: ExecutionPolicyConfig,
        decision: StrategyDecision,
    ) -> ExecutionPolicyConfig:
        allocator_meta = allocator_payload(decision)
        participation_override = optional_decimal(
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
        self, request: QuantityResolutionRequest
    ) -> tuple[Decimal, Decimal | None]:
        decision = request.decision
        qty = optional_decimal(decision.qty)
        resolution = resolve_quantity_resolution(
            decision.symbol,
            action=decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=request.allow_shorts,
            position_qty=request.position_qty,
            requested_qty=qty,
        )
        fractional_equities_enabled = (
            resolution.fractional_allowed and not request.short_increasing
        )
        min_qty = min_qty_for_symbol(
            decision.symbol, fractional_equities_enabled=fractional_equities_enabled
        )
        if qty is None or qty <= 0:
            request.reasons.append("qty_non_positive")
            qty = Decimal("0")
        elif qty < min_qty:
            request.reasons.append(resolve_qty_below_min_reason(decision))
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
            request.reasons.append(
                f"qty_invalid_increment:step={stringify_decimal(min_qty)}"
            )
            qty = quantized
        notional = request.price * qty if request.price is not None else None
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
        if adaptive_policy.has_override is False:
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
        metadata = self._base_microstructure_metadata()
        if state is None:
            metadata["fallback_reason"] = "microstructure_state_unavailable"
            return metadata, Decimal("1"), Decimal("1")
        self._hydrate_microstructure_metadata(metadata, state)
        if is_microstructure_stale(
            state,
            reference_ts=decision.event_ts,
            max_staleness_seconds=settings.trading_execution_advisor_max_staleness_seconds,
        ):
            metadata["fallback_reason"] = "microstructure_state_stale"
            return metadata, Decimal("1"), Decimal("1")
        adjustment = MicrostructureAdjustment(metadata=metadata)
        self._apply_microstructure_regime(adjustment, state)
        self._apply_microstructure_depth_and_spread(adjustment, state)
        self._apply_microstructure_crumbling_quote(adjustment, state)
        self._apply_microstructure_latency_and_imbalance(adjustment, state)
        return self._finalize_microstructure_adjustment(adjustment)

    @staticmethod
    def _base_microstructure_metadata() -> dict[str, Any]:
        return {
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

    @staticmethod
    def _hydrate_microstructure_metadata(
        metadata: dict[str, Any], state: MicrostructureStateV5
    ) -> None:
        metadata.update(
            {
                "liquidity_regime": state.liquidity_regime,
                "spread_bps": str(state.spread_bps),
                "depth_top5_usd": str(state.depth_top5_usd),
                "order_flow_imbalance": str(state.order_flow_imbalance),
                "fill_hazard": str(state.fill_hazard),
                "crumbling_quote_probability": stringify_decimal(
                    state.crumbling_quote_probability
                ),
                "mechanical_liquidity_withdrawal_probability": stringify_decimal(
                    state.mechanical_liquidity_withdrawal_probability
                ),
                "latency_ms_estimate": state.latency_ms_estimate,
                "event_ts": state.event_ts.isoformat(),
                "state_valid": True,
            }
        )

    @staticmethod
    def _apply_microstructure_regime(
        adjustment: MicrostructureAdjustment, state: MicrostructureStateV5
    ) -> None:
        if state.liquidity_regime == "stressed":
            adjustment.tighten_participation(
                MICROSTRUCTURE_STRESSED_RATE_SCALE,
                "microstructure_regime_stressed",
            )
            adjustment.slow_execution(MICROSTRUCTURE_STRESS_EXECUTION_SCALE)
            adjustment.prefer_limit()
        elif state.liquidity_regime == "compressed":
            adjustment.tighten_participation(
                MICROSTRUCTURE_COMPRESSED_RATE_SCALE,
                "microstructure_regime_compressed",
            )

    @staticmethod
    def _apply_microstructure_depth_and_spread(
        adjustment: MicrostructureAdjustment, state: MicrostructureStateV5
    ) -> None:
        if state.spread_bps >= MICROSTRUCTURE_SPREAD_BPS_PRESSURE:
            adjustment.tighten_participation(
                MICROSTRUCTURE_HIGH_SPREAD_RATE_SCALE,
                "microstructure_spread_bps_above_pressure",
            )
            adjustment.slow_execution(MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE)
            adjustment.prefer_limit()
        if state.depth_top5_usd < MICROSTRUCTURE_DEPTH_USD_PRESSURE:
            adjustment.tighten_participation(
                MICROSTRUCTURE_LOW_DEPTH_RATE_SCALE,
                "microstructure_depth_compressed",
            )
            adjustment.prefer_limit()
        if state.fill_hazard >= MICROSTRUCTURE_HAZARD_PRESSURE:
            adjustment.tighten_participation(
                MICROSTRUCTURE_HAZARD_RATE_SCALE,
                "microstructure_fill_hazard_above_pressure",
            )
            adjustment.prefer_limit()

    @staticmethod
    def _apply_microstructure_crumbling_quote(
        adjustment: MicrostructureAdjustment, state: MicrostructureStateV5
    ) -> None:
        crumbling_threshold = MICROSTRUCTURE_CRUMBLING_QUOTE_PROBABILITY_PRESSURE
        crumbling_pressure = (
            state.crumbling_quote_probability is not None
            and state.crumbling_quote_probability >= crumbling_threshold
        )
        mechanical_pressure = (
            state.mechanical_liquidity_withdrawal_probability is not None
            and state.mechanical_liquidity_withdrawal_probability >= crumbling_threshold
        )
        if crumbling_pressure:
            apply_crumbling_quote_pressure(
                adjustment, "microstructure_crumbling_quote_probability_above_pressure"
            )
        if mechanical_pressure:
            apply_crumbling_quote_pressure(
                adjustment,
                "microstructure_mechanical_liquidity_withdrawal_above_pressure",
            )

    @staticmethod
    def _apply_microstructure_latency_and_imbalance(
        adjustment: MicrostructureAdjustment, state: MicrostructureStateV5
    ) -> None:
        if state.latency_ms_estimate >= MICROSTRUCTURE_LATENCY_PRESSURE_MS:
            adjustment.slow_execution(
                MICROSTRUCTURE_PRESSURE_EXECUTION_SCALE,
                "microstructure_latency_ms_above_pressure",
            )
        abs_imbalance = abs(state.order_flow_imbalance)
        if abs_imbalance >= Decimal("0.55"):
            adjustment.tighten_participation(
                Decimal("0.85"),
                "microstructure_order_flow_imbalance_pressure",
            )
        if abs_imbalance >= Decimal("0.85"):
            adjustment.tighten_participation(Decimal("0.90"))
            adjustment.prefer_limit()

    @staticmethod
    def _finalize_microstructure_adjustment(
        adjustment: MicrostructureAdjustment,
    ) -> tuple[dict[str, Any], Decimal, Decimal]:
        participation_rate_scale = min(
            Decimal("1"), adjustment.participation_rate_scale
        )
        execution_seconds_scale = max(
            MICROSTRUCTURE_EXECUTION_SCALE_MIN,
            min(MICROSTRUCTURE_EXECUTION_SCALE_MAX, adjustment.execution_seconds_scale),
        )
        if participation_rate_scale < Decimal("1") or execution_seconds_scale > Decimal(
            "1"
        ):
            adjustment.metadata["applied"] = True
        adjustment.metadata["participation_rate_scale"] = str(participation_rate_scale)
        adjustment.metadata["execution_seconds_scale"] = str(execution_seconds_scale)
        return adjustment.metadata, participation_rate_scale, execution_seconds_scale

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

        price = resolve_price(decision, market_snapshot)
        if price is None:
            return decision, selected_order_type

        spread = optional_decimal(decision.params.get("spread"))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread
        return (
            decision.model_copy(
                update={
                    "order_type": "limit",
                    "limit_price": near_touch_limit_price(
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
        max_staleness_seconds = settings.trading_execution_advisor_max_staleness_seconds
        fallback_reason = execution_advisor_input_fallback_reason(
            decision=decision,
            state=state,
            advice=advice,
            max_staleness_seconds=max_staleness_seconds,
        )
        if fallback_reason is not None:
            metadata["fallback_reason"] = fallback_reason
            return metadata, None
        assert advice is not None

        metadata["urgency_tier"] = advice.urgency_tier
        metadata["preferred_order_type"] = advice.preferred_order_type
        metadata["adverse_selection_risk"] = stringify_decimal(
            advice.adverse_selection_risk
        )
        metadata["simulator_version"] = advice.simulator_version
        metadata["expected_shortfall_bps_p50"] = stringify_decimal(
            advice.expected_shortfall_bps_p50
        )
        metadata["expected_shortfall_bps_p95"] = stringify_decimal(
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
            metadata["max_participation_rate"] = stringify_decimal(candidate)
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
        price = resolve_price(decision, market_snapshot)
        if price is None:
            return decision, selected_order_type
        spread = optional_decimal(decision.params.get("spread"))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread
        return (
            decision.model_copy(
                update={
                    "order_type": "limit",
                    "limit_price": near_touch_limit_price(
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

        return ExecutionPolicyConfig(
            min_notional=config.min_notional,
            max_notional=config.max_notional,
            max_participation_rate=max_participation_rate,
            allow_shorts=config.allow_shorts,
            kill_switch_enabled=config.kill_switch_enabled,
            prefer_limit=config.prefer_limit,
        )

    def _resolve_config(
        self, *, strategy: Optional[Strategy], kill_switch_enabled: Optional[bool]
    ) -> ExecutionPolicyConfig:
        if self.config is not None:
            return self.config

        if self.economic_policy is not None:
            resolved_kill_switch_enabled = (
                settings.trading_kill_switch_enabled
                if kill_switch_enabled is None
                else kill_switch_enabled
            )
            return self.economic_policy.execution_policy_config(
                kill_switch_enabled=resolved_kill_switch_enabled
            )

        min_notional = optional_decimal(settings.trading_min_notional_per_trade)
        max_notional = optional_decimal(
            strategy.max_notional_per_trade if strategy else None
        )
        if max_notional is None:
            max_notional = optional_decimal(settings.trading_max_notional_per_trade)

        max_participation = optional_decimal(settings.trading_max_participation_rate)
        if max_participation is None:
            max_participation = self.cost_model.config.max_participation_rate

        resolved_kill_switch_enabled = (
            settings.trading_kill_switch_enabled
            if kill_switch_enabled is None
            else kill_switch_enabled
        )

        return ExecutionPolicyConfig(
            min_notional=min_notional,
            max_notional=max_notional,
            max_participation_rate=max_participation,
            allow_shorts=settings.trading_allow_shorts,
            kill_switch_enabled=resolved_kill_switch_enabled,
            prefer_limit=settings.trading_execution_prefer_limit,
        )

    def _select_order_type(
        self,
        decision: StrategyDecision,
        market_snapshot: Optional[MarketSnapshot],
        *,
        prefer_limit: bool,
    ) -> tuple[StrategyDecision, str]:
        price = resolve_price(decision, market_snapshot)
        spread = optional_decimal(decision.params.get("spread"))
        if spread is None and market_snapshot is not None:
            spread = market_snapshot.spread

        selected_order_type = decision.order_type
        limit_price = decision.limit_price
        stop_price = decision.stop_price

        if (
            decision.order_type == "market"
            and prefer_limit
            and price is not None
            and not should_keep_market_order_for_high_conviction_entry(
                decision,
                price=price,
                spread=spread,
            )
            and not should_keep_market_order_for_pair_runtime_exit(
                decision,
                price=price,
                spread=spread,
            )
        ):
            selected_order_type = "limit"
            limit_price = near_touch_limit_price(price, spread, decision.action)

        if (
            selected_order_type in {"limit", "stop_limit"}
            and limit_price is None
            and price is not None
        ):
            limit_price = normalize_price_for_trading(price)
        elif limit_price is not None:
            limit_price = normalize_price_for_trading(limit_price)

        if (
            selected_order_type in {"stop", "stop_limit"}
            and stop_price is None
            and price is not None
        ):
            stop_price = normalize_price_for_trading(price)
        elif stop_price is not None:
            stop_price = normalize_price_for_trading(stop_price)

        updated = decision.model_copy(
            update={
                "order_type": selected_order_type,
                "limit_price": limit_price,
                "stop_price": stop_price,
            }
        )
        return updated, selected_order_type


__all__ = ["ExecutionPolicy"]

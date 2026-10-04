"""Trading pipeline implementation."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Optional, Sequence, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Strategy,
)
from ...firewall import OrderFirewall
from ...llm import LLMReviewEngine, apply_policy
from ...llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
)
from ...llm.guardrails import evaluate_llm_guardrails
from ...models import StrategyDecision
from ...portfolio import (
    PortfolioSizingResult,
    sizer_from_settings,
)
from ...quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from ..pipeline_helpers import build_llm_policy_resolution

from .contexts import (
    LLMPolicyReviewRequest,
    LLMReviewContext,
    LLMReviewErrorRequest,
    LLMReviewInputs,
    LLMReviewRecord,
    LLMReviewRunRequest,
    LLMRuntimeReviewResult,
    LLMRuntimeBlockRequest,
    LLMUnavailableRequest,
    MarketContextBlockRequest,
)
from .shared import (
    TradingPipelineRuntime,
    RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS,
)
from .support import (
    build_portfolio_snapshot,
    is_runtime_risk_increasing_entry,
    load_recent_decisions,
    optional_decimal,
)

logger = logging.getLogger(__name__)


class TradingPipelineReviewMixin(TradingPipelineRuntime):
    def _resolve_regime_confidence_thresholds(
        self,
        entropy_band: str,
    ) -> tuple[Decimal, Decimal]:
        normalized_entropy_band = (entropy_band or "").strip().lower()
        (
            degrade_threshold,
            abstain_threshold,
        ) = settings.trading_runtime_regime_confidence_thresholds_by_entropy_band.get(
            normalized_entropy_band,
            RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS,
        )
        decimal_degrade_threshold = Decimal(str(degrade_threshold))
        decimal_abstain_threshold = Decimal(str(abstain_threshold))
        return max(
            decimal_degrade_threshold, decimal_abstain_threshold
        ), decimal_abstain_threshold

    def _apply_runtime_uncertainty_gate(
        self,
        decision: StrategyDecision,
        *,
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, dict[str, Any], str | None]:
        uncertainty_gate, regime_gate, gate = (
            self._resolve_runtime_uncertainty_gate_components(decision)
        )
        risk_increasing_entry = is_runtime_risk_increasing_entry(decision, positions)
        payload: dict[str, Any] = {
            "action": gate.action,
            "source": gate.source,
            "uncertainty_gate": uncertainty_gate.to_payload(),
            "regime_gate": regime_gate.to_payload(),
            "risk_increasing_entry": risk_increasing_entry,
            "entry_blocked": False,
            "block_reason": None,
            "degrade_qty_multiplier": None,
            "max_participation_rate_override": None,
            "min_execution_seconds": None,
            "coverage_error": (
                str(uncertainty_gate.coverage_error)
                if uncertainty_gate.coverage_error is not None
                else None
            ),
            "shift_score": (
                str(uncertainty_gate.shift_score)
                if uncertainty_gate.shift_score is not None
                else None
            ),
            "conformal_interval_width": (
                str(uncertainty_gate.conformal_interval_width)
                if uncertainty_gate.conformal_interval_width is not None
                else None
            ),
        }
        if gate.action == "pass":
            return decision, payload, None
        if self._should_degrade_runtime_uncertainty_fail(uncertainty_gate, gate):
            payload["original_action"] = gate.action
            payload["original_source"] = gate.source
            payload["action"] = "degrade"
            payload["source"] = "autonomy_gate_report_coverage_fallback"
            payload["fallback_applied"] = True
            payload["fallback_reason"] = "autonomy_gate_report_coverage_error"
            return self._degrade_runtime_uncertainty_gate_decision(
                decision=decision,
                positions=positions,
                regime_gate=regime_gate,
                payload=payload,
            )
        if gate.action in {"abstain", "fail"}:
            if risk_increasing_entry:
                reason = (
                    "runtime_uncertainty_gate_fail_block_new_entries"
                    if gate.action == "fail"
                    else "runtime_uncertainty_gate_abstain_block_risk_increasing_entries"
                )
                payload["entry_blocked"] = True
                payload["block_reason"] = reason
                payload["regime_action_blocked"] = (
                    regime_gate.source
                    if regime_gate.action in {"abstain", "fail"}
                    else None
                )
                payload["uncertainty_action_blocked"] = (
                    uncertainty_gate.source
                    if uncertainty_gate.action in {"abstain", "fail"}
                    else None
                )
                return decision, payload, reason
            return decision, payload, None

        return self._degrade_runtime_uncertainty_gate_decision(
            decision=decision,
            positions=positions,
            regime_gate=regime_gate,
            payload=payload,
        )

    def _execution_client_for_symbol(
        self,
        symbol: str,
    ) -> Any:
        _ = symbol
        if getattr(self.execution_adapter, "name", None) == "simulation":
            return self.execution_adapter
        return self.order_firewall

    def _execution_client_name(self, client: Any) -> str:
        raw_name = getattr(client, "name", None)
        if raw_name:
            return str(raw_name)
        if isinstance(client, OrderFirewall):
            return "alpaca"
        return type(client).__name__

    def _apply_portfolio_sizing(
        self,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> PortfolioSizingResult:
        equity = optional_decimal(account.get("equity"))
        sizer = sizer_from_settings(strategy, equity)
        return sizer.size(decision, account=account, positions=positions)

    @staticmethod
    def _load_strategies(session: Session) -> list[Strategy]:
        stmt = select(Strategy).where(Strategy.enabled.is_(True))
        return list(session.execute(stmt).scalars().all())

    def _apply_llm_review(
        self,
        context: LLMReviewContext,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, Optional[str]]:
        if not settings.llm_enabled:
            return decision, None

        guardrails = evaluate_llm_guardrails()
        policy_resolution = build_llm_policy_resolution(
            rollout_stage=guardrails.rollout_stage,
            effective_fail_mode=guardrails.effective_fail_mode,
            guardrail_reasons=guardrails.reasons,
        )
        self._record_llm_policy_resolution_metrics(policy_resolution)
        engine: LLMReviewEngine | None = None

        runtime_review = self._resolve_active_dspy_runtime_review(
            LLMPolicyReviewRequest(
                context=context,
                decision=decision,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
            )
        )
        if runtime_review.block is not None:
            return runtime_review.block
        engine = runtime_review.engine

        guardrail_block = self._handle_llm_guardrail_block(
            LLMPolicyReviewRequest(
                context=context,
                decision=decision,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
            )
        )
        if guardrail_block is not None:
            return guardrail_block

        if engine is None:
            engine = self.llm_review_engine or LLMReviewEngine()

        circuit_open = self._handle_llm_circuit_open(
            LLMPolicyReviewRequest(
                context=context,
                decision=decision,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
                engine=engine,
            )
        )
        if circuit_open is not None:
            return circuit_open

        request_json: dict[str, Any] = {}
        try:
            return self._run_llm_review_request(
                LLMReviewRunRequest(
                    context=context,
                    decision=decision,
                    guardrails=guardrails,
                    policy_resolution=policy_resolution,
                    engine=engine,
                    request_json=request_json,
                )
            )
        except Exception as exc:
            return self._handle_llm_review_error(
                LLMReviewErrorRequest(
                    context=context,
                    decision=decision,
                    guardrails=guardrails,
                    policy_resolution=policy_resolution,
                    engine=engine,
                    request_json=request_json,
                    error=exc,
                )
            )

    def _record_llm_policy_resolution_metrics(
        self, policy_resolution: Mapping[str, Any]
    ) -> None:
        self.state.metrics.record_llm_policy_resolution(
            cast(str | None, policy_resolution.get("classification"))
        )
        if bool(policy_resolution.get("stage_policy_violation")):
            self.state.metrics.llm_stage_policy_violation_total += 1
        if bool(policy_resolution.get("fail_mode_exception_active")):
            self.state.metrics.llm_fail_mode_exception_total += 1
            return
        if bool(policy_resolution.get("fail_mode_violation_active")):
            self.state.metrics.llm_fail_mode_override_total += 1

    def _resolve_active_dspy_runtime_review(
        self,
        request: LLMPolicyReviewRequest,
    ) -> LLMRuntimeReviewResult:
        if settings.llm_dspy_runtime_mode != "active":
            return LLMRuntimeReviewResult(engine=request.engine)
        gate_allowed, gate_reasons = settings.llm_dspy_live_runtime_gate()
        if not gate_allowed:
            return LLMRuntimeReviewResult(
                engine=None,
                block=self._handle_dspy_runtime_readiness_block(request, gate_reasons),
            )

        engine = request.engine or self.llm_review_engine or LLMReviewEngine()
        dspy_runtime = getattr(engine, "dspy_runtime", None)
        if isinstance(dspy_runtime, DSPyReviewRuntime):
            ready, readiness_reasons = dspy_runtime.evaluate_live_readiness()
        else:
            ready, readiness_reasons = (
                DSPyReviewRuntime.from_settings().evaluate_live_readiness()
            )
        if ready:
            return LLMRuntimeReviewResult(engine=engine)
        return LLMRuntimeReviewResult(
            engine=engine,
            block=self._handle_dspy_runtime_readiness_block(
                request,
                readiness_reasons,
            ),
        )

    def _handle_dspy_runtime_readiness_block(
        self,
        request: LLMPolicyReviewRequest,
        reasons: Sequence[str],
    ) -> tuple[StrategyDecision, Optional[str]]:
        reject_reason, runtime_subtype = self._classify_dspy_live_runtime_block(reasons)
        response_payload_extra = {
            "llm_runtime": {
                "reject_reason": reject_reason,
                "subtype": runtime_subtype,
                "error": "llm_dspy_live_runtime_gate_blocked",
                "primary_reason": (
                    reasons[0] if reasons else "llm_dspy_live_runtime_gate_blocked"
                ),
            }
        }
        guardrails = request.guardrails
        return self._handle_llm_dspy_live_runtime_block(
            LLMRuntimeBlockRequest(
                context=request.context,
                decision=request.decision,
                reason="llm_dspy_live_runtime_gate_blocked",
                reject_reason=reject_reason,
                risk_flags=list(reasons),
                response_payload_extra=response_payload_extra,
                policy_resolution=build_llm_policy_resolution(
                    rollout_stage=guardrails.rollout_stage,
                    effective_fail_mode="veto",
                    guardrail_reasons=tuple(guardrails.reasons) + tuple(reasons),
                ),
            ),
        )

    def _handle_llm_guardrail_block(
        self,
        request: LLMPolicyReviewRequest,
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        guardrails = request.guardrails
        if guardrails.allow_requests:
            return None
        self.state.metrics.llm_guardrail_block_total += 1
        return self._handle_llm_unavailable(
            LLMUnavailableRequest(
                context=request.context,
                decision=request.decision,
                reason="llm_guardrail_blocked",
                shadow_mode=True,
                effective_fail_mode=guardrails.effective_fail_mode,
                risk_flags=list(guardrails.reasons),
                market_context=None,
                policy_resolution=request.policy_resolution,
            )
        )

    def _handle_llm_circuit_open(
        self,
        request: LLMPolicyReviewRequest,
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        guardrails = request.guardrails
        engine = cast(LLMReviewEngine, request.engine)
        if not engine.circuit_breaker.is_open():
            return None
        self.state.metrics.llm_circuit_open_total += 1
        return self._handle_llm_unavailable(
            LLMUnavailableRequest(
                context=request.context,
                decision=request.decision,
                reason="llm_circuit_open",
                shadow_mode=guardrails.shadow_mode,
                effective_fail_mode=guardrails.effective_fail_mode,
                market_context=None,
                policy_resolution=request.policy_resolution,
            )
        )

    def _handle_llm_dspy_live_runtime_block(
        self,
        request: LLMRuntimeBlockRequest,
    ) -> tuple[StrategyDecision, Optional[str]]:
        block_fail_mode = settings.llm_dspy_live_runtime_block_fail_mode
        if request.reject_reason.startswith("llm_runtime_fallback"):
            self.state.metrics.llm_runtime_fallback_total += 1
        effective_fail_mode = "veto" if block_fail_mode == "veto" else "pass_through"
        passthrough_decision = request.decision
        if block_fail_mode == "pass_through_reduced_size":
            passthrough_decision = self._degrade_llm_runtime_block_qty(
                decision=request.decision,
                positions=request.context.positions,
                reason=request.reason,
                risk_flags=request.risk_flags,
            )
        return self._handle_llm_unavailable(
            LLMUnavailableRequest(
                context=request.context,
                decision=passthrough_decision,
                reason=request.reason,
                reject_reason=request.reject_reason,
                shadow_mode=False,
                effective_fail_mode=effective_fail_mode,
                risk_flags=request.risk_flags,
                market_context=None,
                response_payload_extra=request.response_payload_extra,
                policy_resolution=request.policy_resolution,
            )
        )

    @staticmethod
    def _classify_dspy_live_runtime_block(
        reasons: Sequence[str] | tuple[str, ...],
    ) -> tuple[str, str]:
        normalized = tuple(
            str(reason).strip() for reason in reasons if str(reason).strip()
        )
        if any(
            reason.startswith("dspy_live_readiness_error:")
            or reason == "dspy_live_runtime_not_ready"
            for reason in normalized
        ):
            return ("llm_runtime_fallback_runtime_not_ready", "runtime_not_ready")
        if any(
            "artifact" in reason or "manifest" in reason or "executor" in reason
            for reason in normalized
        ):
            return ("llm_runtime_fallback_artifact_invalid", "artifact_invalid")
        if any(
            reason.startswith("dspy_live_")
            or reason.startswith("dspy_jangar_")
            or reason.startswith("llm_model_")
            or reason.startswith("llm_shadow_")
            or reason.startswith("llm_evaluation_")
            or reason.startswith("llm_effective_")
            or reason.startswith("llm_committee_")
            or reason.startswith("dspy_cutover_")
            or reason == "migration_guard_failed"
            or "migration_guard" in reason
            for reason in normalized
        ):
            return ("llm_runtime_fallback_policy_blocked", "policy_blocked")
        return ("llm_runtime_fallback_runtime_not_ready", "runtime_not_ready")

    def _bounded_degraded_qty(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
        multiplier: Decimal,
    ) -> Decimal:
        if multiplier >= Decimal("1"):
            return decision.qty

        current_qty = Decimal("0")
        for position in positions:
            if str(position.get("symbol") or "").upper() != decision.symbol.upper():
                continue
            raw_qty = position.get("qty") or position.get("quantity")
            if raw_qty is None:
                continue
            try:
                qty = Decimal(str(raw_qty))
            except (ArithmeticError, ValueError):
                continue
            side = str(position.get("side") or "").lower()
            if side == "short":
                qty = -abs(qty)
            current_qty += qty

        scaled_qty = decision.qty * multiplier
        resolution = resolve_quantity_resolution(
            decision.symbol,
            action=decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=current_qty,
            requested_qty=scaled_qty,
        )
        if decision.action == "sell":
            self.state.metrics.record_sell_inventory_context(
                stage="pipeline",
                context=self._sell_inventory_context(
                    decision=decision,
                    positions=positions,
                    projected=True,
                ),
            )
        self.state.metrics.record_qty_resolution(
            stage="pipeline",
            outcome="fractional" if resolution.fractional_allowed else "integer",
            reason=resolution.reason,
        )
        quantized_qty = quantize_qty_for_symbol(
            decision.symbol,
            scaled_qty,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        min_qty = min_qty_for_symbol(
            decision.symbol, fractional_equities_enabled=resolution.fractional_allowed
        )
        if quantized_qty < min_qty:
            if decision.qty >= min_qty:
                quantized_qty = min_qty
            else:
                quantized_qty = decision.qty
        if quantized_qty <= 0 or quantized_qty >= decision.qty:
            return decision.qty
        return quantized_qty

    def _degrade_llm_runtime_block_qty(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
        reason: str,
        risk_flags: list[str],
    ) -> StrategyDecision:
        multiplier = Decimal(str(settings.llm_dspy_live_runtime_block_qty_multiplier))
        quantized_qty = self._bounded_degraded_qty(
            decision=decision,
            positions=positions,
            multiplier=multiplier,
        )
        if quantized_qty >= decision.qty:
            return decision

        updated_params = dict(decision.params)
        updated_params["llm_runtime_block_degrade"] = {
            "reason": reason,
            "risk_flags": list(risk_flags),
            "qty_multiplier": str(multiplier),
            "original_qty": str(decision.qty),
            "degraded_qty": str(quantized_qty),
        }
        return decision.model_copy(
            update={"qty": quantized_qty, "params": updated_params}
        )

    def _run_llm_review_request(
        self,
        request: LLMReviewRunRequest,
    ) -> tuple[StrategyDecision, Optional[str]]:
        context = request.context
        decision = request.decision
        guardrails = request.guardrails
        engine = request.engine
        request_json = request.request_json
        pre_llm_reject_reason = self._record_pre_llm_executability_reject(decision)
        if pre_llm_reject_reason is not None:
            return decision, pre_llm_reject_reason

        self.state.metrics.llm_requests_total += 1
        inputs = self._llm_review_inputs(request)
        market_context_block = self._maybe_handle_market_context_block(
            MarketContextBlockRequest(
                context=context,
                decision=decision,
                guardrails=guardrails,
                policy_resolution=request.policy_resolution,
                market_context=inputs.market_context,
                market_context_error=inputs.market_context_error,
            )
        )
        if market_context_block is not None:
            return market_context_block

        llm_request = engine.build_request(
            decision,
            context.account,
            context.positions,
            inputs.portfolio_snapshot,
            inputs.market_snapshot,
            inputs.market_context,
            inputs.recent_decisions,
            adjustment_allowed=guardrails.adjustment_allowed,
        )
        request_json.update(llm_request.model_dump(mode="json"))
        outcome = engine.review(
            decision,
            context.account,
            context.positions,
            request=llm_request,
            portfolio=inputs.portfolio_snapshot,
            market=inputs.market_snapshot,
            market_context=inputs.market_context,
            recent_decisions=inputs.recent_decisions,
        )
        runtime_fallback = self._handle_llm_runtime_fallback(request, outcome)
        if runtime_fallback is not None:
            return runtime_fallback
        self._record_llm_verdict_counter(outcome.response.verdict)
        policy_outcome = apply_policy(
            decision,
            outcome.response,
            adjustment_allowed=guardrails.adjustment_allowed,
        )
        response_json = self._build_llm_response_json(
            outcome=outcome,
            policy_outcome=policy_outcome,
            guardrails=guardrails,
            policy_resolution=request.policy_resolution,
        )
        self._persist_successful_llm_review(
            request=request,
            outcome=outcome,
            policy_outcome=policy_outcome,
            response_json=response_json,
        )
        engine.circuit_breaker.record_success()
        return self._finalize_llm_review_outcome(
            decision=decision,
            outcome=outcome,
            policy_outcome=policy_outcome,
            guardrails=guardrails,
        )

    def _record_pre_llm_executability_reject(
        self,
        decision: StrategyDecision,
    ) -> str | None:
        pre_llm_reject_reason = self._resolve_pre_llm_executability_reject(decision)
        if pre_llm_reject_reason == "symbol_capacity_exhausted":
            self.state.metrics.pre_llm_capacity_reject_total += 1
            return pre_llm_reject_reason
        if pre_llm_reject_reason == "qty_below_min":
            self.state.metrics.pre_llm_qty_below_min_total += 1
            return pre_llm_reject_reason
        return None

    def _llm_review_inputs(
        self,
        request: LLMReviewRunRequest,
    ) -> LLMReviewInputs:
        decision = request.decision
        context = request.context
        market_context, market_context_error = self._fetch_market_context(
            decision.symbol,
            as_of=decision.event_ts,
        )
        self._record_market_context_observation(
            symbol=decision.symbol,
            market_context=market_context,
            market_context_error=market_context_error,
        )
        if market_context_error is not None:
            self.state.metrics.llm_market_context_error_total += 1
        return LLMReviewInputs(
            portfolio_snapshot=build_portfolio_snapshot(
                context.account,
                context.positions,
            ),
            market_snapshot=self._build_market_snapshot(decision),
            market_context=market_context,
            market_context_error=market_context_error,
            recent_decisions=load_recent_decisions(
                context.session,
                decision.strategy_id,
                decision.symbol,
            ),
        )

    def _handle_llm_runtime_fallback(
        self,
        request: LLMReviewRunRequest,
        outcome: Any,
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        if outcome.runtime_fallback is None:
            return None
        self.executor.update_decision_json(
            request.context.session,
            request.context.decision_row,
            {"llm_runtime": outcome.runtime_fallback},
        )
        runtime_error = str(
            outcome.runtime_fallback.get("error") or "dspy_runtime_error"
        )
        runtime_subtype = str(
            outcome.runtime_fallback.get("subtype") or "dspy_runtime_error"
        )
        return self._handle_llm_dspy_live_runtime_block(
            LLMRuntimeBlockRequest(
                context=request.context,
                decision=request.decision,
                reason=runtime_error,
                reject_reason=str(
                    outcome.runtime_fallback.get("reject_reason")
                    or "llm_runtime_fallback"
                ),
                risk_flags=[runtime_subtype, runtime_error],
                response_payload_extra={
                    "llm_runtime": outcome.runtime_fallback,
                    "dspy": outcome.response_json.get("dspy"),
                },
                policy_resolution=request.policy_resolution,
            )
        )

    def _persist_successful_llm_review(
        self,
        *,
        request: LLMReviewRunRequest,
        outcome: Any,
        policy_outcome: Any,
        response_json: dict[str, Any],
    ) -> None:
        context = request.context
        self._record_llm_committee_metrics(response_json)
        self._record_llm_token_metrics(outcome)
        adjusted_qty, adjusted_order_type = self._apply_llm_policy_verdict(
            session=context.session,
            decision_row=context.decision_row,
            policy_outcome=policy_outcome,
        )
        self._persist_llm_review(
            LLMReviewRecord(
                session=context.session,
                decision_row=context.decision_row,
                model=outcome.model,
                prompt_version=outcome.prompt_version,
                request_json=outcome.request_json,
                response_json=response_json,
                verdict=policy_outcome.verdict,
                confidence=outcome.response.confidence,
                adjusted_qty=adjusted_qty,
                adjusted_order_type=adjusted_order_type,
                rationale=outcome.response.rationale,
                risk_flags=outcome.response.risk_flags,
                tokens_prompt=outcome.tokens_prompt,
                tokens_completion=outcome.tokens_completion,
            )
        )

"""Trading pipeline implementation."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    TradeDecision,
)
from ....observability import capture_posthog_event
from ...models import StrategyDecision
from ...prices import MarketSnapshot
from ...execution_runtime import ExecutionOrderResult, record_last_execution_order
from ...tca import derive_adaptive_execution_policy
from ..state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
)

from .contexts import (
    DecisionBlockRequest,
    DecisionRejectionRequest,
    DecisionSubmissionContext,
    DomainTelemetryEvent,
    ExecutionPolicyRequest,
    ExecutionFallbackRequest,
    LLMReviewContext,
    LiveSubmissionGateInputs,
    OrderSubmissionRequest,
    RiskVerdictRequest,
)
from .shared import TradingPipelineBase
from .support import (
    allocator_rejection_reasons,
    autonomy_gate_report_is_saturated_fail_sentinel,
    coerce_json,
    coerce_runtime_uncertainty_gate_action,
    is_runtime_risk_increasing_entry,
    optional_decimal,
    optional_int,
    resolve_decision_regime_label_with_source,
)

logger = logging.getLogger(__name__)


def _decision_execution_notional(decision: StrategyDecision) -> Decimal:
    portfolio_sizing = decision.params.get("portfolio_sizing")
    if isinstance(portfolio_sizing, Mapping):
        portfolio_sizing_map = cast(Mapping[str, Any], portfolio_sizing)
        output = portfolio_sizing_map.get("output")
        if isinstance(output, Mapping):
            output_map = cast(Mapping[str, Any], output)
            final_notional = optional_decimal(output_map.get("final_notional"))
            if final_notional is not None and final_notional > 0:
                return final_notional
    for key in (
        "notional",
        "notional_usd",
        "target_notional",
        "target_notional_usd",
        "final_notional",
    ):
        value = optional_decimal(decision.params.get(key))
        if value is not None and value > 0:
            return value
    price = (
        optional_decimal(decision.params.get("price"))
        or decision.limit_price
        or decision.stop_price
    )
    if price is not None and price > 0 and decision.qty > 0:
        return decision.qty * price
    return Decimal("0")


class TradingPipelineSubmissionPolicyMixin(TradingPipelineBase):
    def _prepare_decision_for_submission(
        self,
        *,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        allocator_rejection = allocator_rejection_reasons(decision)
        if allocator_rejection:
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    context.session,
                    decision,
                    context.decision_row,
                    allocator_rejection,
                    "Decision rejected by allocator strategy_id=%s symbol=%s reason=%s",
                ),
            )
            return None

        decision, snapshot = self._ensure_decision_price(
            decision, signal_price=decision.params.get("price")
        )
        if snapshot is not None:
            price_params_update = cast(
                Mapping[str, Any],
                decision.model_dump(mode="json").get("params", {}),
            )
            self.executor.update_decision_params(
                context.session, context.decision_row, price_params_update
            )

        sizing_result = self._apply_portfolio_sizing(
            decision, context.strategy, context.account, context.positions
        )
        decision = sizing_result.decision
        sizing_params = decision.model_dump(mode="json").get("params", {})
        self.executor.sync_decision_state(
            context.session, context.decision_row, decision
        )
        if isinstance(sizing_params, Mapping) and "portfolio_sizing" in sizing_params:
            self.executor.update_decision_params(
                context.session,
                context.decision_row,
                cast(Mapping[str, Any], sizing_params),
            )
        if not sizing_result.approved:
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    context.session,
                    decision,
                    context.decision_row,
                    sizing_result.reasons,
                    "Decision rejected by portfolio sizing strategy_id=%s symbol=%s reason=%s",
                ),
            )
            return None

        decision, gate_payload, gate_rejection = self._apply_runtime_uncertainty_gate(
            decision, positions=context.positions
        )
        self._persist_runtime_uncertainty_gate_payload(
            session=context.session,
            decision=decision,
            decision_row=context.decision_row,
            gate_payload=gate_payload,
        )
        if gate_rejection:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=gate_rejection,
            )
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    context.session,
                    decision,
                    context.decision_row,
                    [gate_rejection],
                    "Decision rejected by execution gate strategy_id=%s symbol=%s reason=%s",
                ),
            )
            return None

        llm_context = LLMReviewContext(
            session=context.session,
            decision_row=context.decision_row,
            account=context.account,
            positions=context.positions,
        )
        decision, llm_reject_reason = self._apply_llm_review(llm_context, decision)
        self.executor.sync_decision_state(
            context.session, context.decision_row, decision
        )
        if llm_reject_reason:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=None,
            )
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    context.session,
                    decision,
                    context.decision_row,
                    [llm_reject_reason],
                    "Decision rejected by llm review strategy_id=%s symbol=%s reason=%s",
                ),
            )
            return None

        gate_rejection = self._recheck_runtime_uncertainty_gate_after_llm(
            context=context,
            decision=decision,
            gate_payload=gate_payload,
        )
        if gate_rejection:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=gate_rejection,
            )
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    context.session,
                    decision,
                    context.decision_row,
                    [gate_rejection],
                    "Decision rejected by execution gate strategy_id=%s symbol=%s reason=%s",
                ),
            )
            return None

        self._record_runtime_uncertainty_gate_result(
            gate_payload=gate_payload,
            gate_rejection=None,
        )
        return decision, snapshot

    def _record_runtime_uncertainty_gate_result(
        self,
        *,
        gate_payload: Mapping[str, Any],
        gate_rejection: str | None,
    ) -> None:
        uncertainty_gate_payload = gate_payload.get("uncertainty_gate")
        uncertainty_action = "pass"
        if isinstance(uncertainty_gate_payload, Mapping):
            uncertainty_gate_map = cast(Mapping[str, Any], uncertainty_gate_payload)
            uncertainty_action = (
                str(uncertainty_gate_map.get("action") or "pass").strip().lower()
            )
        elif str(gate_payload.get("action") or "pass").strip().lower() in {
            "pass",
            "degrade",
            "abstain",
            "fail",
        }:
            uncertainty_action = (
                str(gate_payload.get("action") or "pass").strip().lower()
            )
        regime_gate_payload = gate_payload.get("regime_gate")
        regime_action = "pass"
        if isinstance(regime_gate_payload, Mapping):
            regime_gate_map = cast(Mapping[str, Any], regime_gate_payload)
            regime_action = str(regime_gate_map.get("action") or "pass").strip().lower()
        if uncertainty_action in {"pass", "degrade", "abstain", "fail"}:
            self.state.metrics.record_runtime_uncertainty_gate(
                cast(RuntimeUncertaintyGateAction, uncertainty_action),
                blocked=gate_rejection is not None,
            )
            self.state.last_runtime_uncertainty_gate_action = uncertainty_action
        else:
            self.state.last_runtime_uncertainty_gate_action = None

        if regime_action in {"pass", "degrade", "abstain", "fail"}:
            self.state.metrics.record_runtime_regime_gate(
                cast(RuntimeUncertaintyGateAction, regime_action),
                blocked=(
                    gate_rejection is not None and regime_action in {"abstain", "fail"}
                ),
            )
            self.state.last_runtime_regime_gate_action = regime_action
        else:
            self.state.last_runtime_regime_gate_action = None

        self.state.last_runtime_uncertainty_gate_source = (
            str(gate_payload.get("source") or "").strip() or None
        )
        self.state.last_runtime_uncertainty_gate_reason = gate_rejection
        uncertainty_gate = gate_payload.get("uncertainty_gate")
        regime_gate = gate_payload.get("regime_gate")
        if isinstance(uncertainty_gate, Mapping):
            uncertainty_gate_map = cast(Mapping[str, Any], uncertainty_gate)
            self.state.last_runtime_uncertainty_gate_source = (
                str(
                    uncertainty_gate_map.get("source")
                    or gate_payload.get("source")
                    or ""
                ).strip()
                or None
            )
            uncertainty_reason = str(uncertainty_gate_map.get("reason") or "").strip()
            if uncertainty_reason:
                self.state.last_runtime_uncertainty_gate_reason = (
                    f"{self.state.last_runtime_uncertainty_gate_reason}|{uncertainty_reason}"
                    if self.state.last_runtime_uncertainty_gate_reason
                    else uncertainty_reason
                )
        if isinstance(regime_gate, Mapping):
            regime_gate_map = cast(Mapping[str, Any], regime_gate)
            self.state.last_runtime_regime_gate_source = (
                str(regime_gate_map.get("source") or "regime").strip() or None
            )
            reason = str(regime_gate_map.get("reason") or "").strip()
            self.state.last_runtime_regime_gate_reason = reason or None
        elif self.state.last_runtime_regime_gate_action is None:
            self.state.last_runtime_regime_gate_action = regime_action
            self.state.last_runtime_regime_gate_source = (
                str(gate_payload.get("source") or "").strip() or None
            )

    def _persist_runtime_uncertainty_gate_payload(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        gate_payload: Mapping[str, Any],
    ) -> None:
        gate_params = decision.model_dump(mode="json").get("params", {})
        params_update: dict[str, Any] = {"runtime_uncertainty_gate": dict(gate_payload)}
        if isinstance(gate_params, Mapping):
            params_update = dict(cast(Mapping[str, Any], gate_params))
            params_update["runtime_uncertainty_gate"] = dict(gate_payload)
        self.executor.update_decision_params(session, decision_row, params_update)

    @staticmethod
    def _should_degrade_runtime_uncertainty_fail(
        uncertainty_gate: RuntimeUncertaintyGate,
        gate: RuntimeUncertaintyGate,
    ) -> bool:
        if uncertainty_gate.source != "autonomy_gate_report":
            return False
        return autonomy_gate_report_is_saturated_fail_sentinel(
            action=gate.action,
            coverage_error=uncertainty_gate.coverage_error,
            shift_score=uncertainty_gate.shift_score,
            conformal_interval_width=uncertainty_gate.conformal_interval_width,
        )

    @staticmethod
    def _should_degrade_runtime_uncertainty_fail_from_payload(
        gate_payload: Mapping[str, Any],
    ) -> bool:
        if (
            str(gate_payload.get("source") or "").strip().lower()
            != "autonomy_gate_report"
        ):
            return False
        action = coerce_runtime_uncertainty_gate_action(gate_payload.get("action"))
        if action is None:
            return False
        return autonomy_gate_report_is_saturated_fail_sentinel(
            action=action,
            coverage_error=optional_decimal(gate_payload.get("coverage_error")),
            shift_score=optional_decimal(gate_payload.get("shift_score")),
            conformal_interval_width=optional_decimal(
                gate_payload.get("conformal_interval_width")
            ),
        )

    def _degrade_runtime_uncertainty_gate_decision(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
        regime_gate: RuntimeUncertaintyGate,
        payload: dict[str, Any],
    ) -> tuple[StrategyDecision, dict[str, Any], str | None]:
        params = dict(decision.params)
        (
            degrade_qty_multiplier,
            max_participation_rate,
            min_execution_seconds,
        ) = self._resolve_runtime_uncertainty_degrade_profile(
            decision=decision,
            regime_gate=regime_gate,
        )
        allocator = coerce_json(params.get("allocator"))
        current_override = optional_decimal(
            allocator.get("max_participation_rate_override")
        )
        if current_override is None or current_override > max_participation_rate:
            allocator["max_participation_rate_override"] = str(max_participation_rate)
        params["allocator"] = allocator
        execution_seconds = optional_int(params.get("execution_seconds"))
        if execution_seconds is None or execution_seconds < min_execution_seconds:
            params["execution_seconds"] = min_execution_seconds

        adjusted_qty = self._bounded_degraded_qty(
            decision=decision,
            positions=positions,
            multiplier=degrade_qty_multiplier,
        )
        payload["degrade_qty_multiplier"] = str(degrade_qty_multiplier)
        payload["max_participation_rate_override"] = str(max_participation_rate)
        payload["min_execution_seconds"] = min_execution_seconds
        payload["adjusted_qty"] = str(adjusted_qty)
        return (
            decision.model_copy(update={"qty": adjusted_qty, "params": params}),
            payload,
            None,
        )

    def _recheck_runtime_uncertainty_gate_after_llm(
        self,
        *,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
        gate_payload: dict[str, Any],
    ) -> str | None:
        gate_action = str(gate_payload.get("action") or "pass").strip().lower()
        if self._should_degrade_runtime_uncertainty_fail_from_payload(gate_payload):
            gate_payload["original_action"] = gate_action
            gate_payload["original_source"] = gate_payload.get("source")
            gate_payload["action"] = "degrade"
            gate_payload["source"] = "autonomy_gate_report_coverage_fallback"
            gate_payload["fallback_applied"] = True
            gate_payload["fallback_reason"] = "autonomy_gate_report_coverage_error"
            gate_payload["entry_blocked"] = False
            gate_payload["block_reason"] = None
            self._persist_runtime_uncertainty_gate_payload(
                session=context.session,
                decision=decision,
                decision_row=context.decision_row,
                gate_payload=gate_payload,
            )
            return None
        if gate_action not in {"abstain", "fail"}:
            return None
        risk_increasing_entry = is_runtime_risk_increasing_entry(
            decision, context.positions
        )
        gate_payload["risk_increasing_entry"] = risk_increasing_entry
        if not risk_increasing_entry:
            gate_payload["entry_blocked"] = False
            gate_payload["block_reason"] = None
            self._persist_runtime_uncertainty_gate_payload(
                session=context.session,
                decision=decision,
                decision_row=context.decision_row,
                gate_payload=gate_payload,
            )
            return None
        reason = (
            "runtime_uncertainty_gate_fail_block_new_entries"
            if gate_action == "fail"
            else "runtime_uncertainty_gate_abstain_block_risk_increasing_entries"
        )
        gate_payload["entry_blocked"] = True
        gate_payload["block_reason"] = reason
        self._persist_runtime_uncertainty_gate_payload(
            session=context.session,
            decision=decision,
            decision_row=context.decision_row,
            gate_payload=gate_payload,
        )
        return reason

    def _record_decision_rejection(
        self,
        request: DecisionRejectionRequest,
    ) -> None:
        reasons = request.reasons
        if not reasons:
            return
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_rejection_reasons(reasons)
        self.state.metrics.record_decision_state("rejected")
        for reason in reasons:
            logger.info(
                request.log_template,
                request.decision.strategy_id,
                request.decision.symbol,
                reason,
            )
        self.executor.mark_rejected(
            request.session,
            request.decision_row,
            ";".join(reasons),
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_pre_submit"
            ),
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.decision.blocked",
                severity="warning",
                decision=request.decision,
                decision_row=request.decision_row,
                reason_codes=reasons,
                extra_properties={"decision_status": "rejected"},
            )
        )

    def _emit_domain_telemetry(
        self,
        event: DomainTelemetryEvent,
    ) -> None:
        properties: dict[str, Any] = {
            "account_label": self.account_label,
            "trading_mode": settings.trading_mode,
        }
        if event.decision is not None:
            properties.update(
                {
                    "strategy_id": event.decision.strategy_id,
                    "symbol": event.decision.symbol,
                    "timeframe": event.decision.timeframe,
                    "decision_action": event.decision.action,
                }
            )
        if event.decision_row is not None:
            properties["trade_decision_id"] = str(event.decision_row.id)
            properties["decision_hash"] = event.decision_row.decision_hash
            properties["decision_status"] = event.decision_row.status
        if event.execution is not None:
            properties["execution_id"] = str(getattr(event.execution, "id", ""))
            properties["execution_status"] = str(getattr(event.execution, "status", ""))
            properties["execution_correlation_id"] = str(
                getattr(event.execution, "execution_correlation_id", "") or ""
            )
            properties["execution_idempotency_key"] = str(
                getattr(event.execution, "execution_idempotency_key", "") or ""
            )
            properties["execution_fallback_reason"] = str(
                getattr(event.execution, "execution_fallback_reason", "") or ""
            )
        if event.reason_codes:
            properties["reason_codes"] = sorted(
                {
                    str(reason).strip()
                    for reason in event.reason_codes
                    if str(reason).strip()
                }
            )
        if event.extra_properties:
            properties.update(
                {str(key): value for key, value in event.extra_properties.items()}
            )
        emitted, drop_reason = capture_posthog_event(
            event.event_name,
            severity=event.severity,
            distinct_id=f"torghut-{self.account_label}",
            properties=properties,
        )
        self.state.metrics.record_domain_telemetry(
            event_name=event.event_name,
            emitted=emitted,
            drop_reason=drop_reason,
        )

    def _evaluate_execution_policy_outcome(
        self,
        request: ExecutionPolicyRequest,
    ) -> tuple[StrategyDecision, Any] | None:
        context = request.context
        decision = request.decision
        regime_label, regime_source, regime_fallback = (
            resolve_decision_regime_label_with_source(decision)
        )
        self.state.metrics.record_decision_regime_resolution(
            source=regime_source,
            fallback_reason=regime_fallback,
        )
        adaptive_policy = derive_adaptive_execution_policy(
            context.session,
            symbol=decision.symbol,
            regime_label=regime_label,
        )
        policy_outcome = self.execution_policy.evaluate(
            decision,
            strategy=context.strategy,
            positions=context.positions,
            market_snapshot=request.snapshot,
            kill_switch_enabled=self.order_firewall.status().kill_switch_enabled,
            adaptive_policy=adaptive_policy,
        )
        decision = policy_outcome.decision
        self.executor.update_decision_params(
            context.session, context.decision_row, policy_outcome.params_update()
        )
        self.state.metrics.record_execution_advisor_result(
            policy_outcome.advisor_metadata
        )
        self.state.metrics.record_adaptive_policy_result(
            adaptive_policy,
            applied=bool(
                policy_outcome.adaptive is not None and policy_outcome.adaptive.applied
            ),
        )
        self.executor.sync_decision_state(
            context.session, context.decision_row, decision
        )
        if not policy_outcome.approved:
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    context.session,
                    decision,
                    context.decision_row,
                    list(policy_outcome.reasons),
                    "Decision rejected by execution policy strategy_id=%s symbol=%s reason=%s",
                )
            )
            return None
        return decision, policy_outcome

    def _passes_risk_verdict(
        self,
        request: RiskVerdictRequest,
    ) -> bool:
        context = request.context
        verdict = self.risk_engine.evaluate(
            context.session,
            request.decision,
            context.strategy,
            context.account,
            context.positions,
            context.symbol_allowlist,
            execution_advisor=request.execution_advisor,
        )
        if verdict.approved:
            return True
        self._record_decision_rejection(
            DecisionRejectionRequest(
                context.session,
                request.decision,
                context.decision_row,
                list(verdict.reasons),
                "Decision rejected strategy_id=%s symbol=%s reason=%s",
            )
        )
        return False

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        if not settings.trading_enabled:
            self._block_decision_submission(
                DecisionBlockRequest(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason="trading_disabled",
                    submission_stage="blocked_trading_disabled",
                )
            )
            logger.warning(
                "Decision blocked because trading is disabled strategy_id=%s decision_id=%s symbol=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
            )
            return False
        live_submission_gate = self._live_submission_gate(
            inputs=LiveSubmissionGateInputs(session=session)
        )
        if settings.trading_mode == "live" and not bool(
            live_submission_gate.get("allowed", False)
        ):
            self._block_decision_submission(
                DecisionBlockRequest(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason="capital_stage_shadow",
                    submission_stage="blocked_capital_stage_shadow",
                    capital_stage="shadow",
                    extra_metadata={"live_submission_gate": live_submission_gate},
                )
            )
            logger.info(
                "Decision held in shadow stage strategy_id=%s decision_id=%s symbol=%s gate_reason=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                live_submission_gate.get("reason"),
            )
            return False
        if not (
            settings.trading_emergency_stop_enabled and self.state.emergency_stop_active
        ):
            return True
        reason = self.state.emergency_stop_reason or "emergency_stop_active"
        self._block_decision_submission(
            DecisionBlockRequest(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=reason,
                submission_stage="blocked_emergency_stop",
            )
        )
        logger.error(
            "Decision blocked by emergency stop strategy_id=%s decision_id=%s symbol=%s reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            reason,
        )
        return False

    def _submit_decision_execution(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        policy_outcome: Any,
    ) -> bool:
        execution_client = self._execution_client_for_symbol(decision.symbol)
        selected_adapter_name = self._execution_client_name(execution_client)
        self._maybe_record_lean_strategy_shadow(
            session=session,
            decision=decision,
            execution_client=execution_client,
            selected_adapter_name=selected_adapter_name,
        )
        self.state.metrics.record_execution_request(selected_adapter_name)
        self.executor.update_decision_json(
            session,
            decision_row,
            self._decision_lifecycle_metadata(submission_stage="submit_requested"),
        )
        self.executor.update_decision_params(
            session,
            decision_row,
            {
                "execution_adapter": {
                    "selected": selected_adapter_name,
                    "symbol": decision.symbol,
                }
            },
        )
        self.state.metrics.record_execution_submit_attempt(
            adapter=selected_adapter_name,
            side=decision.action,
            asset_class="crypto" if "/" in decision.symbol else "equity",
        )

        execution, rejected = self._submit_order_with_handling(
            OrderSubmissionRequest(
                session=session,
                execution_client=execution_client,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                retry_delays=policy_outcome.retry_delays,
            )
        )
        if rejected:
            return False
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.decision.generated",
                severity="info",
                decision=decision,
                decision_row=decision_row,
                extra_properties={
                    "selected_execution_adapter": selected_adapter_name,
                },
            )
        )
        if execution is None:
            self._sync_lean_observability(execution_client)
            self._record_simulation_position_state(
                execution_client=execution_client,
                symbol=decision.symbol,
            )
            self.state.metrics.orders_submitted_total += 1
            self.state.metrics.record_decision_state("submitted")
            self.state.metrics.record_execution_submit_result(
                status="accepted",
                adapter=selected_adapter_name,
            )
            record_last_execution_order(
                state=self.state,
                order=ExecutionOrderResult(
                    route=selected_adapter_name,
                    symbol=decision.symbol,
                    side=decision.action,
                    notional=_decision_execution_notional(decision),
                    broker_order_id=None,
                    status="accepted",
                    submitted_at=decision.event_ts.isoformat(),
                ),
            )
            self.executor.update_decision_json(
                session,
                decision_row,
                self._decision_lifecycle_metadata(submission_stage="submitted"),
            )
            self._emit_domain_telemetry(
                DomainTelemetryEvent(
                    event_name="torghut.execution.submitted",
                    severity="info",
                    decision=decision,
                    decision_row=decision_row,
                    extra_properties={
                        "execution_expected_adapter": selected_adapter_name,
                        "execution_actual_adapter": selected_adapter_name,
                    },
                )
            )
            return True

        actual_adapter_name = str(
            getattr(execution_client, "last_route", selected_adapter_name)
        )
        if actual_adapter_name == "alpaca_fallback":
            actual_adapter_name = "alpaca"
        self._handle_execution_fallback(
            ExecutionFallbackRequest(
                session=session,
                decision=decision,
                decision_row=decision_row,
                execution=execution,
                selected_adapter_name=selected_adapter_name,
                actual_adapter_name=actual_adapter_name,
            )
        )
        self._record_lean_shadow_from_execution(execution)
        self._sync_lean_observability(execution_client)
        self._record_simulation_position_state(
            execution_client=execution_client,
            symbol=decision.symbol,
        )
        self.state.metrics.orders_submitted_total += 1
        self.state.metrics.record_decision_state("submitted")
        self.state.metrics.record_execution_submit_result(
            status="accepted",
            adapter=actual_adapter_name,
        )
        record_last_execution_order(
            state=self.state,
            order=ExecutionOrderResult(
                route=actual_adapter_name,
                symbol=decision.symbol,
                side=decision.action,
                notional=_decision_execution_notional(decision),
                broker_order_id=execution.alpaca_order_id,
                status=str(getattr(execution, "status", "accepted") or "accepted"),
                submitted_at=decision.event_ts.isoformat(),
            ),
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.execution.submitted",
                severity="info",
                decision=decision,
                decision_row=decision_row,
                execution=execution,
                extra_properties={
                    "execution_expected_adapter": selected_adapter_name,
                    "execution_actual_adapter": actual_adapter_name,
                },
            )
        )
        logger.info(
            "Order submitted strategy_id=%s decision_id=%s symbol=%s adapter=%s alpaca_order_id=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            actual_adapter_name,
            execution.alpaca_order_id,
        )
        return True

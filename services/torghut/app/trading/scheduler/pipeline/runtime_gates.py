"""Trading pipeline implementation."""

from __future__ import annotations

import logging
import json
from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from alpaca.common.exceptions import APIError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ....config import settings
from ...firewall import OrderFirewallBlocked
from ...broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionDeferred,
)
from ...lean_runtime import evaluate_strategy_shadow
from ...models import StrategyDecision
from ...regime_hmm import (
    HMMRegimeContext,
    resolve_hmm_context,
    resolve_regime_context_authority_reason,
)
from ..state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
)

from .contexts import (
    DomainTelemetryEvent,
    ExecutionFallbackRequest,
    OrderSubmissionRequest,
)
from .shared import (
    TradingPipelineRuntime,
    RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE,
    RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS,
    RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER,
)
from .support import (
    autonomy_gate_report_is_saturated_fail_sentinel,
    coerce_bool,
    coerce_runtime_uncertainty_gate_action,
    extract_json_error_payload,
    extract_top_regime_posterior_probability,
    format_order_submit_rejection,
    optional_decimal,
    resolve_decision_regime_label_with_source,
    select_strictest_runtime_uncertainty_gate,
    uncertainty_gate_staleness_reason,
)


_TERMINAL_ORDER_STATUSES = {"canceled", "cancelled", "expired", "rejected"}


def terminal_unfilled_execution_reason(execution: object) -> str | None:
    status = str(getattr(execution, "status", "") or "").strip().lower()
    if status not in _TERMINAL_ORDER_STATUSES:
        return None
    if _execution_has_fill(execution):
        return None
    return f"order_terminal_unfilled_{status}"


def _execution_has_fill(execution: object) -> bool:
    if _positive_decimal(getattr(execution, "filled_qty", None)) is not None:
        return True
    for attribute in ("raw_order", "execution_audit_json"):
        payload = getattr(execution, attribute, None)
        if not isinstance(payload, Mapping):
            continue
        lifecycle = cast(Mapping[object, object], payload).get("_order_lifecycle")
        if not isinstance(lifecycle, Mapping):
            continue
        lifecycle_payload = cast(Mapping[object, object], lifecycle)
        if _positive_decimal(lifecycle_payload.get("filled_qty_total")) is not None:
            return True
    return False


def _positive_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value or 0))
    except (ArithmeticError, ValueError):
        return None
    return parsed if parsed.is_finite() and parsed > 0 else None


def _execution_quantity_resolution_mismatched(
    decision: StrategyDecision,
    resolution_map: Mapping[str, Any],
) -> bool:
    decision_sizing = decision.params.get("sizing")
    if not isinstance(decision_sizing, Mapping):
        return False
    decision_sizing_map = cast(Mapping[str, Any], decision_sizing)
    decision_resolution = decision_sizing_map.get("quantity_resolution")
    if not isinstance(decision_resolution, Mapping):
        return False
    decision_resolution_map = cast(Mapping[str, Any], decision_resolution)
    return (
        bool(decision_resolution_map.get("fractional_allowed"))
        != bool(resolution_map.get("fractional_allowed"))
        or str(decision_resolution_map.get("reason") or "").strip()
        != str(resolution_map.get("reason") or "").strip()
    )


def _runtime_uncertainty_gate_from_payload(
    *,
    source: str,
    payload: Mapping[str, Any],
    action_key: str,
) -> RuntimeUncertaintyGate | None:
    staleness_reason = uncertainty_gate_staleness_reason(source, payload)
    if staleness_reason is not None:
        return RuntimeUncertaintyGate(
            action="abstain",
            source=f"{source}_stale",
            reason=staleness_reason,
        )
    action = coerce_runtime_uncertainty_gate_action(payload.get(action_key))
    if action is None:
        return None
    return RuntimeUncertaintyGate(action=action, source=source)


def _runtime_uncertainty_gate_from_autonomy_report(
    gate_path_raw: str,
) -> RuntimeUncertaintyGate:
    try:
        payload = json.loads(Path(gate_path_raw).read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(
            "Failed to read autonomy gate report path=%s error=%s",
            gate_path_raw,
            exc,
        )
        return RuntimeUncertaintyGate(
            action="abstain",
            source="autonomy_gate_report_read_error",
            reason="autonomy_gate_report_read_error",
        )
    if not isinstance(payload, Mapping):
        return RuntimeUncertaintyGate(
            action="abstain",
            source="autonomy_gate_report_invalid_payload",
            reason="autonomy_gate_report_invalid_payload",
        )
    return _runtime_uncertainty_gate_from_autonomy_payload(
        cast(Mapping[str, Any], payload)
    )


def _runtime_uncertainty_gate_from_autonomy_payload(
    gate_map: Mapping[str, Any],
) -> RuntimeUncertaintyGate:
    staleness_reason = uncertainty_gate_staleness_reason(
        "autonomy_gate_report", gate_map
    )
    if staleness_reason is not None:
        return RuntimeUncertaintyGate(
            action="abstain",
            source="autonomy_gate_report_stale",
            reason=staleness_reason,
        )
    gate_action = coerce_runtime_uncertainty_gate_action(
        gate_map.get("uncertainty_gate_action")
    )
    if gate_action is None:
        return RuntimeUncertaintyGate(
            action="abstain",
            source="autonomy_gate_report_missing_action",
            reason="autonomy_gate_report_missing_action",
        )
    return _runtime_uncertainty_gate_from_autonomy_action(gate_action, gate_map)


def _runtime_uncertainty_gate_from_autonomy_action(
    gate_action: RuntimeUncertaintyGateAction,
    gate_map: Mapping[str, Any],
) -> RuntimeUncertaintyGate:
    coverage_error = optional_decimal(gate_map.get("coverage_error"))
    shift_score = optional_decimal(gate_map.get("shift_score"))
    conformal_interval_width = optional_decimal(
        gate_map.get("conformal_interval_width")
    )
    source = "autonomy_gate_report"
    reason = None
    if autonomy_gate_report_is_saturated_fail_sentinel(
        action=gate_action,
        coverage_error=coverage_error,
        shift_score=shift_score,
        conformal_interval_width=conformal_interval_width,
    ):
        gate_action = "degrade"
        source = "autonomy_gate_report_saturated_fail_sentinel"
        reason = "autonomy_gate_report_saturated_fail_sentinel"
    return RuntimeUncertaintyGate(
        action=gate_action,
        source=source,
        coverage_error=coverage_error,
        shift_score=shift_score,
        conformal_interval_width=conformal_interval_width,
        reason=reason,
    )


def _runtime_regime_gate_from_decision_payload(
    regime_gate: object,
) -> RuntimeUncertaintyGate | None:
    if regime_gate is None:
        return None
    if not isinstance(regime_gate, Mapping):
        return RuntimeUncertaintyGate(
            action="abstain",
            source="decision_regime_gate_unparseable",
            regime_action_source="decision_regime_gate",
            reason="decision_regime_gate_unparseable",
        )
    gate_map = cast(Mapping[str, Any], regime_gate)
    gate_action = coerce_runtime_uncertainty_gate_action(gate_map.get("action"))
    if gate_action is None:
        return RuntimeUncertaintyGate(
            action="abstain",
            source="decision_regime_gate_invalid_action",
            regime_action_source="decision_regime_gate",
            reason="decision_regime_gate_invalid_action",
        )
    return RuntimeUncertaintyGate(
        action=gate_action,
        source="decision_regime_gate",
        regime_action_source="decision_regime_gate",
        regime_label=_optional_stripped_text(gate_map.get("regime_label")),
        regime_stale=coerce_bool(gate_map.get("regime_stale")),
        reason=_optional_stripped_text(gate_map.get("reason")),
    )


def _runtime_regime_gate_from_decision_label(
    decision: StrategyDecision,
) -> RuntimeUncertaintyGate:
    regime_label, regime_source, regime_fallback = (
        resolve_decision_regime_label_with_source(decision)
    )
    if regime_label:
        return RuntimeUncertaintyGate(
            action="pass",
            source=regime_source or "decision_params",
            regime_action_source=regime_source or "decision_params",
            regime_label=regime_label,
            reason=regime_fallback,
        )
    return RuntimeUncertaintyGate(
        action="degrade",
        source=regime_fallback or "regime_input_missing",
        regime_action_source=regime_fallback or "regime_input_missing",
        reason=regime_fallback or "regime_input_missing",
    )


def _runtime_regime_hmm_block_gate(
    *,
    source: str,
    regime_label: str | None,
    regime_stale: bool,
    reason: str,
) -> RuntimeUncertaintyGate:
    return RuntimeUncertaintyGate(
        action="abstain",
        source=source,
        regime_action_source="regime_hmm",
        regime_label=regime_label,
        regime_stale=regime_stale,
        reason=reason,
    )


def _runtime_regime_non_authoritative_gate(
    *,
    regime_context: HMMRegimeContext,
    regime_stale: bool,
    regime_fallback: str | None,
) -> RuntimeUncertaintyGate:
    source = (
        "regime_hmm_unknown_regime"
        if regime_context.authority_reason
        in {"invalid_regime_id", "missing_regime", "invalid_schema_version"}
        else "regime_hmm_non_authoritative"
    )
    authority_reason = resolve_regime_context_authority_reason(regime_context)
    return RuntimeUncertaintyGate(
        action="abstain",
        source=source,
        regime_action_source="regime_hmm",
        regime_stale=regime_stale,
        reason=regime_fallback or authority_reason or "regime_hmm_non_authoritative",
    )


def _optional_stripped_text(value: object) -> str | None:
    if value is None:
        return None
    return str(value).strip()


logger = logging.getLogger(__name__)


class TradingPipelineRuntimeGatesMixin(TradingPipelineRuntime):
    def _maybe_record_lean_strategy_shadow(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
    ) -> None:
        if not settings.trading_lean_strategy_shadow_enabled:
            return
        if settings.trading_lean_lane_disable_switch:
            return
        intent = {
            "action": decision.action,
            "qty": str(decision.qty),
            "order_type": decision.order_type,
            "time_in_force": decision.time_in_force,
        }
        try:
            strategy_shadow = evaluate_strategy_shadow(
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                intent=intent,
                correlation_id=f"torghut-shadow-{uuid4().hex[:18]}",
            )
            shadow_map: Mapping[str, Any] = strategy_shadow
            parity_status = str(shadow_map.get("parity_status") or "unknown")
            self.state.metrics.record_lean_strategy_shadow(parity_status)
            self.lean_lane_manager.record_strategy_shadow(
                session,
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                intent=intent,
                shadow_result=shadow_map,
            )
        except Exception as exc:
            try:
                session.rollback()
            except Exception:
                logger.exception(
                    "LEAN strategy shadow rollback failed strategy_id=%s symbol=%s",
                    decision.strategy_id,
                    decision.symbol,
                )
            logger.warning(
                "LEAN strategy shadow evaluation failed strategy_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision.symbol,
                exc,
            )
            self.state.metrics.record_lean_strategy_shadow("error")

    def _submit_order_with_handling(
        self,
        request: OrderSubmissionRequest,
    ) -> tuple[Any | None, bool]:
        try:
            execution = self.executor.submit_order(
                request.session,
                request.execution_client,
                request.decision,
                request.decision_row,
                self.account_label,
                execution_expected_adapter=request.selected_adapter_name,
            )
            terminal_reason = terminal_unfilled_execution_reason(execution)
            if terminal_reason is not None:
                return self._handle_terminal_unfilled_execution(
                    request=request,
                    execution=execution,
                    reason=terminal_reason,
                )
            return execution, False
        except OrderFirewallBlocked as exc:
            return self._handle_order_firewall_block(
                request=request,
                exc=exc,
            )
        except BrokerMutationSubmissionDeferred as exc:
            return self._handle_broker_mutation_deferred(request=request, exc=exc)
        except (
            APIError,
            OSError,
            RuntimeError,
            SQLAlchemyError,
            TypeError,
            ValueError,
        ) as exc:
            return self._handle_order_submit_exception(
                request=request,
                exc=exc,
            )

    def _handle_terminal_unfilled_execution(
        self,
        *,
        request: OrderSubmissionRequest,
        execution: object,
        reason: str,
    ) -> tuple[object, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons([reason])
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=request.selected_adapter_name,
        )
        self.executor.mark_rejected(
            request.session,
            request.decision_row,
            reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_unfilled"
            ),
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.execution.rejected",
                severity="warning",
                decision=request.decision,
                decision_row=request.decision_row,
                execution=execution,
                reason_codes=[reason],
                extra_properties={"rejection_type": "terminal_unfilled"},
            )
        )
        logger.warning(
            "Order terminated without a fill strategy_id=%s decision_id=%s symbol=%s reason=%s",
            request.decision.strategy_id,
            request.decision_row.id,
            request.decision.symbol,
            reason,
        )
        return execution, True

    def _handle_order_firewall_block(
        self,
        *,
        request: OrderSubmissionRequest,
        exc: OrderFirewallBlocked,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=request.selected_adapter_name,
        )
        self.state.metrics.record_decision_rejection_reasons([str(exc)])
        self.executor.mark_rejected(
            request.session,
            request.decision_row,
            str(exc),
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit"
            ),
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.execution.rejected",
                severity="warning",
                decision=request.decision,
                decision_row=request.decision_row,
                reason_codes=[str(exc)],
                extra_properties={"rejection_type": "firewall_blocked"},
            )
        )
        logger.warning(
            "Order blocked by firewall strategy_id=%s decision_id=%s symbol=%s reason=%s",
            request.decision.strategy_id,
            request.decision_row.id,
            request.decision.symbol,
            exc,
        )
        return None, True

    def _handle_order_submit_exception(
        self,
        *,
        request: OrderSubmissionRequest,
        exc: Exception,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons(
            [f"order_submit_error_{type(exc).__name__}"]
        )
        payload = extract_json_error_payload(exc) or {}
        self._record_local_pre_submit_rejection_metrics(request.decision, payload)
        reason = format_order_submit_rejection(exc)
        self.executor.mark_rejected(
            request.session,
            request.decision_row,
            reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit",
                extra={"broker_precheck": payload} if payload else None,
            ),
        )
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=request.selected_adapter_name,
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.execution.rejected",
                severity="error",
                decision=request.decision,
                decision_row=request.decision_row,
                reason_codes=[reason],
                extra_properties={"rejection_type": "submit_failed"},
            )
        )
        logger.warning(
            "Order submission failed strategy_id=%s decision_id=%s symbol=%s error=%s payload=%s",
            request.decision.strategy_id,
            request.decision_row.id,
            request.decision.symbol,
            exc,
            payload,
        )
        return None, True

    def _handle_broker_mutation_deferred(
        self,
        *,
        request: OrderSubmissionRequest,
        exc: BrokerMutationSubmissionDeferred,
    ) -> tuple[None, bool]:
        reason = str(exc)
        stage = (
            "broker_io_unresolved"
            if "unresolved" in reason
            else "broker_mutation_deferred"
        )
        raw_existing_decision = request.decision_row.decision_json
        existing_decision = (
            cast(Mapping[str, object], raw_existing_decision)
            if isinstance(raw_existing_decision, Mapping)
            else None
        )
        if (
            existing_decision is not None
            and existing_decision.get("submission_stage") == "broker_io_unresolved"
        ):
            stage = "broker_io_unresolved"
        self.executor.update_decision_json(
            request.session,
            request.decision_row,
            self._decision_lifecycle_metadata(
                submission_stage=stage,
                extra={"broker_mutation_deferred_reason": reason},
            ),
        )
        self.state.metrics.record_execution_submit_result(
            status="deferred",
            adapter=request.selected_adapter_name,
        )
        logger.error(
            "Order submission deferred for durable reconciliation strategy_id=%s "
            "decision_id=%s symbol=%s reason=%s",
            request.decision.strategy_id,
            request.decision_row.id,
            request.decision.symbol,
            reason,
        )
        return None, True

    def _record_local_pre_submit_rejection_metrics(
        self,
        decision: StrategyDecision,
        payload: Mapping[str, Any],
    ) -> None:
        source = str(payload.get("source") or "").strip().lower()
        if source != "local_pre_submit":
            return
        self.state.metrics.record_execution_local_reject(
            code=cast(str | None, payload.get("code")),
            reason=cast(str | None, payload.get("reject_reason")),
        )
        quantity_resolution = payload.get("quantity_resolution")
        if not isinstance(quantity_resolution, Mapping):
            return
        resolution_map = cast(Mapping[str, Any], quantity_resolution)
        self.state.metrics.record_qty_resolution(
            stage="execution",
            outcome=(
                "fractional"
                if bool(resolution_map.get("fractional_allowed"))
                else "integer"
            ),
            reason=cast(str | None, resolution_map.get("reason")),
        )
        self.state.metrics.record_sell_inventory_context(
            stage="execution",
            context=(
                "unknown"
                if resolution_map.get("position_qty") in (None, "")
                else "known"
            ),
        )
        if _execution_quantity_resolution_mismatched(decision, resolution_map):
            self.state.metrics.execution_validation_mismatch_total += 1

    def _record_simulation_position_state(
        self,
        *,
        execution_client: Any,
        symbol: str,
    ) -> None:
        if self._execution_client_name(execution_client) not in {
            "simulation",
            "testnet",
        }:
            return
        try:
            positions = execution_client.list_positions()
        except Exception:
            return
        state = "flat"
        normalized_symbol = symbol.strip().upper()
        if isinstance(positions, list):
            for raw_position in cast(list[Any], positions):
                if not isinstance(raw_position, Mapping):
                    continue
                position = cast(Mapping[str, Any], raw_position)
                if (
                    str(position.get("symbol") or "").strip().upper()
                    != normalized_symbol
                ):
                    continue
                side = str(position.get("side") or "").strip().lower()
                if side == "short":
                    state = "short"
                elif side == "long":
                    state = "long"
                break
        self.state.metrics.record_simulation_position_state(state)

    def _handle_execution_fallback(
        self,
        request: ExecutionFallbackRequest,
    ) -> None:
        if request.actual_adapter_name == request.selected_adapter_name:
            return
        fallback_reason = request.execution.execution_fallback_reason
        self.state.metrics.record_execution_fallback(
            expected_adapter=request.selected_adapter_name,
            actual_adapter=request.actual_adapter_name,
            fallback_reason=fallback_reason or "adaptive_fallback",
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.execution.fallback",
                severity="warning",
                decision=request.decision,
                decision_row=request.decision_row,
                execution=request.execution,
                reason_codes=[fallback_reason or "adaptive_fallback"],
                extra_properties={
                    "execution_expected_adapter": request.selected_adapter_name,
                    "execution_actual_adapter": request.actual_adapter_name,
                },
            )
        )
        self.executor.update_decision_params(
            request.session,
            request.decision_row,
            {
                "execution_adapter": {
                    "selected": request.selected_adapter_name,
                    "actual": request.actual_adapter_name,
                    "symbol": request.decision.symbol,
                }
            },
        )

    def _resolve_runtime_uncertainty_gate_components(
        self, decision: StrategyDecision
    ) -> tuple[RuntimeUncertaintyGate, RuntimeUncertaintyGate, RuntimeUncertaintyGate]:
        uncertainty_gate = self._resolve_runtime_uncertainty_gate_from_inputs(decision)
        regime_gate = self._resolve_runtime_regime_gate(decision)
        combined_gate = select_strictest_runtime_uncertainty_gate(
            [uncertainty_gate, regime_gate]
        )
        return uncertainty_gate, regime_gate, combined_gate

    def _resolve_runtime_uncertainty_gate(
        self, decision: StrategyDecision
    ) -> RuntimeUncertaintyGate:
        _, _, gate = self._resolve_runtime_uncertainty_gate_components(decision)
        return gate

    def _resolve_runtime_uncertainty_degrade_profile(
        self,
        decision: StrategyDecision,
        regime_gate: RuntimeUncertaintyGate,
    ) -> tuple[Decimal, Decimal, int]:
        regime_label = regime_gate.regime_label
        if regime_label is None:
            regime_label, _, _ = resolve_decision_regime_label_with_source(decision)
        regime_key = str(regime_label).strip().lower() if regime_label else ""

        qty_multiplier = RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER
        max_participation_rate = RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE
        min_execution_seconds = RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS

        if regime_key:
            configured_qty_multiplier = settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime.get(
                regime_key
            )
            if configured_qty_multiplier is not None:
                qty_multiplier = Decimal(str(configured_qty_multiplier))

            configured_max_participation_rate = settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime.get(
                regime_key
            )
            if configured_max_participation_rate is not None:
                max_participation_rate = Decimal(str(configured_max_participation_rate))

            configured_min_execution_seconds = settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime.get(
                regime_key
            )
            if configured_min_execution_seconds is not None:
                min_execution_seconds = configured_min_execution_seconds

        return (
            qty_multiplier,
            max_participation_rate,
            int(min_execution_seconds),
        )

    def _resolve_runtime_uncertainty_gate_from_inputs(
        self, decision: StrategyDecision
    ) -> RuntimeUncertaintyGate:
        params = decision.params
        candidates: list[RuntimeUncertaintyGate] = []
        self._append_direct_runtime_uncertainty_candidate(params, candidates)
        self._append_runtime_payload_uncertainty_candidate(params, candidates)
        self._append_forecast_audit_uncertainty_candidate(params, candidates)
        self._append_autonomy_gate_report_uncertainty_candidate(candidates)
        if not candidates:
            candidates.append(
                RuntimeUncertaintyGate(
                    action="degrade", source="uncertainty_input_missing"
                )
            )
        return select_strictest_runtime_uncertainty_gate(candidates)

    def _append_direct_runtime_uncertainty_candidate(
        self,
        params: Mapping[str, Any],
        candidates: list[RuntimeUncertaintyGate],
    ) -> None:
        direct_action = coerce_runtime_uncertainty_gate_action(
            params.get("uncertainty_gate_action")
        )
        if direct_action is not None:
            candidates.append(
                RuntimeUncertaintyGate(action=direct_action, source="decision_params")
            )

    def _append_runtime_payload_uncertainty_candidate(
        self,
        params: Mapping[str, Any],
        candidates: list[RuntimeUncertaintyGate],
    ) -> None:
        runtime_payload = params.get("runtime_uncertainty_gate")
        if isinstance(runtime_payload, Mapping):
            gate = _runtime_uncertainty_gate_from_payload(
                source="decision_runtime_payload",
                payload=cast(Mapping[str, Any], runtime_payload),
                action_key="action",
            )
            if gate is not None:
                candidates.append(gate)

    def _append_forecast_audit_uncertainty_candidate(
        self,
        params: Mapping[str, Any],
        candidates: list[RuntimeUncertaintyGate],
    ) -> None:
        forecast_audit = params.get("forecast_audit")
        if isinstance(forecast_audit, Mapping):
            gate = _runtime_uncertainty_gate_from_payload(
                source="forecast_audit",
                payload=cast(Mapping[str, Any], forecast_audit),
                action_key="uncertainty_gate_action",
            )
            if gate is not None:
                candidates.append(gate)

    def _append_autonomy_gate_report_uncertainty_candidate(
        self,
        candidates: list[RuntimeUncertaintyGate],
    ) -> None:
        gate_path_raw = self.state.last_autonomy_gates
        if not gate_path_raw:
            return
        gate = _runtime_uncertainty_gate_from_autonomy_report(gate_path_raw)
        candidates.append(gate)

    def _resolve_runtime_regime_gate(
        self, decision: StrategyDecision
    ) -> RuntimeUncertaintyGate:
        params = decision.params
        decision_gate = _runtime_regime_gate_from_decision_payload(
            params.get("regime_gate")
        )
        if decision_gate is not None:
            return decision_gate
        raw_regime_hmm = params.get("regime_hmm")
        if raw_regime_hmm is None:
            return _runtime_regime_gate_from_decision_label(decision)
        if not isinstance(raw_regime_hmm, Mapping):
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_unparseable",
                regime_action_source="regime_hmm_unparseable",
                reason="regime_hmm_unparseable_payload",
            )
        return self._resolve_runtime_regime_gate_from_hmm(
            decision,
            raw_regime_hmm=cast(Mapping[str, Any], raw_regime_hmm),
        )

    def _resolve_runtime_regime_gate_from_hmm(
        self,
        decision: StrategyDecision,
        *,
        raw_regime_hmm: Mapping[str, Any],
    ) -> RuntimeUncertaintyGate:
        try:
            regime_context = resolve_hmm_context(raw_regime_hmm)
        except Exception as exc:
            logger.warning(
                "Failed to parse decision regime_hmm payload source=%s error=%s",
                decision.params.get("strategy_id") or "strategy",
                exc,
            )
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_parse_error",
                regime_action_source="regime_hmm_parse_error",
                reason="regime_hmm_parse_error",
            )

        regime_label, _, regime_fallback = resolve_decision_regime_label_with_source(
            decision
        )
        regime_stale = bool(
            regime_context.guardrail.stale
            or regime_context.guardrail.fallback_to_defensive
        )
        regime_label = regime_label or regime_context.regime_id
        if regime_context.transition_shock:
            return _runtime_regime_hmm_block_gate(
                source="regime_hmm_transition_shock",
                regime_label=regime_label,
                regime_stale=regime_stale,
                reason="regime_context_transition_shock",
            )
        if regime_stale:
            return _runtime_regime_hmm_block_gate(
                source="regime_hmm_stale",
                regime_label=regime_label,
                regime_stale=True,
                reason=regime_context.guardrail_reason
                or "regime_context_guardrail_stale",
            )
        if not regime_context.is_authoritative:
            return _runtime_regime_non_authoritative_gate(
                regime_context=regime_context,
                regime_stale=regime_stale,
                regime_fallback=regime_fallback,
            )
        confidence_gate = self._resolve_runtime_regime_confidence_gate(
            regime_context=regime_context,
            regime_label=regime_label,
        )
        if confidence_gate is not None:
            return confidence_gate
        return RuntimeUncertaintyGate(
            action="pass",
            source="regime_hmm",
            regime_action_source="regime_hmm",
            regime_label=regime_label or regime_context.regime_id,
            regime_stale=regime_stale,
        )

    def _resolve_runtime_regime_confidence_gate(
        self,
        *,
        regime_context: HMMRegimeContext,
        regime_label: str | None,
    ) -> RuntimeUncertaintyGate | None:
        top_posterior_probability = extract_top_regime_posterior_probability(
            regime_context.posterior
        )
        if top_posterior_probability is None:
            return None

        degrade_threshold, abstain_threshold = (
            self._resolve_regime_confidence_thresholds(regime_context.entropy_band)
        )
        if top_posterior_probability < abstain_threshold:
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_confidence",
                regime_action_source="regime_hmm",
                regime_label=regime_label,
                regime_stale=False,
                reason="regime_hmm_confidence_too_low",
            )
        if top_posterior_probability < degrade_threshold:
            return RuntimeUncertaintyGate(
                action="degrade",
                source="regime_hmm_confidence",
                regime_action_source="regime_hmm",
                regime_label=regime_label,
                regime_stale=False,
                reason="regime_hmm_confidence_is_uncertain",
            )
        return None

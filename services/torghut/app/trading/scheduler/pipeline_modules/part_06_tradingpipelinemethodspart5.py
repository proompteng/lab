# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Trading pipeline implementation."""

from __future__ import annotations

import hashlib
import json
import inspect
import logging
import os
from collections.abc import Callable, Mapping
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional, Sequence, cast

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ....alpaca_client import TorghutAlpacaClient
from ....config import settings
from ....db import SessionLocal
from ....models import (
    Execution,
    LLMDecisionReview,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ....observability import capture_posthog_event
from ....snapshots import snapshot_account_and_positions
from ....strategies import StrategyCatalog
from ...autonomy.phase_manifest_contract import AUTONOMY_PHASE_ORDER
from ...decisions import DecisionEngine
from ...empirical_jobs import build_empirical_jobs_status
from ...execution import OrderExecutor
from ...execution_adapters import ExecutionAdapter
from ...execution_policy import ExecutionPolicy
from ...feature_quality import (
    REASON_STALENESS,
    FeatureQualityThresholds,
    evaluate_feature_batch_quality,
)
from ...features import extract_executable_price, optional_decimal, payload_value
from ...firewall import OrderFirewall, OrderFirewallBlocked
from ...ingest import ClickHouseSignalIngestor, SignalBatch
from ...lean_lanes import LeanLaneManager
from ...llm import LLMReviewEngine, apply_policy
from ...llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from ...llm.guardrails import evaluate_llm_guardrails
from ...llm.policy import allowed_order_types
from ...llm.schema import MarketContextBundle
from ...llm.schema import MarketSnapshot as LLMMarketSnapshot
from ...market_context import (
    MarketContextClient,
    MarketContextStatus,
    evaluate_market_context,
)
from ...market_context_domains import (
    active_market_context_domain_states,
    active_market_context_reasons,
)
from ...models import SignalEnvelope, StrategyDecision
from ...order_feed import OrderFeedIngestor
from ...paper_route_evidence import (
    PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS,
    PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS,
)
from ...portfolio import (
    AllocationResult,
    PortfolioSizingResult,
    allocator_from_settings,
    sizer_from_settings,
)
from ...prices import ClickHousePriceFetcher, MarketSnapshot, PriceFetcher
from ...quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    SignalQuoteQualityTracker,
    assess_signal_quote_quality,
)
from ...quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from ...reconcile import Reconciler
from ...regime_hmm import (
    HMMRegimeContext,
    resolve_hmm_context,
    resolve_regime_context_authority_reason,
)
from ...risk import RiskEngine
from ...session_context import regular_session_open_utc_for
from ...tca import derive_adaptive_execution_policy
from ...time_source import trading_now
from ...universe import UniverseResolver
from ...submission_council import (
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..pipeline_helpers import (
    _allocator_rejection_reasons,
    _apply_projected_position_decision,
    _attach_dspy_lineage,
    _autonomy_gate_report_is_saturated_fail_sentinel,
    _build_committee_veto_alignment_payload,
    _build_llm_policy_resolution,
    _build_portfolio_snapshot,
    _classify_llm_error,
    _clone_positions,
    _coerce_bool,
    _coerce_json,
    _coerce_runtime_uncertainty_gate_action,
    _coerce_strategy_symbols,
    _committee_trace_has_veto,
    _extract_json_error_payload,
    _extract_top_regime_posterior_probability,
    _format_order_submit_rejection,
    _hash_payload,
    _is_runtime_risk_increasing_entry,
    _llm_guardrail_controls_snapshot,
    _load_recent_decisions,
    _normalize_rollout_stage,
    _optional_decimal,
    _optional_int,
    _price_snapshot_payload,
    _project_open_orders_onto_positions,
    _resolve_decision_regime_label_with_source,
    _resolve_llm_review_error_reject_reason,
    _resolve_llm_unavailable_reject_reason,
    _resolve_signal_regime,
    _select_strictest_runtime_uncertainty_gate,
    _uncertainty_gate_staleness_reason,
)
from ..safety import (
    _FRESH_TAIL_NO_SIGNAL_REASONS,
    _is_market_session_open,
    _latch_signal_continuity_alert_state,
    _record_signal_continuity_recovery_cycle,
    _signal_bootstrap_grace_active,
    _signal_tail_is_fresh,
)
from ..state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
    TradingState,
    _normalize_reason_metric,
)

# ruff: noqa: F401,F403,F405,F821,F821,F821

from .part_01_statements_158 import *
from .part_02_tradingpipelinemethodspart1 import *
from .part_03_tradingpipelinemethodspart2 import *
from .part_04_tradingpipelinemethodspart3 import *
from .part_05_tradingpipelinemethodspart4 import *


def _execution_quantity_resolution_mismatched(
    decision: StrategyDecision,
    resolution_map: Mapping[str, Any],
) -> bool:
    decision_sizing = decision.params.get("sizing")
    if not isinstance(decision_sizing, Mapping):
        return False
    decision_resolution = decision_sizing.get("quantity_resolution")
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
    staleness_reason = _uncertainty_gate_staleness_reason(source, payload)
    if staleness_reason is not None:
        return RuntimeUncertaintyGate(
            action="abstain",
            source=f"{source}_stale",
            reason=staleness_reason,
        )
    action = _coerce_runtime_uncertainty_gate_action(payload.get(action_key))
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
    staleness_reason = _uncertainty_gate_staleness_reason(
        "autonomy_gate_report", gate_map
    )
    if staleness_reason is not None:
        return RuntimeUncertaintyGate(
            action="abstain",
            source="autonomy_gate_report_stale",
            reason=staleness_reason,
        )
    gate_action = _coerce_runtime_uncertainty_gate_action(
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
    coverage_error = _optional_decimal(gate_map.get("coverage_error"))
    shift_score = _optional_decimal(gate_map.get("shift_score"))
    conformal_interval_width = _optional_decimal(
        gate_map.get("conformal_interval_width")
    )
    source = "autonomy_gate_report"
    reason = None
    if _autonomy_gate_report_is_saturated_fail_sentinel(
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
    gate_action = _coerce_runtime_uncertainty_gate_action(gate_map.get("action"))
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
        regime_stale=_coerce_bool(gate_map.get("regime_stale")),
        reason=_optional_stripped_text(gate_map.get("reason")),
    )


def _runtime_regime_gate_from_decision_label(
    decision: StrategyDecision,
) -> RuntimeUncertaintyGate:
    regime_label, regime_source, regime_fallback = (
        _resolve_decision_regime_label_with_source(decision)
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


class _TradingPipelineMethodsPart5:
    def _maybe_record_lean_strategy_shadow(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        execution_client: Any,
        selected_adapter_name: str,
    ) -> None:
        if selected_adapter_name != "lean":
            return
        if not settings.trading_lean_strategy_shadow_enabled:
            return
        if settings.trading_lean_lane_disable_switch:
            return
        evaluator = getattr(execution_client, "evaluate_strategy_shadow", None)
        if not callable(evaluator):
            return
        try:
            strategy_shadow = evaluator(
                {
                    "strategy_id": decision.strategy_id,
                    "symbol": decision.symbol,
                    "action": decision.action,
                    "qty": str(decision.qty),
                    "order_type": decision.order_type,
                    "time_in_force": decision.time_in_force,
                }
            )
            if not isinstance(strategy_shadow, Mapping):
                return
            shadow_map = cast(Mapping[str, Any], strategy_shadow)
            parity_status = str(shadow_map.get("parity_status") or "unknown")
            self.state.metrics.record_lean_strategy_shadow(parity_status)
            self.lean_lane_manager.record_strategy_shadow(
                session,
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                intent={
                    "action": decision.action,
                    "qty": str(decision.qty),
                    "order_type": decision.order_type,
                    "time_in_force": decision.time_in_force,
                },
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
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        retry_delays: list[int],
    ) -> tuple[Any | None, bool]:
        try:
            retry_delays_seconds = [float(delay) for delay in retry_delays]
            execution = self.executor.submit_order(
                session,
                execution_client,
                decision,
                decision_row,
                self.account_label,
                execution_expected_adapter=selected_adapter_name,
                retry_delays=retry_delays_seconds,
            )
            return execution, False
        except OrderFirewallBlocked as exc:
            return self._handle_order_firewall_block(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                exc=exc,
            )
        except Exception as exc:
            return self._handle_order_submit_exception(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                exc=exc,
            )

    def _handle_order_firewall_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        exc: OrderFirewallBlocked,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=selected_adapter_name,
        )
        self.state.metrics.record_decision_rejection_reasons([str(exc)])
        self.executor.mark_rejected(
            session,
            decision_row,
            str(exc),
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit"
            ),
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.rejected",
            severity="warning",
            decision=decision,
            decision_row=decision_row,
            reason_codes=[str(exc)],
            extra_properties={"rejection_type": "firewall_blocked"},
        )
        logger.warning(
            "Order blocked by firewall strategy_id=%s decision_id=%s symbol=%s reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            exc,
        )
        return None, True

    def _handle_order_submit_exception(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        exc: Exception,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons(
            [f"order_submit_error_{type(exc).__name__}"]
        )
        payload = _extract_json_error_payload(exc) or {}
        self._record_local_pre_submit_rejection_metrics(decision, payload)
        self._cancel_conflicting_precheck_order(decision_row, payload)
        reason = _format_order_submit_rejection(exc)
        self.executor.mark_rejected(
            session,
            decision_row,
            reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit",
                extra={"broker_precheck": payload} if payload else None,
            ),
        )
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=selected_adapter_name,
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.rejected",
            severity="error",
            decision=decision,
            decision_row=decision_row,
            reason_codes=[reason],
            extra_properties={"rejection_type": "submit_failed"},
        )
        logger.warning(
            "Order submission failed strategy_id=%s decision_id=%s symbol=%s error=%s payload=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            exc,
            payload,
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

    def _cancel_conflicting_precheck_order(
        self,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
    ) -> None:
        existing_order_id = payload.get("existing_order_id")
        existing_order_code = str(payload.get("code") or "").strip().lower()
        existing_order_reason = str(payload.get("reject_reason") or "").strip().lower()
        if not existing_order_id or not (
            existing_order_code == "precheck_opposite_side_open_order"
            or "opposite side market/stop order exists" in existing_order_reason
        ):
            return
        try:
            self.order_firewall.cancel_order(str(existing_order_id))
            logger.info(
                "Canceled conflicting Alpaca order decision_id=%s existing_order_id=%s",
                decision_row.id,
                existing_order_id,
            )
        except Exception:
            logger.exception(
                "Failed to cancel conflicting Alpaca order decision_id=%s existing_order_id=%s",
                decision_row.id,
                existing_order_id,
            )

    def _record_simulation_position_state(
        self,
        *,
        execution_client: Any,
        symbol: str,
    ) -> None:
        if self._execution_client_name(execution_client) != "simulation":
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
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        execution: Any,
        selected_adapter_name: str,
        actual_adapter_name: str,
    ) -> None:
        if actual_adapter_name == selected_adapter_name:
            return
        fallback_reason = execution.execution_fallback_reason
        self.state.metrics.record_execution_fallback(
            expected_adapter=selected_adapter_name,
            actual_adapter=actual_adapter_name,
            fallback_reason=fallback_reason or "adaptive_fallback",
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.fallback",
            severity="warning",
            decision=decision,
            decision_row=decision_row,
            execution=execution,
            reason_codes=[fallback_reason or "adaptive_fallback"],
            extra_properties={
                "execution_expected_adapter": selected_adapter_name,
                "execution_actual_adapter": actual_adapter_name,
            },
        )
        self._evaluate_lean_canary_guard(session, symbol=decision.symbol)
        self.executor.update_decision_params(
            session,
            decision_row,
            {
                "execution_adapter": {
                    "selected": selected_adapter_name,
                    "actual": actual_adapter_name,
                    "symbol": decision.symbol,
                }
            },
        )

    def _record_lean_shadow_from_execution(self, execution: Any) -> None:
        raw_order_payload = getattr(execution, "raw_order", None)
        if not isinstance(raw_order_payload, Mapping):
            return
        raw_order_source = cast(Mapping[object, Any], raw_order_payload)
        raw_order: dict[str, Any] = {
            str(key): value for key, value in raw_order_source.items()
        }
        shadow_event = raw_order.get("_lean_shadow")
        if not isinstance(shadow_event, Mapping):
            return
        shadow_map = cast(Mapping[str, Any], shadow_event)
        parity_status = str(shadow_map.get("parity_status") or "unknown")
        failure_taxonomy = (
            str(shadow_map.get("failure_taxonomy")).strip()
            if shadow_map.get("failure_taxonomy") is not None
            else None
        )
        self.state.metrics.record_lean_shadow(
            parity_status=parity_status,
            failure_taxonomy=failure_taxonomy,
        )

    def _resolve_runtime_uncertainty_gate_components(
        self, decision: StrategyDecision
    ) -> tuple[RuntimeUncertaintyGate, RuntimeUncertaintyGate, RuntimeUncertaintyGate]:
        uncertainty_gate = self._resolve_runtime_uncertainty_gate_from_inputs(decision)
        regime_gate = self._resolve_runtime_regime_gate(decision)
        combined_gate = _select_strictest_runtime_uncertainty_gate(
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
            regime_label, _, _ = _resolve_decision_regime_label_with_source(decision)
        regime_key = str(regime_label).strip().lower() if regime_label else ""

        qty_multiplier = _RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER
        max_participation_rate = _RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE
        min_execution_seconds = _RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS

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
        return _select_strictest_runtime_uncertainty_gate(candidates)

    def _append_direct_runtime_uncertainty_candidate(
        self,
        params: Mapping[str, Any],
        candidates: list[RuntimeUncertaintyGate],
    ) -> None:
        direct_action = _coerce_runtime_uncertainty_gate_action(
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

        regime_label, _, regime_fallback = _resolve_decision_regime_label_with_source(
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
        top_posterior_probability = _extract_top_regime_posterior_probability(
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


__all__ = [name for name in globals() if not name.startswith("__")]

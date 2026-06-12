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


class _TradingPipelineMethodsPart4:
    def _prepare_decision_for_submission(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        allocator_rejection = _allocator_rejection_reasons(decision)
        if allocator_rejection:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=allocator_rejection,
                log_template=(
                    "Decision rejected by allocator strategy_id=%s symbol=%s reason=%s"
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
                session, decision_row, price_params_update
            )

        sizing_result = self._apply_portfolio_sizing(
            decision, strategy, account, positions
        )
        decision = sizing_result.decision
        sizing_params = decision.model_dump(mode="json").get("params", {})
        self.executor.sync_decision_state(session, decision_row, decision)
        if isinstance(sizing_params, Mapping) and "portfolio_sizing" in sizing_params:
            self.executor.update_decision_params(
                session, decision_row, cast(Mapping[str, Any], sizing_params)
            )
        if not sizing_result.approved:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=sizing_result.reasons,
                log_template=(
                    "Decision rejected by portfolio sizing strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None

        decision, gate_payload, gate_rejection = self._apply_runtime_uncertainty_gate(
            decision, positions=positions
        )
        self._persist_runtime_uncertainty_gate_payload(
            session=session,
            decision=decision,
            decision_row=decision_row,
            gate_payload=gate_payload,
        )
        if gate_rejection:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=gate_rejection,
            )
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[gate_rejection],
                log_template=(
                    "Decision rejected by execution gate strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None

        decision, llm_reject_reason = self._apply_llm_review(
            session, decision, decision_row, account, positions
        )
        self.executor.sync_decision_state(session, decision_row, decision)
        if llm_reject_reason:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=None,
            )
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[llm_reject_reason],
                log_template="Decision rejected by llm review strategy_id=%s symbol=%s reason=%s",
            )
            return None

        gate_rejection = self._recheck_runtime_uncertainty_gate_after_llm(
            session=session,
            decision=decision,
            decision_row=decision_row,
            positions=positions,
            gate_payload=gate_payload,
        )
        if gate_rejection:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=gate_rejection,
            )
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[gate_rejection],
                log_template=(
                    "Decision rejected by execution gate strategy_id=%s symbol=%s reason=%s"
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
        return _autonomy_gate_report_is_saturated_fail_sentinel(
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
        action = _coerce_runtime_uncertainty_gate_action(gate_payload.get("action"))
        if action is None:
            return False
        return _autonomy_gate_report_is_saturated_fail_sentinel(
            action=action,
            coverage_error=_optional_decimal(gate_payload.get("coverage_error")),
            shift_score=_optional_decimal(gate_payload.get("shift_score")),
            conformal_interval_width=_optional_decimal(
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
        allocator = _coerce_json(params.get("allocator"))
        current_override = _optional_decimal(
            allocator.get("max_participation_rate_override")
        )
        if current_override is None or current_override > max_participation_rate:
            allocator["max_participation_rate_override"] = str(max_participation_rate)
        params["allocator"] = allocator
        execution_seconds = _optional_int(params.get("execution_seconds"))
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
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        positions: list[dict[str, Any]],
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
                session=session,
                decision=decision,
                decision_row=decision_row,
                gate_payload=gate_payload,
            )
            return None
        if gate_action not in {"abstain", "fail"}:
            return None
        risk_increasing_entry = _is_runtime_risk_increasing_entry(decision, positions)
        gate_payload["risk_increasing_entry"] = risk_increasing_entry
        if not risk_increasing_entry:
            gate_payload["entry_blocked"] = False
            gate_payload["block_reason"] = None
            self._persist_runtime_uncertainty_gate_payload(
                session=session,
                decision=decision,
                decision_row=decision_row,
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
            session=session,
            decision=decision,
            decision_row=decision_row,
            gate_payload=gate_payload,
        )
        return reason

    def _record_decision_rejection(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        reasons: list[str],
        log_template: str,
    ) -> None:
        if not reasons:
            return
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_rejection_reasons(reasons)
        self.state.metrics.record_decision_state("rejected")
        for reason in reasons:
            logger.info(log_template, decision.strategy_id, decision.symbol, reason)
        self.executor.mark_rejected(
            session,
            decision_row,
            ";".join(reasons),
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_pre_submit"
            ),
        )
        self._emit_domain_telemetry(
            event_name="torghut.decision.blocked",
            severity="warning",
            decision=decision,
            decision_row=decision_row,
            reason_codes=reasons,
            extra_properties={"decision_status": "rejected"},
        )

    def _emit_domain_telemetry(
        self,
        *,
        event_name: str,
        severity: str,
        decision: StrategyDecision | None = None,
        decision_row: TradeDecision | None = None,
        execution: Any | None = None,
        reason_codes: Sequence[str] | None = None,
        extra_properties: Mapping[str, Any] | None = None,
    ) -> None:
        properties: dict[str, Any] = {
            "account_label": self.account_label,
            "trading_mode": settings.trading_mode,
        }
        if decision is not None:
            properties.update(
                {
                    "strategy_id": decision.strategy_id,
                    "symbol": decision.symbol,
                    "timeframe": decision.timeframe,
                    "decision_action": decision.action,
                }
            )
        if decision_row is not None:
            properties["trade_decision_id"] = str(decision_row.id)
            properties["decision_hash"] = decision_row.decision_hash
            properties["decision_status"] = decision_row.status
        if execution is not None:
            properties["execution_id"] = str(getattr(execution, "id", ""))
            properties["execution_status"] = str(getattr(execution, "status", ""))
            properties["execution_correlation_id"] = str(
                getattr(execution, "execution_correlation_id", "") or ""
            )
            properties["execution_idempotency_key"] = str(
                getattr(execution, "execution_idempotency_key", "") or ""
            )
            properties["execution_fallback_reason"] = str(
                getattr(execution, "execution_fallback_reason", "") or ""
            )
        if reason_codes:
            properties["reason_codes"] = sorted(
                {str(reason).strip() for reason in reason_codes if str(reason).strip()}
            )
        if extra_properties:
            properties.update(
                {str(key): value for key, value in extra_properties.items()}
            )
        emitted, drop_reason = capture_posthog_event(
            event_name,
            severity=severity,
            distinct_id=f"torghut-{self.account_label}",
            properties=properties,
        )
        self.state.metrics.record_domain_telemetry(
            event_name=event_name,
            emitted=emitted,
            drop_reason=drop_reason,
        )

    def _evaluate_execution_policy_outcome(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        positions: list[dict[str, Any]],
        snapshot: Optional[MarketSnapshot],
    ) -> tuple[StrategyDecision, Any] | None:
        regime_label, regime_source, regime_fallback = (
            _resolve_decision_regime_label_with_source(decision)
        )
        self.state.metrics.record_decision_regime_resolution(
            source=regime_source,
            fallback_reason=regime_fallback,
        )
        adaptive_policy = derive_adaptive_execution_policy(
            session,
            symbol=decision.symbol,
            regime_label=regime_label,
        )
        policy_outcome = self.execution_policy.evaluate(
            decision,
            strategy=strategy,
            positions=positions,
            market_snapshot=snapshot,
            kill_switch_enabled=self.order_firewall.status().kill_switch_enabled,
            adaptive_policy=adaptive_policy,
        )
        decision = policy_outcome.decision
        self.executor.update_decision_params(
            session, decision_row, policy_outcome.params_update()
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
        self.executor.sync_decision_state(session, decision_row, decision)
        if not policy_outcome.approved:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=list(policy_outcome.reasons),
                log_template=(
                    "Decision rejected by execution policy strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None
        return decision, policy_outcome

    def _passes_risk_verdict(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        symbol_allowlist: set[str],
        execution_advisor: Mapping[str, Any] | None,
    ) -> bool:
        verdict = self.risk_engine.evaluate(
            session,
            decision,
            strategy,
            account,
            positions,
            symbol_allowlist,
            execution_advisor=execution_advisor,
        )
        if verdict.approved:
            return True
        self._record_decision_rejection(
            session=session,
            decision=decision,
            decision_row=decision_row,
            reasons=list(verdict.reasons),
            log_template="Decision rejected strategy_id=%s symbol=%s reason=%s",
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
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason="trading_disabled",
                submission_stage="blocked_trading_disabled",
            )
            logger.warning(
                "Decision blocked because trading is disabled strategy_id=%s decision_id=%s symbol=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
            )
            return False
        live_submission_gate = self._live_submission_gate(session=session)
        if settings.trading_mode == "live" and not bool(
            live_submission_gate.get("allowed", False)
        ):
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason="capital_stage_shadow",
                submission_stage="blocked_capital_stage_shadow",
                capital_stage="shadow",
                extra_metadata={"live_submission_gate": live_submission_gate},
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
            session=session,
            decision=decision,
            decision_row=decision_row,
            reason=reason,
            submission_stage="blocked_emergency_stop",
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
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            selected_adapter_name=selected_adapter_name,
            retry_delays=policy_outcome.retry_delays,
        )
        if rejected:
            return False
        self._emit_domain_telemetry(
            event_name="torghut.decision.generated",
            severity="info",
            decision=decision,
            decision_row=decision_row,
            extra_properties={
                "selected_execution_adapter": selected_adapter_name,
            },
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
            self.executor.update_decision_json(
                session,
                decision_row,
                self._decision_lifecycle_metadata(submission_stage="submitted"),
            )
            self._emit_domain_telemetry(
                event_name="torghut.execution.submitted",
                severity="info",
                decision=decision,
                decision_row=decision_row,
                extra_properties={
                    "execution_expected_adapter": selected_adapter_name,
                    "execution_actual_adapter": selected_adapter_name,
                },
            )
            return True

        actual_adapter_name = str(
            getattr(execution_client, "last_route", selected_adapter_name)
        )
        if actual_adapter_name == "alpaca_fallback":
            actual_adapter_name = "alpaca"
        self._handle_execution_fallback(
            session=session,
            decision=decision,
            decision_row=decision_row,
            execution=execution,
            selected_adapter_name=selected_adapter_name,
            actual_adapter_name=actual_adapter_name,
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
        self._emit_domain_telemetry(
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
        logger.info(
            "Order submitted strategy_id=%s decision_id=%s symbol=%s adapter=%s alpaca_order_id=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            actual_adapter_name,
            execution.alpaca_order_id,
        )
        return True


__all__ = [name for name in globals() if not name.startswith("__")]

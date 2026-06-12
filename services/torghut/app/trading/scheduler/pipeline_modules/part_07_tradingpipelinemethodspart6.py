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
from .part_05_tradingpipelinemethodspart4 import *
from .part_06_tradingpipelinemethodspart5 import *


class _TradingPipelineMethodsPart6:
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
            _RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS,
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
        risk_increasing_entry = _is_runtime_risk_increasing_entry(decision, positions)
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

    @staticmethod
    def _execution_client_name(client: Any) -> str:
        raw_name = getattr(client, "name", None)
        if raw_name:
            return str(raw_name)
        if isinstance(client, OrderFirewall):
            return "alpaca"
        return type(client).__name__

    def _sync_lean_observability(self, execution_client: Any) -> None:
        snapshot_getter = getattr(execution_client, "get_observability_snapshot", None)
        if not callable(snapshot_getter):
            return
        try:
            snapshot = snapshot_getter()
        except Exception as exc:
            logger.warning("Failed to read LEAN observability snapshot: %s", exc)
            return
        if isinstance(snapshot, Mapping):
            self.state.metrics.record_lean_observability(
                cast(Mapping[str, Any], snapshot)
            )

    def _evaluate_lean_canary_guard(self, session: Session, *, symbol: str) -> None:
        if settings.trading_mode != "live":
            return
        if not settings.trading_lean_live_canary_enabled:
            return
        if settings.trading_lean_lane_disable_switch:
            return

        lean_total = self.state.metrics.execution_requests_total.get("lean", 0)
        fallback_total = self.state.metrics.execution_fallback_total.get(
            "lean->alpaca", 0
        )
        if lean_total <= 0:
            return
        ratio = fallback_total / lean_total
        if ratio <= settings.trading_lean_live_canary_fallback_ratio_limit:
            return

        self.state.metrics.record_lean_canary_breach("fallback_ratio_exceeded")
        evidence = {
            "symbol": symbol,
            "fallback_ratio": ratio,
            "fallback_total": fallback_total,
            "lean_total": lean_total,
            "threshold": settings.trading_lean_live_canary_fallback_ratio_limit,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
        incident_key = hashlib.sha256(
            json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:24]
        incident = self.lean_lane_manager.record_canary_incident(
            session,
            incident_key=incident_key,
            breach_type="fallback_ratio_exceeded",
            severity="critical",
            symbols=[symbol],
            evidence=evidence,
            rollback_triggered=settings.trading_lean_live_canary_hard_rollback_enabled,
        )
        self.state.rollback_incidents_total += 1
        self.state.rollback_incident_evidence_path = (
            f"postgres://lean_canary_incidents/{incident.incident_key}"
        )

        if not settings.trading_lean_live_canary_hard_rollback_enabled:
            return
        self.state.emergency_stop_active = True
        self.state.emergency_stop_reason = (
            f"lean_canary_breach:fallback_ratio_exceeded:{ratio:.4f}"
        )
        self.state.emergency_stop_triggered_at = datetime.now(timezone.utc)

    def _apply_portfolio_sizing(
        self,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> PortfolioSizingResult:
        equity = _optional_decimal(account.get("equity"))
        sizer = sizer_from_settings(strategy, equity)
        return sizer.size(decision, account=account, positions=positions)

    @staticmethod
    def _load_strategies(session: Session) -> list[Strategy]:
        stmt = select(Strategy).where(Strategy.enabled.is_(True))
        return list(session.execute(stmt).scalars().all())

    def _apply_llm_review(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[str]]:
        if not settings.llm_enabled:
            return decision, None

        guardrails = evaluate_llm_guardrails()
        policy_resolution = _build_llm_policy_resolution(
            rollout_stage=guardrails.rollout_stage,
            effective_fail_mode=guardrails.effective_fail_mode,
            guardrail_reasons=guardrails.reasons,
        )
        self._record_llm_policy_resolution_metrics(policy_resolution)
        engine: LLMReviewEngine | None = None

        if settings.llm_dspy_runtime_mode == "active":
            gate_allowed, dspy_live_gate_reasons = settings.llm_dspy_live_runtime_gate()
            if not gate_allowed:
                reject_reason, runtime_subtype = self._classify_dspy_live_runtime_block(
                    dspy_live_gate_reasons
                )
                return self._handle_llm_dspy_live_runtime_block(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    account=account,
                    positions=positions,
                    reason="llm_dspy_live_runtime_gate_blocked",
                    reject_reason=reject_reason,
                    risk_flags=list(dspy_live_gate_reasons),
                    response_payload_extra={
                        "llm_runtime": {
                            "reject_reason": reject_reason,
                            "subtype": runtime_subtype,
                            "error": "llm_dspy_live_runtime_gate_blocked",
                            "primary_reason": (
                                dspy_live_gate_reasons[0]
                                if dspy_live_gate_reasons
                                else "llm_dspy_live_runtime_gate_blocked"
                            ),
                        }
                    },
                    policy_resolution=_build_llm_policy_resolution(
                        rollout_stage=guardrails.rollout_stage,
                        effective_fail_mode="veto",
                        guardrail_reasons=tuple(guardrails.reasons)
                        + tuple(dspy_live_gate_reasons),
                    ),
                )

            engine = self.llm_review_engine or LLMReviewEngine()

            dspy_runtime = getattr(engine, "dspy_runtime", None)
            if isinstance(dspy_runtime, DSPyReviewRuntime):
                dspy_live_ready, dspy_live_readiness_reasons = (
                    dspy_runtime.evaluate_live_readiness()
                )
            else:
                dspy_live_ready, dspy_live_readiness_reasons = (
                    DSPyReviewRuntime.from_settings().evaluate_live_readiness()
                )

            if not dspy_live_ready:
                reject_reason, runtime_subtype = self._classify_dspy_live_runtime_block(
                    dspy_live_readiness_reasons
                )
                return self._handle_llm_dspy_live_runtime_block(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    account=account,
                    positions=positions,
                    reason="llm_dspy_live_runtime_gate_blocked",
                    reject_reason=reject_reason,
                    risk_flags=list(dspy_live_readiness_reasons),
                    response_payload_extra={
                        "llm_runtime": {
                            "reject_reason": reject_reason,
                            "subtype": runtime_subtype,
                            "error": "llm_dspy_live_runtime_gate_blocked",
                            "primary_reason": (
                                dspy_live_readiness_reasons[0]
                                if dspy_live_readiness_reasons
                                else "llm_dspy_live_runtime_gate_blocked"
                            ),
                        }
                    },
                    policy_resolution=_build_llm_policy_resolution(
                        rollout_stage=guardrails.rollout_stage,
                        effective_fail_mode="veto",
                        guardrail_reasons=tuple(guardrails.reasons)
                        + tuple(dspy_live_readiness_reasons),
                    ),
                )

        guardrail_block = self._handle_llm_guardrail_block(
            session=session,
            decision=decision,
            decision_row=decision_row,
            account=account,
            positions=positions,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
        )
        if guardrail_block is not None:
            return guardrail_block

        if engine is None:
            engine = self.llm_review_engine or LLMReviewEngine()

        circuit_open = self._handle_llm_circuit_open(
            session=session,
            decision=decision,
            decision_row=decision_row,
            account=account,
            positions=positions,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
            engine=engine,
        )
        if circuit_open is not None:
            return circuit_open

        request_json: dict[str, Any] = {}
        try:
            return self._run_llm_review_request(
                session=session,
                decision=decision,
                decision_row=decision_row,
                account=account,
                positions=positions,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
                engine=engine,
                request_json=request_json,
            )
        except Exception as exc:
            return self._handle_llm_review_error(
                session=session,
                decision=decision,
                decision_row=decision_row,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
                engine=engine,
                request_json=request_json,
                error=exc,
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

    def _handle_llm_guardrail_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        if guardrails.allow_requests:
            return None
        self.state.metrics.llm_guardrail_block_total += 1
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason="llm_guardrail_blocked",
            shadow_mode=True,
            effective_fail_mode=guardrails.effective_fail_mode,
            risk_flags=list(guardrails.reasons),
            market_context=None,
            policy_resolution=policy_resolution,
        )

    def _handle_llm_circuit_open(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        if not engine.circuit_breaker.is_open():
            return None
        self.state.metrics.llm_circuit_open_total += 1
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason="llm_circuit_open",
            shadow_mode=guardrails.shadow_mode,
            effective_fail_mode=guardrails.effective_fail_mode,
            market_context=None,
            policy_resolution=policy_resolution,
        )

    def _handle_llm_dspy_live_runtime_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        reason: str,
        reject_reason: str,
        risk_flags: list[str],
        response_payload_extra: Optional[dict[str, Any]] = None,
        policy_resolution: Optional[dict[str, Any]] = None,
    ) -> tuple[StrategyDecision, Optional[str]]:
        block_fail_mode = settings.llm_dspy_live_runtime_block_fail_mode
        if reject_reason.startswith("llm_runtime_fallback"):
            self.state.metrics.llm_runtime_fallback_total += 1
        effective_fail_mode = "veto" if block_fail_mode == "veto" else "pass_through"
        passthrough_decision = decision
        if block_fail_mode == "pass_through_reduced_size":
            passthrough_decision = self._degrade_llm_runtime_block_qty(
                decision=decision,
                positions=positions,
                reason=reason,
                risk_flags=risk_flags,
            )
        return self._handle_llm_unavailable(
            session,
            passthrough_decision,
            decision_row,
            account,
            positions,
            reason=reason,
            reject_reason=reject_reason,
            shadow_mode=False,
            effective_fail_mode=effective_fail_mode,
            risk_flags=risk_flags,
            market_context=None,
            response_payload_extra=response_payload_extra,
            policy_resolution=policy_resolution,
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
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
        request_json: dict[str, Any],
    ) -> tuple[StrategyDecision, Optional[str]]:
        pre_llm_reject_reason = self._resolve_pre_llm_executability_reject(decision)
        if pre_llm_reject_reason == "symbol_capacity_exhausted":
            self.state.metrics.pre_llm_capacity_reject_total += 1
            return decision, pre_llm_reject_reason
        if pre_llm_reject_reason == "qty_below_min":
            self.state.metrics.pre_llm_qty_below_min_total += 1
            return decision, pre_llm_reject_reason

        self.state.metrics.llm_requests_total += 1
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

        portfolio_snapshot = _build_portfolio_snapshot(account, positions)
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = _load_recent_decisions(
            session,
            decision.strategy_id,
            decision.symbol,
        )
        market_context_block = self._maybe_handle_market_context_block(
            session=session,
            decision=decision,
            decision_row=decision_row,
            account=account,
            positions=positions,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
            market_context=market_context,
            market_context_error=market_context_error,
        )
        if market_context_block is not None:
            return market_context_block

        request = engine.build_request(
            decision,
            account,
            positions,
            portfolio_snapshot,
            market_snapshot,
            market_context,
            recent_decisions,
            adjustment_allowed=guardrails.adjustment_allowed,
        )
        request_json.update(request.model_dump(mode="json"))
        outcome = engine.review(
            decision,
            account,
            positions,
            request=request,
            portfolio=portfolio_snapshot,
            market=market_snapshot,
            market_context=market_context,
            recent_decisions=recent_decisions,
        )
        if outcome.runtime_fallback is not None:
            self.executor.update_decision_json(
                session,
                decision_row,
                {"llm_runtime": outcome.runtime_fallback},
            )
            runtime_error = str(
                outcome.runtime_fallback.get("error") or "dspy_runtime_error"
            )
            runtime_subtype = str(
                outcome.runtime_fallback.get("subtype") or "dspy_runtime_error"
            )
            return self._handle_llm_dspy_live_runtime_block(
                session=session,
                decision=decision,
                decision_row=decision_row,
                account=account,
                positions=positions,
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
                policy_resolution=policy_resolution,
            )
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
            policy_resolution=policy_resolution,
        )
        self._record_llm_committee_metrics(response_json)
        self._record_llm_token_metrics(outcome)
        adjusted_qty, adjusted_order_type = self._apply_llm_policy_verdict(
            session=session,
            decision_row=decision_row,
            policy_outcome=policy_outcome,
        )
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
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
        engine.circuit_breaker.record_success()
        return self._finalize_llm_review_outcome(
            decision=decision,
            outcome=outcome,
            policy_outcome=policy_outcome,
            guardrails=guardrails,
        )


__all__ = [name for name in globals() if not name.startswith("__")]

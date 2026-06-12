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


class _TradingPipelineMethodsPart3:
    def _position_qty_for_symbol(
        self,
        positions: list[dict[str, Any]],
        symbol: str,
    ) -> Decimal:
        current_qty = Decimal("0")
        normalized_symbol = symbol.strip().upper()
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            raw_qty = position.get("qty") or position.get("quantity")
            if raw_qty is None:
                continue
            try:
                qty = Decimal(str(raw_qty))
            except (ArithmeticError, ValueError):
                continue
            side = str(position.get("side") or "").strip().lower()
            if side == "short":
                qty = -abs(qty)
            current_qty += qty
        return current_qty

    def _sell_inventory_context(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
        projected: bool,
    ) -> str:
        if decision.action != "sell":
            return "n_a"
        position_qty = self._position_qty_for_symbol(positions, decision.symbol)
        if projected:
            return "projected"
        if position_qty > 0:
            return "known"
        return "known"

    def _apply_allocation_results(
        self,
        *,
        session: Session,
        allocation_results: list[AllocationResult],
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        for allocation_result in allocation_results:
            self.state.metrics.record_allocator_result(allocation_result)
            decision = allocation_result.decision
            self.state.metrics.decisions_total += 1
            try:
                submitted_decision = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted_decision is not None:
                    _apply_projected_position_decision(positions, submitted_decision)
            except Exception:
                logger.exception(
                    "Decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["decision_handling_failed"]
                )

    def _ingest_order_feed(self, session: Session) -> None:
        counters = self.order_feed_ingestor.ingest_once(session)
        self.state.metrics.order_feed_messages_total += counters.get(
            "messages_total", 0
        )
        self.state.metrics.order_feed_events_persisted_total += counters.get(
            "events_persisted_total", 0
        )
        self.state.metrics.order_feed_duplicates_total += counters.get(
            "duplicates_total", 0
        )
        self.state.metrics.order_feed_out_of_order_total += counters.get(
            "out_of_order_total", 0
        )
        self.state.metrics.order_feed_missing_fields_total += counters.get(
            "missing_fields_total", 0
        )
        self.state.metrics.order_feed_apply_updates_total += counters.get(
            "apply_updates_total", 0
        )
        self.state.metrics.order_feed_consumer_errors_total += counters.get(
            "consumer_errors_total", 0
        )

    def record_no_signal_batch(self, batch: SignalBatch) -> None:
        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason
        reason = batch.no_signal_reason
        normalized_reason = _normalize_reason_metric(reason)
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        if batch.signal_lag_seconds is not None:
            self.state.metrics.signal_lag_seconds = int(batch.signal_lag_seconds)
        else:
            self.state.metrics.signal_lag_seconds = None
        self.state.metrics.record_no_signal(reason)
        streak = self.state.metrics.no_signal_reason_streak.get(normalized_reason, 0)
        continuity_streak_reasons = {
            "no_signals_in_window",
            "cursor_tail_stable",
            "cursor_ahead_of_stream",
            "empty_batch_advanced",
        }
        streak_threshold_met = (
            normalized_reason in continuity_streak_reasons
            and streak >= settings.trading_signal_no_signal_streak_alert_threshold
        )
        lag_threshold_met = (
            batch.signal_lag_seconds is not None
            and batch.signal_lag_seconds
            >= settings.trading_signal_stale_lag_alert_seconds
        )
        actionable = self._is_actionable_no_signal_reason(
            reason=normalized_reason,
            signal_lag_seconds=batch.signal_lag_seconds,
            market_session_open=market_session_open,
        )
        continuity_state = (
            "actionable_source_fault"
            if actionable
            else "expected_market_closed_staleness"
        )
        self.state.last_signal_continuity_state = continuity_state
        self.state.last_signal_continuity_reason = normalized_reason
        self.state.last_signal_continuity_actionable = actionable
        self.state.metrics.signal_continuity_actionable = 1 if actionable else 0
        if actionable:
            self.state.metrics.record_signal_actionable_staleness(normalized_reason)
        else:
            self.state.metrics.record_signal_expected_staleness(normalized_reason)

        if actionable and streak_threshold_met:
            _latch_signal_continuity_alert_state(self.state, normalized_reason)
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal continuity alert: reason=%s consecutive_no_signal=%s lag_seconds=%s market_session_open=%s",
                reason,
                streak,
                batch.signal_lag_seconds,
                market_session_open,
            )
        elif actionable and lag_threshold_met:
            _latch_signal_continuity_alert_state(self.state, normalized_reason)
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal freshness alert: reason=%s lag_seconds=%s market_session_open=%s",
                reason,
                batch.signal_lag_seconds,
                market_session_open,
            )
        elif actionable and self.state.signal_continuity_alert_active:
            _latch_signal_continuity_alert_state(self.state, normalized_reason)
        elif not actionable and (streak_threshold_met or lag_threshold_met):
            logger.info(
                "Signal continuity observed as expected staleness reason=%s lag_seconds=%s market_session_open=%s",
                reason,
                batch.signal_lag_seconds,
                market_session_open,
            )

    def _is_actionable_no_signal_reason(
        self,
        *,
        reason: str,
        signal_lag_seconds: float | None,
        market_session_open: bool,
    ) -> bool:
        if reason == "cursor_ahead_of_stream":
            return True
        if reason in _FRESH_TAIL_NO_SIGNAL_REASONS:
            if _signal_bootstrap_grace_active(
                self.state,
                grace_seconds=settings.trading_signal_bootstrap_grace_seconds,
            ):
                return False
            if _signal_tail_is_fresh(
                reason,
                signal_lag_seconds,
                stale_lag_seconds=settings.trading_signal_stale_lag_alert_seconds,
            ):
                return False
        if market_session_open:
            return True
        expected_market_closed_reasons = (
            settings.trading_signal_market_closed_expected_reasons
        )
        return reason not in expected_market_closed_reasons

    def _is_market_session_open(self, now: datetime | None = None) -> bool:
        trading_client = getattr(self.alpaca_client, "trading", None)
        return _is_market_session_open(trading_client, now=now)

    def reconcile(self) -> int:
        with self.session_factory() as session:
            updates = self.reconciler.reconcile(session, self.execution_adapter)
            if updates:
                self.state.metrics.reconcile_updates_total += updates
            return updates

    def _handle_decision(
        self,
        session: Session,
        decision: StrategyDecision,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> StrategyDecision | None:
        decision_row: Optional[TradeDecision] = None
        try:
            strategy_context = self._resolve_strategy_context(
                decision=decision,
                strategies=strategies,
                allowed_symbols=allowed_symbols,
            )
            if strategy_context is None:
                return
            strategy, symbol_allowlist = strategy_context

            decision_row = self._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
            if decision_row is None:
                return

            prepared = self._prepare_decision_for_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                strategy=strategy,
                account=account,
                positions=positions,
            )
            if prepared is None:
                return
            decision, snapshot = prepared

            policy_stage = self._evaluate_execution_policy_outcome(
                session=session,
                decision=decision,
                decision_row=decision_row,
                strategy=strategy,
                positions=positions,
                snapshot=snapshot,
            )
            if policy_stage is None:
                return
            decision, policy_outcome = policy_stage

            if not self._passes_risk_verdict(
                session=session,
                decision=decision,
                decision_row=decision_row,
                strategy=strategy,
                account=account,
                positions=positions,
                symbol_allowlist=symbol_allowlist,
                execution_advisor=policy_outcome.advisor_metadata,
            ):
                return
            if not self._is_trading_submission_allowed(
                session=session,
                decision=decision,
                decision_row=decision_row,
            ):
                return

            submitted = self._submit_decision_execution(
                session=session,
                decision=decision,
                decision_row=decision_row,
                policy_outcome=policy_outcome,
            )
            if not submitted:
                return None
            return decision
        except Exception as exc:
            try:
                session.rollback()
            except Exception:
                logger.exception(
                    "Decision handler rollback failed strategy_id=%s symbol=%s",
                    decision.strategy_id,
                    decision.symbol,
                )
            logger.exception(
                "Decision handling failed strategy_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision.symbol,
                exc,
            )
            if decision_row is not None and decision_row.status == "planned":
                self.state.metrics.orders_rejected_total += 1
                reason_code = f"decision_handler_error_{type(exc).__name__}"
                self.state.metrics.record_decision_rejection_reasons([reason_code])
                self.state.metrics.record_decision_state("rejected")
                self.executor.mark_rejected(
                    session,
                    decision_row,
                    reason_code,
                    metadata_update=self._decision_lifecycle_metadata(
                        submission_stage="rejected_handler_error"
                    ),
                )
            return None

    def _resolve_strategy_context(
        self,
        *,
        decision: StrategyDecision,
        strategies: list[Strategy],
        allowed_symbols: set[str],
    ) -> tuple[Strategy, set[str]] | None:
        strategy = next(
            (s for s in strategies if str(s.id) == decision.strategy_id), None
        )
        if strategy is None:
            return None

        strategy_symbols = _coerce_strategy_symbols(strategy.universe_symbols)
        if strategy_symbols and allowed_symbols:
            return strategy, strategy_symbols & allowed_symbols
        if strategy_symbols:
            return strategy, strategy_symbols
        return strategy, allowed_symbols

    def _decision_row_age_seconds(self, decision_row: TradeDecision) -> int:
        created_at = decision_row.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return max(
            0,
            int(
                (
                    trading_now(account_label=self.account_label) - created_at
                ).total_seconds()
            ),
        )

    def _dspy_runtime_gate_status(self) -> dict[str, object]:
        dspy_runtime_status: dict[str, object] = {
            "mode": settings.llm_dspy_runtime_mode,
            "artifact_hash": settings.llm_dspy_artifact_hash,
            "live_ready": False,
            "readiness_reasons": [],
        }
        if not settings.llm_dspy_runtime_mode:
            return dspy_runtime_status

        try:
            dspy_runtime = DSPyReviewRuntime.from_settings()
            live_ready, readiness_reasons = dspy_runtime.evaluate_live_readiness()
            dspy_runtime_status["live_ready"] = live_ready
            dspy_runtime_status["readiness_reasons"] = list(readiness_reasons)
        except DSPyRuntimeUnsupportedStateError as exc:
            dspy_runtime_status["readiness_reasons"] = [str(exc)]
        except Exception as exc:  # pragma: no cover - additive status surface only
            dspy_runtime_status["readiness_reasons"] = [
                f"dspy_status_error:{type(exc).__name__}"
            ]
        return dspy_runtime_status

    def _live_submission_gate(
        self,
        *,
        session: Session | None = None,
        hypothesis_summary: Mapping[str, Any] | None = None,
        empirical_jobs_status: Mapping[str, Any] | None = None,
        dspy_runtime_status: Mapping[str, Any] | None = None,
        quant_health_status: Mapping[str, Any] | None = None,
    ) -> dict[str, object]:
        if (
            session is None
            and hypothesis_summary is None
            and empirical_jobs_status is None
            and dspy_runtime_status is None
            and quant_health_status is None
            and self._last_live_submission_gate is not None
        ):
            return dict(self._last_live_submission_gate)

        summary = hypothesis_summary
        if summary is None and session is not None:
            try:
                summary = build_hypothesis_runtime_summary(
                    session,
                    state=self.state,
                    market_context_status=build_submission_gate_market_context_status(
                        self.state
                    ),
                )
            except Exception as exc:  # pragma: no cover - additive runtime safety
                summary = {
                    "promotion_eligible_total": 0,
                    "capital_stage_totals": {},
                    "dependency_quorum": {
                        "decision": "unknown",
                        "reasons": ["alpha_readiness_unavailable"],
                        "message": str(exc),
                    },
                }

        empirical_status = empirical_jobs_status
        if empirical_status is None and session is not None:
            try:
                empirical_status = build_empirical_jobs_status(
                    session=session,
                    stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
                )
            except Exception as exc:  # pragma: no cover - additive runtime safety
                empirical_status = {
                    "ready": False,
                    "status": "degraded",
                    "message": f"empirical job status unavailable: {type(exc).__name__}",
                }

        quant_status = quant_health_status
        if quant_status is None:
            quant_status = load_quant_evidence_status(account_label=self.account_label)

        gate = build_live_submission_gate_payload(
            self.state,
            hypothesis_summary=summary,
            empirical_jobs_status=empirical_status,
            dspy_runtime_status=dspy_runtime_status,
            quant_health_status=quant_status,
            quant_account_label=self.account_label,
            session=session,
        )
        self._last_live_submission_gate = dict(gate)
        return gate

    def _submission_capital_stage(self) -> str:
        gate = self._live_submission_gate()
        capital_stage = gate.get("capital_stage")
        if isinstance(capital_stage, str) and capital_stage.strip():
            return capital_stage
        return settings.trading_mode

    def _submission_control_plane_snapshot(
        self,
        *,
        capital_stage: str | None = None,
    ) -> dict[str, object]:
        gate = self._live_submission_gate()
        return {
            "active_revision": os.getenv("K_REVISION", "").strip() or None,
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "capital_stage": capital_stage or self._submission_capital_stage(),
            "live_submission_gate": gate,
        }

    def _decision_lifecycle_metadata(
        self,
        *,
        submission_stage: str,
        capital_stage: str | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "submission_stage": submission_stage,
            "control_plane_snapshot": self._submission_control_plane_snapshot(
                capital_stage=capital_stage
            ),
        }
        if extra:
            metadata.update({str(key): value for key, value in extra.items()})
        return metadata

    def _block_decision_submission(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        reason: str,
        submission_stage: str,
        capital_stage: str | None = None,
        extra_metadata: Mapping[str, Any] | None = None,
        severity: str = "warning",
    ) -> None:
        metadata = self._decision_lifecycle_metadata(
            submission_stage=submission_stage,
            capital_stage=capital_stage,
            extra=extra_metadata,
        )
        self.state.metrics.record_submission_block(reason)
        self.state.metrics.record_decision_state("blocked")
        self.executor.mark_blocked(
            session,
            decision_row,
            reason,
            metadata_update=metadata,
        )
        self._emit_domain_telemetry(
            event_name="torghut.decision.blocked",
            severity=severity,
            decision=decision,
            decision_row=decision_row,
            reason_codes=[reason],
            extra_properties={"decision_status": "blocked"},
        )

    def _ensure_pending_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        decision_row = self.executor.ensure_decision(
            session, decision, strategy, self.account_label
        )
        if decision_row.status != "planned":
            return None
        self.state.metrics.record_decision_state("planned")
        age_seconds = self._decision_row_age_seconds(decision_row)
        self.state.metrics.observe_planned_decision_age(age_seconds)
        if self.executor.execution_exists(session, decision_row):
            self.state.metrics.planned_decisions_with_execution_total += 1
            execution_status = (
                session.execute(
                    select(Execution.status)
                    .where(Execution.trade_decision_id == decision_row.id)
                    .order_by(Execution.created_at.desc())
                    .limit(1)
                )
                .scalars()
                .first()
            )
            resolved_status = (
                str(execution_status or "submitted").strip() or "submitted"
            )
            decision_json = _coerce_json(decision_row.decision_json)
            decision_json["submission_stage"] = "execution_backfilled"
            decision_json["control_plane_snapshot"] = coerce_json_payload(
                self._submission_control_plane_snapshot()
            )
            decision_row.status = resolved_status
            decision_row.decision_json = decision_json
            session.add(decision_row)
            session.commit()
            self.state.metrics.record_decision_state(resolved_status)
            logger.warning(
                "Resolved planned decision with existing execution decision_id=%s strategy_id=%s symbol=%s resolved_status=%s",
                decision_row.id,
                decision.strategy_id,
                decision.symbol,
                resolved_status,
            )
            return None
        if self._expire_stale_planned_decision(
            session=session, decision=decision, decision_row=decision_row
        ):
            return None
        return decision_row

    def _expire_stale_planned_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        timeout_seconds = settings.trading_planned_decision_timeout_seconds
        if timeout_seconds <= 0:
            return False
        age_seconds = self._decision_row_age_seconds(decision_row)
        self.state.metrics.observe_planned_decision_age(age_seconds)
        if age_seconds < timeout_seconds:
            return False
        self.state.metrics.planned_decisions_stale_total += 1
        self._block_decision_submission(
            session=session,
            decision=decision,
            decision_row=decision_row,
            reason="stale_planned_cleanup",
            submission_stage="blocked_stale_planned_cleanup",
            extra_metadata={
                "stale_planned_age_seconds": age_seconds,
                "planned_decision_timeout_seconds": timeout_seconds,
            },
            severity="error",
        )
        logger.error(
            "Recovered stale planned decision decision_id=%s strategy_id=%s symbol=%s age_seconds=%s timeout_seconds=%s",
            decision_row.id,
            decision.strategy_id,
            decision.symbol,
            age_seconds,
            timeout_seconds,
        )
        return True


__all__ = [name for name in globals() if not name.startswith("__")]

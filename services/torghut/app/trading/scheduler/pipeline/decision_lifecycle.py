"""Trading pipeline implementation."""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ...empirical_jobs import build_empirical_jobs_status
from ...ingest import SignalBatch
from ...llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from ...models import StrategyDecision
from ...portfolio import (
    AllocationResult,
)
from ...time_source import trading_now
from ...submission_council import (
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..safety import (
    FRESH_TAIL_NO_SIGNAL_REASONS,
    is_market_session_open,
    latch_signal_continuity_alert_state,
    signal_bootstrap_grace_active,
    signal_tail_is_fresh,
)
from ..state import (
    normalize_reason_metric,
)

from .contexts import (
    AllocationDecisionContext,
    DecisionBlockRequest,
    DecisionSubmissionContext,
    DomainTelemetryEvent,
    ExecutionPolicyRequest,
    LiveSubmissionGateInputs,
    RiskVerdictRequest,
)
from .shared import TradingPipelineBase
from .support import (
    apply_projected_position_decision,
    coerce_json,
    coerce_strategy_symbols,
)

logger = logging.getLogger(__name__)


class TradingPipelineDecisionLifecycleMixin(TradingPipelineBase):
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
        context: AllocationDecisionContext,
        allocation_results: list[AllocationResult],
    ) -> None:
        for allocation_result in allocation_results:
            self.state.metrics.record_allocator_result(allocation_result)
            decision = allocation_result.decision
            self.state.metrics.decisions_total += 1
            try:
                submitted_decision = self._handle_decision(
                    context,
                    decision,
                )
                if submitted_decision is not None:
                    apply_projected_position_decision(
                        context.positions, submitted_decision
                    )
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
        normalized_reason = normalize_reason_metric(reason)
        market_session_open = self.is_market_session_open()
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
            latch_signal_continuity_alert_state(self.state, normalized_reason)
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal continuity alert: reason=%s consecutive_no_signal=%s lag_seconds=%s market_session_open=%s",
                reason,
                streak,
                batch.signal_lag_seconds,
                market_session_open,
            )
        elif actionable and lag_threshold_met:
            latch_signal_continuity_alert_state(self.state, normalized_reason)
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal freshness alert: reason=%s lag_seconds=%s market_session_open=%s",
                reason,
                batch.signal_lag_seconds,
                market_session_open,
            )
        elif actionable and self.state.signal_continuity_alert_active:
            latch_signal_continuity_alert_state(self.state, normalized_reason)
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
        if reason in FRESH_TAIL_NO_SIGNAL_REASONS:
            if signal_bootstrap_grace_active(
                self.state,
                grace_seconds=settings.trading_signal_bootstrap_grace_seconds,
            ):
                return False
            if signal_tail_is_fresh(
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

    def is_market_session_open(self, now: datetime | None = None) -> bool:
        return self._is_market_session_open(now)

    def _is_market_session_open(self, now: datetime | None = None) -> bool:
        trading_client = getattr(self.alpaca_client, "trading", None)
        return is_market_session_open(trading_client, now=now)

    def reconcile(self) -> int:
        with self.session_factory() as session:
            updates = self.reconciler.reconcile(session, self.execution_adapter)
            if updates:
                self.state.metrics.reconcile_updates_total += updates
            return updates

    def _handle_decision(
        self,
        context: AllocationDecisionContext | Any,
        decision: StrategyDecision | None = None,
        *legacy_args: Any,
    ) -> StrategyDecision | None:
        context, decision = self._handle_decision_request(
            context,
            decision,
            legacy_args,
        )
        decision_row: Optional[TradeDecision] = None
        try:
            strategy_context = self._resolve_strategy_context(
                decision=decision,
                strategies=context.strategies,
                allowed_symbols=context.allowed_symbols,
            )
            if strategy_context is None:
                return
            strategy, symbol_allowlist = strategy_context

            decision_row = self._ensure_pending_decision_row(
                session=context.session,
                decision=decision,
                strategy=strategy,
            )
            if decision_row is None:
                return

            submission_context = DecisionSubmissionContext(
                session=context.session,
                decision_row=decision_row,
                strategy=strategy,
                account=context.account,
                positions=context.positions,
                symbol_allowlist=symbol_allowlist,
            )
            policy_stage = self._prepare_decision_policy_stage(
                context=submission_context, decision=decision
            )
            if policy_stage is None:
                return
            decision, policy_outcome = policy_stage

            if (
                not self._passes_risk_verdict(
                    RiskVerdictRequest(
                        context=submission_context,
                        decision=decision,
                        execution_advisor=policy_outcome.advisor_metadata,
                    )
                )
                or not self._is_trading_submission_allowed(
                    session=context.session,
                    decision=decision,
                    decision_row=decision_row,
                    strategy=strategy,
                    account=context.account,
                    positions=context.positions,
                )
                or not self._submit_decision_execution(
                    session=context.session,
                    decision=decision,
                    decision_row=decision_row,
                    policy_outcome=policy_outcome,
                )
            ):
                return None
            return decision
        except Exception as exc:
            try:
                context.session.rollback()
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
                    context.session,
                    decision_row,
                    reason_code,
                    metadata_update=self._decision_lifecycle_metadata(
                        submission_stage="rejected_handler_error"
                    ),
                )
            return None

    @staticmethod
    def _handle_decision_request(
        context: AllocationDecisionContext | Any,
        decision: StrategyDecision | None,
        legacy_args: tuple[Any, ...],
    ) -> tuple[AllocationDecisionContext, StrategyDecision]:
        if isinstance(context, AllocationDecisionContext):
            if decision is None:
                raise TypeError("decision is required")
            return context, decision
        if decision is None or len(legacy_args) != 4:
            raise TypeError("legacy _handle_decision call requires 6 arguments")
        strategies, account, positions, allowed_symbols = legacy_args
        return (
            AllocationDecisionContext(
                session=context,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            ),
            decision,
        )

    def _prepare_decision_policy_stage(
        self,
        *,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, Any] | None:
        prepared = self._prepare_decision_for_submission(
            context=context,
            decision=decision,
        )
        if prepared is None:
            return None
        decision, snapshot = prepared
        return self._evaluate_execution_policy_outcome(
            ExecutionPolicyRequest(
                context=context,
                decision=decision,
                snapshot=snapshot,
            )
        )

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

        strategy_symbols = coerce_strategy_symbols(strategy.universe_symbols)
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
        inputs: LiveSubmissionGateInputs | None = None,
        **legacy_inputs: Any,
    ) -> dict[str, object]:
        if inputs is None and legacy_inputs:
            inputs = LiveSubmissionGateInputs(**legacy_inputs)
        inputs = inputs or LiveSubmissionGateInputs()
        if (
            inputs.session is None
            and inputs.hypothesis_summary is None
            and inputs.empirical_jobs_status is None
            and inputs.dspy_runtime_status is None
            and inputs.quant_health_status is None
            and self._last_live_submission_gate is not None
        ):
            return dict(self._last_live_submission_gate)

        summary = inputs.hypothesis_summary
        if summary is None and inputs.session is not None:
            try:
                summary = build_hypothesis_runtime_summary(
                    inputs.session,
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

        empirical_status = inputs.empirical_jobs_status
        if empirical_status is None and inputs.session is not None:
            try:
                empirical_status = build_empirical_jobs_status(
                    session=inputs.session,
                    stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
                )
            except Exception as exc:  # pragma: no cover - additive runtime safety
                empirical_status = {
                    "ready": False,
                    "status": "degraded",
                    "message": f"empirical job status unavailable: {type(exc).__name__}",
                }

        quant_status = inputs.quant_health_status
        if quant_status is None:
            quant_status = load_quant_evidence_status(account_label=self.account_label)

        gate = build_live_submission_gate_payload(
            self.state,
            hypothesis_summary=summary,
            empirical_jobs_status=empirical_status,
            dspy_runtime_status=inputs.dspy_runtime_status,
            quant_health_status=quant_status,
            quant_account_label=self.account_label,
            session=inputs.session,
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
        request: DecisionBlockRequest | None = None,
        **legacy_kwargs: Any,
    ) -> None:
        if request is None:
            request = DecisionBlockRequest(
                session=legacy_kwargs["session"],
                decision=legacy_kwargs["decision"],
                decision_row=legacy_kwargs["decision_row"],
                reason=legacy_kwargs["reason"],
                submission_stage=legacy_kwargs["submission_stage"],
                capital_stage=legacy_kwargs.get("capital_stage"),
                extra_metadata=legacy_kwargs.get("extra_metadata"),
                severity=legacy_kwargs.get("severity", "warning"),
            )
        metadata = self._decision_lifecycle_metadata(
            submission_stage=request.submission_stage,
            capital_stage=request.capital_stage,
            extra=request.extra_metadata,
        )
        self.state.metrics.record_submission_block(request.reason)
        self.state.metrics.record_decision_state("blocked")
        self.executor.mark_blocked(
            request.session,
            request.decision_row,
            request.reason,
            metadata_update=metadata,
        )
        self._emit_domain_telemetry(
            DomainTelemetryEvent(
                event_name="torghut.decision.blocked",
                severity=request.severity,
                decision=request.decision,
                decision_row=request.decision_row,
                reason_codes=[request.reason],
                extra_properties={"decision_status": "blocked"},
            )
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
            decision_json = coerce_json(decision_row.decision_json)
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
            DecisionBlockRequest(
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

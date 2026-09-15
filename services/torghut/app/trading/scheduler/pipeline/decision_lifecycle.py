"""Trading pipeline implementation."""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, cast

from alpaca.common.exceptions import APIError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ...ingest import SignalBatch
from ...execution_policy import ExecutionPolicyOutcome
from ...llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from ...models import StrategyDecision
from ...broker_risk_snapshot import (
    normalize_live_open_order_rows,
    normalize_live_position_rows,
)
from ...portfolio import (
    AllocationResult,
)
from ...time_source import trading_now
from ...submission_council import (
    build_live_submission_gate_payload,
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
    RiskVerdictRequest,
)
from .shared import TradingPipelineRuntime
from .support import (
    apply_projected_position_decision,
    coerce_json,
    coerce_strategy_symbols,
    is_runtime_risk_increasing_entry,
    project_open_orders_onto_positions,
)

logger = logging.getLogger(__name__)


class TradingPipelineDecisionLifecycleMixin(TradingPipelineRuntime):
    def _position_qty_for_symbol(
        self,
        positions: list[dict[str, object]],
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
        positions: list[dict[str, object]],
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

    def _apply_pair_allocation_results(
        self,
        *,
        context: AllocationDecisionContext,
        allocation_results: list[AllocationResult],
    ) -> None:
        if not allocation_results:
            return
        if any(not result.approved for result in allocation_results):
            self._apply_allocation_results(
                context=context,
                allocation_results=allocation_results,
            )
            return
        symbols = {result.decision.symbol for result in allocation_results}
        try:
            before = self.capital_safety.position_market_values(symbols)
        except (APIError, OSError, RuntimeError, TypeError, ValueError):
            self.capital_safety.trigger_flatten("pair_balance_snapshot_unavailable")
            return
        submitted: list[StrategyDecision] = []
        for allocation_result in allocation_results:
            self.state.metrics.record_allocator_result(allocation_result)
            self.state.metrics.decisions_total += 1
            decision = allocation_result.decision
            submitted_decision = self._handle_decision(context, decision)
            if submitted_decision is None:
                if submitted:
                    self.capital_safety.trigger_flatten("unhedged_pair_submission")
                return
            submitted.append(submitted_decision)
            apply_projected_position_decision(context.positions, submitted_decision)

        submitted_notionals = {
            self._pair_submitted_notional(decision) for decision in submitted
        }
        if len(submitted_notionals) > 1:
            self.capital_safety.trigger_flatten("unhedged_pair_notional_mismatch")
            return
        try:
            after = self.capital_safety.position_market_values(symbols)
        except (APIError, OSError, RuntimeError, TypeError, ValueError):
            self.capital_safety.trigger_flatten("pair_balance_snapshot_unavailable")
            return
        if not self.capital_safety.pair_delta_is_balanced(
            submitted,
            before=before,
            after=after,
        ):
            self.capital_safety.trigger_flatten("unhedged_pair_fill")

    @staticmethod
    def _pair_submitted_notional(decision: StrategyDecision) -> Decimal:
        price = TradingPipelineDecisionLifecycleMixin._positive_decimal(
            decision.params.get("price") or decision.limit_price
        )
        return (
            (decision.qty * price).quantize(Decimal("0.01")) if price else Decimal("0")
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
        self.state.metrics.broker_stream_source_events_total += counters.get(
            "immutable_source_events_total", 0
        )
        self.state.metrics.broker_stream_source_duplicates_total += counters.get(
            "immutable_source_duplicates_total", 0
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
        context: AllocationDecisionContext,
        decision: StrategyDecision,
    ) -> StrategyDecision | None:
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
            self._refresh_live_submission_context(context)
            if (
                not self.state.capital_new_exposure_allowed
                and is_runtime_risk_increasing_entry(decision, context.positions)
            ):
                reason = "new_exposure_cutoff_active"
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons([reason])
                self.state.metrics.record_decision_state("rejected")
                self.executor.mark_rejected(
                    context.session,
                    decision_row,
                    reason,
                    metadata_update=self._decision_lifecycle_metadata(
                        submission_stage="blocked_capital_control"
                    ),
                )
                return None

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
                )
                or not self._submit_decision_execution(
                    context=submission_context,
                    decision=decision,
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

    def _refresh_live_submission_context(
        self,
        context: AllocationDecisionContext,
    ) -> None:
        if settings.trading_mode != "live":
            return
        account = self.order_firewall.get_account()
        positions = self.order_firewall.list_positions()
        open_orders = self.order_firewall.list_orders(status="open")
        if not isinstance(account, Mapping):
            raise RuntimeError("live_risk_account_snapshot_unavailable")
        account_values = cast(Mapping[object, object], account)
        refreshed_account: dict[str, str] = {}
        for key in ("equity", "cash", "buying_power"):
            value = account_values.get(key)
            if value is not None:
                refreshed_account[key] = str(value)
        equity = self._positive_decimal(refreshed_account.get("equity"))
        buying_power = self._nonnegative_decimal(refreshed_account.get("buying_power"))
        if equity is None or buying_power is None:
            raise RuntimeError("live_risk_account_values_invalid")

        refreshed_positions = normalize_live_position_rows(positions)
        normalized_orders = normalize_live_open_order_rows(open_orders)
        projected_count = project_open_orders_onto_positions(
            refreshed_positions, normalized_orders
        )
        if projected_count != len(normalized_orders):
            raise RuntimeError("live_risk_open_order_projection_incomplete")
        refreshed_positions = self._attach_current_session_strategy_position_tags(
            context.session,
            refreshed_positions,
        )
        context.account.clear()
        context.account.update(refreshed_account)
        context.positions[:] = refreshed_positions

    @staticmethod
    def _positive_decimal(value: object) -> Decimal | None:
        parsed = TradingPipelineDecisionLifecycleMixin._nonnegative_decimal(value)
        if parsed is None or parsed <= 0:
            return None
        return parsed

    @staticmethod
    def _nonnegative_decimal(value: object) -> Decimal | None:
        try:
            parsed = Decimal(str(value))
        except (ArithmeticError, ValueError):
            return None
        return parsed if parsed.is_finite() and parsed >= 0 else None

    def _prepare_decision_policy_stage(
        self,
        *,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, ExecutionPolicyOutcome] | None:
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

    def _live_submission_gate(self) -> dict[str, object]:
        clickhouse_ta_status = self._submission_signal_freshness()
        gate = build_live_submission_gate_payload(
            self.state,
            clickhouse_ta_status=clickhouse_ta_status,
        )
        self._last_live_submission_gate = dict(gate)
        return gate

    def _submission_signal_freshness(self) -> Mapping[str, object]:
        latest_signal_status = getattr(self.ingestor, "latest_signal_status", None)
        if not callable(latest_signal_status):
            return {
                "state": "unavailable",
                "accepted_source_state": "unavailable",
                "blocking_reason": "accepted_ta_signal_unavailable",
            }
        try:
            status = latest_signal_status()
        except (SQLAlchemyError, OSError, RuntimeError, TypeError, ValueError):
            logger.exception("Accepted-source freshness read failed before submission")
            return {
                "state": "unavailable",
                "accepted_source_state": "unavailable",
                "blocking_reason": "accepted_ta_signal_unavailable",
            }
        if not isinstance(status, Mapping):
            return {
                "state": "unavailable",
                "accepted_source_state": "unavailable",
                "blocking_reason": "accepted_ta_signal_unavailable",
            }
        return cast(Mapping[str, object], status)

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
        extra: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        metadata: dict[str, object] = {
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
        request: DecisionBlockRequest,
    ) -> None:
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

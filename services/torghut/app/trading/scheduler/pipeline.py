"""Trading pipeline implementation."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional, Sequence, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...alpaca_client import TorghutAlpacaClient
from ...config import settings
from ...db import SessionLocal
from ...models import LLMDecisionReview, Strategy, TradeDecision, coerce_json_payload
from ...observability import capture_posthog_event
from ...snapshots import snapshot_account_and_positions
from ...strategies import StrategyCatalog
from ..autonomy.phase_manifest_contract import AUTONOMY_PHASE_ORDER
from ..decisions import DecisionEngine
from ..execution import OrderExecutor
from ..execution_adapters import (
    ExecutionAdapter,
    adapter_enabled_for_symbol,
    build_execution_adapter,
)
from ..execution_policy import ExecutionPolicy
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..firewall import OrderFirewall, OrderFirewallBlocked
from ..ingest import ClickHouseSignalIngestor, SignalBatch
from ..lean_lanes import LeanLaneManager
from ..llm import LLMReviewEngine, apply_policy
from ..llm.dspy_programs.runtime import DSPyReviewRuntime, DSPyRuntimeUnsupportedStateError
from ..llm.guardrails import evaluate_llm_guardrails
from ..llm.policy import allowed_order_types
from ..llm.schema import MarketContextBundle
from ..llm.schema import MarketSnapshot as LLMMarketSnapshot
from ..market_context import MarketContextClient, MarketContextStatus, evaluate_market_context
from ..models import SignalEnvelope, StrategyDecision
from ..order_feed import OrderFeedIngestor
from ..portfolio import AllocationResult, PortfolioSizingResult, allocator_from_settings, sizer_from_settings
from ..prices import ClickHousePriceFetcher, MarketSnapshot, PriceFetcher
from ..quantity_rules import fractional_equities_enabled_for_trade, min_qty_for_symbol, quantize_qty_for_symbol
from ..reconcile import Reconciler
from ..regime_hmm import HMMRegimeContext, resolve_hmm_context, resolve_regime_context_authority_reason
from ..risk import RiskEngine
from ..route_metadata import coerce_route_text
from ..tca import AdaptiveExecutionPolicyDecision, derive_adaptive_execution_policy
from ..time_source import trading_now
from ..universe import UniverseResolver
from .pipeline_helpers import *
from .safety import _is_market_session_open, _latch_signal_continuity_alert_state, _record_signal_continuity_recovery_cycle
from .state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
    TradingState,
    _normalize_reason_metric,
)

logger = logging.getLogger(__name__)
_AUTONOMY_PHASE_ORDER: tuple[str, ...] = AUTONOMY_PHASE_ORDER
_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER = Decimal("0.50")
_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE = Decimal("0.05")
_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS = 120
_RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS = (Decimal("0.75"), Decimal("0.55"))

class TradingPipeline:
    """Orchestrate ingest -> decide -> risk -> execute for one cycle."""

    def __init__(
        self,
        alpaca_client: TorghutAlpacaClient,
        order_firewall: OrderFirewall,
        ingestor: ClickHouseSignalIngestor,
        decision_engine: DecisionEngine,
        risk_engine: RiskEngine,
        executor: OrderExecutor,
        execution_adapter: ExecutionAdapter,
        reconciler: Reconciler,
        universe_resolver: UniverseResolver,
        state: TradingState,
        account_label: str,
        session_factory: Callable[[], Session] = SessionLocal,
        llm_review_engine: Optional[LLMReviewEngine] = None,
        price_fetcher: Optional[PriceFetcher] = None,
        strategy_catalog: StrategyCatalog | None = None,
        execution_policy: Optional[ExecutionPolicy] = None,
        order_feed_ingestor: OrderFeedIngestor | None = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.order_firewall = order_firewall
        self.ingestor = ingestor
        self.decision_engine = decision_engine
        self.risk_engine = risk_engine
        self.executor = executor
        self.execution_adapter = execution_adapter
        self.reconciler = reconciler
        self.universe_resolver = universe_resolver
        self.state = state
        self.account_label = account_label
        self.session_factory = session_factory
        self.price_fetcher = price_fetcher or ClickHousePriceFetcher()
        self._snapshot_cache = None
        self._snapshot_cached_at: Optional[datetime] = None
        self.strategy_catalog = strategy_catalog
        self.execution_policy = execution_policy or ExecutionPolicy()
        self.order_feed_ingestor = order_feed_ingestor or OrderFeedIngestor()
        self.market_context_client = MarketContextClient()
        self.lean_lane_manager = LeanLaneManager()
        self.llm_review_engine = llm_review_engine

    def run_once(self) -> None:
        with self.session_factory() as session:
            strategies = self._prepare_run_once(session)
            if not strategies:
                return

            batch = self.ingestor.fetch_signals(session)
            self._record_ingest_window(batch)
            if not self._prepare_batch_for_decisions(session, batch):
                return

            context = self._build_run_context(session)
            if context is None:
                self.ingestor.commit_cursor(session, batch)
                return
            account_snapshot, account, positions, allowed_symbols = context
            self._process_batch_signals(
                session=session,
                batch=batch,
                strategies=strategies,
                account_snapshot=account_snapshot,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self.ingestor.commit_cursor(session, batch)

    def _prepare_run_once(self, session: Session) -> list[Strategy]:
        self._ingest_order_feed(session)
        self.order_firewall.cancel_open_orders_if_kill_switch()
        if self.strategy_catalog is not None:
            self.strategy_catalog.refresh(session)
        strategies = self._load_strategies(session)
        if not strategies:
            logger.info("No enabled strategies found; skipping trading cycle")
        return strategies

    def _record_ingest_window(self, batch: SignalBatch) -> None:
        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason

    def _prepare_batch_for_decisions(
        self, session: Session, batch: SignalBatch
    ) -> bool:
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        if not batch.signals:
            self.record_no_signal_batch(batch)
            self.ingestor.commit_cursor(session, batch)
            return False

        if settings.trading_feature_quality_enabled:
            quality_thresholds = FeatureQualityThresholds(
                max_required_null_rate=settings.trading_feature_max_required_null_rate,
                max_staleness_ms=settings.trading_feature_max_staleness_ms,
                max_duplicate_ratio=settings.trading_feature_max_duplicate_ratio,
            )
            quality_report = evaluate_feature_batch_quality(
                batch.signals, thresholds=quality_thresholds
            )
            self.state.metrics.feature_batch_rows_total += quality_report.rows_total
            self.state.metrics.feature_null_rate = quality_report.null_rate_by_field
            self.state.metrics.feature_staleness_ms_p95 = (
                quality_report.staleness_ms_p95
            )
            self.state.metrics.feature_duplicate_ratio = quality_report.duplicate_ratio
            self.state.metrics.feature_schema_mismatch_total += (
                quality_report.schema_mismatch_total
            )
            if not quality_report.accepted:
                self.state.metrics.feature_quality_rejections_total += 1
                logger.error(
                    "Feature quality gate failed rows=%s reasons=%s staleness_ms_p95=%s duplicate_ratio=%s",
                    quality_report.rows_total,
                    quality_report.reasons,
                    quality_report.staleness_ms_p95,
                    quality_report.duplicate_ratio,
                )
                self.ingestor.commit_cursor(session, batch)
                return False

        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.last_signal_continuity_state = "signals_present"
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = False
        _record_signal_continuity_recovery_cycle(
            self.state,
            required_recovery_cycles=max(
                1, int(settings.trading_signal_continuity_recovery_cycles)
            ),
        )
        return True

    def _build_run_context(
        self, session: Session
    ) -> tuple[Any, dict[str, str], list[dict[str, Any]], set[str]] | None:
        account_snapshot = self._get_account_snapshot(session)
        account = {
            "equity": str(account_snapshot.equity),
            "cash": str(account_snapshot.cash),
            "buying_power": str(account_snapshot.buying_power),
        }
        positions = _clone_positions(account_snapshot.positions)

        universe_resolution = self.universe_resolver.get_resolution()
        self.state.universe_source_status = universe_resolution.status
        self.state.universe_source_reason = universe_resolution.reason
        self.state.universe_symbols_count = len(universe_resolution.symbols)
        self.state.universe_cache_age_seconds = universe_resolution.cache_age_seconds
        self.state.metrics.record_universe_resolution(
            status=universe_resolution.status,
            reason=universe_resolution.reason,
            symbols_count=len(universe_resolution.symbols),
            cache_age_seconds=universe_resolution.cache_age_seconds,
        )
        self.state.universe_fail_safe_blocked = False
        self.state.universe_fail_safe_block_reason = None
        allowed_symbols = universe_resolution.symbols
        if universe_resolution.status == "degraded":
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_stale_cache"
            )
        if (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
            and not allowed_symbols
        ):
            universe_reason = universe_resolution.reason or "unknown"
            self.state.universe_fail_safe_blocked = True
            self.state.universe_fail_safe_block_reason = universe_reason
            self.state.last_signal_continuity_state = "universe_fail_safe_block"
            self.state.last_signal_continuity_reason = "universe_source_unavailable"
            self.state.last_signal_continuity_actionable = True
            self.state.metrics.signal_continuity_actionable = 1
            self.state.metrics.record_signal_actionable_staleness(
                "universe_source_unavailable"
            )
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_unavailable"
            )
            self.state.metrics.record_universe_fail_safe_block(universe_reason)
            _latch_signal_continuity_alert_state(
                self.state, "universe_source_unavailable"
            )
            self.state.last_error = (
                f"universe_source_unavailable reason={universe_resolution.reason}"
            )
            logger.error(
                "Blocking decision execution: authoritative Jangar universe unavailable reason=%s status=%s",
                universe_resolution.reason,
                universe_resolution.status,
            )
            return None

        return account_snapshot, account, positions, allowed_symbols

    def _process_batch_signals(
        self,
        *,
        session: Session,
        batch: SignalBatch,
        strategies: list[Strategy],
        account_snapshot: Any,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        allocator = allocator_from_settings(account_snapshot.equity)
        for signal in batch.signals:
            decisions = self._evaluate_signal_decisions(
                signal,
                strategies,
                equity=account_snapshot.equity,
            )
            if not decisions:
                continue
            allocation_results = allocator.allocate(
                decisions,
                account=account,
                positions=positions,
                regime_label=_resolve_signal_regime(signal),
            )
            self._apply_allocation_results(
                session=session,
                allocation_results=allocation_results,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )

    def _evaluate_signal_decisions(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Decimal,
    ) -> list[StrategyDecision]:
        try:
            decisions = self.decision_engine.evaluate(signal, strategies, equity=equity)
            self.state.metrics.record_strategy_runtime(
                self.decision_engine.consume_runtime_telemetry()
            )
            for telemetry in self.decision_engine.consume_forecast_telemetry():
                self.state.metrics.record_forecast_telemetry(telemetry.to_payload())
            return decisions
        except Exception:
            logger.exception(
                "Decision evaluation failed symbol=%s timeframe=%s",
                signal.symbol,
                signal.timeframe,
            )
            return []

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
        market_session_open: bool,
    ) -> bool:
        if reason == "cursor_ahead_of_stream":
            return True
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
                symbol_allowlist=symbol_allowlist,
            )
            if not submitted:
                return None
            return decision
        except Exception as exc:
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
                self.executor.mark_rejected(
                    session,
                    decision_row,
                    reason_code,
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
        if self.executor.execution_exists(session, decision_row):
            self.state.metrics.planned_decisions_with_execution_total += 1
            logger.warning(
                "Decision remained planned while execution already exists decision_id=%s strategy_id=%s symbol=%s",
                decision_row.id,
                decision.strategy_id,
                decision.symbol,
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
        created_at = decision_row.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        age_seconds = int((datetime.now(timezone.utc) - created_at).total_seconds())
        if age_seconds < timeout_seconds:
            return False
        self.state.metrics.planned_decisions_stale_total += 1
        self.state.metrics.planned_decisions_timeout_rejected_total += 1
        self.state.metrics.orders_rejected_total += 1
        reason = f"decision_timeout_unsubmitted:{age_seconds}s"
        self.state.metrics.record_decision_rejection_reasons([reason])
        self.executor.mark_rejected(session, decision_row, reason)
        logger.error(
            "Rejected stale planned decision decision_id=%s strategy_id=%s symbol=%s age_seconds=%s timeout_seconds=%s",
            decision_row.id,
            decision.strategy_id,
            decision.symbol,
            age_seconds,
            timeout_seconds,
        )
        return True

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
        if str(gate_payload.get("source") or "").strip().lower() != "autonomy_gate_report":
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
        for reason in reasons:
            logger.info(log_template, decision.strategy_id, decision.symbol, reason)
        self.executor.mark_rejected(session, decision_row, ";".join(reasons))
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
            return False
        if not (
            settings.trading_emergency_stop_enabled and self.state.emergency_stop_active
        ):
            return True
        self.state.metrics.orders_rejected_total += 1
        reason = self.state.emergency_stop_reason or "emergency_stop_active"
        self.state.metrics.record_decision_rejection_reasons([reason])
        self.executor.mark_rejected(session, decision_row, reason)
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
        symbol_allowlist: set[str],
    ) -> bool:
        execution_client = self._execution_client_for_symbol(
            decision.symbol,
            symbol_allowlist=symbol_allowlist,
        )
        selected_adapter_name = self._execution_client_name(execution_client)
        self._maybe_record_lean_strategy_shadow(
            session=session,
            decision=decision,
            execution_client=execution_client,
            selected_adapter_name=selected_adapter_name,
        )
        self.state.metrics.record_execution_request(selected_adapter_name)
        self.executor.update_decision_params(
            session,
            decision_row,
            {
                "execution_adapter": {
                    "selected": selected_adapter_name,
                    "policy": settings.trading_execution_adapter_policy,
                    "symbol": decision.symbol,
                }
            },
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
            self.state.metrics.orders_submitted_total += 1
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
        self.state.metrics.orders_submitted_total += 1
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
            self.state.metrics.orders_rejected_total += 1
            self.state.metrics.record_decision_rejection_reasons([str(exc)])
            self.executor.mark_rejected(session, decision_row, str(exc))
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
        except Exception as exc:
            self.state.metrics.orders_rejected_total += 1
            self.state.metrics.record_decision_rejection_reasons(
                [f"order_submit_error_{type(exc).__name__}"]
            )
            payload = _extract_json_error_payload(exc) or {}
            existing_order_id = payload.get("existing_order_id")
            existing_order_code = str(payload.get("code") or "").strip().lower()
            existing_order_reason = str(payload.get("reject_reason") or "").strip().lower()
            if existing_order_id and (
                existing_order_code == "precheck_opposite_side_open_order"
                or "opposite side market/stop order exists" in existing_order_reason
            ):
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
            reason = _format_order_submit_rejection(exc)
            metadata_update = {"broker_precheck": payload} if payload else None
            self.executor.mark_rejected(
                session,
                decision_row,
                reason,
                metadata_update=metadata_update,
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
                "Order submission failed strategy_id=%s decision_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                exc,
            )
            return None, True

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
                    "policy": settings.trading_execution_adapter_policy,
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
        direct_action = _coerce_runtime_uncertainty_gate_action(
            params.get("uncertainty_gate_action")
        )
        if direct_action is not None:
            candidates.append(
                RuntimeUncertaintyGate(action=direct_action, source="decision_params")
            )

        runtime_payload = params.get("runtime_uncertainty_gate")
        if isinstance(runtime_payload, Mapping):
            runtime_map = cast(Mapping[str, Any], runtime_payload)
            runtime_staleness_reason = _uncertainty_gate_staleness_reason(
                "decision_runtime_payload", runtime_map
            )
            if runtime_staleness_reason is not None:
                candidates.append(
                    RuntimeUncertaintyGate(
                        action="abstain",
                        source="decision_runtime_payload_stale",
                        reason=runtime_staleness_reason,
                    )
                )
            else:
                runtime_action = _coerce_runtime_uncertainty_gate_action(
                    runtime_map.get("action")
                )
                if runtime_action is not None:
                    candidates.append(
                        RuntimeUncertaintyGate(
                            action=runtime_action,
                            source="decision_runtime_payload",
                        )
                    )

        forecast_audit = params.get("forecast_audit")
        if isinstance(forecast_audit, Mapping):
            audit_map = cast(Mapping[str, Any], forecast_audit)
            forecast_staleness_reason = _uncertainty_gate_staleness_reason(
                "forecast_audit", audit_map
            )
            if forecast_staleness_reason is not None:
                candidates.append(
                    RuntimeUncertaintyGate(
                        action="abstain",
                        source="forecast_audit_stale",
                        reason=forecast_staleness_reason,
                    )
                )
            else:
                audit_action = _coerce_runtime_uncertainty_gate_action(
                    audit_map.get("uncertainty_gate_action")
                )
                if audit_action is not None:
                    candidates.append(
                        RuntimeUncertaintyGate(
                            action=audit_action,
                            source="forecast_audit",
                        )
                    )

        gate_path_raw = self.state.last_autonomy_gates
        if gate_path_raw:
            try:
                payload = json.loads(Path(gate_path_raw).read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning(
                    "Failed to read autonomy gate report path=%s error=%s",
                    gate_path_raw,
                    exc,
                )
                candidates.append(
                    RuntimeUncertaintyGate(
                        action="abstain",
                        source="autonomy_gate_report_read_error",
                        reason="autonomy_gate_report_read_error",
                    )
                )
            else:
                if isinstance(payload, Mapping):
                    gate_map = cast(Mapping[str, Any], payload)
                    staleness_reason = _uncertainty_gate_staleness_reason(
                        "autonomy_gate_report", gate_map
                    )
                    if staleness_reason is not None:
                        candidates.append(
                            RuntimeUncertaintyGate(
                                action="abstain",
                                source="autonomy_gate_report_stale",
                                reason=staleness_reason,
                            )
                        )
                        return _select_strictest_runtime_uncertainty_gate(candidates)
                    gate_action = _coerce_runtime_uncertainty_gate_action(
                        gate_map.get("uncertainty_gate_action")
                    )
                    if gate_action is not None:
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
                        candidates.append(
                            RuntimeUncertaintyGate(
                                action=gate_action,
                                source=source,
                                coverage_error=coverage_error,
                                shift_score=shift_score,
                                conformal_interval_width=conformal_interval_width,
                                reason=reason,
                            )
                        )
                    else:
                        candidates.append(
                            RuntimeUncertaintyGate(
                                action="abstain",
                                source="autonomy_gate_report_missing_action",
                                reason="autonomy_gate_report_missing_action",
                            )
                        )
                else:
                    candidates.append(
                        RuntimeUncertaintyGate(
                            action="abstain",
                            source="autonomy_gate_report_invalid_payload",
                            reason="autonomy_gate_report_invalid_payload",
                        )
                    )
        if not candidates:
            candidates.append(
                RuntimeUncertaintyGate(
                    action="degrade", source="uncertainty_input_missing"
                )
            )
        return _select_strictest_runtime_uncertainty_gate(candidates)

    def _resolve_runtime_regime_gate(
        self, decision: StrategyDecision
    ) -> RuntimeUncertaintyGate:
        params = decision.params

        regime_gate = params.get("regime_gate")
        if regime_gate is not None:
            if isinstance(regime_gate, Mapping):
                gate_map = cast(Mapping[str, Any], regime_gate)
                gate_action = _coerce_runtime_uncertainty_gate_action(
                    gate_map.get("action")
                )
                if gate_action is not None:
                    return RuntimeUncertaintyGate(
                        action=gate_action,
                        source="decision_regime_gate",
                        regime_action_source="decision_regime_gate",
                        regime_label=(
                            str(gate_map.get("regime_label")).strip()
                            if gate_map.get("regime_label") is not None
                            else None
                        ),
                        regime_stale=_coerce_bool(gate_map.get("regime_stale")),
                        reason=(
                            str(gate_map.get("reason")).strip()
                            if gate_map.get("reason") is not None
                            else None
                        ),
                    )
                return RuntimeUncertaintyGate(
                    action="abstain",
                    source="decision_regime_gate_invalid_action",
                    regime_action_source="decision_regime_gate",
                    reason="decision_regime_gate_invalid_action",
                )
            return RuntimeUncertaintyGate(
                action="abstain",
                source="decision_regime_gate_unparseable",
                regime_action_source="decision_regime_gate",
                reason="decision_regime_gate_unparseable",
            )

        raw_regime_hmm = params.get("regime_hmm")
        if raw_regime_hmm is None:
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

        if not isinstance(raw_regime_hmm, Mapping):
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_unparseable",
                regime_action_source="regime_hmm_unparseable",
                reason="regime_hmm_unparseable_payload",
            )

        try:
            regime_context = resolve_hmm_context(
                cast(Mapping[str, Any], raw_regime_hmm)
            )
        except Exception as exc:
            logger.warning(
                "Failed to parse decision regime_hmm payload source=%s error=%s",
                params.get("strategy_id") or "strategy",
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
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_transition_shock",
                regime_action_source="regime_hmm",
                regime_label=regime_label,
                regime_stale=regime_stale,
                reason="regime_context_transition_shock",
            )
        if regime_stale:
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_stale",
                regime_action_source="regime_hmm",
                regime_label=regime_label,
                regime_stale=True,
                reason=(
                    regime_context.guardrail_reason or "regime_context_guardrail_stale"
                ),
            )
        if not regime_context.is_authoritative:
            source = (
                "regime_hmm_unknown_regime"
                if regime_context.authority_reason
                in {"invalid_regime_id", "missing_regime", "invalid_schema_version"}
                else "regime_hmm_non_authoritative"
            )
            regime_context_authority_reason = resolve_regime_context_authority_reason(
                regime_context
            )
            return RuntimeUncertaintyGate(
                action="abstain",
                source=source,
                regime_action_source="regime_hmm",
                regime_stale=regime_stale,
                reason=(
                    regime_fallback
                    if regime_fallback is not None
                    else regime_context_authority_reason
                    or "regime_hmm_non_authoritative"
                ),
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
        top_posterior_probability = self._extract_top_regime_posterior_probability(
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

    def _extract_top_regime_posterior_probability(
        self,
        posterior: Mapping[str, str],
    ) -> Decimal | None:
        top_probability = None
        for raw_probability in posterior.values():
            try:
                parsed_probability = Decimal(raw_probability)
            except (ArithmeticError, ValueError):
                continue
            if parsed_probability < 0 or parsed_probability > 1:
                continue
            if top_probability is None or parsed_probability > top_probability:
                top_probability = parsed_probability
        return top_probability

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
        *,
        symbol_allowlist: set[str] | None = None,
    ) -> Any:
        if adapter_enabled_for_symbol(symbol, allowlist=symbol_allowlist):
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
                return self._handle_llm_dspy_live_runtime_block(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    account=account,
                    positions=positions,
                    reason="llm_dspy_live_runtime_gate_blocked",
                    reject_reason="llm_runtime_fallback",
                    risk_flags=list(dspy_live_gate_reasons),
                    response_payload_extra={
                        "llm_runtime": {
                            "reject_reason": "llm_runtime_fallback",
                            "subtype": "dspy_live_runtime_gate",
                            "error": "llm_dspy_live_runtime_gate_blocked",
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
                return self._handle_llm_dspy_live_runtime_block(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    account=account,
                    positions=positions,
                    reason="llm_dspy_live_runtime_gate_blocked",
                    reject_reason="llm_runtime_fallback",
                    risk_flags=list(dspy_live_readiness_reasons),
                    response_payload_extra={
                        "llm_runtime": {
                            "reject_reason": "llm_runtime_fallback",
                            "subtype": "dspy_live_runtime_gate",
                            "error": "llm_dspy_live_runtime_gate_blocked",
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
        if reject_reason == "llm_runtime_fallback":
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
    def _bounded_degraded_qty(
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
        fractional_equities_enabled = fractional_equities_enabled_for_trade(
            action=decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=current_qty,
            requested_qty=scaled_qty,
        )
        quantized_qty = quantize_qty_for_symbol(
            decision.symbol,
            scaled_qty,
            fractional_equities_enabled=fractional_equities_enabled,
        )
        min_qty = min_qty_for_symbol(
            decision.symbol, fractional_equities_enabled=fractional_equities_enabled
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
            runtime_error = str(outcome.runtime_fallback.get("error") or "dspy_runtime_error")
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

    def _maybe_handle_market_context_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        market_context: Optional[MarketContextBundle],
        market_context_error: Optional[str],
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        market_context_status = evaluate_market_context(market_context)
        if market_context_error is not None:
            market_context_status = MarketContextStatus(
                allow_llm=False,
                reason="market_context_fetch_error",
                risk_flags=["market_context_fetch_error"],
            )
        if market_context_status.allow_llm:
            return None

        self.state.metrics.llm_market_context_block_total += 1
        market_context_shadow_mode = (
            guardrails.shadow_mode
            or settings.trading_market_context_fail_mode == "shadow_only"
        )
        self.state.metrics.record_market_context_result(
            market_context_status.reason,
            shadow_mode=market_context_shadow_mode,
        )
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason=market_context_status.reason or "market_context_unavailable",
            reject_reason="market_context_block",
            shadow_mode=market_context_shadow_mode,
            effective_fail_mode=guardrails.effective_fail_mode,
            risk_flags=market_context_status.risk_flags,
            market_context=market_context,
            response_payload_extra={
                "market_context": {
                    "reason": market_context_status.reason,
                    "risk_flags": list(market_context_status.risk_flags),
                }
            },
            policy_resolution=policy_resolution,
        )

    def _record_market_context_observation(
        self,
        *,
        symbol: str,
        market_context: Optional[MarketContextBundle],
        market_context_error: Optional[str],
    ) -> None:
        now = trading_now(account_label=self.account_label)
        self.state.last_market_context_symbol = symbol
        self.state.last_market_context_checked_at = now
        self.state.last_market_context_fetch_error = market_context_error
        if market_context is None:
            self.state.last_market_context_as_of = None
            self.state.last_market_context_freshness_seconds = None
            self.state.last_market_context_quality_score = None
            self.state.last_market_context_domain_states = {}
            self.state.last_market_context_risk_flags = []
            allow_llm = not settings.trading_market_context_required
            reason = (
                market_context_error
                or (
                    "market_context_required_missing"
                    if settings.trading_market_context_required
                    else None
                )
            )
            self.state.last_market_context_allow_llm = allow_llm
            self.state.last_market_context_reason = reason
            self.state.market_context_alert_active = market_context_error is not None or (
                settings.trading_market_context_required and not allow_llm
            )
            self.state.market_context_alert_reason = reason
            return

        market_context_status = evaluate_market_context(market_context)
        as_of = market_context.as_of_utc
        self.state.last_market_context_as_of = as_of
        self.state.last_market_context_freshness_seconds = int(
            market_context.freshness_seconds
        )
        self.state.last_market_context_quality_score = float(
            market_context.quality_score
        )
        self.state.last_market_context_domain_states = {
            "technicals": market_context.domains.technicals.state,
            "fundamentals": market_context.domains.fundamentals.state,
            "news": market_context.domains.news.state,
            "regime": market_context.domains.regime.state,
        }
        self.state.last_market_context_risk_flags = list(market_context.risk_flags)
        self.state.last_market_context_allow_llm = market_context_status.allow_llm
        self.state.last_market_context_reason = (
            market_context_error or market_context_status.reason
        )
        self.state.market_context_alert_active = market_context_error is not None or (
            not market_context_status.allow_llm
        )
        self.state.market_context_alert_reason = (
            market_context_error or market_context_status.reason
        )

    def _record_llm_verdict_counter(self, verdict: str) -> None:
        if verdict == "abstain":
            self.state.metrics.llm_abstain_total += 1
            return
        if verdict == "escalate":
            self.state.metrics.llm_escalate_total += 1

    def _build_llm_response_json(
        self,
        *,
        outcome: Any,
        policy_outcome: Any,
        guardrails: Any,
        policy_resolution: dict[str, Any],
    ) -> dict[str, Any]:
        response_json: dict[str, Any] = dict(outcome.response_json)
        response_json["advisory_only"] = True
        response_json["request_hash"] = outcome.request_hash
        response_json["response_hash"] = outcome.response_hash
        if policy_outcome.reason:
            response_json["policy_override"] = policy_outcome.reason
            response_json["policy_verdict"] = policy_outcome.verdict
            if "_fallback_" in policy_outcome.reason:
                self.state.metrics.llm_policy_fallback_total += 1
        if policy_outcome.guardrail_reasons:
            response_json["deterministic_guardrails"] = list(
                policy_outcome.guardrail_reasons
            )
        if guardrails.reasons:
            response_json["mrm_guardrails"] = list(guardrails.reasons)
        response_json["policy_resolution"] = policy_resolution
        response_json["guardrail_controls"] = _llm_guardrail_controls_snapshot()
        committee_veto = _committee_trace_has_veto(response_json)
        response_json["committee_veto_alignment"] = (
            _build_committee_veto_alignment_payload(
                committee_veto=committee_veto,
                deterministic_veto=policy_outcome.verdict == "veto",
            )
        )
        _attach_dspy_lineage(
            response_json,
            artifact_source="runtime_review",
        )
        return response_json

    def _record_llm_committee_metrics(self, response_json: Mapping[str, Any]) -> None:
        committee_payload = response_json.get("committee")
        if not isinstance(committee_payload, Mapping):
            return
        committee_roles = cast(Mapping[str, Any], committee_payload).get("roles", {})
        if not isinstance(committee_roles, Mapping):
            return
        for role, role_payload in cast(Mapping[str, Any], committee_roles).items():
            if not isinstance(role_payload, Mapping):
                continue
            role_data = cast(Mapping[str, Any], role_payload)
            self.state.metrics.record_llm_committee_member(
                role=str(role),
                verdict=str(role_data.get("verdict", "unknown")),
                latency_ms=_optional_int(role_data.get("latency_ms")),
                schema_error=bool(role_data.get("schema_error", False)),
            )

    def _record_llm_token_metrics(self, outcome: Any) -> None:
        if outcome.tokens_prompt is not None:
            self.state.metrics.llm_tokens_prompt_total += outcome.tokens_prompt
        if outcome.tokens_completion is not None:
            self.state.metrics.llm_tokens_completion_total += outcome.tokens_completion

    def _apply_llm_policy_verdict(
        self,
        *,
        session: Session,
        decision_row: TradeDecision,
        policy_outcome: Any,
    ) -> tuple[Optional[Decimal], Optional[str]]:
        if policy_outcome.verdict == "adjust":
            self.state.metrics.llm_adjust_total += 1
            adjusted_qty = Decimal(str(policy_outcome.decision.qty))
            adjusted_order_type = policy_outcome.decision.order_type
            self._persist_llm_adjusted_decision(
                session, decision_row, policy_outcome.decision
            )
            return adjusted_qty, adjusted_order_type
        if policy_outcome.verdict == "approve":
            self.state.metrics.llm_approve_total += 1
            return None, None
        if policy_outcome.verdict == "veto":
            self.state.metrics.llm_veto_total += 1
            if policy_outcome.reason == "llm_policy_veto":
                self.state.metrics.llm_policy_veto_total += 1
        return None, None

    def _finalize_llm_review_outcome(
        self,
        *,
        decision: StrategyDecision,
        outcome: Any,
        policy_outcome: Any,
        guardrails: Any,
    ) -> tuple[StrategyDecision, Optional[str]]:
        committee_veto = _committee_trace_has_veto(outcome.response_json)
        if committee_veto:
            self.state.metrics.record_llm_committee_veto_alignment(
                committee_veto=True,
                deterministic_veto=policy_outcome.verdict == "veto",
            )
        if guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if policy_outcome.verdict != "veto":
            return policy_outcome.decision, None
        return decision, policy_outcome.reason or "llm_policy_veto"

    def _handle_llm_review_error(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
        request_json: dict[str, Any],
        error: Exception,
    ) -> tuple[StrategyDecision, Optional[str]]:
        self.state.metrics.llm_error_total += 1
        unsupported_state_error = isinstance(error, DSPyRuntimeUnsupportedStateError)
        if not unsupported_state_error:
            engine.circuit_breaker.record_error()
        if unsupported_state_error:
            policy_resolution = _build_llm_policy_resolution(
                rollout_stage=guardrails.rollout_stage,
                effective_fail_mode="veto",
                guardrail_reasons=guardrails.reasons,
            )
        error_label = _classify_llm_error(error)
        if error_label == "llm_response_not_json":
            self.state.metrics.llm_parse_error_total += 1
        elif error_label == "llm_response_invalid":
            self.state.metrics.llm_validation_error_total += 1

        fallback = (
            "veto"
            if unsupported_state_error
            else self._resolve_llm_fallback(guardrails.effective_fail_mode)
        )
        effective_verdict = "veto" if fallback == "veto" else "approve"
        if not request_json:
            request_json = {"decision": decision.model_dump(mode="json")}
        response_json: dict[str, Any] = {
            "error": str(error),
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "policy_resolution": policy_resolution,
            "guardrail_controls": _llm_guardrail_controls_snapshot(),
            "advisory_only": True,
        }
        if guardrails.reasons:
            response_json["mrm_guardrails"] = list(guardrails.reasons)
        response_json["request_hash"] = _hash_payload(request_json)
        response_json["response_hash"] = _hash_payload(response_json)
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=self._llm_runtime_model_identifier(),
            prompt_version=self._llm_runtime_prompt_identifier(),
            request_json=request_json,
            response_json=response_json,
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=f"llm_error_{fallback}",
            risk_flags=[type(error).__name__] + list(guardrails.reasons),
            tokens_prompt=None,
            tokens_completion=None,
        )
        if unsupported_state_error:
            logger.warning(
                "Unsupported DSPy runtime state; vetoing decision_id=%s error=%s",
                decision_row.id,
                error,
            )
            return decision, "llm_unavailable_dspy_runtime_unsupported_state"
        if guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            logger.warning(
                "LLM review failed; vetoing decision_id=%s error=%s",
                decision_row.id,
                error,
            )
            return decision, _resolve_llm_review_error_reject_reason(error)
        logger.warning(
            "LLM review failed; pass-through decision_id=%s error=%s",
            decision_row.id,
            error,
        )
        return decision, None

    def _handle_llm_unavailable(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        reason: str,
        shadow_mode: bool,
        effective_fail_mode: Optional[str] = None,
        risk_flags: Optional[list[str]] = None,
        market_context: Optional[MarketContextBundle] = None,
        reject_reason: Optional[str] = None,
        response_payload_extra: Optional[dict[str, Any]] = None,
        policy_resolution: Optional[dict[str, Any]] = None,
    ) -> tuple[StrategyDecision, Optional[str]]:
        fallback = self._resolve_llm_fallback(effective_fail_mode)
        effective_verdict = "veto" if fallback == "veto" else "approve"
        reject_reason = (
            _resolve_llm_unavailable_reject_reason(reason)
            if fallback == "veto" and not shadow_mode
            else None
        )
        self.state.metrics.record_llm_unavailable(
            reason=reason, reject_reason=reject_reason
        )
        portfolio_snapshot = _build_portfolio_snapshot(account, positions)
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = _load_recent_decisions(
            session,
            decision.strategy_id,
            decision.symbol,
        )
        if self.llm_review_engine is not None:
            request_payload = self.llm_review_engine.build_request(
                decision=decision,
                account=account,
                positions=positions,
                portfolio=portfolio_snapshot,
                market=market_snapshot,
                market_context=market_context,
                recent_decisions=recent_decisions,
            ).model_dump(mode="json")
        else:
            request_payload = {
                "decision": decision.model_dump(mode="json"),
                "portfolio": portfolio_snapshot.model_dump(mode="json"),
                "market": market_snapshot.model_dump(mode="json")
                if market_snapshot is not None
                else None,
                "market_context": market_context.model_dump(mode="json")
                if market_context is not None
                else None,
                "recent_decisions": [
                    summary.model_dump(mode="json") for summary in recent_decisions
                ],
                "account": account,
                "positions": positions,
                "policy": {
                    "adjustment_allowed": settings.llm_adjustment_allowed,
                    "min_qty_multiplier": str(settings.llm_min_qty_multiplier),
                    "max_qty_multiplier": str(settings.llm_max_qty_multiplier),
                    "allowed_order_types": sorted(
                        allowed_order_types(decision.order_type)
                    ),
                },
                "trading_mode": settings.trading_mode,
                "prompt_version": f"dspy:{settings.llm_dspy_signature_version}",
            }
        response_payload = {
            "error": reason,
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "reject_reason": reject_reason,
            "policy_resolution": policy_resolution
            or _build_llm_policy_resolution(
                rollout_stage=_normalize_rollout_stage(settings.llm_rollout_stage),
                effective_fail_mode=fallback,
                guardrail_reasons=risk_flags or [],
            ),
            "advisory_only": True,
        }
        if response_payload_extra:
            response_payload.update(response_payload_extra)
        decision_metadata_update: dict[str, Any] = {}
        if response_payload_extra:
            llm_runtime_payload = response_payload_extra.get("llm_runtime")
            if isinstance(llm_runtime_payload, Mapping):
                decision_metadata_update["llm_runtime"] = dict(
                    cast(Mapping[str, Any], llm_runtime_payload)
                )
            market_context_payload = response_payload_extra.get("market_context")
            if isinstance(market_context_payload, Mapping):
                decision_metadata_update["market_context"] = dict(
                    cast(Mapping[str, Any], market_context_payload)
                )
        if decision_metadata_update:
            self.executor.update_decision_json(
                session,
                decision_row,
                decision_metadata_update,
            )
        response_payload["request_hash"] = _hash_payload(request_payload)
        response_payload["response_hash"] = _hash_payload(response_payload)
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=self._llm_runtime_model_identifier(),
            prompt_version=self._llm_runtime_prompt_identifier(),
            request_json=request_payload,
            response_json={
                **response_payload,
                "guardrail_controls": _llm_guardrail_controls_snapshot(),
            },
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=reason,
            risk_flags=[reason] + (risk_flags or []),
            tokens_prompt=None,
            tokens_completion=None,
        )
        if shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            return decision, reject_reason or "llm_unavailable_unknown"
        return decision, None

    def _build_market_snapshot(
        self, decision: StrategyDecision
    ) -> Optional[LLMMarketSnapshot]:
        params = decision.params or {}
        price = params.get("price") or params.get("close")
        spread: Optional[Any] = None
        source = "decision_params"
        snapshot_payload = params.get("price_snapshot")
        if price is None and isinstance(snapshot_payload, Mapping):
            snapshot_data = cast(Mapping[str, Any], snapshot_payload)
            price = snapshot_data.get("price")
            if spread is None:
                spread = snapshot_data.get("spread")
            payload_source = snapshot_data.get("source")
            if payload_source is not None:
                source = str(payload_source)
        imbalance = params.get("imbalance")
        if isinstance(imbalance, Mapping):
            imbalance_data = cast(Mapping[str, Any], imbalance)
            spread = imbalance_data.get("spread")
        snapshot = None
        if price is not None:
            snapshot = MarketSnapshot(
                symbol=decision.symbol,
                as_of=decision.event_ts,
                price=_optional_decimal(price),
                spread=_optional_decimal(spread),
                source=source,
            )
        else:
            snapshot = self.price_fetcher.fetch_market_snapshot(
                SignalEnvelope(
                    event_ts=decision.event_ts,
                    symbol=decision.symbol,
                    payload={},
                    timeframe=decision.timeframe,
                )
            )
        if snapshot is None:
            return None
        return LLMMarketSnapshot(
            symbol=snapshot.symbol,
            as_of=snapshot.as_of,
            price=snapshot.price,
            spread=snapshot.spread,
            source=snapshot.source,
        )

    @staticmethod
    def _resolve_pre_llm_executability_reject(
        decision: StrategyDecision,
    ) -> Optional[str]:
        portfolio_sizing = decision.params.get("portfolio_sizing")
        if not isinstance(portfolio_sizing, Mapping):
            return None
        portfolio_sizing_mapping = cast(Mapping[str, Any], portfolio_sizing)
        output = portfolio_sizing_mapping.get("output")
        if not isinstance(output, Mapping):
            return None
        output_mapping = cast(Mapping[str, Any], output)

        limiting_constraint = str(output_mapping.get("limiting_constraint") or "").strip()
        caps = output_mapping.get("caps")
        per_symbol_cap = None
        if isinstance(caps, Mapping):
            per_symbol_cap = _optional_decimal(
                cast(Mapping[str, Any], caps).get("per_symbol")
            )
        if limiting_constraint == "symbol_capacity_exhausted" or (
            per_symbol_cap is not None and per_symbol_cap <= 0
        ):
            return "symbol_capacity_exhausted"

        fractional_allowed = output_mapping.get("fractional_allowed")
        final_qty = _optional_decimal(output_mapping.get("final_qty"))
        min_executable_qty = _optional_decimal(output_mapping.get("min_executable_qty"))
        if (
            fractional_allowed is False
            and final_qty is not None
            and final_qty <= 0
            and min_executable_qty == Decimal("1")
        ):
            return "qty_below_min"

        return None

    def _ensure_decision_price(
        self, decision: StrategyDecision, signal_price: Any
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]]:
        if signal_price is not None and "price_snapshot" in decision.params:
            return decision, None
        snapshot = self.price_fetcher.fetch_market_snapshot(
            SignalEnvelope(
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                payload={},
                timeframe=decision.timeframe,
            )
        )
        if snapshot is None or snapshot.price is None:
            return decision, None
        updated_params = dict(decision.params)
        if signal_price is None:
            updated_params["price"] = snapshot.price
        updated_params["price_snapshot"] = _price_snapshot_payload(snapshot)
        if snapshot.spread is not None and "spread" not in updated_params:
            updated_params["spread"] = snapshot.spread
        return decision.model_copy(update={"params": updated_params}), snapshot

    @staticmethod
    def _resolve_llm_fallback(effective_fail_mode: Optional[str] = None) -> str:
        if effective_fail_mode in {"veto", "pass_through"}:
            return effective_fail_mode
        return settings.llm_effective_fail_mode()

    @staticmethod
    def _llm_runtime_model_identifier() -> str:
        return f"dspy:{settings.llm_dspy_program_name}"

    @staticmethod
    def _llm_runtime_prompt_identifier() -> str:
        return f"dspy:{settings.llm_dspy_signature_version}"

    def _fetch_market_context(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> tuple[Optional[MarketContextBundle], Optional[str]]:
        try:
            return self.market_context_client.fetch(symbol, as_of=as_of), None
        except Exception as exc:
            logger.warning(
                "market context fetch failed symbol=%s error=%s", symbol, exc
            )
            return None, str(exc)

    def _get_account_snapshot(self, session: Session):
        now = datetime.now(timezone.utc)
        snapshot_ttl = timedelta(milliseconds=settings.trading_reconcile_ms)
        if self._snapshot_cache and self._snapshot_cached_at:
            if now - self._snapshot_cached_at < snapshot_ttl:
                return self._snapshot_cache
        # Reuse snapshots within the reconcile interval to reduce Alpaca and DB churn.
        snapshot = snapshot_account_and_positions(
            session, self.alpaca_client, self.account_label
        )
        self._snapshot_cache = snapshot
        self._snapshot_cached_at = now
        return snapshot

    @staticmethod
    def _persist_llm_review(
        session: Session,
        decision_row: TradeDecision,
        model: str,
        prompt_version: str,
        request_json: dict[str, Any],
        response_json: dict[str, Any],
        verdict: str,
        confidence: Optional[float],
        adjusted_qty: Optional[Decimal],
        adjusted_order_type: Optional[str],
        rationale: Optional[str],
        risk_flags: list[str],
        tokens_prompt: Optional[int],
        tokens_completion: Optional[int],
    ) -> None:
        request_payload = coerce_json_payload(request_json)
        response_payload_json = dict(response_json)
        _attach_dspy_lineage(
            response_payload_json,
            artifact_source="runtime_persisted_review",
        )
        if not isinstance(
            response_payload_json.get("committee_veto_alignment"), Mapping
        ):
            response_payload_json["committee_veto_alignment"] = (
                _build_committee_veto_alignment_payload(
                    committee_veto=_committee_trace_has_veto(response_payload_json),
                    deterministic_veto=verdict == "veto",
                )
            )
        response_payload = coerce_json_payload(response_payload_json)
        risk_payload = coerce_json_payload(risk_flags)
        review = LLMDecisionReview(
            trade_decision_id=decision_row.id,
            model=model,
            prompt_version=prompt_version,
            input_json=request_payload,
            response_json=response_payload,
            verdict=verdict,
            confidence=Decimal(str(confidence)) if confidence is not None else None,
            adjusted_qty=adjusted_qty,
            adjusted_order_type=adjusted_order_type,
            rationale=rationale,
            risk_flags=risk_payload,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
        )
        session.add(review)
        session.commit()

    @staticmethod
    def _persist_llm_adjusted_decision(
        session: Session,
        decision_row: TradeDecision,
        decision: StrategyDecision,
    ) -> None:
        decision_json = _coerce_json(decision_row.decision_json)
        decision_json["llm_adjusted_decision"] = coerce_json_payload(
            decision.model_dump(mode="json")
        )
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()


__all__ = ["TradingPipeline"]

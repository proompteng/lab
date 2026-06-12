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


class _TradingPipelineMethodsPart1:
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
        if self.decision_engine.price_fetcher is None:
            self.decision_engine.price_fetcher = self.price_fetcher
        self._snapshot_cache = None
        self._snapshot_cached_at: Optional[datetime] = None
        self.strategy_catalog = strategy_catalog
        self.execution_policy = execution_policy or ExecutionPolicy()
        self.order_feed_ingestor = order_feed_ingestor or OrderFeedIngestor()
        self.market_context_client = MarketContextClient()
        self.lean_lane_manager = LeanLaneManager()
        self.llm_review_engine = llm_review_engine
        self._last_live_submission_gate: dict[str, object] | None = None
        self._signal_quote_quality = SignalQuoteQualityTracker(
            policy=QuoteQualityPolicy(
                max_executable_spread_bps=settings.trading_signal_max_executable_spread_bps,
                max_quote_mid_jump_bps=settings.trading_signal_max_quote_mid_jump_bps,
                max_jump_with_wide_spread_bps=settings.trading_signal_max_jump_with_wide_spread_bps,
            )
        )
        self._session_context_warmup_day: date | None = None
        self._runtime_window_account_snapshot_day: date | None = None

    def run_once(self) -> None:
        self._label_mature_rejected_signal_outcome_events()
        with self.session_factory() as session:
            self.state.metrics.planned_decision_age_seconds = 0
            strategies = self._prepare_run_once(session)
            if not strategies:
                return
            self._capture_runtime_window_account_snapshot_if_due(session)
            self._warm_session_context_from_open(session, strategies=strategies)

            batch = self.ingestor.fetch_signals(session)
            self._record_ingest_window(batch)
            if not batch.signals:
                if not self._prepare_batch_for_decisions(
                    session, batch, quality_signals=batch.signals
                ):
                    return
            context = self._build_run_context(session)
            if context is None:
                self.ingestor.commit_cursor(session, batch)
                return
            account_snapshot, account, positions, allowed_symbols = context
            quality_signals = self._quality_gate_signals(
                signals=batch.signals,
                strategies=strategies,
                allowed_symbols=allowed_symbols,
            )
            if not self._prepare_batch_for_decisions(
                session,
                batch,
                quality_signals=quality_signals,
            ):
                return
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

    def _warm_session_context_from_open(
        self,
        session: Session,
        *,
        strategies: Sequence[Strategy] | None = None,
        allowed_symbols: set[str] | None = None,
    ) -> None:
        fetch_with_reason = getattr(self.ingestor, "fetch_signals_with_reason", None)
        get_cursor = getattr(self.ingestor, "_get_cursor", None)
        if not callable(fetch_with_reason) or not callable(get_cursor):
            return

        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        session_open = regular_session_open_utc_for(now)
        session_day = session_open.date()
        if self._session_context_warmup_day == session_day:
            return

        if now < session_open:
            return

        try:
            cursor_at, _cursor_seq, _cursor_symbol = cast(
                tuple[datetime, Optional[int], Optional[str]],
                get_cursor(session),
            )
        except Exception:
            logger.exception("Failed to read trade cursor for session context warmup")
            return
        try:
            session.commit()
        except Exception:
            session.rollback()
            logger.exception(
                "Failed to close trade-cursor transaction before session context warmup"
            )
            return
        if cursor_at.tzinfo is None:
            cursor_at = cursor_at.replace(tzinfo=timezone.utc)
        cursor_at = cursor_at.astimezone(timezone.utc)
        warmup_end = min(cursor_at, now)
        if warmup_end <= session_open:
            return
        max_warmup_seconds = max(
            1, int(settings.trading_session_context_warmup_max_seconds)
        )
        warmup_start = max(
            session_open,
            warmup_end - timedelta(seconds=max_warmup_seconds),
        )
        max_warmup_signals = max(
            1, int(settings.trading_session_context_warmup_max_signals)
        )
        warmup_signal_limit = max(
            1,
            int(settings.trading_session_context_warmup_signal_limit),
        )
        warmup_limit = min(warmup_signal_limit, max_warmup_signals)
        try:
            warmup_batch = cast(
                SignalBatch,
                fetch_with_reason(
                    start=warmup_start,
                    end=warmup_end,
                    limit=warmup_limit,
                ),
            )
        except Exception:
            logger.exception(
                "Failed to fetch session context warmup signals start=%s end=%s",
                warmup_start.isoformat(),
                warmup_end.isoformat(),
            )
            return

        relevant_symbols = self._relevant_signal_symbols(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        warmed = 0
        for signal in warmup_batch.signals:
            if (
                relevant_symbols
                and _normalized_symbol(signal.symbol) not in relevant_symbols
            ):
                continue
            try:
                warmed_signal = self._ensure_signal_executable_price(signal)
                self._signal_quote_quality.assess(warmed_signal)
                self.decision_engine.observe_signal(warmed_signal)
                warmed += 1
            except Exception:
                logger.debug(
                    "Skipping session context warmup signal symbol=%s ts=%s",
                    signal.symbol,
                    signal.event_ts,
                    exc_info=True,
                )
        self._session_context_warmup_day = session_day
        logger.info(
            "Session context warmup complete account=%s start=%s end=%s limit=%s signals=%s max_seconds=%s max_signals=%s",
            self.account_label,
            warmup_start.isoformat(),
            warmup_end.isoformat(),
            warmup_limit,
            warmed,
            max_warmup_seconds,
            max_warmup_signals,
        )

    def _capture_runtime_window_account_snapshot_if_due(self, session: Session) -> None:
        if not (
            settings.trading_simple_paper_route_probe_enabled
            or str(settings.trading_paper_route_target_plan_url or "").strip()
        ):
            return

        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        session_open = regular_session_open_utc_for(now)
        session_day = session_open.date()
        if self._runtime_window_account_snapshot_day == session_day:
            return

        capture_start = session_open - timedelta(
            seconds=PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS
        )
        capture_end = session_open + timedelta(
            seconds=PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS
        )
        if now < capture_start or now > capture_end:
            return

        existing_snapshot = session.execute(
            select(PositionSnapshot.id)
            .where(PositionSnapshot.alpaca_account_label == self.account_label)
            .where(PositionSnapshot.as_of >= capture_start)
            .where(PositionSnapshot.as_of <= capture_end)
            .limit(1)
        ).first()
        if existing_snapshot is not None:
            self._runtime_window_account_snapshot_day = session_day
            return

        try:
            snapshot = self._get_account_snapshot(session)
        except Exception:
            session.rollback()
            logger.exception(
                "Failed to capture runtime-window account snapshot account=%s window_start=%s window_end=%s",
                self.account_label,
                capture_start.isoformat(),
                capture_end.isoformat(),
            )
            return

        self._runtime_window_account_snapshot_day = session_day
        logger.info(
            "Captured runtime-window account snapshot account=%s snapshot_id=%s as_of=%s window_start=%s window_end=%s",
            self.account_label,
            getattr(snapshot, "id", None),
            getattr(snapshot, "as_of", None),
            capture_start.isoformat(),
            capture_end.isoformat(),
        )

    def _record_ingest_window(self, batch: SignalBatch) -> None:
        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason

    def _prepare_batch_for_decisions(
        self,
        session: Session,
        batch: SignalBatch,
        *,
        quality_signals: list[SignalEnvelope],
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
                quality_signals, thresholds=quality_thresholds
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
                self.state.metrics.record_feature_quality_rejection(
                    quality_report.reasons
                )
                failure_payload = self._feature_quality_failure_payload(
                    batch=batch,
                    quality_signals=quality_signals,
                    quality_report=quality_report,
                )
                if quality_report.blocking_reasons:
                    staleness_only_block = set(quality_report.blocking_reasons) == {
                        REASON_STALENESS
                    }
                    if not staleness_only_block:
                        self.state.metrics.record_feature_quality_cursor_commit_blocked(
                            quality_report.blocking_reasons
                        )
                    logger.error(
                        "Feature quality gate failed component=%s account_label=%s rows=%s reasons=%s "
                        "cursor_at=%s cursor_symbol=%s cursor_seq=%s staleness_ms_p95=%s duplicate_ratio=%s "
                        "sample=%s",
                        failure_payload["component"],
                        failure_payload["account_label"],
                        quality_report.rows_total,
                        quality_report.reasons,
                        failure_payload["cursor_at"],
                        failure_payload["cursor_symbol"],
                        failure_payload["cursor_seq"],
                        quality_report.staleness_ms_p95,
                        quality_report.duplicate_ratio,
                        failure_payload["sample_rows"],
                    )
                    if staleness_only_block:
                        logger.warning(
                            "Skipping stale feature batch and advancing cursor without decisions "
                            "component=%s account_label=%s cursor_at=%s cursor_symbol=%s cursor_seq=%s",
                            failure_payload["component"],
                            failure_payload["account_label"],
                            failure_payload["cursor_at"],
                            failure_payload["cursor_symbol"],
                            failure_payload["cursor_seq"],
                        )
                        self.ingestor.commit_cursor(session, batch)
                    return False

                logger.warning(
                    "Feature quality degradation observed component=%s account_label=%s rows=%s reasons=%s "
                    "cursor_at=%s cursor_symbol=%s cursor_seq=%s staleness_ms_p95=%s duplicate_ratio=%s "
                    "sample=%s",
                    failure_payload["component"],
                    failure_payload["account_label"],
                    quality_report.rows_total,
                    quality_report.reasons,
                    failure_payload["cursor_at"],
                    failure_payload["cursor_symbol"],
                    failure_payload["cursor_seq"],
                    quality_report.staleness_ms_p95,
                    quality_report.duplicate_ratio,
                    failure_payload["sample_rows"],
                )
        else:
            self.state.metrics.feature_batch_rows_total += len(quality_signals)

        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.signal_lag_seconds = (
            int(batch.signal_lag_seconds)
            if batch.signal_lag_seconds is not None
            else None
        )
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

    def _quality_gate_signals(
        self,
        *,
        signals: list[SignalEnvelope],
        strategies: list[Strategy],
        allowed_symbols: set[str],
    ) -> list[SignalEnvelope]:
        relevant_symbols = self._relevant_signal_symbols(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        if not relevant_symbols:
            return signals
        filtered = [
            signal
            for signal in signals
            if _normalized_symbol(signal.symbol) in relevant_symbols
        ]
        return filtered

    def _relevant_signal_symbols(
        self,
        *,
        strategies: Sequence[Strategy] | None,
        allowed_symbols: set[str] | None,
    ) -> set[str]:
        if strategies is None:
            return set()
        normalized_allowed_symbols = {
            _normalized_symbol(symbol)
            for symbol in (
                allowed_symbols
                if allowed_symbols is not None
                else self.universe_resolver.get_resolution().symbols
            )
            if _normalized_symbol(symbol)
        }
        relevant_symbols: set[str] = set()
        for strategy in strategies:
            if not strategy.enabled:
                continue
            strategy_symbols = {
                _normalized_symbol(symbol)
                for symbol in _coerce_strategy_symbols(strategy.universe_symbols)
                if _normalized_symbol(symbol)
            }
            if strategy_symbols and normalized_allowed_symbols:
                relevant_symbols.update(strategy_symbols & normalized_allowed_symbols)
            elif strategy_symbols:
                relevant_symbols.update(strategy_symbols)
            else:
                relevant_symbols.update(normalized_allowed_symbols)
        return relevant_symbols

    def _build_run_context(
        self, session: Session
    ) -> tuple[Any, dict[str, str], list[dict[str, Any]], set[str]] | None:
        account_snapshot = self._get_account_snapshot(session)
        account = {
            "equity": str(account_snapshot.equity),
            "cash": str(account_snapshot.cash),
            "buying_power": str(account_snapshot.buying_power),
        }
        snapshot_positions = _clone_positions(account_snapshot.positions)
        positions = self._resolve_execution_context_positions(
            snapshot_positions,
            session=session,
        )

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

    def _resolve_execution_context_positions(
        self,
        snapshot_positions: list[dict[str, Any]],
        *,
        session: Session | None = None,
    ) -> list[dict[str, Any]]:
        normalized_positions = _clone_positions(snapshot_positions)
        seed_snapshot = getattr(self.execution_adapter, "seed_positions_snapshot", None)
        if callable(seed_snapshot):
            try:
                seed_snapshot(_clone_positions(snapshot_positions))
            except Exception as exc:
                logger.warning(
                    "Failed to seed simulation execution positions account=%s error=%s",
                    self.account_label,
                    exc,
                )
            else:
                list_positions = getattr(self.execution_adapter, "list_positions", None)
                if callable(list_positions):
                    try:
                        seeded_positions = list_positions()
                    except Exception as exc:
                        logger.warning(
                            "Failed to read simulation execution positions account=%s error=%s",
                            self.account_label,
                            exc,
                        )
                    else:
                        if isinstance(seeded_positions, list):
                            normalized_positions: list[dict[str, Any]] = []
                            for raw_position in cast(list[Any], seeded_positions):
                                if not isinstance(raw_position, Mapping):
                                    continue
                                normalized_positions.append(
                                    {
                                        str(key): value
                                        for key, value in cast(
                                            Mapping[object, Any], raw_position
                                        ).items()
                                    }
                                )
        projected_open_orders = self._resolve_execution_context_open_orders()
        if projected_open_orders:
            projected_count = _project_open_orders_onto_positions(
                normalized_positions,
                projected_open_orders,
            )
            if projected_count > 0:
                logger.info(
                    "Projected open-order exposure into execution context account=%s orders=%s",
                    self.account_label,
                    projected_count,
                )
        if session is not None:
            normalized_positions = self._attach_current_session_strategy_position_tags(
                session,
                normalized_positions,
            )
        return normalized_positions

    def _attach_current_session_strategy_position_tags(
        self,
        session: Session,
        positions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not positions:
            return positions
        session_open = regular_session_open_utc_for(
            trading_now(account_label=self.account_label).astimezone(timezone.utc)
        )
        lookback_start = session_open - _STRATEGY_POSITION_TAG_LOOKBACK
        try:
            rows = session.execute(
                select(Execution, TradeDecision)
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == self.account_label,
                    TradeDecision.alpaca_account_label == self.account_label,
                    Execution.status == "filled",
                    Execution.filled_qty > Decimal("0"),
                    Execution.created_at >= lookback_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to resolve strategy position tags account=%s",
                self.account_label,
            )
            return positions

        exposures: dict[str, dict[str, dict[str, Any]]] = {}
        for execution, decision_row in rows:
            symbol = _normalized_symbol(execution.symbol or decision_row.symbol)
            strategy_id = str(decision_row.strategy_id)
            if not symbol or not strategy_id:
                continue
            execution_created_at = _aware_utc(execution.created_at)
            filled_qty = _optional_decimal(execution.filled_qty)
            if filled_qty is None or filled_qty <= 0:
                continue
            side = str(execution.side or "").strip().lower()
            if side not in {"buy", "sell"}:
                continue
            signed_qty = filled_qty if side == "buy" else -filled_qty
            strategy_exposures = exposures.setdefault(symbol, {})
            exposure = strategy_exposures.setdefault(
                strategy_id,
                {
                    "qty": Decimal("0"),
                    "buy_qty": Decimal("0"),
                    "buy_notional": Decimal("0"),
                    "session_qty": Decimal("0"),
                    "latest_execution_at": None,
                    "earliest_execution_at": None,
                },
            )
            exposure["qty"] = cast(Decimal, exposure["qty"]) + signed_qty
            if execution_created_at >= session_open:
                exposure["session_qty"] = (
                    cast(Decimal, exposure["session_qty"]) + signed_qty
                )
            avg_fill_price = _optional_decimal(execution.avg_fill_price)
            if side == "buy" and avg_fill_price is not None and avg_fill_price > 0:
                exposure["buy_qty"] = cast(Decimal, exposure["buy_qty"]) + filled_qty
                exposure["buy_notional"] = cast(
                    Decimal,
                    exposure["buy_notional"],
                ) + (filled_qty * avg_fill_price)
            earliest_execution_at = exposure.get("earliest_execution_at")
            if (
                earliest_execution_at is None
                or execution_created_at < earliest_execution_at
            ):
                exposure["earliest_execution_at"] = execution_created_at
            latest_execution_at = exposure.get("latest_execution_at")
            if (
                latest_execution_at is None
                or execution_created_at > latest_execution_at
            ):
                exposure["latest_execution_at"] = execution_created_at

        if not exposures:
            return positions

        tagged_positions: list[dict[str, Any]] = []
        for position in positions:
            tagged_positions.extend(
                self._attach_strategy_position_tags(
                    position,
                    exposures=exposures,
                    session_open=session_open,
                )
            )
        return tagged_positions

    @staticmethod
    def _same_side_position_exposure(
        position_qty: Decimal,
        exposure_qty: Decimal,
    ) -> bool:
        if position_qty == 0 or exposure_qty == 0:
            return False
        return (position_qty > 0 and exposure_qty > 0) or (
            position_qty < 0 and exposure_qty < 0
        )

    @staticmethod
    def _attach_strategy_position_tag(
        position: dict[str, Any],
        *,
        exposures: Mapping[str, Mapping[str, Mapping[str, Any]]],
        session_open: datetime,
    ) -> dict[str, Any]:
        tagged_positions = TradingPipeline._attach_strategy_position_tags(
            position,
            exposures=exposures,
            session_open=session_open,
        )
        if len(tagged_positions) == 1:
            return tagged_positions[0]
        return position


__all__ = [name for name in globals() if not name.startswith("__")]

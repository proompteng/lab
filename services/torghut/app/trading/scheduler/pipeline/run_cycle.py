"""Trading pipeline implementation."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, Sequence, cast

from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

from ....config import settings
from ....db import SessionLocal
from ....models import Strategy
from ...broker_account_activities import BrokerAccountActivityError
from ...broker_account_activity_backfill import BrokerAccountActivityIngestor
from ...execution_policy import ExecutionPolicy
from ...feature_quality import (
    REASON_STALENESS,
    FeatureQualityThresholds,
    evaluate_feature_batch_quality,
)
from ...ingest import SignalBatch
from ...lean_lanes import LeanLaneManager
from ...market_context import (
    MarketContextClient,
)
from ...models import SignalEnvelope
from ...order_feed import OrderFeedIngestor
from ...prices import ClickHousePriceFetcher
from ...quote_quality import (
    QuoteQualityPolicy,
    SignalQuoteQualityTracker,
)
from ...session_context import regular_session_open_utc_for
from ...time_source import trading_now
from ..safety import (
    latch_signal_continuity_alert_state,
    record_signal_continuity_recovery_cycle,
)
from ..capital_controls import CapitalSafetyController


from .contexts import (
    BatchSignalProcessingContext,
    SessionWarmupWindow,
    TradingPipelineRuntimeDependencies,
)
from .position_exposure import TradingPipelinePositionExposureMixin
from .shared import STRATEGY_POSITION_TAG_LOOKBACK, normalized_symbol
from .support import (
    clone_positions,
    coerce_strategy_symbols,
    project_open_orders_onto_positions,
)

logger = logging.getLogger(__name__)


class TradingPipelineRunCycleMixin(TradingPipelinePositionExposureMixin):
    def __init__(
        self,
        dependencies: TradingPipelineRuntimeDependencies | None = None,
        *,
        alpaca_client: Any | None = None,
        order_firewall: Any | None = None,
        ingestor: Any | None = None,
        decision_engine: Any | None = None,
        risk_engine: Any | None = None,
        executor: Any | None = None,
        execution_adapter: Any | None = None,
        reconciler: Any | None = None,
        universe_resolver: Any | None = None,
        state: Any | None = None,
        account_label: str | None = None,
        session_factory: Any | None = None,
        llm_review_engine: Any | None = None,
        price_fetcher: Any | None = None,
        strategy_catalog: Any | None = None,
        execution_policy: Any | None = None,
        order_feed_ingestor: Any | None = None,
        broker_account_activity_ingestor: Any | None = None,
    ) -> None:
        if dependencies is None:
            required = {
                "alpaca_client": alpaca_client,
                "order_firewall": order_firewall,
                "ingestor": ingestor,
                "decision_engine": decision_engine,
                "risk_engine": risk_engine,
                "executor": executor,
                "execution_adapter": execution_adapter,
                "reconciler": reconciler,
                "universe_resolver": universe_resolver,
                "state": state,
                "account_label": account_label,
            }
            missing = [name for name, value in required.items() if value is None]
            if missing:
                missing_list = ", ".join(missing)
                raise TypeError(
                    f"missing required pipeline dependencies: {missing_list}"
                )
            dependencies = TradingPipelineRuntimeDependencies(
                alpaca_client=alpaca_client,
                order_firewall=order_firewall,
                ingestor=ingestor,
                decision_engine=decision_engine,
                risk_engine=risk_engine,
                executor=executor,
                execution_adapter=execution_adapter,
                reconciler=reconciler,
                universe_resolver=universe_resolver,
                state=state,
                account_label=str(account_label),
                session_factory=session_factory or SessionLocal,
                llm_review_engine=llm_review_engine,
                price_fetcher=price_fetcher,
                strategy_catalog=strategy_catalog,
                execution_policy=execution_policy,
                order_feed_ingestor=order_feed_ingestor,
                broker_account_activity_ingestor=broker_account_activity_ingestor,
            )
        self.alpaca_client = dependencies.alpaca_client
        self.order_firewall = dependencies.order_firewall
        self.ingestor = dependencies.ingestor
        self.decision_engine = dependencies.decision_engine
        self.risk_engine = dependencies.risk_engine
        self.executor = dependencies.executor
        self.execution_adapter = dependencies.execution_adapter
        self.reconciler = dependencies.reconciler
        self.universe_resolver = dependencies.universe_resolver
        self.state = dependencies.state
        self.account_label = dependencies.account_label
        self.session_factory = dependencies.session_factory
        self.price_fetcher = dependencies.price_fetcher or ClickHousePriceFetcher()
        if self.decision_engine.price_fetcher is None:
            self.decision_engine.price_fetcher = self.price_fetcher
        self.capital_safety = CapitalSafetyController(
            execution_adapter=self.execution_adapter,
            state=self.state,
            account_label=self.account_label,
        )
        self._snapshot_cache = None
        self._snapshot_cached_at: Optional[datetime] = None
        self.strategy_catalog = dependencies.strategy_catalog
        self.execution_policy = dependencies.execution_policy or ExecutionPolicy()
        self.order_feed_ingestor = (
            dependencies.order_feed_ingestor or OrderFeedIngestor()
        )
        self.broker_account_activity_ingestor: BrokerAccountActivityIngestor | None = (
            dependencies.broker_account_activity_ingestor
        )
        self.market_context_client = MarketContextClient()
        self.lean_lane_manager = LeanLaneManager()
        self.llm_review_engine = dependencies.llm_review_engine
        self._last_live_submission_gate: dict[str, object] | None = None
        self._signal_quote_quality = SignalQuoteQualityTracker(
            policy=QuoteQualityPolicy(
                max_executable_spread_bps=settings.trading_signal_max_executable_spread_bps,
                max_quote_mid_jump_bps=settings.trading_signal_max_quote_mid_jump_bps,
                max_jump_with_wide_spread_bps=settings.trading_signal_max_jump_with_wide_spread_bps,
            )
        )
        self._session_context_warmup_day: date | None = None

    def _commit_signal_cursor(self, batch: SignalBatch) -> None:
        with self.session_factory() as cursor_session:
            self.ingestor.commit_cursor(cursor_session, batch)

    def run_once(self) -> None:
        self._label_mature_rejected_signal_outcome_events()
        with self.session_factory() as session:
            self.state.metrics.planned_decision_age_seconds = 0
            self._prepare_run_once(session)
            account_snapshot = self._get_account_snapshot(session)
            self.capital_safety.evaluate(session, account_snapshot)
            if self.state.emergency_stop_active:
                return
            strategies = self._load_strategies(session)
            if not strategies:
                logger.info("No enabled strategies found; skipping trading cycle")
                return
            self._warm_session_context_from_open(session, strategies=strategies)

            batch = self.ingestor.fetch_signals(session)
            self._record_ingest_window(batch)
            if not batch.signals:
                if not self._prepare_batch_for_decisions(
                    session, batch, quality_signals=batch.signals
                ):
                    return
            context = self._build_run_context(session, account_snapshot)
            if context is None:
                self._commit_signal_cursor(batch)
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
                context=BatchSignalProcessingContext(
                    session=session,
                    batch=batch,
                    strategies=strategies,
                    account_snapshot=account_snapshot,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
            )
            self._commit_signal_cursor(batch)

    def _prepare_run_once(self, session: Session) -> None:
        self._ingest_order_feed(session)
        if self.order_firewall.status().kill_switch_enabled:
            self.execution_adapter.cancel_all_orders(purpose="kill_switch")
        if self.strategy_catalog is not None:
            self.strategy_catalog.refresh(session)

    def ingest_broker_account_activities(self) -> None:
        """Backfill broker economics outside the latency-sensitive trading cycle."""

        if self.broker_account_activity_ingestor is None:
            return
        try:
            result = self.broker_account_activity_ingestor.ingest_batch()
        except (
            BrokerAccountActivityError,
            OSError,
            SQLAlchemyError,
            ValueError,
        ) as exc:
            self.state.metrics.broker_account_activity_errors_total += 1
            logger.warning("Broker account activity ingest failed: %s", exc)
            return
        self.state.metrics.broker_account_activity_seen_total += result.seen
        self.state.metrics.broker_account_activity_inserted_total += result.inserted
        self.state.metrics.broker_account_activity_duplicates_total += result.duplicates

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

        window = self._resolve_session_warmup_window(session, get_cursor)
        if window is None:
            return
        warmup_batch = self._fetch_session_warmup_batch(fetch_with_reason, window)
        if warmup_batch is None:
            return
        warmed = self._warm_session_context_signals(
            warmup_batch,
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        self._session_context_warmup_day = window.session_day
        logger.info(
            "Session context warmup complete account=%s start=%s end=%s limit=%s signals=%s max_seconds=%s max_signals=%s",
            self.account_label,
            window.start.isoformat(),
            window.end.isoformat(),
            window.limit,
            warmed,
            window.max_seconds,
            window.max_signals,
        )

    def _resolve_session_warmup_window(
        self,
        session: Session,
        get_cursor: Any,
    ) -> SessionWarmupWindow | None:
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
        return SessionWarmupWindow(
            session_day=session_day,
            start=warmup_start,
            end=warmup_end,
            limit=min(warmup_signal_limit, max_warmup_signals),
            max_seconds=max_warmup_seconds,
            max_signals=max_warmup_signals,
        )

    def _fetch_session_warmup_batch(
        self,
        fetch_with_reason: Any,
        window: SessionWarmupWindow,
    ) -> SignalBatch | None:
        try:
            return cast(
                SignalBatch,
                fetch_with_reason(
                    start=window.start,
                    end=window.end,
                    limit=window.limit,
                ),
            )
        except Exception:
            logger.exception(
                "Failed to fetch session context warmup signals start=%s end=%s",
                window.start.isoformat(),
                window.end.isoformat(),
            )
            return None

    def _warm_session_context_signals(
        self,
        warmup_batch: SignalBatch,
        *,
        strategies: Sequence[Strategy] | None,
        allowed_symbols: set[str] | None,
    ) -> int:
        relevant_symbols = self._relevant_signal_symbols(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        warmed = 0
        for signal in warmup_batch.signals:
            if (
                relevant_symbols
                and normalized_symbol(signal.symbol) not in relevant_symbols
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
        return warmed

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
        market_session_open = self.is_market_session_open()
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
        record_signal_continuity_recovery_cycle(
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
            if normalized_symbol(signal.symbol) in relevant_symbols
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
            normalized_symbol(symbol)
            for symbol in (
                allowed_symbols
                if allowed_symbols is not None
                else self.universe_resolver.get_resolution().symbols
            )
            if normalized_symbol(symbol)
        }
        relevant_symbols: set[str] = set()
        for strategy in strategies:
            if not strategy.enabled:
                continue
            strategy_symbols = {
                normalized_symbol(symbol)
                for symbol in coerce_strategy_symbols(strategy.universe_symbols)
                if normalized_symbol(symbol)
            }
            if strategy_symbols and normalized_allowed_symbols:
                relevant_symbols.update(strategy_symbols & normalized_allowed_symbols)
            elif strategy_symbols:
                relevant_symbols.update(strategy_symbols)
            else:
                relevant_symbols.update(normalized_allowed_symbols)
        return relevant_symbols

    def _build_run_context(
        self, session: Session, account_snapshot: Any
    ) -> tuple[Any, dict[str, str], list[dict[str, Any]], set[str]] | None:
        account = {
            "equity": str(account_snapshot.equity),
            "cash": str(account_snapshot.cash),
            "buying_power": str(account_snapshot.buying_power),
        }
        snapshot_positions = clone_positions(account_snapshot.positions)
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
            latch_signal_continuity_alert_state(
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
        normalized_positions = self._seed_execution_context_positions(
            snapshot_positions
        )
        self._project_open_orders_into_positions(normalized_positions)
        if session is not None:
            normalized_positions = self._attach_current_session_strategy_position_tags(
                session,
                normalized_positions,
            )
        return normalized_positions

    def _seed_execution_context_positions(
        self,
        snapshot_positions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        fallback_positions = clone_positions(snapshot_positions)
        seed_snapshot = getattr(self.execution_adapter, "seed_positions_snapshot", None)
        if not callable(seed_snapshot):
            return fallback_positions
        try:
            seed_snapshot(clone_positions(snapshot_positions))
        except Exception as exc:
            logger.warning(
                "Failed to seed simulation execution positions account=%s error=%s",
                self.account_label,
                exc,
            )
            return fallback_positions
        list_positions = getattr(self.execution_adapter, "list_positions", None)
        if not callable(list_positions):
            return fallback_positions
        try:
            seeded_positions = list_positions()
        except Exception as exc:
            logger.warning(
                "Failed to read simulation execution positions account=%s error=%s",
                self.account_label,
                exc,
            )
            return fallback_positions
        if not isinstance(seeded_positions, list):
            return fallback_positions
        return [
            {str(key): value for key, value in cast(Mapping[object, Any], item).items()}
            for item in cast(list[Any], seeded_positions)
            if isinstance(item, Mapping)
        ]

    def _project_open_orders_into_positions(
        self,
        normalized_positions: list[dict[str, Any]],
    ) -> None:
        projected_open_orders = self._resolve_execution_context_open_orders()
        if projected_open_orders:
            projected_count = project_open_orders_onto_positions(
                normalized_positions,
                projected_open_orders,
            )
            if projected_count > 0:
                logger.info(
                    "Projected open-order exposure into execution context account=%s orders=%s",
                    self.account_label,
                    projected_count,
                )

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
        lookback_start = session_open - STRATEGY_POSITION_TAG_LOOKBACK
        rows = self._load_strategy_position_tag_rows(session, lookback_start)
        if rows is None:
            return positions
        exposures = self._build_strategy_position_exposures(rows, session_open)
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

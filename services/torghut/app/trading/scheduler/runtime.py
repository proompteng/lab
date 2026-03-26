"""Trading scheduler runtime entrypoint and async loop."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, cast

from ...alpaca_client import TorghutAlpacaClient
from ...config import TradingAccountLane, settings
from ...observability import capture_posthog_event
from ...strategies import StrategyCatalog
from ..decisions import DecisionEngine
from ..execution import OrderExecutor
from ..execution_adapters import build_execution_adapter, build_simple_execution_adapter
from ..firewall import OrderFirewall
from ..ingest import ClickHouseSignalIngestor
from ..llm.dspy_programs.runtime import DSPyReviewRuntime, DSPyRuntimeUnsupportedStateError
from ..llm.guardrails import evaluate_llm_guardrails
from ..market_context import MarketContextClient
from ..order_feed import OrderFeedIngestor
from ..prices import ClickHousePriceFetcher
from ..reconcile import Reconciler
from ..risk import RiskEngine
from ..simulation_progress import active_simulation_runtime_context
from ..simulation import resolve_market_context_as_of
from ..time_source import trading_time_status
from ..universe import UniverseResolver
from .governance import TradingSchedulerGovernanceMixin
from .pipeline import TradingPipeline
from .simple_pipeline import SimpleTradingPipeline
from .pipeline_helpers import _build_llm_policy_resolution
from .state import TradingState

logger = logging.getLogger(__name__)

class TradingScheduler(TradingSchedulerGovernanceMixin):
    def __init__(self) -> None:
        self.state = TradingState()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._pipeline: Optional[TradingPipeline] = None
        self._pipelines: list[TradingPipeline] = []
        self._active_simulation_run_id: str | None = None

    def _emit_autonomy_domain_telemetry(
        self,
        *,
        event_name: str,
        severity: str,
        properties: Mapping[str, Any],
    ) -> None:
        payload = {str(key): value for key, value in properties.items()}
        emitted, drop_reason = capture_posthog_event(
            event_name,
            severity=severity,
            distinct_id=f"torghut-autonomy-{settings.trading_account_label}",
            properties=payload,
        )
        self.state.metrics.record_domain_telemetry(
            event_name=event_name,
            emitted=emitted,
            drop_reason=drop_reason,
        )

    def _emit_runtime_loop_failure(
        self,
        *,
        loop_name: str,
        error: Exception,
        account_label: str | None = None,
    ) -> None:
        emitted, drop_reason = capture_posthog_event(
            "torghut.runtime.loop_failed",
            severity="error",
            distinct_id=f"torghut-runtime-{settings.trading_account_label}",
            properties={
                "loop": loop_name,
                "account_label": account_label or settings.trading_account_label,
                "error_class": type(error).__name__,
                "error": str(error),
            },
        )
        self.state.metrics.record_domain_telemetry(
            event_name="torghut.runtime.loop_failed",
            emitted=emitted,
            drop_reason=drop_reason,
        )

    def llm_status(self) -> dict[str, object]:
        circuit_snapshot = None
        pipeline = self._pipeline
        llm_review_engine = (
            getattr(pipeline, "llm_review_engine", None) if pipeline is not None else None
        )
        if llm_review_engine:
            circuit_snapshot = (
                llm_review_engine.circuit_breaker.snapshot()
            )
        guardrails = evaluate_llm_guardrails()
        policy_resolution = _build_llm_policy_resolution(
            rollout_stage=guardrails.rollout_stage,
            effective_fail_mode=guardrails.effective_fail_mode,
            guardrail_reasons=guardrails.reasons,
        )
        dspy_runtime_status: dict[str, object] = {
            "mode": settings.llm_dspy_runtime_mode,
            "artifact_hash": settings.llm_dspy_artifact_hash,
            "live_ready": False,
            "readiness_reasons": [],
            "executor": None,
            "artifact_source": None,
        }
        if settings.llm_dspy_runtime_mode:
            try:
                dspy_runtime = DSPyReviewRuntime.from_settings()
                live_ready, readiness_reasons = dspy_runtime.evaluate_live_readiness()
                dspy_runtime_status["live_ready"] = live_ready
                dspy_runtime_status["readiness_reasons"] = list(readiness_reasons)
                if live_ready:
                    manifest = dspy_runtime._resolve_artifact_manifest()
                    dspy_runtime_status["executor"] = manifest.executor
                    dspy_runtime_status["artifact_source"] = manifest.source
            except DSPyRuntimeUnsupportedStateError as exc:
                dspy_runtime_status["readiness_reasons"] = [str(exc)]
            except Exception as exc:  # pragma: no cover - additive status surface only
                dspy_runtime_status["readiness_reasons"] = [
                    f"dspy_status_error:{type(exc).__name__}"
                ]
        return {
            "enabled": settings.llm_enabled,
            "rollout_stage": guardrails.rollout_stage,
            "fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            # Keep configured shadow_mode for backward compatibility.
            "shadow_mode": settings.llm_shadow_mode,
            # Effective runtime posture after model-risk guardrails.
            "effective_shadow_mode": guardrails.shadow_mode,
            "fail_mode": settings.llm_fail_mode,
            "effective_fail_mode": guardrails.effective_fail_mode,
            "policy_exceptions": settings.llm_policy_exceptions,
            "policy_resolution": policy_resolution,
            "policy_resolution_counters": dict(
                self.state.metrics.llm_policy_resolution_total
            ),
            "policy_veto_total": self.state.metrics.llm_policy_veto_total,
            "runtime_fallback_total": self.state.metrics.llm_runtime_fallback_total,
            "runtime_fallback_ratio": self.rejection_alert_status()[
                "runtime_fallback_ratio"
            ],
            "dspy_live_runtime_block_fail_mode": settings.llm_dspy_live_runtime_block_fail_mode,
            "dspy_live_runtime_block_qty_multiplier": settings.llm_dspy_live_runtime_block_qty_multiplier,
            "dspy_runtime": dspy_runtime_status,
            "circuit": circuit_snapshot,
            "guardrails": {
                "allow_requests": guardrails.allow_requests,
                "governance_evidence_complete": guardrails.governance_evidence_complete,
                "effective_adjustment_allowed": guardrails.adjustment_allowed,
                "committee_enabled": guardrails.committee_enabled,
                "reasons": list(guardrails.reasons),
            },
        }

    def shorting_metadata_status(self) -> dict[str, object]:
        pipeline = self._pipeline
        executor = getattr(pipeline, "executor", None) if pipeline is not None else None
        alert_active = False
        if self.state.market_session_open is True:
            raw_status = None
            if isinstance(executor, OrderExecutor):
                raw_status = executor.shorting_metadata_status()
            account_ready = raw_status.get("account_ready") if isinstance(raw_status, Mapping) else None
            alert_active = account_ready is False
        if isinstance(executor, OrderExecutor):
            status = cast(dict[str, object], executor.shorting_metadata_status())
            status["alert_active"] = alert_active
            return status
        return {
            "account_ready": None,
            "last_refresh_at": None,
            "last_error": None,
            "alert_active": False,
        }

    def market_context_status(self) -> dict[str, object]:
        health: dict[str, Any] | None = None
        health_error: str | None = None
        pipeline = self._pipeline
        market_context_client = (
            getattr(pipeline, "market_context_client", None)
            if pipeline is not None
            else None
        )
        if not isinstance(market_context_client, MarketContextClient):
            market_context_client = MarketContextClient()
        as_of = resolve_market_context_as_of()
        if self.state.last_market_context_symbol:
            try:
                health = market_context_client.fetch_health(
                    self.state.last_market_context_symbol,
                    as_of=as_of,
                )
            except Exception as exc:
                health_error = str(exc)
        return {
            "required": settings.trading_market_context_required,
            "fail_mode": settings.trading_market_context_fail_mode,
            "allow_degraded_last_good": settings.trading_market_context_allow_degraded_last_good,
            "min_quality": settings.trading_market_context_min_quality,
            "max_staleness_seconds": settings.trading_market_context_max_staleness_seconds,
            "fundamentals_degraded_max_staleness_seconds": settings.trading_market_context_fundamentals_degraded_max_staleness_seconds,
            "news_degraded_max_staleness_seconds": settings.trading_market_context_news_degraded_max_staleness_seconds,
            "last_symbol": self.state.last_market_context_symbol,
            "last_checked_at": self.state.last_market_context_checked_at,
            "last_as_of": self.state.last_market_context_as_of,
            "last_freshness_seconds": self.state.last_market_context_freshness_seconds,
            "last_quality_score": self.state.last_market_context_quality_score,
            "last_domain_states": dict(self.state.last_market_context_domain_states),
            "last_risk_flags": list(self.state.last_market_context_risk_flags),
            "last_allow_llm": self.state.last_market_context_allow_llm,
            "last_reason": self.state.last_market_context_reason,
            "last_fetch_error": self.state.last_market_context_fetch_error,
            "reason_total": dict(self.state.metrics.llm_market_context_reason_total),
            "shadow_total": dict(self.state.metrics.llm_market_context_shadow_total),
            "alert_active": self.state.market_context_alert_active,
            "alert_reason": self.state.market_context_alert_reason,
            "health": health,
            "health_error": health_error,
            "time_source": trading_time_status(account_label=settings.trading_account_label),
        }

    def rejection_alert_status(self) -> dict[str, object]:
        llm_requests_total = max(0, int(self.state.metrics.llm_requests_total))
        runtime_fallback_total = max(
            0, int(self.state.metrics.llm_runtime_fallback_total)
        )
        runtime_fallback_ratio = (
            float(runtime_fallback_total) / float(llm_requests_total)
            if llm_requests_total > 0
            else 0.0
        )
        runtime_fallback_alert_active = (
            llm_requests_total > 0
            and runtime_fallback_ratio
            > settings.llm_dspy_runtime_fallback_alert_ratio
        )
        shorting_status = self.shorting_metadata_status()
        return {
            "runtime_fallback_ratio": runtime_fallback_ratio,
            "runtime_fallback_alert_ratio_threshold": settings.llm_dspy_runtime_fallback_alert_ratio,
            "runtime_fallback_alert_active": runtime_fallback_alert_active,
            "shorting_metadata_alert_active": bool(
                shorting_status.get("alert_active", False)
            ),
        }

    def _build_pipeline_for_account(self, lane: TradingAccountLane) -> TradingPipeline:
        price_fetcher = ClickHousePriceFetcher()
        strategy_catalog = StrategyCatalog.from_settings()
        alpaca_client = TorghutAlpacaClient(
            api_key=lane.api_key,
            secret_key=lane.secret_key,
            base_url=lane.base_url,
        )
        order_firewall = OrderFirewall(alpaca_client)
        pipeline_cls: type[TradingPipeline] = TradingPipeline
        if settings.trading_pipeline_mode == "simple":
            execution_adapter = build_simple_execution_adapter(
                alpaca_client=alpaca_client,
                order_firewall=order_firewall,
            )
            pipeline_cls = SimpleTradingPipeline
        else:
            execution_adapter = build_execution_adapter(
                alpaca_client=alpaca_client, order_firewall=order_firewall
            )
        executor = OrderExecutor()
        executor.prime_shorting_metadata_cache(alpaca_client)
        return pipeline_cls(
            alpaca_client=alpaca_client,
            order_firewall=order_firewall,
            ingestor=ClickHouseSignalIngestor(account_label=lane.label),
            decision_engine=DecisionEngine(price_fetcher=price_fetcher),
            risk_engine=RiskEngine(),
            executor=executor,
            execution_adapter=execution_adapter,
            reconciler=Reconciler(account_label=lane.label),
            universe_resolver=UniverseResolver(),
            state=self.state,
            account_label=lane.label,
            price_fetcher=price_fetcher,
            strategy_catalog=strategy_catalog,
            order_feed_ingestor=OrderFeedIngestor(default_account_label=lane.label),
        )

    def _build_pipeline(self) -> TradingPipeline:
        lane = settings.trading_accounts[0]
        return self._build_pipeline_for_account(lane)

    @staticmethod
    def _coerce_boolean_env_value(env_name: str, value: str) -> bool:
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "on", "y"}:
            return True
        if normalized in {"0", "false", "f", "no", "off", "n"}:
            return False
        raise ValueError(
            f"{env_name} has invalid boolean value: {value!r}; expected one of "
            "1, true, false, 0, on, off, yes, no"
        )

    def _assert_trading_shorts_startup_policy(self) -> None:
        env_name = "TRADING_ALLOW_SHORTS"
        raw_env_value = os.getenv(env_name)
        if raw_env_value is None:
            raise RuntimeError(
                f"{env_name} must be explicitly set before scheduler startup"
            )

        configured_env_value = self._coerce_boolean_env_value(env_name, raw_env_value)
        configured_setting = bool(settings.trading_allow_shorts)
        if configured_env_value != configured_setting:
            raise RuntimeError(
                f"{env_name} resolved to {configured_env_value} but settings value is "
                f"{configured_setting}; expected a single source of truth"
            )

        logger.info(
            "Startup short policy explicit: %s=%s (declared=%s)",
            env_name,
            configured_setting,
            raw_env_value,
        )
        self.state.metrics.trading_shorts_enabled = 1 if configured_setting else 0

    async def start(self) -> None:
        if self._task:
            return
        self._assert_trading_shorts_startup_policy()
        if not self._pipelines:
            lanes = settings.trading_accounts
            self._pipelines = [self._build_pipeline_for_account(lane) for lane in lanes]
            self._pipeline = self._pipelines[0] if self._pipelines else None
        account_labels = ",".join(pipeline.account_label for pipeline in self._pipelines)
        logger.info(
            "Trading scheduler starting accounts=%s poll_interval_seconds=%s reconcile_interval_seconds=%s autonomy_enabled=%s autonomy_interval_seconds=%s evidence_enabled=%s evidence_interval_seconds=%s",
            account_labels or "none",
            settings.trading_poll_ms / 1000,
            settings.trading_reconcile_ms / 1000,
            settings.trading_autonomy_enabled,
            max(30, settings.trading_autonomy_interval_seconds),
            settings.trading_evidence_continuity_enabled,
            max(300, settings.trading_evidence_continuity_interval_seconds),
        )
        self._stop_event.clear()
        self.state.startup_started_at = datetime.now(timezone.utc)
        self.state.signal_bootstrap_started_at = self.state.startup_started_at
        self.state.signal_bootstrap_completed_at = None
        self.state.running = False
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if not self._task:
            return
        account_labels = ",".join(
            pipeline.account_label
            for pipeline in (self._pipelines or ([self._pipeline] if self._pipeline else []))
        )
        logger.info("Trading scheduler stopping accounts=%s", account_labels or "none")
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self.state.startup_started_at = None
        self.state.signal_bootstrap_started_at = None
        self.state.signal_bootstrap_completed_at = None
        self.state.running = False
        active_pipelines = self._pipelines or (
            [self._pipeline] if self._pipeline is not None else []
        )
        for pipeline in active_pipelines:
            pipeline.order_feed_ingestor.close()
        self._pipelines = []
        self._pipeline = None
        logger.info("Trading scheduler stopped")

    async def _run_loop(self) -> None:
        self.state.running = True
        poll_interval = settings.trading_poll_ms / 1000
        reconcile_interval = settings.trading_reconcile_ms / 1000
        autonomy_interval = max(30, settings.trading_autonomy_interval_seconds)
        evidence_interval = max(
            300, settings.trading_evidence_continuity_interval_seconds
        )
        last_reconcile = datetime.now(timezone.utc)
        last_autonomy = datetime.now(timezone.utc)
        last_evidence_check = datetime.now(timezone.utc)
        logger.info(
            "Trading scheduler loop running poll_interval_seconds=%s reconcile_interval_seconds=%s autonomy_interval_seconds=%s evidence_interval_seconds=%s",
            poll_interval,
            reconcile_interval,
            autonomy_interval,
            evidence_interval,
        )
        try:
            while not self._stop_event.is_set():
                self._sync_simulation_run_context()
                await self._run_trading_iteration()
                now = datetime.now(timezone.utc)
                if self._interval_elapsed(last_reconcile, reconcile_interval, now=now):
                    await self._run_reconcile_iteration()
                    last_reconcile = now

                if settings.trading_autonomy_enabled and self._interval_elapsed(
                    last_autonomy, autonomy_interval, now=now
                ):
                    await self._run_autonomy_iteration()
                    last_autonomy = now

                if settings.trading_evidence_continuity_enabled and self._interval_elapsed(
                    last_evidence_check, evidence_interval, now=now
                ):
                    await self._run_evidence_iteration()
                    last_evidence_check = now

                await asyncio.sleep(poll_interval)
        finally:
            self.state.running = False
            logger.info("Trading scheduler loop exited")

    def _sync_simulation_run_context(self) -> None:
        runtime_context = active_simulation_runtime_context()
        active_run_id = str((runtime_context or {}).get("run_id") or "").strip() or None
        if active_run_id == self._active_simulation_run_id:
            return

        previous_run_id = self._active_simulation_run_id
        self._active_simulation_run_id = active_run_id
        if active_run_id is None:
            return

        self._reset_simulation_run_state(
            previous_run_id=previous_run_id,
            active_run_id=active_run_id,
        )

    def _reset_simulation_run_state(
        self,
        *,
        previous_run_id: str | None,
        active_run_id: str,
    ) -> None:
        self.state.last_error = None
        self.state.last_ingest_signals_total = 0
        self.state.last_ingest_window_start = None
        self.state.last_ingest_window_end = None
        self.state.last_ingest_reason = None
        self.state.last_signal_continuity_state = None
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = None
        self.state.signal_continuity_alert_active = False
        self.state.signal_continuity_alert_reason = None
        self.state.signal_continuity_alert_started_at = None
        self.state.signal_continuity_alert_last_seen_at = None
        self.state.signal_continuity_recovery_streak = 0
        self.state.signal_bootstrap_started_at = datetime.now(timezone.utc)
        self.state.signal_bootstrap_completed_at = None
        self.state.autonomy_no_signal_streak = 0
        self.state.last_evidence_continuity_report = None
        self.state.autonomy_failure_streak = 0
        self.state.universe_fail_safe_blocked = False
        self.state.universe_fail_safe_block_reason = None
        self.state.emergency_stop_active = False
        self.state.emergency_stop_reason = None
        self.state.emergency_stop_triggered_at = None
        self.state.emergency_stop_resolved_at = None
        self.state.emergency_stop_recovery_streak = 0
        self.state.rollback_incident_evidence_path = None
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.metrics.record_signal_continuity_alert_state(
            active=False,
            recovery_streak=0,
        )
        logger.info(
            "Trading scheduler reset simulation run state previous_run_id=%s active_run_id=%s",
            previous_run_id or "none",
            active_run_id,
        )

    @staticmethod
    def _interval_elapsed(
        last_run: datetime,
        interval_seconds: float,
        *,
        now: datetime,
    ) -> bool:
        return now - last_run >= timedelta(seconds=interval_seconds)

    async def _run_trading_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            active_pipelines = self._pipelines or [self._pipeline]
            for pipeline in active_pipelines:
                try:
                    await asyncio.to_thread(pipeline.run_once)
                except Exception as lane_exc:
                    self._emit_runtime_loop_failure(
                        loop_name="trading_lane",
                        error=lane_exc,
                        account_label=pipeline.account_label,
                    )
                    logger.exception(
                        "Trading lane failed account=%s: %s",
                        pipeline.account_label,
                        lane_exc,
                    )
            self.state.last_run_at = datetime.now(timezone.utc)
            self.state.last_error = None
        except Exception as exc:  # pragma: no cover - loop guard
            self._emit_runtime_loop_failure(loop_name="trading", error=exc)
            logger.exception("Trading loop failed: %s", exc)
            self.state.last_error = str(exc)
        finally:
            self._evaluate_safety_controls()

    async def _run_reconcile_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            updates = 0
            active_pipelines = self._pipelines or [self._pipeline]
            for pipeline in active_pipelines:
                try:
                    updates += await asyncio.to_thread(pipeline.reconcile)
                except Exception as lane_exc:
                    self._emit_runtime_loop_failure(
                        loop_name="reconcile_lane",
                        error=lane_exc,
                        account_label=pipeline.account_label,
                    )
                    logger.exception(
                        "Reconcile lane failed account=%s: %s",
                        pipeline.account_label,
                        lane_exc,
                    )
            if updates:
                logger.info("Reconciled %s executions", updates)
            self.state.last_reconcile_at = datetime.now(timezone.utc)
            self.state.last_error = None
        except Exception as exc:  # pragma: no cover - loop guard
            self._emit_runtime_loop_failure(loop_name="reconcile", error=exc)
            logger.exception("Reconcile loop failed: %s", exc)
            self.state.last_error = str(exc)
        finally:
            self._evaluate_safety_controls()

    async def _run_autonomy_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            await asyncio.to_thread(self._run_autonomous_cycle)
            self.state.last_autonomy_error = None
        except Exception as exc:  # pragma: no cover - loop guard
            self._emit_runtime_loop_failure(loop_name="autonomy", error=exc)
            logger.exception("Autonomous loop failed: %s", exc)
            self.state.last_error = str(exc)
            self.state.last_autonomy_error = str(exc)
            self.state.autonomy_failure_streak += 1
            self._clear_autonomy_result_state()
        finally:
            self._evaluate_safety_controls()

    async def _run_evidence_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            await asyncio.to_thread(self._run_evidence_continuity_check)
        except Exception as exc:  # pragma: no cover - loop guard
            self._emit_runtime_loop_failure(loop_name="evidence", error=exc)
            logger.exception("Evidence continuity check failed: %s", exc)
            self.state.last_error = str(exc)


__all__ = ["TradingScheduler"]

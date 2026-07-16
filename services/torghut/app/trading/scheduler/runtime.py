"""Trading scheduler runtime entrypoint and async loop."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable, Iterable, Mapping
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, cast

from ...config import TradingAccountLane, settings
from ...db import engine as database_engine
from ..execution import OrderExecutor
from ..broker_mutation_recovery_worker import BrokerMutationRecoveryWorker
from ..llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from ..llm.guardrails import evaluate_llm_guardrails
from ..market_context import (
    MarketContextClient,
    evaluate_market_context,
    market_context_enforced,
)
from ..market_context_domains import (
    active_market_context_domain_states,
    active_market_context_mapping,
    active_market_context_reasons,
)
from ..simulation import resolve_market_context_as_of
from ..time_source import trading_time_status
from .governance.governance_mixin_decision_methods import (
    TradingSchedulerGovernanceDecisionMethods,
)
from .governance.governance_mixin_lifecycle_methods import (
    TradingSchedulerGovernanceLifecycleMethods,
)
from .governance.governance_mixin_runtime_methods import (
    TradingSchedulerGovernanceRuntimeMethods,
)
from .governance.shared_context import TradingSchedulerGovernanceMixinFields
from .leadership import (
    PostgresSchedulerLeadership,
    SchedulerLeadership,
    SchedulerLeadershipError,
    SchedulerLeadershipStatus,
    scheduler_advisory_lock_id,
)
from .broker_mutation_recovery_runtime import (
    build_alpaca_mutation_recovery_worker,
    reconcile_broker_mutation_recovery,
)
from .pipeline import TradingPipeline
from .pipeline_helpers import build_llm_policy_resolution
from .runtime_pipeline_factory import build_trading_pipeline_for_account
from .simulation_state import sync_simulation_run_state
from .state import TradingState
from .startup_policy import resolve_trading_shorts_startup_policy

logger = logging.getLogger(__name__)


class TradingScheduler(
    TradingSchedulerGovernanceMixinFields,
    TradingSchedulerGovernanceLifecycleMethods,
    TradingSchedulerGovernanceDecisionMethods,
    TradingSchedulerGovernanceRuntimeMethods,
):
    def __init__(
        self,
        *,
        leadership: SchedulerLeadership | None = None,
        fatal_exit: Callable[[int], object] | None = None,
    ) -> None:
        self.state = TradingState()
        self._task: Optional[asyncio.Task[None]] = None
        self._leadership_task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._pipeline: Optional[TradingPipeline] = None
        self._pipelines: list[TradingPipeline] = []
        self._broker_mutation_recovery_worker: BrokerMutationRecoveryWorker | None = (
            None
        )
        self._active_simulation_run_id: str | None = None
        self._leadership = leadership or PostgresSchedulerLeadership(
            engine=database_engine,
            required=settings.trading_scheduler_leadership_required,
            lock_id=scheduler_advisory_lock_id(
                settings.trading_scheduler_leadership_lock_name
            ),
        )
        self._fatal_exit = fatal_exit or os._exit

    @property
    def leadership_status(self) -> SchedulerLeadershipStatus:
        """Return the process-local writer-fence state for probes and metrics."""

        return self._leadership.status

    def _emit_autonomy_domain_telemetry(
        self,
        *,
        event_name: str,
        severity: str,
        properties: Mapping[str, Any],
    ) -> None:
        logger.log(
            logging.ERROR if severity == "error" else logging.INFO,
            "Torghut autonomy event event=%s properties=%s",
            event_name,
            {str(key): value for key, value in properties.items()},
        )
        self.state.metrics.record_domain_telemetry(
            event_name=event_name,
            emitted=True,
            drop_reason=None,
        )

    def _emit_runtime_loop_failure(
        self,
        *,
        loop_name: str,
        error: Exception,
        account_label: str | None = None,
    ) -> None:
        logger.error(
            "Torghut runtime loop failed loop=%s account_label=%s error_class=%s error=%s",
            loop_name,
            account_label or settings.trading_account_label,
            type(error).__name__,
            error,
        )
        self.state.metrics.record_domain_telemetry(
            event_name="torghut.runtime.loop_failed",
            emitted=True,
            drop_reason=None,
        )

    def llm_status(self) -> dict[str, object]:
        circuit_snapshot = None
        pipeline = self._pipeline
        llm_review_engine = (
            getattr(pipeline, "llm_review_engine", None)
            if pipeline is not None
            else None
        )
        if llm_review_engine:
            circuit_snapshot = llm_review_engine.circuit_breaker.snapshot()
        guardrails = evaluate_llm_guardrails()
        policy_resolution = build_llm_policy_resolution(
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
                    manifest = dspy_runtime.resolve_artifact_manifest()
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
            account_ready = (
                raw_status.get("account_ready")
                if isinstance(raw_status, Mapping)
                else None
            )
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
        context_error: str | None = None
        pipeline = self._pipeline
        market_context_client = (
            getattr(pipeline, "market_context_client", None)
            if pipeline is not None
            else None
        )
        if not isinstance(market_context_client, MarketContextClient):
            market_context_client = MarketContextClient()
        as_of = resolve_market_context_as_of()
        last_symbol = self.state.last_market_context_symbol
        last_checked_at = self.state.last_market_context_checked_at
        last_as_of = self.state.last_market_context_as_of
        last_freshness_seconds = self.state.last_market_context_freshness_seconds
        last_quality_score = self.state.last_market_context_quality_score
        last_domain_states = {
            key: str(value).strip().lower()
            for key, value in active_market_context_mapping(
                self.state.last_market_context_domain_states
            ).items()
        }
        last_risk_flags = active_market_context_reasons(
            self.state.last_market_context_risk_flags
        )
        last_allow_llm = self.state.last_market_context_allow_llm
        last_reason = self.state.last_market_context_reason
        enforce_market_context = market_context_enforced()
        shadow_alert_active = self.state.market_context_alert_active
        shadow_alert_reason = self.state.market_context_alert_reason
        alert_active = shadow_alert_active if enforce_market_context else False
        alert_reason = self.state.market_context_alert_reason
        if alert_active:
            active_alert_reasons = active_market_context_reasons(
                [alert_reason or "market_context_alert_active"]
            )
            if active_alert_reasons:
                alert_reason = active_alert_reasons[0]
            else:
                alert_active = False
                alert_reason = None
        elif not enforce_market_context:
            alert_reason = None
        probe_symbol = self._market_context_probe_symbol()
        fetch_symbol = last_symbol or probe_symbol
        if fetch_symbol:
            try:
                health = market_context_client.fetch_health(
                    fetch_symbol,
                    as_of=as_of,
                )
            except Exception as exc:
                health_error = str(exc)
        domain_refresh_states = {"stale", "error"}
        refreshable_domain_state = any(
            str(state).strip().lower() in domain_refresh_states
            for state in last_domain_states.values()
        )
        local_snapshot_stale = (
            last_freshness_seconds is not None
            and int(last_freshness_seconds)
            > settings.trading_market_context_max_staleness_seconds
        )
        if (
            settings.trading_market_context_url
            and (
                last_freshness_seconds is None
                or last_symbol is None
                or local_snapshot_stale
                or refreshable_domain_state
            )
            and probe_symbol
        ):
            try:
                bundle = market_context_client.fetch(probe_symbol, as_of=as_of)
            except Exception as exc:
                context_error = str(exc)
                self.state.last_market_context_fetch_error = context_error
            else:
                if bundle is not None:
                    verdict = evaluate_market_context(bundle)
                    last_symbol = bundle.symbol
                    last_checked_at = datetime.now(timezone.utc)
                    last_as_of = bundle.as_of_utc
                    last_freshness_seconds = int(bundle.freshness_seconds)
                    last_quality_score = float(bundle.quality_score)
                    last_domain_states = active_market_context_domain_states(bundle)
                    last_risk_flags = active_market_context_reasons(bundle.risk_flags)
                    last_allow_llm = verdict.allow_llm
                    last_reason = verdict.reason
                    shadow_alert_active = not verdict.allow_llm
                    alert_reason = verdict.reason
                    shadow_alert_reason = verdict.reason
                    alert_active = enforce_market_context and shadow_alert_active
                    if not alert_active:
                        alert_reason = None
                    self.state.last_market_context_symbol = last_symbol
                    self.state.last_market_context_checked_at = last_checked_at
                    self.state.last_market_context_as_of = last_as_of
                    self.state.last_market_context_freshness_seconds = (
                        last_freshness_seconds
                    )
                    self.state.last_market_context_quality_score = last_quality_score
                    self.state.last_market_context_domain_states = dict(
                        last_domain_states
                    )
                    self.state.last_market_context_risk_flags = list(last_risk_flags)
                    self.state.last_market_context_allow_llm = last_allow_llm
                    self.state.last_market_context_reason = last_reason
                    self.state.last_market_context_fetch_error = None
                    self.state.market_context_alert_active = alert_active
                    self.state.market_context_alert_reason = alert_reason
        return {
            "required": settings.trading_market_context_required,
            "fail_mode": settings.trading_market_context_fail_mode,
            "min_quality": settings.trading_market_context_min_quality,
            "max_staleness_seconds": settings.trading_market_context_max_staleness_seconds,
            "last_symbol": last_symbol,
            "last_checked_at": last_checked_at,
            "last_as_of": last_as_of,
            "last_freshness_seconds": last_freshness_seconds,
            "last_quality_score": last_quality_score,
            "last_domain_states": last_domain_states,
            "last_risk_flags": last_risk_flags,
            "last_allow_llm": last_allow_llm,
            "last_reason": last_reason,
            "last_fetch_error": self.state.last_market_context_fetch_error
            or context_error,
            "reason_total": dict(self.state.metrics.llm_market_context_reason_total),
            "shadow_total": dict(self.state.metrics.llm_market_context_shadow_total),
            "alert_active": alert_active,
            "alert_reason": alert_reason,
            "shadow_alert_active": shadow_alert_active,
            "shadow_alert_reason": shadow_alert_reason,
            "health": health,
            "health_error": health_error,
            "time_source": trading_time_status(
                account_label=settings.trading_account_label
            ),
        }

    def _market_context_probe_symbol(self) -> str | None:
        existing_symbol = (
            str(self.state.last_market_context_symbol or "").strip().upper()
        )
        if existing_symbol:
            return existing_symbol
        pipeline = self._pipeline
        resolver = (
            getattr(pipeline, "universe_resolver", None)
            if pipeline is not None
            else None
        )
        if resolver is not None:
            try:
                symbols = cast(
                    Iterable[object], getattr(resolver.get_resolution(), "symbols", ())
                )
                for symbol in sorted(str(raw).strip().upper() for raw in symbols):
                    if symbol:
                        return symbol
            except Exception:
                logger.exception("Market-context status probe universe unavailable")
        for symbol in settings.trading_static_symbols:
            normalized = str(symbol).strip().upper()
            if normalized:
                return normalized
        return None

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
            and runtime_fallback_ratio > settings.llm_dspy_runtime_fallback_alert_ratio
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
        return build_trading_pipeline_for_account(
            lane=lane,
            state=self.state,
        )

    def _build_pipeline(self) -> TradingPipeline:
        lane = settings.trading_accounts[0]
        return self._build_pipeline_for_account(lane)

    def _assert_trading_shorts_startup_policy(self) -> None:
        configured_setting = resolve_trading_shorts_startup_policy(
            raw_env_value=os.getenv("TRADING_ALLOW_SHORTS"),
            configured_setting=bool(settings.trading_allow_shorts),
        )
        self.state.metrics.trading_shorts_enabled = 1 if configured_setting else 0

    async def start(self) -> None:
        if self._task:
            return
        try:
            await asyncio.to_thread(self._leadership.acquire)
        except SchedulerLeadershipError as exc:
            self.state.running = False
            self.state.last_error = f"scheduler_startup_failed:{type(exc).__name__}"
            raise
        if str(self.state.last_error or "").startswith("scheduler_startup_failed:"):
            self.state.last_error = None
        with ExitStack() as startup_cleanup:
            startup_cleanup.callback(self._leadership.release)
            self._assert_trading_shorts_startup_policy()
            if not self._pipelines:
                lanes = settings.trading_accounts
                self._pipelines = [
                    self._build_pipeline_for_account(lane) for lane in lanes
                ]
                self._pipeline = self._pipelines[0] if self._pipelines else None
            if self._broker_mutation_recovery_worker is None:
                self._broker_mutation_recovery_worker = (
                    build_alpaca_mutation_recovery_worker(
                        self._pipelines,
                        enabled=settings.trading_broker_mutation_recovery_enabled,
                    )
                )
            account_labels = ",".join(
                pipeline.account_label for pipeline in self._pipelines
            )
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
            self._task.add_done_callback(self._scheduler_loop_completed)
            self._leadership_task = asyncio.create_task(self._monitor_leadership())
            self._leadership_task.add_done_callback(self._leadership_monitor_completed)
            startup_cleanup.pop_all()

    async def stop(self) -> None:
        account_labels = ",".join(
            pipeline.account_label
            for pipeline in (
                self._pipelines or ([self._pipeline] if self._pipeline else [])
            )
        )
        logger.info("Trading scheduler stopping accounts=%s", account_labels or "none")
        self._stop_event.set()
        task = self._task
        drain_seconds = settings.trading_scheduler_shutdown_drain_seconds
        deadline = asyncio.get_running_loop().time() + drain_seconds
        if task is not None and task is not asyncio.current_task():
            completed, _ = await asyncio.wait({task}, timeout=drain_seconds)
            if not completed:
                self._fail_closed_on_shutdown_timeout(
                    phase="scheduler_loop",
                    drain_seconds=drain_seconds,
                )
                return

        leadership_task = self._leadership_task
        if (
            leadership_task is not None
            and leadership_task is not asyncio.current_task()
        ):
            remaining_seconds = max(
                0.0,
                deadline - asyncio.get_running_loop().time(),
            )
            completed, _ = await asyncio.wait(
                {leadership_task},
                timeout=remaining_seconds,
            )
            if not completed:
                self._fail_closed_on_shutdown_timeout(
                    phase="leadership_monitor",
                    drain_seconds=drain_seconds,
                )
                return

        self._leadership_task = None
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
        await asyncio.to_thread(self._leadership.release)
        logger.info("Trading scheduler stopped")

    def _fail_closed_on_shutdown_timeout(
        self,
        *,
        phase: str,
        drain_seconds: float,
    ) -> None:
        reason = f"scheduler_shutdown_drain_timeout:{phase}"
        self.state.last_error = reason
        self.state.emergency_stop_active = True
        self.state.emergency_stop_reason = reason
        self.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
        logger.critical(
            "Trading scheduler shutdown drain timed out; retaining writer fence "
            "phase=%s drain_seconds=%s",
            phase,
            drain_seconds,
        )
        self._fatal_exit(70)

    async def _monitor_leadership(self) -> None:
        """Cancel broker-affecting work as soon as the writer fence is lost."""

        check_seconds = settings.trading_scheduler_leadership_check_seconds
        try:
            while True:
                scheduler_task = self._task
                if self._stop_event.is_set():
                    if scheduler_task is None or scheduler_task.done():
                        return
                    await asyncio.wait({scheduler_task}, timeout=check_seconds)
                else:
                    try:
                        await asyncio.wait_for(
                            self._stop_event.wait(),
                            timeout=check_seconds,
                        )
                    except TimeoutError:
                        pass

                scheduler_task = self._task
                if self._stop_event.is_set() and (
                    scheduler_task is None or scheduler_task.done()
                ):
                    return
                healthy = await asyncio.to_thread(self._leadership.check)
                if healthy:
                    continue

                status = self._leadership.status
                reason = status.failure_reason or "leadership_unhealthy"
                self._latch_leadership_failure(
                    state_reason="scheduler_leadership_lost",
                    detail=reason,
                )
                logger.critical(
                    "Trading scheduler leadership lost; writer stopped reason=%s",
                    reason,
                )
                self._fatal_exit(70)
                return
        except asyncio.CancelledError:
            raise

    def _leadership_monitor_completed(
        self,
        monitor_task: asyncio.Task[None],
    ) -> None:
        """Fail closed if the monitor itself exits with any unexpected error."""

        if monitor_task.cancelled():
            return
        error = monitor_task.exception()
        if error is None:
            return
        detail = type(error).__name__
        self._latch_leadership_failure(
            state_reason="scheduler_leadership_monitor_failed",
            detail=detail,
        )
        logger.critical(
            "Trading scheduler leadership monitor crashed; writer stopped error=%s",
            detail,
            exc_info=(type(error), error, error.__traceback__),
        )
        self._fatal_exit(70)

    def _scheduler_loop_completed(self, scheduler_task: asyncio.Task[None]) -> None:
        if self._stop_event.is_set():
            return
        if scheduler_task.cancelled():
            error: BaseException | None = None
            state_reason = "scheduler_loop_cancelled_unexpectedly"
            detail = "task_cancelled"
        else:
            error = scheduler_task.exception()
            if error is None:
                state_reason = "scheduler_loop_exited_unexpectedly"
                detail = "task_returned"
            else:
                state_reason, detail = "scheduler_loop_failed", type(error).__name__
        self._latch_leadership_failure(state_reason=state_reason, detail=detail)
        logger.critical(
            "Scheduler loop stopped unexpectedly reason=%s detail=%s",
            state_reason,
            detail,
            exc_info=error,
        )
        self._fatal_exit(70)

    def _latch_leadership_failure(
        self,
        *,
        state_reason: str,
        detail: str,
    ) -> None:
        self.state.last_error = f"{state_reason}:{detail}"
        self.state.emergency_stop_active = True
        self.state.emergency_stop_reason = state_reason
        self.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
        self._stop_event.set()
        task = self._task
        if task is not None:
            task.cancel()

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
        last_broker_activity = datetime.fromtimestamp(0, tz=timezone.utc)
        broker_activity_task: asyncio.Task[None] | None = None
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
                if broker_activity_task is not None and broker_activity_task.done():
                    await broker_activity_task
                    broker_activity_task = None
                if broker_activity_task is None and self._interval_elapsed(
                    last_broker_activity,
                    reconcile_interval,
                    now=now,
                ):
                    # REST accounting must never delay signal decisions, broker
                    # mutation recovery, or emergency reductions.
                    broker_activity_task = asyncio.create_task(
                        self._run_broker_account_activity_iteration()
                    )
                    last_broker_activity = now
                if self._interval_elapsed(last_reconcile, reconcile_interval, now=now):
                    await self._run_reconcile_iteration()
                    last_reconcile = now

                if settings.trading_autonomy_enabled and self._interval_elapsed(
                    last_autonomy, autonomy_interval, now=now
                ):
                    await self._run_autonomy_iteration()
                    last_autonomy = now

                if (
                    settings.trading_evidence_continuity_enabled
                    and self._interval_elapsed(
                        last_evidence_check, evidence_interval, now=now
                    )
                ):
                    await self._run_evidence_iteration()
                    last_evidence_check = now

                try:
                    await asyncio.wait_for(
                        self._stop_event.wait(),
                        timeout=poll_interval,
                    )
                except TimeoutError:
                    pass
        finally:
            if broker_activity_task is not None:
                # Account-activity recovery is read-only broker I/O with its own
                # cursor CAS. It must not hold the writer fence during shutdown.
                broker_activity_task.cancel()
                try:
                    await broker_activity_task
                except asyncio.CancelledError:
                    pass
            self.state.running = False
            logger.info("Trading scheduler loop exited")

    def _sync_simulation_run_context(self) -> None:
        self._active_simulation_run_id = sync_simulation_run_state(
            self.state,
            self._active_simulation_run_id,
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
        if self._pipeline is None:
            error = RuntimeError("trading_pipeline_not_initialized")
            self._emit_runtime_loop_failure(loop_name="trading", error=error)
            self._set_trading_iteration_error(str(error))
            self._evaluate_safety_controls()
            return

        failed_accounts: list[str] = []
        active_pipelines = self._pipelines or [self._pipeline]
        for pipeline in active_pipelines:
            outcome = (
                await asyncio.gather(
                    asyncio.to_thread(pipeline.run_once),
                    return_exceptions=True,
                )
            )[0]
            if isinstance(outcome, Exception):
                failed_accounts.append(pipeline.account_label)
                self._emit_runtime_loop_failure(
                    loop_name="trading_lane",
                    error=outcome,
                    account_label=pipeline.account_label,
                )
                logger.error(
                    "Trading lane failed account=%s error=%s",
                    pipeline.account_label,
                    outcome,
                    exc_info=(type(outcome), outcome, outcome.__traceback__),
                )
            elif isinstance(outcome, BaseException):
                raise outcome

        if failed_accounts:
            self._set_trading_iteration_error(
                "trading_lane_failures:" + ",".join(failed_accounts)
            )
        else:
            self.state.last_run_at = datetime.now(timezone.utc)
            self._set_trading_iteration_error(None)
        self._evaluate_safety_controls()

    async def _run_broker_account_activity_iteration(self) -> None:
        active_pipelines = self._pipelines or (
            [self._pipeline] if self._pipeline else []
        )
        calls: list[tuple[str, Callable[[], object]]] = []
        for pipeline in active_pipelines:
            ingest = getattr(pipeline, "ingest_broker_account_activities", None)
            if callable(ingest):
                calls.append((pipeline.account_label, ingest))
        if not calls:
            return
        outcomes = await asyncio.gather(
            *(asyncio.to_thread(ingest) for _, ingest in calls),
            return_exceptions=True,
        )
        for (account_label, _), outcome in zip(calls, outcomes, strict=True):
            if isinstance(outcome, Exception):
                self.state.metrics.broker_account_activity_errors_total += 1
                logger.error(
                    "Broker account activity lane failed account=%s error=%s",
                    account_label,
                    outcome,
                    exc_info=(type(outcome), outcome, outcome.__traceback__),
                )
            elif isinstance(outcome, BaseException):
                raise outcome

    async def _run_reconcile_iteration(self) -> None:
        if self._pipeline is None:
            error = RuntimeError("trading_pipeline_not_initialized")
            self._emit_runtime_loop_failure(loop_name="reconcile", error=error)
            self._set_reconcile_iteration_error(str(error))
            self._evaluate_safety_controls()
            return

        updates = 0
        failed_accounts: list[str] = []
        active_pipelines = self._pipelines or [self._pipeline]
        for pipeline in active_pipelines:
            outcome = (
                await asyncio.gather(
                    asyncio.to_thread(pipeline.reconcile),
                    return_exceptions=True,
                )
            )[0]
            if isinstance(outcome, Exception):
                failed_accounts.append(pipeline.account_label)
                self._emit_runtime_loop_failure(
                    loop_name="reconcile_lane",
                    error=outcome,
                    account_label=pipeline.account_label,
                )
                logger.error(
                    "Reconcile lane failed account=%s error=%s",
                    pipeline.account_label,
                    outcome,
                    exc_info=(type(outcome), outcome, outcome.__traceback__),
                )
            elif isinstance(outcome, BaseException):
                raise outcome
            else:
                updates += outcome

        recovery_succeeded = await reconcile_broker_mutation_recovery(
            self._broker_mutation_recovery_worker,
            metrics=self.state.metrics,
            emit_failure=self._emit_runtime_loop_failure,
        )
        if not recovery_succeeded:
            failed_accounts.append("broker-mutation-recovery")

        if updates:
            logger.info("Reconciled %s executions", updates)
        if failed_accounts:
            self._set_reconcile_iteration_error(
                "reconcile_lane_failures:" + ",".join(failed_accounts)
            )
        else:
            self.state.last_reconcile_at = datetime.now(timezone.utc)
            self._set_reconcile_iteration_error(None)
        self._evaluate_safety_controls()

    def _set_trading_iteration_error(self, error: str | None) -> None:
        previous_iteration_error = self._runtime_iteration_error()
        self.state.last_trading_error = error
        self._refresh_runtime_iteration_error(
            previous_iteration_error=previous_iteration_error
        )

    def _set_reconcile_iteration_error(self, error: str | None) -> None:
        previous_iteration_error = self._runtime_iteration_error()
        self.state.last_reconcile_error = error
        self._refresh_runtime_iteration_error(
            previous_iteration_error=previous_iteration_error
        )

    def _set_autonomy_iteration_error(self, error: str | None) -> None:
        previous_iteration_error = self._runtime_iteration_error()
        self.state.last_autonomy_error = error
        self._refresh_runtime_iteration_error(
            previous_iteration_error=previous_iteration_error
        )

    def _set_evidence_iteration_error(self, error: str | None) -> None:
        previous_iteration_error = self._runtime_iteration_error()
        self.state.last_evidence_error = error
        self._refresh_runtime_iteration_error(
            previous_iteration_error=previous_iteration_error
        )

    def _runtime_iteration_error(self) -> str | None:
        active_errors = tuple(
            error
            for error in (
                self.state.last_trading_error,
                self.state.last_reconcile_error,
                self.state.last_autonomy_error,
                self.state.last_evidence_error,
            )
            if error is not None
        )
        if not active_errors:
            return None
        return ";".join(active_errors)

    def _refresh_runtime_iteration_error(
        self,
        *,
        previous_iteration_error: str | None,
    ) -> None:
        if self.state.last_error in (None, previous_iteration_error):
            self.state.last_error = self._runtime_iteration_error()

    async def _run_autonomy_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            self._set_autonomy_iteration_error(None)
            await asyncio.to_thread(self._run_autonomous_cycle)
        except Exception as exc:  # pragma: no cover - loop guard
            self._emit_runtime_loop_failure(loop_name="autonomy", error=exc)
            logger.exception("Autonomous loop failed: %s", exc)
            self._set_autonomy_iteration_error(str(exc))
            self.state.autonomy_failure_streak += 1
            self._clear_autonomy_result_state()
        finally:
            self._evaluate_safety_controls()

    async def _run_evidence_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            await asyncio.to_thread(self._run_evidence_continuity_check)
            self._set_evidence_iteration_error(None)
        except Exception as exc:  # pragma: no cover - loop guard
            self._emit_runtime_loop_failure(loop_name="evidence", error=exc)
            logger.exception("Evidence continuity check failed: %s", exc)
            self._set_evidence_iteration_error(str(exc))


__all__ = ["TradingScheduler"]

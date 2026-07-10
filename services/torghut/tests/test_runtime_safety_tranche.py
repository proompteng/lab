from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import Future
from threading import Event
from typing import cast
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app import bootstrap
from app.api import command_auth, readiness
from app.config import settings
from app.trading.scheduler.pipeline import TradingPipeline
from app.trading.scheduler.runtime import TradingScheduler


class _FeedStub:
    def __init__(self) -> None:
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1


class _LaneStub:
    def __init__(
        self,
        account_label: str,
        *,
        run_error: RuntimeError | None = None,
        run_hook: Callable[[], None] | None = None,
        hold: Event | None = None,
    ) -> None:
        self.account_label = account_label
        self.run_error = run_error
        self.run_hook = run_hook
        self.hold = hold
        self.run_calls = 0
        self.reconcile_calls = 0
        self.order_feed_ingestor = _FeedStub()

    def run_once(self) -> None:
        self.run_calls += 1
        if self.run_hook is not None:
            self.run_hook()
        if self.hold is not None:
            self.hold.wait()
        if self.run_error is not None:
            raise self.run_error

    def reconcile(self) -> int:
        self.reconcile_calls += 1
        return 0


def _install_lanes(scheduler: TradingScheduler, *lanes: _LaneStub) -> None:
    pipelines = cast(list[TradingPipeline], list(lanes))
    scheduler._pipelines = pipelines
    scheduler._pipeline = pipelines[0]


def test_lifespan_always_stops_runtime_resources(monkeypatch: MonkeyPatch) -> None:
    events: list[str] = []

    class SchedulerStub:
        _task = None

        async def stop(self) -> None:
            events.append("scheduler.stop")

    class WorkerStub:
        _task = None

        async def stop(self) -> None:
            events.append("worker.stop")

    scheduler = SchedulerStub()
    worker = WorkerStub()
    monkeypatch.setattr(bootstrap, "TradingScheduler", lambda: scheduler)
    monkeypatch.setattr(
        bootstrap,
        "WhitepaperKafkaWorker",
        lambda session_factory: worker,
    )
    monkeypatch.setattr(bootstrap, "_validate_runtime_schema", lambda: None)
    monkeypatch.setattr(bootstrap, "whitepaper_workflow_enabled", lambda: False)
    monkeypatch.setattr(
        bootstrap,
        "shutdown_posthog_telemetry",
        lambda: events.append("telemetry.stop"),
    )
    monkeypatch.setattr(settings, "trading_enabled", False)
    monkeypatch.setattr(settings, "trading_autonomy_enabled", False)

    async def exercise() -> None:
        async with bootstrap.lifespan(FastAPI()):
            raise RuntimeError("request_failed")

    with pytest.raises(RuntimeError, match="request_failed"):
        asyncio.run(exercise())

    assert events == ["worker.stop", "scheduler.stop", "telemetry.stop"]


def test_runtime_schema_validation_fails_closed_on_pending_migrations(
    monkeypatch: MonkeyPatch,
) -> None:
    class SessionContext:
        def __enter__(self) -> object:
            return object()

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(bootstrap, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        bootstrap,
        "check_schema_current",
        lambda _session: {
            "schema_current": False,
            "schema_missing_heads": ["head-next"],
            "schema_unexpected_heads": ["head-old"],
        },
    )

    with pytest.raises(
        RuntimeError,
        match="missing_heads=head-next:unexpected_heads=head-old",
    ):
        bootstrap._validate_runtime_schema()


def test_runtime_schema_validation_accepts_current_schema(
    monkeypatch: MonkeyPatch,
) -> None:
    class SessionContext:
        def __enter__(self) -> object:
            return object()

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(bootstrap, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        bootstrap,
        "check_schema_current",
        lambda _session: {"schema_current": True},
    )

    bootstrap._validate_runtime_schema()


def test_scheduler_keeps_lane_failures_visible_while_other_lanes_run() -> None:
    scheduler = TradingScheduler()
    failed = _LaneStub("failed", run_error=RuntimeError("lane_broken"))
    healthy = _LaneStub("healthy")
    _install_lanes(scheduler, failed, healthy)

    async def exercise() -> None:
        await scheduler._run_trading_iteration()
        assert healthy.run_calls == 1
        assert scheduler.state.last_trading_error == "trading_lane[failed]:lane_broken"
        await scheduler._run_reconcile_iteration()
        assert "trading_lane[failed]:lane_broken" in str(scheduler.state.last_error)
        failed.run_error = None
        await scheduler._run_trading_iteration()

    with (
        patch.object(scheduler, "_emit_runtime_loop_failure"),
        patch.object(scheduler, "_evaluate_safety_controls"),
    ):
        asyncio.run(exercise())

    assert scheduler.state.last_error is None
    assert healthy.run_calls == 2


def test_scheduler_does_not_clobber_pipeline_owned_last_error() -> None:
    scheduler = TradingScheduler()

    def latch_pipeline_error() -> None:
        scheduler.state.universe_fail_safe_blocked = True
        scheduler.state.last_error = "universe_fail_safe_blocked"

    lane = _LaneStub(
        "primary",
        run_hook=latch_pipeline_error,
    )
    _install_lanes(scheduler, lane)

    with patch.object(scheduler, "_evaluate_safety_controls"):
        asyncio.run(scheduler._run_trading_iteration())

    assert scheduler.state.last_error == "universe_fail_safe_blocked"
    assert scheduler.state.last_trading_error is None

    lane.run_hook = None
    scheduler.state.universe_fail_safe_blocked = False
    with patch.object(scheduler, "_evaluate_safety_controls"):
        asyncio.run(scheduler._run_trading_iteration())

    assert scheduler.state.last_error is None


def test_command_auth_rejects_non_ascii_token(monkeypatch: MonkeyPatch) -> None:
    class RequestStub:
        headers = {"x-torghut-command-token": "nön-ascii"}

    monkeypatch.setattr(settings, "torghut_command_api_token", "ascii-token")

    with pytest.raises(HTTPException) as exc_info:
        command_auth.require_command_auth(cast(Request, RequestStub()))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "command_auth_required"
    assert command_auth._bearer_token("Basic opaque-token") is None
    assert not command_auth._tokens_match("\ud800", "ascii-token")


def test_command_auth_prefers_dedicated_header_over_ambient_bearer(
    monkeypatch: MonkeyPatch,
) -> None:
    class RequestStub:
        headers = {
            "authorization": "Bearer ambient-identity-token",
            "x-torghut-command-token": "command-token",
        }

    monkeypatch.setattr(settings, "torghut_command_api_token", "command-token")

    command_auth.require_command_auth(cast(Request, RequestStub()))


def test_scheduler_timeout_never_overlaps_lane_work(monkeypatch: MonkeyPatch) -> None:
    scheduler = TradingScheduler()
    release = Event()
    slow = _LaneStub("slow", hold=release)
    healthy = _LaneStub("healthy")
    _install_lanes(scheduler, slow, healthy)
    monkeypatch.setattr(settings, "trading_run_once_timeout_seconds", 0.01)
    monkeypatch.setattr(settings, "trading_lane_shutdown_timeout_seconds", 0.5)

    async def exercise() -> None:
        await scheduler._run_trading_iteration()
        assert slow.run_calls == 1
        assert healthy.run_calls == 1
        await scheduler._run_reconcile_iteration()
        assert slow.reconcile_calls == 0
        assert healthy.reconcile_calls == 1
        await scheduler._run_trading_iteration()
        assert slow.run_calls == 1
        assert healthy.run_calls == 2
        release.set()
        assert await scheduler._drain_lane_work()
        await scheduler._run_reconcile_iteration()
        assert slow.reconcile_calls == 1
        assert healthy.reconcile_calls == 2
        await scheduler._run_trading_iteration()

    with (
        patch.object(scheduler, "_emit_runtime_loop_failure"),
        patch.object(scheduler, "_evaluate_safety_controls"),
    ):
        asyncio.run(exercise())

    assert slow.run_calls == 2
    assert healthy.run_calls == 3
    assert scheduler.state.last_error is None


def test_scheduler_shutdown_skips_unsafe_cleanup_after_drain_timeout(
    monkeypatch: MonkeyPatch,
) -> None:
    scheduler = TradingScheduler()
    release = Event()
    slow = _LaneStub("slow", hold=release)
    _install_lanes(scheduler, slow)
    monkeypatch.setattr(settings, "trading_lane_shutdown_timeout_seconds", 0.01)

    async def exercise() -> None:
        with pytest.raises(TimeoutError):
            await scheduler._run_lane_work(
                operation="trading",
                account_label=slow.account_label,
                work=slow.run_once,
                timeout_seconds=0.01,
            )
        await scheduler.stop()
        release.set()

    asyncio.run(exercise())

    assert slow.order_feed_ingestor.close_calls == 0
    assert scheduler._lane_shutdown_incomplete


def test_scheduler_stop_cancels_loop_and_closes_drained_lane_resources() -> None:
    scheduler = TradingScheduler()
    lane = _LaneStub("primary")
    _install_lanes(scheduler, lane)

    async def exercise() -> None:
        scheduler._task = asyncio.create_task(asyncio.Event().wait())
        await scheduler.stop()

    asyncio.run(exercise())

    assert scheduler._task is None
    assert lane.order_feed_ingestor.close_calls == 1
    assert not scheduler._lane_shutdown_incomplete


def test_runtime_readyz_uses_only_bounded_runtime_dependencies(
    monkeypatch: MonkeyPatch,
) -> None:
    app = FastAPI()
    app.include_router(readiness.router)
    scheduler = TradingScheduler()
    scheduler.state.running = True
    app.state.trading_scheduler = scheduler
    monkeypatch.setattr(settings, "trading_enabled", True)
    monkeypatch.setattr(
        readiness,
        "_runtime_database_readiness_bounded",
        lambda: {"ok": True, "detail": "ok", "schema_current": True},
    )

    response = TestClient(app).get("/runtime-readyz")

    assert response.status_code == 200
    assert response.json()["readiness_surface"] == "bounded_runtime_dependencies"

    scheduler.state.last_error = "universe_fail_safe_blocked"
    response = TestClient(app).get("/runtime-readyz")
    assert response.status_code == 200

    scheduler.state.last_trading_error = "trading_lane[primary]:timed_out"
    response = TestClient(app).get("/runtime-readyz")
    assert response.status_code == 503


def test_runtime_readyz_rejects_missing_scheduler(monkeypatch: MonkeyPatch) -> None:
    app = FastAPI()
    app.include_router(readiness.router)
    monkeypatch.setattr(
        readiness,
        "_runtime_database_readiness_bounded",
        lambda: {"ok": True, "detail": "ok", "schema_current": True},
    )

    response = TestClient(app).get("/runtime-readyz")

    assert response.status_code == 503
    assert response.json()["scheduler"]["detail"] == (
        "trading scheduler not initialized"
    )


def test_evaluate_runtime_database_readiness_reads_schema_contract(
    monkeypatch: MonkeyPatch,
) -> None:
    session_marker = object()

    class SessionContext:
        def __enter__(self) -> object:
            return session_marker

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(readiness, "SessionLocal", SessionContext)
    monkeypatch.setattr(
        readiness,
        "check_schema_current",
        lambda session: {
            "schema_current": session is session_marker,
            "current_heads": ["head-current"],
            "expected_heads": ["head-current"],
        },
    )

    result = readiness._evaluate_runtime_database_readiness()

    assert result["ok"] is True
    assert result["detail"] == "ok"
    assert result["current_heads"] == ["head-current"]


def test_runtime_database_readiness_success_is_cached(
    monkeypatch: MonkeyPatch,
) -> None:
    calls = 0

    class ImmediateExecutor:
        def submit(
            self,
            function: Callable[[], dict[str, object]],
        ) -> Future[dict[str, object]]:
            nonlocal calls
            calls += 1
            future: Future[dict[str, object]] = Future()
            future.set_result(function())
            return future

    monkeypatch.setattr(readiness, "_RUNTIME_READINESS_EXECUTOR", ImmediateExecutor())
    monkeypatch.setattr(
        readiness,
        "_evaluate_runtime_database_readiness",
        lambda: {"ok": True, "detail": "ok", "schema_current": True},
    )
    monkeypatch.setattr(settings, "trading_runtime_readiness_cache_ttl_seconds", 60.0)
    monkeypatch.setattr(readiness, "_runtime_readiness_future", None)
    monkeypatch.setattr(readiness, "_runtime_readiness_cache", None)
    monkeypatch.setattr(readiness, "_runtime_readiness_cache_monotonic", 0.0)

    first = readiness._runtime_database_readiness_bounded()
    second = readiness._runtime_database_readiness_bounded()

    assert first["cache_used"] is False
    assert second["cache_used"] is True
    assert calls == 1


def test_runtime_database_readiness_timeout_is_single_flight(
    monkeypatch: MonkeyPatch,
) -> None:
    release = Event()
    calls = 0

    def blocked_check() -> dict[str, object]:
        nonlocal calls
        calls += 1
        release.wait()
        return {"ok": True, "detail": "ok", "schema_current": True}

    monkeypatch.setattr(
        readiness, "_evaluate_runtime_database_readiness", blocked_check
    )
    monkeypatch.setattr(settings, "trading_runtime_readiness_timeout_seconds", 0.01)
    monkeypatch.setattr(settings, "trading_runtime_readiness_cache_ttl_seconds", 0.0)
    monkeypatch.setattr(readiness, "_runtime_readiness_future", None)
    monkeypatch.setattr(readiness, "_runtime_readiness_cache", None)

    first = readiness._runtime_database_readiness_bounded()
    second = readiness._runtime_database_readiness_bounded()
    release.set()
    assert first["reason"] == "database_readiness_timeout"
    assert second["reason"] == "database_readiness_timeout"
    assert calls == 1


def test_runtime_database_readiness_clears_failed_future(
    monkeypatch: MonkeyPatch,
) -> None:
    calls = 0

    def failed_check() -> dict[str, object]:
        nonlocal calls
        calls += 1
        raise ValueError("invalid readiness payload")

    monkeypatch.setattr(readiness, "_evaluate_runtime_database_readiness", failed_check)
    monkeypatch.setattr(readiness, "_runtime_readiness_future", None)
    monkeypatch.setattr(readiness, "_runtime_readiness_cache", None)

    first = readiness._runtime_database_readiness_bounded()
    second = readiness._runtime_database_readiness_bounded()

    assert first["reason"] == "ValueError"
    assert second["reason"] == "ValueError"
    assert readiness._runtime_readiness_future is None
    assert calls == 2

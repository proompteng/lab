from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import cast
from unittest.mock import patch

from pytest import MonkeyPatch
from sqlalchemy.orm import Session

from app.api.health_cache_state import TRADING_DEPENDENCY_HEALTH_CACHE
from app.api.readiness_helpers import readiness_surface
from app.config import settings
from app.trading.scheduler import TradingScheduler


def _scheduler() -> TradingScheduler:
    scheduler = TradingScheduler()
    scheduler.state.running = True
    scheduler.state.last_run_at = datetime.now(timezone.utc)
    scheduler.state.market_session_open = True
    scheduler.state.universe_source_status = "ok"
    scheduler.state.universe_symbols_count = 2
    scheduler.state.universe_cache_age_seconds = 0
    return scheduler


def _dependencies(*, postgres_ok: bool = True) -> dict[str, object]:
    return {
        "postgres": {"ok": postgres_ok, "detail": "ok"},
        "clickhouse": {"ok": True, "detail": "ok"},
        "alpaca": {"ok": True, "detail": "ok"},
        "tigerbeetle": {"ok": True, "detail": "ok"},
        "database": {"ok": True, "detail": "ok"},
    }


def _freshness(*, stale: bool = False) -> dict[str, object]:
    return {
        "state": "current",
        "accepted_sources": ["ta"],
        "latest_accepted_event_at": datetime.now(timezone.utc).isoformat(),
        "accepted_lag_seconds": 600 if stale else 1,
        "accepted_max_lag_seconds": 300,
        "accepted_source_state": "stale" if stale else "current",
        "blocking_reason": "accepted_ta_signal_stale" if stale else None,
        "market_session_state": "regular_open",
        "regular_session_open": True,
    }


def _enable_live_runtime(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "trading_mode", "live")
    monkeypatch.setattr(settings, "trading_enabled", True)
    monkeypatch.setattr(settings, "trading_kill_switch_enabled", False)
    monkeypatch.setattr(settings, "trading_simple_submit_enabled", True)
    monkeypatch.setattr(settings, "trading_live_submit_enabled", True)


def test_readyz_allows_healthy_operational_runtime(monkeypatch: MonkeyPatch) -> None:
    _enable_live_runtime(monkeypatch)
    scheduler = _scheduler()
    checked_at = datetime.now(timezone.utc)
    with (
        patch.object(
            readiness_surface, "get_trading_scheduler", return_value=scheduler
        ),
        patch.object(
            readiness_surface,
            "readiness_dependency_snapshot",
            return_value=(_dependencies(), checked_at, False),
        ),
        patch(
            "app.api.readiness_helpers.status_dependencies.load_clickhouse_ta_status",
            return_value=_freshness(),
        ),
        patch(
            "app.trading.submission_council._alpaca_broker_available",
            return_value=True,
        ),
    ):
        payload, status_code = readiness_surface.evaluate_core_readiness_payload(
            include_database_contract=True
        )

    assert status_code == 200
    assert payload["status"] == "ok"
    gate = payload["live_submission_gate"]
    assert isinstance(gate, dict)
    assert gate["allowed"] is True
    assert gate["reason"] == "operational_submission_ready"
    assert "promotion_authority" not in gate
    assert "proof_floor" not in payload


def test_readyz_blocks_stale_accepted_ta(monkeypatch: MonkeyPatch) -> None:
    _enable_live_runtime(monkeypatch)
    scheduler = _scheduler()
    with (
        patch.object(
            readiness_surface, "get_trading_scheduler", return_value=scheduler
        ),
        patch.object(
            readiness_surface,
            "readiness_dependency_snapshot",
            return_value=(_dependencies(), datetime.now(timezone.utc), False),
        ),
        patch(
            "app.api.readiness_helpers.status_dependencies.load_clickhouse_ta_status",
            return_value=_freshness(stale=True),
        ),
        patch(
            "app.trading.submission_council._alpaca_broker_available",
            return_value=True,
        ),
    ):
        payload, status_code = readiness_surface.evaluate_core_readiness_payload()

    assert status_code == 503
    gate = payload["live_submission_gate"]
    assert isinstance(gate, dict)
    assert gate["allowed"] is False
    assert gate["reason"] == "accepted_ta_signal_stale"


def test_readyz_dependency_health_does_not_rewrite_submission_authority(
    monkeypatch: MonkeyPatch,
) -> None:
    _enable_live_runtime(monkeypatch)
    with (
        patch(
            "app.api.readiness_helpers.status_dependencies.load_clickhouse_ta_status",
            return_value=_freshness(),
        ),
        patch(
            "app.trading.submission_council._alpaca_broker_available",
            return_value=True,
        ),
    ):
        gate = readiness_surface.readiness_live_submission_gate(_scheduler())

    assert gate["allowed"] is True
    assert gate["reason"] == "operational_submission_ready"
    assert gate["blocked_reasons"] == []


def test_readyz_gate_fails_closed_when_freshness_read_fails() -> None:
    with patch(
        "app.api.readiness_helpers.status_dependencies.load_clickhouse_ta_status",
        side_effect=RuntimeError("clickhouse unavailable"),
    ):
        gate = readiness_surface.readiness_live_submission_gate(
            _scheduler(),
        )

    assert gate["allowed"] is False
    assert gate["reason"] == "readiness_live_submission_gate_unavailable"
    assert gate["read_model_unavailable"] is True


def test_dependency_snapshot_can_reuse_stale_cache_within_tolerance(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "trading_readiness_dependency_cache_enabled", True)
    monkeypatch.setattr(settings, "trading_readiness_dependency_cache_ttl_seconds", 8)
    monkeypatch.setattr(
        settings,
        "trading_readiness_dependency_cache_stale_tolerance_seconds",
        20,
    )
    cache_key = readiness_surface.readiness_dependency_cache_key(True)
    checked_at = datetime.now(timezone.utc) - timedelta(seconds=12)
    TRADING_DEPENDENCY_HEALTH_CACHE[cache_key] = {
        "checked_at": checked_at,
        "dependencies": _dependencies(postgres_ok=False),
    }
    try:
        with patch.object(
            readiness_surface,
            "readiness_dependency_checks",
            side_effect=AssertionError("stale cache should be reused"),
        ):
            dependencies, actual_checked_at, cache_used = (
                readiness_surface.readiness_dependency_snapshot(
                    cast(Session, object()),
                    include_database_contract=True,
                    allow_stale_dependency_cache=True,
                )
            )
    finally:
        TRADING_DEPENDENCY_HEALTH_CACHE.pop(cache_key, None)

    assert cache_used is True
    assert actual_checked_at == checked_at
    assert dependencies["postgres"] == {"ok": False, "detail": "ok"}

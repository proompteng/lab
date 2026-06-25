from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

import pytest
from fastapi import HTTPException
from pytest import MonkeyPatch
from sqlalchemy.orm import Session

from app.api.trading_misc import lean_backtests, simulation_progress
from app.config import settings


@dataclass(frozen=True)
class FakeLeanBacktestRow:
    backtest_id: str = "bt-1"
    status: str = "submitted"
    lane: str = "research"
    reproducibility_hash: str = "hash-1"
    requested_by: str | None = "codex"
    created_at: str = "2026-06-25T20:00:00+00:00"
    result_json: dict[str, object] | None = None
    artifacts_json: dict[str, object] | None = None
    replay_hash: str | None = "replay-1"
    deterministic_replay_passed: bool | None = True
    failure_taxonomy: str | None = None
    completed_at: str | None = "2026-06-25T20:01:00+00:00"


class FakeLeanLaneManager:
    def __init__(self) -> None:
        self.submit_error: RuntimeError | None = None
        self.refresh_error: RuntimeError | None = None
        self.submitted: list[dict[str, object]] = []

    def submit_backtest(
        self,
        session: Session,
        *,
        config: dict[str, object],
        lane: str,
        requested_by: str | None,
        correlation_id: str,
    ) -> FakeLeanBacktestRow:
        _ = session
        if self.submit_error is not None:
            raise self.submit_error
        self.submitted.append(
            {
                "config": config,
                "lane": lane,
                "requested_by": requested_by,
                "correlation_id": correlation_id,
            }
        )
        return FakeLeanBacktestRow(lane=lane, requested_by=requested_by)

    def refresh_backtest(
        self, session: Session, *, backtest_id: str
    ) -> FakeLeanBacktestRow:
        _ = session
        if self.refresh_error is not None:
            raise self.refresh_error
        return FakeLeanBacktestRow(backtest_id=backtest_id, status="completed")

    def parity_summary(
        self, session: Session, *, lookback_hours: int
    ) -> dict[str, object]:
        _ = session
        return {"lookback_hours": lookback_hours, "status": "ok"}


@pytest.fixture()
def lean_settings() -> None:
    original_disable = settings.trading_lean_lane_disable_switch
    original_enabled = settings.trading_lean_backtest_enabled
    settings.trading_lean_lane_disable_switch = False
    settings.trading_lean_backtest_enabled = True
    try:
        yield
    finally:
        settings.trading_lean_lane_disable_switch = original_disable
        settings.trading_lean_backtest_enabled = original_enabled


def test_lean_backtest_routes_use_explicit_manager_contract(
    monkeypatch: MonkeyPatch, lean_settings: None
) -> None:
    _ = lean_settings
    manager = FakeLeanLaneManager()
    session = cast(Session, object())
    monkeypatch.setattr(lean_backtests, "LEAN_LANE_MANAGER", manager)

    submitted = lean_backtests.submit_lean_backtest(
        payload={"lane": "governance", "config": {"alpha": 1}},
        requested_by="codex",
        session=session,
    )
    fetched = lean_backtests.get_lean_backtest("bt-2", session=session)
    parity = lean_backtests.get_lean_shadow_parity(lookback_hours=12, session=session)

    assert submitted["backtest_id"] == "bt-1"
    assert submitted["lane"] == "governance"
    assert manager.submitted[0]["config"] == {"alpha": 1}
    assert str(manager.submitted[0]["correlation_id"]).startswith("torghut-backtest-")
    assert fetched["backtest_id"] == "bt-2"
    assert fetched["status"] == "completed"
    assert parity == {"lookback_hours": 12, "status": "ok"}


def test_lean_backtest_routes_report_configuration_and_manager_errors(
    monkeypatch: MonkeyPatch, lean_settings: None
) -> None:
    _ = lean_settings
    session = cast(Session, object())
    manager = FakeLeanLaneManager()
    monkeypatch.setattr(lean_backtests, "LEAN_LANE_MANAGER", manager)

    settings.trading_lean_lane_disable_switch = True
    with pytest.raises(HTTPException) as disabled_exc:
        lean_backtests.submit_lean_backtest(payload={"config": {}}, session=session)
    assert disabled_exc.value.status_code == 409
    assert disabled_exc.value.detail == "lean_lane_disabled"

    settings.trading_lean_lane_disable_switch = False
    settings.trading_lean_backtest_enabled = False
    with pytest.raises(HTTPException) as backtest_disabled_exc:
        lean_backtests.submit_lean_backtest(payload={"config": {}}, session=session)
    assert backtest_disabled_exc.value.status_code == 409
    assert backtest_disabled_exc.value.detail == "lean_backtest_lane_disabled"

    settings.trading_lean_backtest_enabled = True
    with pytest.raises(HTTPException) as config_exc:
        lean_backtests.submit_lean_backtest(payload={"config": []}, session=session)
    assert config_exc.value.status_code == 400
    assert config_exc.value.detail == "config_must_be_object"

    manager.submit_error = RuntimeError("upstream_down")
    with pytest.raises(HTTPException) as submit_exc:
        lean_backtests.submit_lean_backtest(payload={"config": {}}, session=session)
    assert submit_exc.value.status_code == 502
    assert submit_exc.value.detail == "upstream_down"

    manager.refresh_error = RuntimeError("lean_backtest_not_found")
    with pytest.raises(HTTPException) as missing_exc:
        lean_backtests.get_lean_backtest("missing", session=session)
    assert missing_exc.value.status_code == 404
    assert missing_exc.value.detail == "lean_backtest_not_found"

    manager.refresh_error = RuntimeError("refresh_down")
    with pytest.raises(HTTPException) as refresh_exc:
        lean_backtests.get_lean_backtest("bt-1", session=session)
    assert refresh_exc.value.status_code == 502
    assert refresh_exc.value.detail == "refresh_down"


def test_simulation_progress_route_adds_request_and_runtime_context(
    monkeypatch: MonkeyPatch,
) -> None:
    session = cast(Session, object())
    original_enabled = settings.trading_simulation_enabled
    original_run_id = settings.trading_simulation_run_id
    settings.trading_simulation_enabled = True
    settings.trading_simulation_run_id = "fallback-run"

    def fake_snapshot(
        snapshot_session: Session, *, run_id: str | None
    ) -> dict[str, Any]:
        assert snapshot_session is session
        return {"snapshot_run_id": run_id}

    def fake_runtime_context(runtime_session: Session) -> dict[str, object]:
        assert runtime_session is session
        return {"run_id": "active-run"}

    monkeypatch.setattr(
        simulation_progress, "simulation_progress_snapshot", fake_snapshot
    )
    monkeypatch.setattr(
        simulation_progress,
        "active_simulation_runtime_context",
        fake_runtime_context,
    )

    try:
        payload = simulation_progress.trading_simulation_progress(
            run_id="requested-run",
            session=session,
        )
    finally:
        settings.trading_simulation_enabled = original_enabled
        settings.trading_simulation_run_id = original_run_id

    assert payload == {
        "snapshot_run_id": "requested-run",
        "requested_run_id": "requested-run",
        "active_run_id": "active-run",
        "simulation_enabled": True,
    }

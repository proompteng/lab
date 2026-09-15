"""Tests for Hyperliquid execution runtime status API."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.hyperliquid_execution import api
from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.models import CycleResult, RuntimeDependencyStatus
from app.trading.loop_status import LoopStatusOptions


@contextmanager
def _runtime_state(
    *,
    config: HyperliquidExecutionConfig,
    cycle: CycleResult | None,
    latest_error: str | None = None,
) -> Iterator[None]:
    old_config = api.runtime_state.config
    old_cycle = api.runtime_state.latest_cycle
    old_error = api.runtime_state.latest_error
    try:
        api.runtime_state.config = config
        api.runtime_state.latest_cycle = cycle
        api.runtime_state.latest_error = latest_error
        yield
    finally:
        api.runtime_state.config = old_config
        api.runtime_state.latest_cycle = old_cycle
        api.runtime_state.latest_error = old_error


def test_trading_status_projects_runtime_cycle_and_compatibility_gate() -> None:
    cycle = CycleResult(
        observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        markets_seen=1,
        selected_coins=("BTC",),
        signals_written=1,
        orders_submitted=1,
        orders_cancelled=0,
        dependencies=(RuntimeDependencyStatus("hyperliquid_feed_service", True),),
        universe_details={"selected": ["BTC"]},
    )
    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_ENABLED": "false"}
    )

    with _runtime_state(config=config, cycle=cycle):
        payload = api.trading_status()

    assert payload["ready"] is True
    assert payload["execution_route"] == "testnet"
    assert payload["latest_cycle"]["orders_submitted"] == 1
    assert payload["config"]["feed_readiness_url_configured"] is False
    assert payload["config"]["marketable_ioc_slippage_bps"] == "0"
    assert payload["dependencies"][0]["name"] == "hyperliquid_feed_service"
    assert payload["operational_submission_gate"]["enabled"] is False
    assert payload["operational_submission_gate"]["blockers"] == [
        "runtime_disabled",
        "trading_disabled",
    ]
    assert payload["live_submission_gate"] == payload["operational_submission_gate"]


def test_trading_loop_status_route_uses_loop_proof_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _Session:
        def close(self) -> None:
            captured["closed"] = True

    def fake_session_local() -> _Session:
        session = _Session()
        captured["session"] = session
        return session

    def fake_build(
        session: object,
        *,
        options: LoopStatusOptions,
    ) -> dict[str, object]:
        captured["build_session"] = session
        captured["options"] = options
        return {
            "schema_version": "torghut.trading-loop-status.v1",
            "restored": False,
            "runtime": {"status": "blocked"},
            "market_data": {"fresh": False},
            "fills": {"recent_count": 0},
            "position": {"reconciled": False},
            "blocker_reasons": ["hyperliquid_market_data_not_fresh"],
        }

    monkeypatch.setattr(api, "SessionLocal", fake_session_local)
    monkeypatch.setattr(api, "build_trading_loop_status", fake_build)
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ENABLED": "false",
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_EXECUTION_NETWORK": "testnet",
        }
    )

    with _runtime_state(config=config, cycle=None):
        response = TestClient(api.app).get("/trading/loop/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == "torghut.trading-loop-status.v1"
    assert payload["restored"] is False
    assert payload["runtime"]["status"] == "blocked"
    assert "ready" not in payload
    assert "latest_cycle" not in payload
    assert captured["build_session"] is captured["session"]
    assert captured["closed"] is True
    assert isinstance(captured["options"], LoopStatusOptions)
    options = captured["options"]
    assert isinstance(options, LoopStatusOptions)
    assert options.trading_mode == "paper"
    assert options.trading_enabled is True


def test_trading_status_reports_operational_gate_without_alpha_blockers() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "secret",
            "HYPERLIQUID_EXECUTION_FEED_READINESS_URL": (
                "http://torghut-hyperliquid-feed.torghut.svc.cluster.local/readyz"
            ),
        }
    )
    cycle = CycleResult(
        observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        markets_seen=12,
        selected_coins=("BTC", "ETH"),
        signals_written=2,
        orders_submitted=0,
        orders_cancelled=0,
        dependencies=(
            RuntimeDependencyStatus(
                "hyperliquid_feed_service",
                False,
                reason="clickhouse_not_fresh,market_data_stale",
            ),
        ),
        universe_details={"selected": ["BTC", "ETH"]},
    )

    with _runtime_state(config=config, cycle=cycle):
        payload = api.trading_status()

    assert payload["ready"] is False
    assert payload["execution_route"] == "testnet"
    assert payload["config"]["feed_readiness_url_configured"] is True
    assert payload["dependencies"][0]["name"] == "hyperliquid_feed_service"
    blockers = payload["operational_submission_gate"]["blockers"]
    assert blockers == ["dependency_not_ready:hyperliquid_feed_service"]
    assert payload["operational_submission_gate"]["enabled"] is False
    assert payload["live_submission_gate"] == payload["operational_submission_gate"]
    assert "non_operational_diagnostic" not in blockers
    assert "proof_collection_pending" not in blockers
    assert "research_evidence_missing" not in blockers

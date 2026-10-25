from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import settings
from app.trading.submission_council import build_live_submission_gate_payload


@pytest.fixture(autouse=True)
def _live_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "trading_enabled", True)
    monkeypatch.setattr(settings, "trading_mode", "live")
    monkeypatch.setattr(settings, "trading_kill_switch_enabled", False)
    monkeypatch.setattr(settings, "trading_simple_submit_enabled", True)
    monkeypatch.setattr(settings, "trading_live_submit_enabled", True)
    monkeypatch.setattr(settings, "trading_emergency_stop_enabled", True)
    monkeypatch.setattr(
        "app.trading.submission_council._alpaca_broker_available",
        lambda: True,
    )


def _state(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "market_session_open": True,
        "capital_new_exposure_allowed": True,
        "emergency_stop_active": False,
        "signal_continuity_alert_active": False,
        "market_context_alert_active": False,
        "universe_fail_safe_blocked": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _gate(
    state: SimpleNamespace,
    *,
    accepted_source_state: str | None = "fresh",
) -> dict[str, object]:
    freshness = (
        {
            "accepted_sources": ["ta"],
            "accepted_source_state": accepted_source_state,
            "accepted_lag_seconds": 2,
            "accepted_max_lag_seconds": 300,
        }
        if accepted_source_state is not None
        else None
    )
    return build_live_submission_gate_payload(
        state,
        clickhouse_ta_status=freshness,
    )


def test_fresh_operational_dependencies_allow_live_submission() -> None:
    gate = _gate(_state())

    assert gate["allowed"] is True
    assert gate["reason"] == "operational_submission_ready"
    assert gate["capital_state"] == "live"
    assert gate["new_exposure_allowed"] is True
    assert gate["accepted_sources"] == ["ta"]
    assert "promotion_eligible_total" not in gate
    assert "paper_probation_eligible_total" not in gate
    assert "profit_window_contract" not in gate


@pytest.mark.parametrize(
    ("accepted_source_state", "expected_reason"),
    [
        ("stale", "accepted_ta_signal_stale"),
        ("missing", "accepted_ta_signal_missing"),
        ("unavailable", "accepted_ta_signal_unavailable"),
        (None, "accepted_ta_signal_unavailable"),
    ],
)
def test_accepted_source_failures_block_live_submission(
    accepted_source_state: str | None,
    expected_reason: str,
) -> None:
    gate = _gate(
        _state(),
        accepted_source_state=accepted_source_state,
    )

    assert gate["allowed"] is False
    assert expected_reason in gate["blocked_reasons"]


def test_closed_session_cannot_route_live_orders() -> None:
    gate = _gate(_state(market_session_open=False))

    assert gate["allowed"] is False
    assert "mainnet_route_unavailable" in gate["blocked_reasons"]
    assert gate["execution_route"] == {
        "route": "closed",
        "reason": "alpaca_regular_session_closed",
        "alpaca_regular_session_open": False,
    }


@pytest.mark.parametrize(
    ("state_override", "expected_reason"),
    [
        ({"signal_continuity_alert_active": True}, "signal_continuity_alert_active"),
        ({"market_context_alert_active": True}, "market_context_alert_active"),
        ({"universe_fail_safe_blocked": True}, "universe_fail_safe_blocked"),
    ],
)
def test_runtime_safety_state_blocks_live_submission(
    state_override: dict[str, object],
    expected_reason: str,
) -> None:
    gate = _gate(_state(**state_override))

    assert gate["allowed"] is False
    assert expected_reason in gate["blocked_reasons"]


def test_new_exposure_cutoff_keeps_reduce_only_submission_route_available() -> None:
    gate = _gate(_state(capital_new_exposure_allowed=False))

    assert gate["allowed"] is True
    assert gate["new_exposure_allowed"] is False
    assert gate["blocked_reasons"] == []

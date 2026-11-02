from __future__ import annotations

from app.api.readiness_helpers import readiness_surface as readiness_surface_helpers


def test_live_submission_gate_dependency_marks_startup_grace_suppression() -> None:
    payload = readiness_surface_helpers.readiness_live_submission_gate_dependency(
        {
            "allowed": False,
            "reason": "trading_loop_startup_readiness_grace_active",
            "capital_stage": "shadow",
            "clickhouse_ta_freshness": {
                "accepted_source_state": "current",
                "accepted_lag_seconds": 7,
                "accepted_max_lag_seconds": 60,
                "blocking_reason": None,
            },
        },
        startup_readiness_grace_active=True,
    )

    assert payload["ok"] is True
    assert payload["startup_readiness_grace_active"] is True
    assert (
        payload["readiness_gate_suppressed"]
        == "trading_loop_startup_readiness_grace_active"
    )


def test_startup_grace_does_not_suppress_operational_blockers() -> None:
    payload = readiness_surface_helpers.readiness_live_submission_gate_dependency(
        {
            "allowed": False,
            "reason": "kill_switch_enabled",
            "blocked_reasons": ["kill_switch_enabled"],
            "capital_stage": "shadow",
            "clickhouse_ta_freshness": {"accepted_source_state": "current"},
        },
        startup_readiness_grace_active=True,
    )

    assert payload["ok"] is False
    assert "readiness_gate_suppressed" not in payload


def test_startup_grace_does_not_suppress_mixed_operational_blockers() -> None:
    payload = readiness_surface_helpers.readiness_live_submission_gate_dependency(
        {
            "allowed": False,
            "reason": "trading_loop_startup_readiness_grace_active",
            "blocked_reasons": [
                "trading_loop_startup_readiness_grace_active",
                "kill_switch_enabled",
            ],
            "capital_stage": "shadow",
            "clickhouse_ta_freshness": {"accepted_source_state": "current"},
        },
        startup_readiness_grace_active=True,
    )

    assert payload["ok"] is False
    assert "readiness_gate_suppressed" not in payload

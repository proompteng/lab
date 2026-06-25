from __future__ import annotations

from app.api.readiness_helpers.evaluate_trading_health_payload import (
    split_runtime_and_proof_lane_dependencies,
)


def test_proof_lane_degradation_does_not_fail_runtime_health() -> None:
    sections = split_runtime_and_proof_lane_dependencies(
        {
            "database": {"ok": True},
            "universe": {"ok": True},
            "live_submission_gate": {"ok": False, "detail": "proof_blocked"},
            "profitability_proof_floor": {"ok": False, "detail": "repair_only"},
        },
        scheduler_ok=True,
    )

    assert sections["runtime"]["ok"] is True
    assert sections["runtime"]["status"] == "ok"
    assert sections["proof_lane"]["ok"] is False
    assert sections["proof_lane"]["hot_path_authority"] is False
    assert sections["proof_lane"]["required_for_runtime_health"] is False


def test_runtime_dependency_degradation_still_fails_runtime_health() -> None:
    sections = split_runtime_and_proof_lane_dependencies(
        {
            "database": {"ok": False, "detail": "unavailable"},
            "live_submission_gate": {"ok": True},
        },
        scheduler_ok=True,
    )

    assert sections["runtime"]["ok"] is False
    assert sections["runtime"]["status"] == "degraded"

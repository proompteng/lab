from __future__ import annotations

from types import SimpleNamespace

from app.api.readiness_helpers.evaluate_trading_health_payload import (
    split_runtime_and_proof_lane_dependencies,
)
from app.api.readiness_helpers.trading_health_proof_lane_repair_payloads import (
    _evidence_clock_payloads,
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


def test_evidence_clock_payloads_loads_clickhouse_ta_status_when_missing() -> None:
    loaded: list[object] = []

    def _load_clickhouse_ta_status(scheduler: object) -> dict[str, object]:
        loaded.append(scheduler)
        return {"state": "current", "source": "loaded"}

    def _build_evidence_clock_payloads(
        **kwargs: object,
    ) -> tuple[dict[str, object], dict[str, object]]:
        assert kwargs["clickhouse_ta_status"] == {
            "state": "current",
            "source": "loaded",
        }
        return {"clock": True}, {"exchange": True}

    proof_lane = SimpleNamespace(
        context=SimpleNamespace(scheduler="scheduler"),
        dependency_quorum=SimpleNamespace(as_payload=lambda: {"decision": "allow"}),
        deps=SimpleNamespace(
            active_runtime_revision=lambda: "test-revision",
            load_clickhouse_ta_status=_load_clickhouse_ta_status,
            build_evidence_clock_payloads=_build_evidence_clock_payloads,
        ),
        payloads={
            "empirical_jobs": {},
            "hypothesis_payload": {},
            "live_submission_gate": {},
            "market_context_status": {},
            "profit_signal_quorum": {},
            "proof_floor": {},
            "quant_evidence": {},
            "routeability_repair_acceptance_ledger": {},
            "tca_summary": {},
        },
    )

    assert _evidence_clock_payloads(proof_lane) == (
        {"clock": True},
        {"exchange": True},
    )
    assert loaded == ["scheduler"]

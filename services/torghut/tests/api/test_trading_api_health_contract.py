from __future__ import annotations

from collections.abc import Callable

from tests.api.trading_api_support import (
    SimpleNamespace,
    TradingApiTestCaseBase,
    TradingScheduler,
    _mark_static_universe_loaded,
    app,
    datetime,
    patch,
    timezone,
)


def _current_clickhouse_ta_status() -> dict[str, object]:
    return {
        "accepted_sources": ["ta"],
        "latest_accepted_event_at": "2026-07-08T12:07:15Z",
        "accepted_lag_seconds": 150,
        "accepted_source_state": "current",
        "blocking_reason": None,
    }


def _healthy_dependency_snapshot(
    checked_at: datetime,
) -> tuple[dict[str, object], datetime, bool]:
    return (
        {
            "postgres": {"ok": True, "detail": "ok"},
            "clickhouse": {"ok": True, "detail": "ok"},
            "alpaca": {"ok": True, "detail": "ok"},
            "tigerbeetle": {"ok": True, "detail": "ok"},
        },
        checked_at,
        False,
    )


def _recording_hypothesis_runtime_builder(
    calls: list[dict[str, object]],
) -> Callable[..., tuple[dict[str, object], dict[str, object], SimpleNamespace]]:
    def _build_hypothesis_runtime(
        *_args: object, **kwargs: object
    ) -> tuple[dict[str, object], dict[str, object], SimpleNamespace]:
        calls.append(dict(kwargs))
        summary = {
            "promotion_eligible_total": 1,
            "capital_stage_totals": {"shadow": 1},
            "dependency_quorum": {
                "decision": "allow",
                "reasons": [],
                "message": "ready",
            },
        }
        return (
            {
                "registry_loaded": True,
                "registry_path": "test",
                "registry_errors": [],
                "dependency_quorum": summary["dependency_quorum"],
                "summary": summary,
                "items": [],
            },
            summary,
            SimpleNamespace(
                decision="allow",
                as_payload=lambda: summary["dependency_quorum"],
            ),
        )

    return _build_hypothesis_runtime


def _recording_live_gate_builder(
    calls: list[dict[str, object]],
) -> Callable[..., dict[str, object]]:
    def _build_gate(_state: object, **kwargs: object) -> dict[str, object]:
        calls.append(dict(kwargs))
        return {
            "allowed": True,
            "reason": "operational_submission_ready",
            "blocked_reasons": [],
            "reason_codes": [],
            "read_model_unavailable": False,
            "promotion_authority": True,
            "promotion_authority_ok": True,
            "final_authority_ok": True,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "capital_stage": "live",
            "capital_state": "live",
            "clickhouse_ta_freshness": kwargs["clickhouse_ta_status"],
        }

    return _build_gate


def _install_running_scheduler() -> object | None:
    original_scheduler = getattr(app.state, "trading_scheduler", None)
    scheduler = TradingScheduler()
    scheduler.state.running = True
    scheduler.state.last_run_at = datetime.now(timezone.utc)
    _mark_static_universe_loaded(scheduler)
    app.state.trading_scheduler = scheduler
    return original_scheduler


def _restore_scheduler(original_scheduler: object | None) -> None:
    if original_scheduler is None:
        if hasattr(app.state, "trading_scheduler"):
            del app.state.trading_scheduler
    else:
        app.state.trading_scheduler = original_scheduler


class TestTradingApiHealthContract(TradingApiTestCaseBase):
    def test_readyz_does_not_evaluate_trading_health_proof_lane(self) -> None:
        with patch(
            "app.api.readiness_helpers.status_dependencies.build_profitability_proof_floor_payload"
        ) as proof_floor:
            response = self.client.get("/readyz")

        self.assertIn(response.status_code, {200, 503})
        payload = response.json()
        self.assertEqual(
            payload["readiness_surface"],
            "core_dependencies_and_live_submission_gate",
        )
        self.assertIn("live_submission_gate", payload["dependencies"])
        proof_floor.assert_not_called()

    def test_trading_health_runtime_degradation_strips_live_gate_authority(
        self,
    ) -> None:
        checked_at = datetime.now(timezone.utc)
        live_submission_gate = {
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "read_model_unavailable": False,
            "promotion_authority": True,
            "promotion_authority_ok": True,
            "final_authority_ok": True,
            "final_promotion_allowed": True,
            "final_promotion_authorized": True,
            "capital_stage": "live",
        }

        def _dependency_snapshot(
            *_args: object, **_kwargs: object
        ) -> tuple[
            dict[str, object],
            datetime,
            bool,
        ]:
            return (
                {
                    "postgres": {"ok": False, "detail": "down"},
                    "clickhouse": {"ok": True, "detail": "ok"},
                    "alpaca": {"ok": True, "detail": "ok"},
                    "tigerbeetle": {"ok": True, "detail": "ok"},
                },
                checked_at,
                False,
            )

        with (
            patch(
                "app.api.readiness_helpers.evaluate_trading_health_payload._readiness_dependency_snapshot",
                side_effect=_dependency_snapshot,
            ),
            patch(
                "app.api.readiness_helpers.status_dependencies.build_api_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
        ):
            response = self.client.get("/trading/health")

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["runtime"]["status"], "degraded")
        self.assertFalse(payload["runtime"]["ok"])
        self.assertFalse(payload["proof_lane"]["required_for_runtime_health"])
        gate = payload["live_submission_gate"]
        self.assertFalse(gate["allowed"])
        self.assertFalse(gate["promotion_authority"])
        self.assertFalse(gate["final_authority_ok"])
        self.assertFalse(gate["final_promotion_allowed"])
        self.assertTrue(gate["readiness_dependency_guard_active"])

    def test_trading_health_uses_one_current_clickhouse_ta_status_for_gate(
        self,
    ) -> None:
        original_scheduler = _install_running_scheduler()
        checked_at = datetime.now(timezone.utc)
        clickhouse_ta_status = _current_clickhouse_ta_status()
        hypothesis_calls: list[dict[str, object]] = []
        gate_calls: list[dict[str, object]] = []

        try:
            with (
                patch(
                    "app.api.readiness_helpers.evaluate_trading_health_payload._readiness_dependency_snapshot",
                    side_effect=(
                        lambda *_args, **_kwargs: _healthy_dependency_snapshot(
                            checked_at
                        )
                    ),
                ),
                patch(
                    "app.api.readiness_helpers.status_dependencies.load_clickhouse_ta_status",
                    return_value=clickhouse_ta_status,
                ),
                patch(
                    "app.api.readiness_helpers.status_dependencies.load_tca_summary",
                    return_value={},
                ),
                patch(
                    "app.api.readiness_helpers.status_dependencies.build_hypothesis_runtime_payload",
                    side_effect=_recording_hypothesis_runtime_builder(hypothesis_calls),
                ),
                patch(
                    "app.api.readiness_helpers.status_dependencies.empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.api.readiness_helpers.evaluate_trading_health_payload.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                        "blocking_reasons": [],
                        "account": "paper",
                        "window": "15m",
                    },
                ),
                patch(
                    "app.api.readiness_helpers.status_dependencies.build_api_live_submission_gate_payload",
                    side_effect=_recording_live_gate_builder(gate_calls),
                ),
            ):
                response = self.client.get("/trading/health")

            self.assertIn(response.status_code, {200, 503})
            self.assertEqual(
                hypothesis_calls[0]["feature_readiness"],
                clickhouse_ta_status,
            )
            self.assertEqual(
                gate_calls[0]["clickhouse_ta_status"],
                clickhouse_ta_status,
            )
            self.assertEqual(
                response.json()["live_submission_gate"]["clickhouse_ta_freshness"],
                clickhouse_ta_status,
            )
        finally:
            _restore_scheduler(original_scheduler)

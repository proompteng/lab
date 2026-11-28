from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import call, patch

from scripts.historical_simulation_startup import (
    RolloutsAnalysisConfig,
    _build_resources,
    _run_full_lifecycle,
    _runtime_verify,
    argocd_rollouts,
    lifecycle,
)
from tests.historical_simulation.fixtures import (
    SimulationOrchestrationTestCase,
    disabled_rollouts_config,
    make_argocd_config,
    make_clickhouse_config,
    make_kafka_config,
    make_postgres_config,
    open_hour_resources,
    open_hour_trading_env,
    patch_ready_compute,
    ready_knative_service,
    simulation_resources,
)


class TestStartHistoricalSimulationLifecycleC(SimulationOrchestrationTestCase):
    def test_run_full_lifecycle_fails_before_teardown_clean_when_teardown_settle_not_ready(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-settle-fail",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = make_kafka_config()
        clickhouse_config = make_clickhouse_config(
            password=None,
        )
        postgres_config = make_postgres_config(
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_teardown_settle_fail",
            simulation_db="torghut_sim_teardown_settle_fail",
        )
        argocd_config = make_argocd_config(
            manage_automation=True,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace="torghut",
            runtime_template="torghut-simulation-runtime-ready",
            activity_template="torghut-simulation-activity",
            teardown_template="torghut-simulation-teardown-clean",
            artifact_template="torghut-simulation-artifact-bundle",
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )
        call_order: list[str] = []

        def _rollouts_side_effect(*, phase: str, **_: object) -> dict[str, object]:
            call_order.append(phase)
            return {"phase": "Successful"}

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_ensure_supported_binary",
                    return_value=None,
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_update_run_state",
                    return_value=None,
                )
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_save_json",
                    return_value=None,
                )
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "persist_completion_trace",
                    return_value={},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_upsert_simulation_progress_row",
                    return_value=None,
                ),
            )
            mock_session_local = stack.enter_context(
                patch.object(lifecycle, "SessionLocal")
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_read_argocd_automation_mode",
                    return_value={"mode": "auto"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_read_named_argocd_application_sync_policy",
                    return_value={"sync_policy": {"automated": {"enabled": True}}},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_read_argocd_application_sync_policy",
                    return_value={
                        "sync_policy": {"automated": {"enabled": True}},
                        "automation_mode": "auto",
                        "ignore_differences": [],
                    },
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_prepare_argocd_for_run",
                    return_value={"managed": False},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_restore_argocd_after_run",
                    side_effect=lambda **_: (
                        call_order.append("argocd_restore") or {"managed": False}
                    ),
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_apply",
                    return_value={"status": "ok"},
                )
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_run_rollouts_analysis",
                    side_effect=_rollouts_side_effect,
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_runtime_verify",
                    return_value={"runtime_state": "ready"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_replay_dump",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_monitor_run_completion",
                    return_value={
                        "status": "ok",
                        "activity_classification": "success",
                        "final_snapshot": {
                            "signal_rows": 5,
                            "price_rows": 5,
                            "trade_decisions": 3,
                            "cursor_at": "2026-02-27T21:00:00Z",
                            "executions": 2,
                            "execution_tca_metrics": 2,
                            "execution_order_events": 2,
                        },
                    },
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_report_simulation",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_build_strategy_proof_artifact",
                    return_value={"status": "ok", "legacy_path_count": 0},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_teardown",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_wait_for_torghut_service_revision_ready",
                    return_value={
                        "ready": False,
                        "condition_ready": "Unknown",
                        "latest_created_revision": "torghut-sim-00002",
                        "latest_ready_revision": "torghut-sim-00001",
                        "revision_settled": False,
                    },
                ),
            )
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "simulation_run_failed:teardown_settle:runtime_not_ready",
            ):
                _run_full_lifecycle(
                    resources=resources,
                    manifest=manifest,
                    manifest_path=Path("/tmp/manifest.json"),
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=postgres_config,
                    argocd_config=argocd_config,
                    rollouts_config=rollouts_config,
                    force_dump=False,
                    force_replay=False,
                    skip_teardown=False,
                    report_only=False,
                )

        self.assertEqual(call_order, ["runtime-ready", "activity", "argocd_restore"])

    def test_run_full_lifecycle_fails_when_teardown_analysis_is_unsuccessful_after_restore(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-teardown-clean-fail",
            {
                "dataset_id": "dataset-a",
            },
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = make_kafka_config()
        clickhouse_config = make_clickhouse_config(
            password=None,
        )
        postgres_config = make_postgres_config(
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_teardown_fail",
            simulation_db="torghut_sim_teardown_fail",
        )
        argocd_config = make_argocd_config(
            manage_automation=False,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace="torghut",
            runtime_template="torghut-simulation-runtime-ready",
            activity_template="torghut-simulation-activity",
            teardown_template="torghut-simulation-teardown-clean",
            artifact_template="torghut-simulation-artifact-bundle",
            verify_timeout_seconds=30,
            verify_poll_seconds=5,
        )

        def _rollouts_side_effect(*, phase: str, **_: object) -> dict[str, object]:
            if phase == "teardown-clean":
                return {"phase": "Failed"}
            return {"phase": "Successful"}

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_ensure_supported_binary",
                    return_value=None,
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_update_run_state",
                    return_value=None,
                )
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_save_json",
                    return_value=None,
                )
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "persist_completion_trace",
                    return_value={},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_upsert_simulation_progress_row",
                    return_value=None,
                ),
            )
            mock_session_local = stack.enter_context(
                patch.object(lifecycle, "SessionLocal")
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_prepare_argocd_for_run",
                    return_value={"managed": False},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_restore_argocd_after_run",
                    return_value={"managed": False},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_apply",
                    return_value={"status": "ok"},
                )
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_run_rollouts_analysis",
                    side_effect=_rollouts_side_effect,
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_runtime_verify",
                    return_value={"runtime_state": "ready"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_replay_dump",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_monitor_run_completion",
                    return_value={
                        "status": "ok",
                        "activity_classification": "success",
                        "final_snapshot": {
                            "signal_rows": 5,
                            "price_rows": 5,
                            "trade_decisions": 3,
                            "cursor_at": "2026-02-27T21:00:00Z",
                            "executions": 2,
                            "execution_tca_metrics": 2,
                            "execution_order_events": 2,
                        },
                    },
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_report_simulation",
                    return_value={"status": "ok"},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_build_strategy_proof_artifact",
                    return_value={"status": "ok", "legacy_path_count": 0},
                ),
            )
            stack.enter_context(
                patch.object(
                    lifecycle,
                    "_teardown",
                    return_value={"status": "ok"},
                ),
            )
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "simulation_run_failed:teardown:environment_incomplete",
            ):
                _run_full_lifecycle(
                    resources=resources,
                    manifest=manifest,
                    manifest_path=Path("/tmp/manifest.json"),
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=postgres_config,
                    argocd_config=argocd_config,
                    rollouts_config=rollouts_config,
                    force_dump=False,
                    force_replay=False,
                    skip_teardown=False,
                    report_only=False,
                )

    def test_run_full_lifecycle_aborts_before_replay_when_runtime_not_ready(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-runtime-gate-fail",
            {
                "dataset_id": "dataset-a",
            },
        )
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = make_kafka_config()
        clickhouse_config = make_clickhouse_config(
            password=None,
        )
        postgres_config = make_postgres_config(
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_runtime_gate",
            simulation_db="torghut_sim_runtime_gate",
        )
        argocd_config = make_argocd_config(
            manage_automation=False,
        )
        rollouts_config = RolloutsAnalysisConfig(
            enabled=True,
            namespace="torghut",
            runtime_template="torghut-simulation-runtime-ready",
            activity_template="torghut-simulation-activity",
            teardown_template="torghut-simulation-teardown-clean",
            artifact_template="torghut-simulation-artifact-bundle",
            verify_timeout_seconds=60,
            verify_poll_seconds=5,
        )

        with (
            patch.object(
                lifecycle,
                "_ensure_supported_binary",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "_update_run_state",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "_save_json",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "persist_completion_trace",
                return_value={},
            ),
            patch.object(
                lifecycle,
                "_upsert_simulation_progress_row",
                return_value=None,
            ),
            patch.object(lifecycle, "SessionLocal") as mock_session_local,
            patch.object(
                lifecycle,
                "_prepare_argocd_for_run",
                return_value={"managed": False},
            ),
            patch.object(
                lifecycle,
                "_restore_argocd_after_run",
                return_value={"managed": False},
            ),
            patch.object(
                lifecycle,
                "_apply",
                return_value={"status": "ok"},
            ),
            patch.object(
                lifecycle,
                "_run_rollouts_analysis",
                return_value={"phase": "Failed"},
            ),
            patch.object(
                lifecycle,
                "_runtime_verify",
                return_value={"runtime_state": "not_ready"},
            ),
            patch.object(lifecycle, "_replay_dump") as replay_dump,
            patch.object(
                lifecycle,
                "_report_simulation",
                return_value={"status": "ok"},
            ),
            patch.object(
                lifecycle,
                "_build_strategy_proof_artifact",
                return_value={"status": "ok", "legacy_path_count": 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "simulation_run_failed:environment_incomplete",
            ):
                _run_full_lifecycle(
                    resources=resources,
                    manifest=manifest,
                    manifest_path=Path("/tmp/manifest.json"),
                    kafka_config=kafka_config,
                    clickhouse_config=clickhouse_config,
                    postgres_config=postgres_config,
                    argocd_config=argocd_config,
                    rollouts_config=rollouts_config,
                    force_dump=False,
                    force_replay=False,
                    skip_teardown=True,
                    report_only=False,
                )

        replay_dump.assert_not_called()

    def test_run_full_lifecycle_waits_for_runtime_verify_without_rollouts(self) -> None:
        resources = simulation_resources()
        manifest = {
            "dataset_id": "dataset-a",
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
        }
        kafka_config = make_kafka_config()
        clickhouse_config = make_clickhouse_config(
            password=None,
        )
        postgres_config = make_postgres_config()
        argocd_config = make_argocd_config(
            manage_automation=False,
        )
        rollouts_config = disabled_rollouts_config(
            verify_timeout_seconds=30,
        )

        with (
            patch.object(
                lifecycle,
                "_ensure_supported_binary",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "_update_run_state",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "_save_json",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "persist_completion_trace",
                return_value={},
            ),
            patch.object(lifecycle, "SessionLocal") as mock_session_local,
            patch.object(
                lifecycle,
                "_prepare_argocd_for_run",
                return_value={"managed": False},
            ),
            patch.object(
                lifecycle,
                "_restore_argocd_after_run",
                return_value={"managed": False},
            ),
            patch.object(
                lifecycle,
                "_apply",
                return_value={"status": "ok"},
            ),
            patch.object(
                argocd_rollouts,
                "_runtime_verify",
                side_effect=[
                    {"runtime_state": "not_ready"},
                    {"runtime_state": "ready"},
                ],
            ) as runtime_verify_mock,
            patch(
                "scripts.historical_simulation_startup.argocd_rollouts.time.sleep",
                return_value=None,
            ) as sleep_mock,
            patch.object(
                lifecycle,
                "_replay_dump",
                return_value={"status": "ok"},
            ),
            patch.object(
                lifecycle,
                "_monitor_run_completion",
                return_value={
                    "status": "ok",
                    "activity_classification": "success",
                    "final_snapshot": {
                        "signal_rows": 5,
                        "price_rows": 5,
                        "trade_decisions": 3,
                        "cursor_at": "2026-02-27T21:00:00Z",
                        "executions": 2,
                        "execution_tca_metrics": 2,
                        "execution_order_events": 2,
                    },
                },
            ),
            patch.object(
                lifecycle,
                "_report_simulation",
                return_value={"status": "ok"},
            ),
            patch.object(
                lifecycle,
                "_build_strategy_proof_artifact",
                return_value={"status": "ok", "legacy_path_count": 0},
            ),
        ):
            mock_session_local.return_value.__enter__.return_value = SimpleNamespace(
                commit=lambda: None
            )
            _run_full_lifecycle(
                resources=resources,
                manifest=manifest,
                manifest_path=Path("/tmp/manifest.json"),
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                argocd_config=argocd_config,
                rollouts_config=rollouts_config,
                force_dump=False,
                force_replay=False,
                skip_teardown=True,
                report_only=False,
            )

        self.assertEqual(runtime_verify_mock.call_count, 2)
        self.assertGreaterEqual(len(sleep_mock.call_args_list), 1)
        self.assertEqual(sleep_mock.call_args_list[0], call(5))

    def test_runtime_verify_accepts_dedicated_sim_runtime_with_ready_replicas(
        self,
    ) -> None:
        manifest = {
            "window": {
                "start": "2026-03-06T14:30:00Z",
                "end": "2026-03-06T15:30:00Z",
            }
        }
        resources = open_hour_resources()
        kservice_payload = ready_knative_service(
            open_hour_trading_env(
                TRADING_PIPELINE_MODE="simple",
                TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED="true",
                TRADING_STRATEGY_RUNTIME_MODE="scheduler_v3",
                TRADING_ORDER_FEED_AUTO_OFFSET_RESET="earliest",
            ),
        )
        ta_configmap_payload = {
            "data": {
                "TA_TRADES_TOPIC": "torghut.sim.trades.v1.sim_2026_03_06_open_hour",
                "TA_QUOTES_TOPIC": "torghut.sim.quotes.v1.sim_2026_03_06_open_hour",
                "TA_BARS1M_TOPIC": "torghut.sim.bars.1m.v1.sim_2026_03_06_open_hour",
                "TA_MICROBARS_TOPIC": "torghut.sim.ta.bars.1s.v1.sim_2026_03_06_open_hour",
                "TA_SIGNALS_TOPIC": "torghut.sim.ta.signals.v1.sim_2026_03_06_open_hour",
                "TA_CLICKHOUSE_URL": f"jdbc:clickhouse://clickhouse/{resources.clickhouse_db}",
            }
        }

        with (
            patch_ready_compute(kservice_payload, ta_configmap_payload),
        ):
            report = _runtime_verify(resources=resources, manifest=manifest)

        self.assertEqual(report["runtime_state"], "ready")
        self.assertEqual(report["environment_state"], "complete")
        self.assertEqual(report["torghut_service"]["name"], "torghut-sim")
        self.assertTrue(all(report["ta_runtime_config"].values()))

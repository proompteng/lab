from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.historical_simulation_startup import (
    _build_resources,
    _run_full_lifecycle,
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
    simulation_resources,
)


class TestStartHistoricalSimulationLifecycleA(SimulationOrchestrationTestCase):
    def test_run_full_lifecycle_fails_when_activity_verify_is_degraded(self) -> None:
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
        rollouts_config = disabled_rollouts_config()

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
                "_apply",
                return_value={"status": "ok"},
            ),
            patch.object(
                argocd_rollouts,
                "_runtime_verify",
                return_value={"runtime_state": "ready"},
            ),
            patch.object(
                lifecycle,
                "_replay_dump",
                return_value={"status": "ok"},
            ),
            patch.object(
                lifecycle,
                "_monitor_run_completion",
                return_value={
                    "status": "degraded",
                    "activity_classification": "decisions_absent",
                    "final_snapshot": {},
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
            with self.assertRaisesRegex(
                RuntimeError, "simulation_run_failed:activity:decisions_absent"
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

    def test_run_full_lifecycle_reports_completion_trace_persist_failure_without_masking_root_cause(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-persist-failure",
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
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_persist_failure",
            simulation_db="torghut_sim_persist_failure",
        )
        argocd_config = make_argocd_config(
            manage_automation=False,
        )
        rollouts_config = disabled_rollouts_config()

        class _FakeSession:
            def __enter__(self) -> SimpleNamespace:
                return SimpleNamespace(commit=lambda: None)

            def __exit__(self, exc_type, exc, tb) -> bool:
                _ = (exc_type, exc, tb)
                return False

        fake_engine = SimpleNamespace(dispose=lambda: None)

        with (
            patch.object(lifecycle, "_ensure_supported_binary"),
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
                side_effect=RuntimeError(
                    "command_binary_not_found:/opt/venv/bin/alembic"
                ),
            ),
            patch.object(
                lifecycle,
                "_upsert_simulation_progress_row",
                return_value=None,
            ),
            patch.object(
                lifecycle,
                "_runtime_sessionmaker",
                return_value=(lambda: _FakeSession(), fake_engine),
            ),
            patch.object(
                lifecycle,
                "persist_completion_trace",
                side_effect=RuntimeError(
                    'relation "vnext_completion_gate_results" does not exist'
                ),
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                (
                    "simulation_run_failed:command_binary_not_found:/opt/venv/bin/alembic; "
                    'completion_trace_persist:relation "vnext_completion_gate_results" does not exist'
                ),
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

    def test_run_full_lifecycle_replays_after_runtime_verify(self) -> None:
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
        rollouts_config = disabled_rollouts_config()
        call_order: list[str] = []

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
                side_effect=lambda **_: call_order.append("apply") or {"status": "ok"},
            ),
            patch.object(
                argocd_rollouts,
                "_runtime_verify",
                side_effect=lambda **_: (
                    call_order.append("runtime_verify") or {"runtime_state": "ready"}
                ),
            ),
            patch.object(
                lifecycle,
                "_replay_dump",
                side_effect=lambda **_: call_order.append("replay") or {"status": "ok"},
            ),
            patch.object(
                lifecycle,
                "_monitor_run_completion",
                side_effect=lambda **_: (
                    call_order.append("monitor")
                    or {
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
                    }
                ),
            ),
            patch.object(
                lifecycle,
                "_report_simulation",
                side_effect=lambda **_: call_order.append("report") or {"status": "ok"},
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

        self.assertEqual(
            call_order,
            ["apply", "runtime_verify", "replay", "monitor", "report"],
        )

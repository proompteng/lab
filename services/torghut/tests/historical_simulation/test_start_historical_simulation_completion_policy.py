from __future__ import annotations

from tests.historical_simulation.start_historical_simulation_base import (
    ClickHouseRuntimeConfig,
    Path,
    PostgresRuntimeConfig,
    StartHistoricalSimulationTestCaseBase,
    TemporaryDirectory,
    _build_fill_price_error_budget_payload,
    _build_resources,
    _build_simulation_completion_trace,
    _doc29_simulation_gate_ids,
    _monitor_run_completion,
    _validate_dump_coverage,
    _validate_window_policy,
    historical_simulation_verification,
    json,
    patch,
    replace,
    start_historical_simulation,
)


class TestStartHistoricalSimulationCompletionPolicy(
    StartHistoricalSimulationTestCaseBase
):
    def test_teardown_requires_runtime_lock_ownership(self) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            state_path = resources.output_root / resources.run_token / "state.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(json.dumps({"ta_job_state": "running"}))

            with patch(
                "scripts.start_historical_simulation_modules.replay_execution._read_simulation_runtime_lock",
                return_value={"run_id": "sim-2"},
            ):
                report = start_historical_simulation._teardown(
                    resources=resources,
                    allow_missing_state=False,
                )

        self.assertEqual(report["status"], "degraded")
        self.assertTrue(report["skipped_restore"])
        self.assertEqual(report["reason"], "simulation_runtime_lock_not_owned_by_run")
        self.assertEqual(report["simulation_lock"]["status"], "not_owner")

    def test_teardown_releases_runtime_lock_when_state_missing_allowed(self) -> None:
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            with patch(
                "scripts.start_historical_simulation_modules.replay_execution._release_simulation_runtime_lock",
                return_value={"status": "released", "run_id": resources.run_id},
            ) as release_lock:
                report = start_historical_simulation._teardown(
                    resources=resources,
                    allow_missing_state=True,
                )

        release_lock.assert_called_once_with(resources=resources)
        self.assertFalse(report["state_found"])
        self.assertEqual(report["simulation_lock"]["status"], "released")

    def test_teardown_keeps_warm_lane_baseline(self) -> None:
        resources = _build_resources(
            "sim-1",
            {
                "dataset_id": "dataset-a",
                "runtime": {"use_warm_lane": True},
            },
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            state_path = resources.output_root / resources.run_token / "state.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(json.dumps({"ta_job_state": "running"}))

            with (
                patch(
                    "scripts.start_historical_simulation_modules.replay_execution._read_simulation_runtime_lock",
                    return_value={"run_id": resources.run_id},
                ),
                patch(
                    "scripts.start_historical_simulation_modules.replay_execution._release_simulation_runtime_lock",
                    return_value={"status": "released", "run_id": resources.run_id},
                ) as release_lock,
                patch(
                    "scripts.start_historical_simulation_modules.runtime_migrations._restore_ta_configuration"
                ) as restore_ta,
                patch(
                    "scripts.start_historical_simulation_modules.runtime_migrations._restore_torghut_env"
                ) as restore_env,
                patch(
                    "scripts.start_historical_simulation_modules.runtime_migrations._restart_ta_deployment",
                    return_value=11,
                ) as restart_ta,
                patch(
                    "scripts.start_historical_simulation_modules.lifecycle._ensure_supported_binary",
                    return_value=None,
                ),
            ):
                report = start_historical_simulation._teardown(
                    resources=resources,
                    allow_missing_state=False,
                )

        restore_ta.assert_not_called()
        restore_env.assert_not_called()
        restart_ta.assert_not_called()
        release_lock.assert_called_once_with(resources=resources)
        self.assertTrue(report["warm_lane_enabled"])
        self.assertTrue(report["skipped_restore"])
        self.assertTrue(report["retained_warm_lane_baseline"])
        self.assertIsNone(report["ta_restart_nonce"])

    def test_build_simulation_completion_trace_marks_smoke_gate_satisfied(self) -> None:
        resources = _build_resources(
            "sim-2026-03-06-open-hour",
            {
                "dataset_id": "torghut-smoke-open-hour-20260306",
                "dataset_snapshot_ref": "torghut-smoke-open-hour-20260306",
                "window": {
                    "start": "2026-03-06T14:30:00Z",
                    "end": "2026-03-06T15:30:00Z",
                    "min_coverage_minutes": 60,
                    "strict_coverage_ratio": 0.95,
                },
            },
        )
        postgres = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost/torghut_sim_smoke",
            simulation_db="torghut_sim_smoke",
            migrations_command="alembic upgrade heads",
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            for filename in (
                "run-manifest.json",
                "run-full-lifecycle-manifest.json",
                "runtime-verify.json",
                "replay-report.json",
                "signal-activity.json",
                "decision-activity.json",
                "execution-activity.json",
            ):
                (resources.output_root / resources.run_token / filename).parent.mkdir(
                    parents=True,
                    exist_ok=True,
                )
                (resources.output_root / resources.run_token / filename).write_text(
                    "{}",
                    encoding="utf-8",
                )

            trace = _build_simulation_completion_trace(
                resources=resources,
                manifest={
                    "dataset_snapshot_ref": "torghut-smoke-open-hour-20260306",
                    "window": {
                        "start": "2026-03-06T14:30:00Z",
                        "end": "2026-03-06T15:30:00Z",
                        "min_coverage_minutes": 60,
                        "strict_coverage_ratio": 0.95,
                    },
                },
                postgres_config=postgres,
                apply_report={
                    "window_policy": {
                        "min_coverage_minutes": 60,
                        "strict_coverage_ratio": 0.95,
                    },
                    "dump_coverage": {"coverage_ratio": 1.0},
                },
                runtime_verify_report={"runtime_state": "ready"},
                monitor_report={
                    "activity_classification": "success",
                    "final_snapshot": {
                        "trade_decisions": 12,
                        "executions": 8,
                        "execution_tca_metrics": 8,
                        "execution_order_events": 8,
                    },
                },
                analytics_report={},
                fill_price_error_budget_report={
                    "status": "within_budget",
                    "schema_version": "fill-price-error-budget-report-v1",
                },
                rollouts_report={},
                errors=[],
            )

        smoke = trace["result_by_gate"]["simulation_smoke_execution_funnel"]
        self.assertEqual(smoke["status"], "satisfied")
        self.assertEqual(
            trace["dataset_snapshot_ref"], "torghut-smoke-open-hour-20260306"
        )
        self.assertEqual(
            smoke["acceptance_snapshot"]["fill_price_error_budget_status"],
            "within_budget",
        )

    def test_fill_price_error_budget_payload_rejects_missing_percentiles(self) -> None:
        resources = _build_resources(
            "sim-2026-03-06-open-hour",
            {
                "dataset_id": "torghut-smoke-open-hour-20260306",
            },
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            payload, artifact_path = _build_fill_price_error_budget_payload(
                resources=resources,
                analytics_report={
                    "funnel": {"execution_tca_metrics": 5},
                    "execution_quality": {
                        "slippage_bps": {
                            "avg_abs": "1.0",
                            "p50_abs": None,
                            "p95_abs": None,
                            "max_abs": None,
                        }
                    },
                },
                manifest={},
            )

        assert payload is not None
        self.assertEqual(payload["status"], "pending_runtime_observation")
        self.assertFalse(payload["metric_observation_complete"])
        self.assertIsNotNone(artifact_path)

    def test_build_simulation_completion_trace_allows_full_day_gate_without_runtime_ready(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-03-06-full-day",
            {
                "dataset_id": "torghut-full-day-20260306",
                "dataset_snapshot_ref": "torghut-full-day-20260306",
                "window": {
                    "profile": "us_equities_regular",
                    "start": "2026-03-06T14:30:00Z",
                    "end": "2026-03-06T21:00:00Z",
                    "min_coverage_minutes": 390,
                    "strict_coverage_ratio": 0.95,
                },
            },
        )
        postgres = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost/torghut_sim_full_day",
            simulation_db="torghut_sim_full_day",
            migrations_command="alembic upgrade heads",
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            for filename in (
                "run-manifest.json",
                "run-full-lifecycle-manifest.json",
                "runtime-verify.json",
                "replay-report.json",
                "signal-activity.json",
                "decision-activity.json",
                "execution-activity.json",
            ):
                (resources.output_root / resources.run_token / filename).parent.mkdir(
                    parents=True,
                    exist_ok=True,
                )
                (resources.output_root / resources.run_token / filename).write_text(
                    "{}",
                    encoding="utf-8",
                )

            trace = _build_simulation_completion_trace(
                resources=resources,
                manifest={
                    "dataset_snapshot_ref": "torghut-full-day-20260306",
                    "window": {
                        "profile": "us_equities_regular",
                        "start": "2026-03-06T14:30:00Z",
                        "end": "2026-03-06T21:00:00Z",
                        "min_coverage_minutes": 390,
                        "strict_coverage_ratio": 0.95,
                    },
                },
                postgres_config=postgres,
                apply_report={
                    "window_policy": {
                        "min_coverage_minutes": 390,
                        "strict_coverage_ratio": 0.95,
                    },
                    "dump_coverage": {"coverage_ratio": 1.0},
                },
                runtime_verify_report={"runtime_state": "not_ready"},
                monitor_report={
                    "activity_classification": "success",
                    "final_snapshot": {
                        "trade_decisions": 1145,
                        "executions": 528,
                        "execution_tca_metrics": 528,
                        "execution_order_events": 520,
                    },
                },
                analytics_report={},
                fill_price_error_budget_report={
                    "status": "within_budget",
                    "schema_version": "fill-price-error-budget-report-v1",
                },
                rollouts_report={},
                errors=[],
            )

        full_day = trace["result_by_gate"]["simulation_full_day_coverage"]
        self.assertEqual(full_day["status"], "satisfied")
        self.assertIsNone(full_day["blocked_reason"])

    def test_build_simulation_completion_trace_derives_full_day_coverage_from_observed_minutes(
        self,
    ) -> None:
        resources = _build_resources(
            "sim-2026-03-13-full-day",
            {
                "dataset_id": "torghut-full-day-20260313",
                "dataset_snapshot_ref": "torghut-full-day-20260313",
                "window": {
                    "profile": "us_equities_regular",
                    "start": "2026-03-13T13:30:00Z",
                    "end": "2026-03-13T20:00:00Z",
                    "min_coverage_minutes": 390,
                    "strict_coverage_ratio": 0.95,
                },
            },
        )
        postgres = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost/torghut_sim_full_day",
            simulation_db="torghut_sim_full_day",
            migrations_command="alembic upgrade heads",
        )
        with TemporaryDirectory() as tmpdir:
            resources = replace(resources, output_root=Path(tmpdir))
            for filename in (
                "run-manifest.json",
                "run-full-lifecycle-manifest.json",
                "runtime-verify.json",
                "replay-report.json",
                "signal-activity.json",
                "decision-activity.json",
                "execution-activity.json",
            ):
                (resources.output_root / resources.run_token / filename).parent.mkdir(
                    parents=True,
                    exist_ok=True,
                )
                (resources.output_root / resources.run_token / filename).write_text(
                    "{}",
                    encoding="utf-8",
                )

            trace = _build_simulation_completion_trace(
                resources=resources,
                manifest={
                    "dataset_snapshot_ref": "torghut-full-day-20260313",
                    "window": {
                        "profile": "us_equities_regular",
                        "start": "2026-03-13T13:30:00Z",
                        "end": "2026-03-13T20:00:00Z",
                        "min_coverage_minutes": 390,
                        "strict_coverage_ratio": 0.95,
                    },
                },
                postgres_config=postgres,
                apply_report={
                    "window_policy": {
                        "min_coverage_minutes": 390,
                        "strict_coverage_ratio": 0.95,
                    },
                    "dump_coverage": {
                        "observed_minutes": 389.9975,
                        "required_minutes": 370.5,
                        "strict_ratio": 0.95,
                    },
                },
                runtime_verify_report={"runtime_state": "ready"},
                monitor_report={
                    "activity_classification": "success",
                    "final_snapshot": {
                        "trade_decisions": 123,
                        "executions": 16,
                        "execution_tca_metrics": 16,
                        "execution_order_events": 16,
                    },
                },
                analytics_report={},
                fill_price_error_budget_report={
                    "status": "within_budget",
                    "schema_version": "fill-price-error-budget-report-v1",
                },
                rollouts_report={},
                errors=[],
            )

        full_day = trace["result_by_gate"]["simulation_full_day_coverage"]
        self.assertEqual(full_day["status"], "satisfied")
        self.assertIsNone(full_day["blocked_reason"])
        self.assertAlmostEqual(
            full_day["acceptance_snapshot"]["coverage_ratio"], 389.9975 / 390.0
        )

    def test_validate_window_policy_us_equities_regular_profile(self) -> None:
        policy = _validate_window_policy(
            {
                "window": {
                    "profile": "us_equities_regular",
                    "trading_day": "2026-02-27",
                    "timezone": "America/New_York",
                    "start": "2026-02-27T14:30:00Z",
                    "end": "2026-02-27T21:00:00Z",
                }
            }
        )
        self.assertEqual(policy["profile"], "us_equities_regular")
        self.assertEqual(policy["min_coverage_minutes"], 390)

    def test_doc29_simulation_gate_ids_normalize_mixed_case_profile(self) -> None:
        gate_ids = _doc29_simulation_gate_ids(
            {
                "window": {
                    "profile": "US_EQUITIES_REGULAR",
                    "min_coverage_minutes": 60,
                }
            }
        )
        self.assertEqual(gate_ids, ["simulation_full_day_coverage"])

    def test_validate_window_policy_rejects_profile_mismatch(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError, "window_profile_mismatch:us_equities_regular"
        ):
            _validate_window_policy(
                {
                    "window": {
                        "profile": "us_equities_regular",
                        "trading_day": "2026-02-27",
                        "timezone": "America/New_York",
                        "start": "2026-02-27T15:00:00Z",
                        "end": "2026-02-27T21:00:00Z",
                    }
                }
            )

    def test_validate_dump_coverage_rejects_short_dump_span(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "dump_coverage_too_short"):
            _validate_dump_coverage(
                manifest={
                    "window": {
                        "profile": "us_equities_regular",
                        "trading_day": "2026-02-27",
                        "timezone": "America/New_York",
                        "start": "2026-02-27T14:30:00Z",
                        "end": "2026-02-27T21:00:00Z",
                    }
                },
                dump_report={
                    "records": 100,
                    "min_source_timestamp_ms": 1709044200000,
                    "max_source_timestamp_ms": 1709044200000 + (30 * 60 * 1000),
                },
            )

    def test_validate_dump_coverage_reports_ratio_when_policy_present(self) -> None:
        coverage = _validate_dump_coverage(
            manifest={
                "window": {
                    "profile": "us_equities_regular",
                    "trading_day": "2026-03-13",
                    "timezone": "America/New_York",
                    "start": "2026-03-13T13:30:00Z",
                    "end": "2026-03-13T20:00:00Z",
                    "min_coverage_minutes": 390,
                    "strict_coverage_ratio": 0.95,
                }
            },
            dump_report={
                "records": 100,
                "min_source_timestamp_ms": 1773408600150,
                "max_source_timestamp_ms": 1773432000000,
            },
        )

        self.assertTrue(coverage["applied"])
        self.assertAlmostEqual(coverage["coverage_ratio"], 389.9975 / 390.0)
        self.assertAlmostEqual(coverage["required_minutes"], 390 * 0.95)

    def test_validate_dump_coverage_reports_full_day_coverage_ratio(self) -> None:
        report = _validate_dump_coverage(
            manifest={
                "window": {
                    "profile": "us_equities_regular",
                    "trading_day": "2026-02-27",
                    "timezone": "America/New_York",
                    "start": "2026-02-27T14:30:00Z",
                    "end": "2026-02-27T21:00:00Z",
                    "min_coverage_minutes": 390,
                    "strict_coverage_ratio": 0.95,
                }
            },
            dump_report={
                "records": 100,
                "min_source_timestamp_ms": 1709044200000,
                "max_source_timestamp_ms": 1709044200000 + (390 * 60 * 1000),
            },
        )

        self.assertTrue(report["applied"])
        self.assertAlmostEqual(report["coverage_ratio"], 1.0)
        self.assertAlmostEqual(report["required_minutes"], 390 * 0.95)

    def test_monitor_run_completion_requires_order_events_when_executions_exist(
        self,
    ) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        manifest = {
            "window": {
                "start": "2026-02-27T14:30:00Z",
                "end": "2026-02-27T21:00:00Z",
            },
            "monitor": {
                "timeout_seconds": 10,
                "poll_seconds": 1,
                "min_trade_decisions": 1,
                "min_executions": 1,
                "min_execution_tca_metrics": 1,
                "min_execution_order_events": 0,
                "cursor_grace_seconds": 0,
            },
        }
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        with (
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._monitor_snapshot",
                return_value={
                    "trade_decisions": 10,
                    "executions": 5,
                    "execution_tca_metrics": 5,
                    "execution_order_events": 0,
                    "cursor_at": "2026-02-27T21:00:01Z",
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._signal_snapshot",
                return_value={"signal_rows": 10, "price_rows": 10},
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification.time.sleep",
                return_value=None,
            ),
        ):
            report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={"runtime_state": "ready"},
            )
        self.assertEqual(report["status"], "degraded")
        self.assertEqual(report["activity_classification"], "executions_absent")

    def test_monitor_run_completion_succeeds_when_terminal_signal_precedes_window_end(
        self,
    ) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        manifest = {
            "window": {
                "start": "2026-03-11T13:30:00Z",
                "end": "2026-03-11T13:35:00Z",
            },
            "monitor": {
                "timeout_seconds": 30,
                "poll_seconds": 1,
                "cursor_grace_seconds": 5,
            },
        }
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        with (
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._monitor_snapshot",
                return_value={
                    "trade_decisions": 12,
                    "executions": 12,
                    "execution_tca_metrics": 12,
                    "execution_order_events": 12,
                    "cursor_at": "2026-03-11T13:34:58Z",
                    "last_source_ts": "2026-03-11T13:34:58Z",
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._signal_snapshot",
                return_value={
                    "signal_rows": 120,
                    "price_rows": 120,
                    "last_signal_ts": "2026-03-11T13:34:58Z",
                    "last_price_ts": "2026-03-11T13:34:58Z",
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification.time.sleep",
                return_value=None,
            ),
        ):
            report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={"runtime_state": "ready"},
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertEqual(
            report["effective_terminal_signal_ts"], "2026-03-11T13:34:58+00:00"
        )
        self.assertEqual(report["dataset_alignment"], "window_declared_beyond_dataset")

    def test_activity_state_treats_subsecond_terminal_cursor_gap_as_reached(
        self,
    ) -> None:
        state = historical_simulation_verification._activity_state(
            manifest={
                "window": {
                    "start": "2026-05-05T13:30:00Z",
                    "end": "2026-05-05T20:00:00Z",
                },
                "monitor": {
                    "cursor_terminal_tolerance_seconds": 1,
                    "min_trade_decisions": 1,
                    "min_executions": 1,
                    "min_execution_tca_metrics": 1,
                    "min_execution_order_events": 0,
                },
            },
            runtime_verify={"runtime_state": "ready"},
            snapshot={
                "signal_rows": 100,
                "price_rows": 100,
                "trade_decisions": 0,
                "executions": 0,
                "execution_tca_metrics": 0,
                "execution_order_events": 0,
                "cursor_at": "2026-05-05T19:59:59Z",
                "last_signal_ts": "2026-05-05T19:59:59.990Z",
                "last_price_ts": "2026-05-05T19:59:59.990Z",
                "last_source_ts": "2026-05-05T19:59:59.990Z",
            },
        )

        self.assertTrue(state["terminal_reached"])
        self.assertEqual(state["activity_classification"], "decisions_absent")
        self.assertLess(state["cursor_gap_seconds"], 1)

    def test_current_activity_report_prefers_terminal_success_over_runtime_flap(
        self,
    ) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        manifest = {
            "window": {
                "start": "2026-03-13T13:30:00Z",
                "end": "2026-03-13T20:00:00Z",
            },
            "monitor": {
                "timeout_seconds": 14400,
                "poll_seconds": 30,
                "min_trade_decisions": 1,
                "min_executions": 1,
                "min_execution_tca_metrics": 1,
                "min_execution_order_events": 1,
                "cursor_grace_seconds": 120,
            },
        }
        resources = _build_resources(
            "sim-proof-terminal-success",
            {
                "dataset_id": "dataset-a",
                "runtime": {
                    "target_mode": "dedicated_service",
                    "namespace": "torghut",
                    "ta_configmap": "torghut-ta-sim-config",
                    "ta_deployment": "torghut-ta-sim",
                    "torghut_service": "torghut-sim",
                },
            },
        )
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        with patch(
            "scripts.historical_simulation_verification_modules.artifact_verification._simulation_progress_snapshot",
            return_value={
                "components": {
                    "replay": {
                        "last_source_ts": "2026-03-13T19:59:59.714000+00:00",
                        "status": "replayed",
                    },
                    "torghut": {
                        "cursor_at": "2026-03-13T20:00:00+00:00",
                        "execution_order_events": 59,
                        "execution_tca_metrics": 59,
                        "executions": 59,
                        "last_signal_ts": "2026-03-13T20:00:00+00:00",
                        "status": "running",
                        "trade_decisions": 174,
                    },
                },
                "cursor_at": "2026-03-13T20:00:00+00:00",
                "execution_order_events": 59,
                "execution_tca_metrics": 59,
                "executions": 59,
                "last_price_ts": None,
                "last_signal_ts": "2026-03-13T20:00:00+00:00",
                "last_source_ts": "2026-03-13T19:59:59.714000+00:00",
                "price_rows": 0,
                "progress_source": "simulation_run_progress",
                "records_dumped": 0,
                "records_replayed": 8435001,
                "signal_rows": 1,
                "trade_decisions": 174,
            },
        ):
            report = historical_simulation_verification._current_activity_report(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={"runtime_state": "not_ready"},
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertTrue(report["terminal_reached"])
        self.assertTrue(report["thresholds_met"])
        self.assertEqual(report["cursor_at"], "2026-03-13T20:00:00+00:00")

    def test_monitor_run_completion_uses_direct_counts_when_progress_rows_are_stale(
        self,
    ) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        manifest = {
            "window": {
                "start": "2026-03-13T13:30:00Z",
                "end": "2026-03-13T20:00:00Z",
            },
            "monitor": {
                "timeout_seconds": 10,
                "poll_seconds": 1,
                "min_trade_decisions": 1,
                "min_executions": 1,
                "min_execution_tca_metrics": 1,
                "min_execution_order_events": 1,
                "cursor_grace_seconds": 0,
            },
        }
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        with (
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._progress_component_snapshot",
                return_value={
                    "torghut": {
                        "trade_decisions": 0,
                        "executions": 0,
                        "execution_tca_metrics": 0,
                        "execution_order_events": 0,
                        "cursor_at": "2026-03-13T20:00:00Z",
                        "last_signal_ts": "2026-03-13T20:00:00Z",
                        "last_price_ts": "2026-03-13T20:00:00Z",
                    },
                    "replay": {
                        "last_source_ts": "2026-03-13T20:00:00Z",
                    },
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._monitor_snapshot",
                return_value={
                    "trade_decisions": 213,
                    "executions": 60,
                    "execution_tca_metrics": 60,
                    "execution_order_events": 60,
                    "cursor_at": "2026-03-13T20:00:00Z",
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._signal_snapshot",
                return_value={
                    "signal_rows": 1,
                    "price_rows": 1,
                    "last_signal_ts": "2026-03-13T20:00:00Z",
                    "last_price_ts": "2026-03-13T20:00:00Z",
                },
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification.time.sleep",
                return_value=None,
            ),
        ):
            report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={"runtime_state": "ready"},
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertEqual(
            report["final_snapshot"]["progress_source"],
            "simulation_run_progress+direct_tables",
        )
        self.assertEqual(report["final_snapshot"]["trade_decisions"], 213)
        self.assertEqual(report["final_snapshot"]["executions"], 60)
        self.assertEqual(report["final_snapshot"]["execution_tca_metrics"], 60)
        self.assertEqual(report["final_snapshot"]["execution_order_events"], 60)

    def test_monitor_run_completion_waits_for_source_window_when_signal_generation_lags(
        self,
    ) -> None:
        postgres_config = PostgresRuntimeConfig(
            admin_dsn="postgresql://torghut:secret@localhost:5432/postgres",
            simulation_dsn="postgresql://torghut:secret@localhost:5432/torghut_sim_sim_1",
            simulation_db="torghut_sim_sim_1",
            migrations_command="true",
        )
        manifest = {
            "window": {
                "start": "2026-03-13T13:30:00Z",
                "end": "2026-03-13T20:00:00Z",
            },
            "monitor": {
                "timeout_seconds": 30,
                "poll_seconds": 1,
                "cursor_grace_seconds": 0,
                "min_trade_decisions": 1,
                "min_executions": 1,
                "min_execution_tca_metrics": 1,
                "min_execution_order_events": 1,
            },
        }
        resources = _build_resources("sim-1", {"dataset_id": "dataset-a"})
        clickhouse_config = ClickHouseRuntimeConfig(
            http_url="http://clickhouse:8123",
            username="torghut",
            password=None,
        )
        with (
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._monitor_snapshot",
                side_effect=[
                    {
                        "trade_decisions": 0,
                        "executions": 0,
                        "execution_tca_metrics": 0,
                        "execution_order_events": 0,
                        "cursor_at": "2026-03-13T17:26:00Z",
                        "last_source_ts": "2026-03-13T19:59:59Z",
                    },
                    {
                        "trade_decisions": 17,
                        "executions": 3,
                        "execution_tca_metrics": 3,
                        "execution_order_events": 3,
                        "cursor_at": "2026-03-13T20:00:00Z",
                        "last_source_ts": "2026-03-13T19:59:59Z",
                    },
                ],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.runtime_progress._signal_snapshot",
                side_effect=[
                    {
                        "signal_rows": 120,
                        "price_rows": 120,
                        "last_signal_ts": "2026-03-13T17:26:00Z",
                        "last_price_ts": "2026-03-13T20:00:00Z",
                    },
                    {
                        "signal_rows": 120,
                        "price_rows": 120,
                        "last_signal_ts": "2026-03-13T20:00:00Z",
                        "last_price_ts": "2026-03-13T20:00:00Z",
                    },
                ],
            ),
            patch(
                "scripts.historical_simulation_verification_modules.artifact_verification.time.sleep",
                return_value=None,
            ),
        ):
            report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify={"runtime_state": "ready"},
            )

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["activity_classification"], "success")
        self.assertEqual(
            report["effective_terminal_signal_ts"], "2026-03-13T20:00:00+00:00"
        )
        self.assertEqual(report["dataset_alignment"], "window_aligned_with_dataset")

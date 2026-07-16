from __future__ import annotations

from typing import cast

from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRunError,
    BrokerMutationRecoveryWorker,
)

from tests.trading_scheduler_autonomy.support import (
    Path,
    TradingAccountLane,
    TradingScheduler,
    _PipelineIterationStub,
    _TestTradingSchedulerAutonomyBase,
    asyncio,
    datetime,
    json,
    os,
    patch,
    settings,
    tempfile,
    timezone,
)


class TestEmergencyStopIncidentContainsHooksAndProvenance(
    _TestTradingSchedulerAutonomyBase
):
    def test_emergency_stop_incident_contains_hooks_and_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-123",
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-1",
                            "recommendation_trace_id": "rec-trace-1",
                        },
                    },
                ),
                encoding="utf-8",
            )
            scheduler.state.last_autonomy_gates = str(gate_path)
            scheduler.state.metrics.no_signal_reason_streak = {
                "cursor_ahead_of_stream": 3
            }
            scheduler.state.metrics.signal_staleness_alert_total = {
                "cursor_ahead_of_stream": 2
            }

            scheduler._trigger_emergency_stop(
                reasons=["signal_staleness_streak_exceeded:cursor_ahead_of_stream:3"],
                fallback_ratio=0.0,
                drawdown=None,
            )

            incident_path = Path(scheduler.state.rollback_incident_evidence_path or "")
            self.assertTrue(incident_path.exists())
            payload = json.loads(incident_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["provenance"]["gate_report_trace_id"], "gate-trace-1"
            )
            self.assertEqual(
                payload["provenance"]["recommendation_trace_id"], "rec-trace-1"
            )
            self.assertTrue(payload["rollback_hooks"]["order_submission_blocked"])
            self.assertTrue(payload["verification"]["incident_evidence_complete"])

    def test_drift_governance_triggers_rollback_on_performance_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_drift_rollback_on_performance = True
            settings.trading_emergency_stop_enabled = True
            settings.trading_drift_rollback_reason_codes_raw = (
                "performance_drawdown_exceeded"
            )
            settings.trading_drift_max_performance_drawdown = 0.01
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "metrics": {"max_drawdown": "0.25"},
            }
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "drift_reason_detected:performance_drawdown_exceeded",
                scheduler.state.emergency_stop_reason or "",
            )
            self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)

    def test_run_trading_iteration_continues_with_partial_lane_failure(self) -> None:
        scheduler = TradingScheduler()
        failing_lane = _PipelineIterationStub(
            account_label="paper-a", run_once_fail=True
        )
        healthy_lane = _PipelineIterationStub(account_label="paper-b")
        scheduler._pipelines = [failing_lane, healthy_lane]
        scheduler._pipeline = failing_lane

        safety_calls = {"count": 0}

        def _capture_safety() -> None:
            safety_calls["count"] += 1

        scheduler._evaluate_safety_controls = _capture_safety
        asyncio.run(scheduler._run_trading_iteration())

        self.assertEqual(failing_lane.run_once_calls, 1)
        self.assertEqual(healthy_lane.run_once_calls, 1)
        self.assertEqual(
            scheduler.state.last_error,
            "trading_lane_failures:paper-a",
        )
        self.assertEqual(
            scheduler.state.last_trading_error,
            "trading_lane_failures:paper-a",
        )
        self.assertEqual(safety_calls["count"], 1)
        self.assertIsNone(scheduler.state.last_run_at)
        self.assertEqual(failing_lane.run_once_last_error, "run_once_failed")
        self.assertEqual(healthy_lane.run_once_last_error, None)

    def test_run_trading_iteration_never_records_success_when_all_lanes_fail(
        self,
    ) -> None:
        scheduler = TradingScheduler()
        first_lane = _PipelineIterationStub(
            account_label="paper-a",
            run_once_fail=True,
        )
        second_lane = _PipelineIterationStub(
            account_label="paper-b",
            run_once_fail=True,
        )
        scheduler._pipelines = [first_lane, second_lane]
        scheduler._pipeline = first_lane

        asyncio.run(scheduler._run_trading_iteration())

        self.assertEqual(first_lane.run_once_calls, 1)
        self.assertEqual(second_lane.run_once_calls, 1)
        self.assertEqual(
            scheduler.state.last_error,
            "trading_lane_failures:paper-a,paper-b",
        )
        self.assertEqual(
            scheduler.state.last_trading_error,
            "trading_lane_failures:paper-a,paper-b",
        )
        self.assertIsNone(scheduler.state.last_run_at)

    def test_successful_reconcile_cannot_mask_latest_trading_failure(self) -> None:
        scheduler = TradingScheduler()
        lane = _PipelineIterationStub(
            account_label="paper-a",
            run_once_fail=True,
            reconcile_return=1,
        )
        scheduler._pipelines = [lane]
        scheduler._pipeline = lane
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler._evaluate_safety_controls = lambda: None

        asyncio.run(scheduler._run_trading_iteration())
        asyncio.run(scheduler._run_reconcile_iteration())

        self.assertEqual(
            scheduler.state.last_error,
            "trading_lane_failures:paper-a",
        )
        self.assertEqual(
            scheduler.state.last_trading_error,
            "trading_lane_failures:paper-a",
        )
        self.assertIsNone(scheduler.state.last_reconcile_error)
        self.assertIsNotNone(scheduler.state.last_reconcile_at)

    def test_successful_autonomy_retry_clears_its_readiness_error(self) -> None:
        scheduler = TradingScheduler()
        lane = _PipelineIterationStub(account_label="paper-a")
        scheduler._pipelines = [lane]
        scheduler._pipeline = lane
        scheduler._evaluate_safety_controls = lambda: None

        with patch.object(
            scheduler,
            "_run_autonomous_cycle",
            side_effect=RuntimeError("autonomy unavailable"),
        ):
            asyncio.run(scheduler._run_autonomy_iteration())

        self.assertEqual(scheduler.state.last_error, "autonomy unavailable")
        self.assertEqual(
            scheduler.state.last_autonomy_error,
            "autonomy unavailable",
        )

        with patch.object(scheduler, "_run_autonomous_cycle", return_value=None):
            asyncio.run(scheduler._run_autonomy_iteration())

        self.assertIsNone(scheduler.state.last_autonomy_error)
        self.assertIsNone(scheduler.state.last_error)

    def test_successful_evidence_retry_clears_its_readiness_error(self) -> None:
        scheduler = TradingScheduler()
        lane = _PipelineIterationStub(account_label="paper-a")
        scheduler._pipelines = [lane]
        scheduler._pipeline = lane

        with patch.object(
            scheduler,
            "_run_evidence_continuity_check",
            side_effect=RuntimeError("evidence unavailable"),
        ):
            asyncio.run(scheduler._run_evidence_iteration())

        self.assertEqual(scheduler.state.last_error, "evidence unavailable")
        self.assertEqual(
            scheduler.state.last_evidence_error,
            "evidence unavailable",
        )

        with patch.object(
            scheduler,
            "_run_evidence_continuity_check",
            return_value=None,
        ):
            asyncio.run(scheduler._run_evidence_iteration())

        self.assertIsNone(scheduler.state.last_evidence_error)
        self.assertIsNone(scheduler.state.last_error)

    def test_successful_retries_clear_aggregate_iteration_error(self) -> None:
        scheduler = TradingScheduler()

        scheduler._set_trading_iteration_error("trading unavailable")
        scheduler._set_reconcile_iteration_error("reconcile unavailable")

        self.assertEqual(
            scheduler.state.last_error,
            "trading unavailable;reconcile unavailable",
        )

        scheduler._set_trading_iteration_error(None)
        self.assertEqual(scheduler.state.last_error, "reconcile unavailable")

        scheduler._set_reconcile_iteration_error(None)
        self.assertIsNone(scheduler.state.last_error)

    def test_iteration_recovery_preserves_non_iteration_runtime_error(self) -> None:
        scheduler = TradingScheduler()
        scheduler._set_trading_iteration_error("trading unavailable")
        scheduler.state.last_error = "leadership_lost"

        scheduler._set_trading_iteration_error(None)

        self.assertEqual(scheduler.state.last_error, "leadership_lost")

    def test_run_reconcile_iteration_continues_with_partial_lane_failure(self) -> None:
        scheduler = TradingScheduler()
        failing_lane = _PipelineIterationStub(
            account_label="paper-a",
            reconcile_fail=True,
        )
        healthy_lane = _PipelineIterationStub(
            account_label="paper-b",
            reconcile_return=2,
        )
        scheduler._pipelines = [failing_lane, healthy_lane]
        scheduler._pipeline = failing_lane

        safety_calls = {"count": 0}

        def _capture_safety() -> None:
            safety_calls["count"] += 1

        scheduler._evaluate_safety_controls = _capture_safety
        asyncio.run(scheduler._run_reconcile_iteration())

        self.assertEqual(failing_lane.reconcile_calls, 1)
        self.assertEqual(healthy_lane.reconcile_calls, 1)
        self.assertEqual(healthy_lane.reconcile_return, 2)
        self.assertEqual(
            scheduler.state.last_error,
            "reconcile_lane_failures:paper-a",
        )
        self.assertEqual(safety_calls["count"], 1)
        self.assertIsNone(scheduler.state.last_reconcile_at)
        self.assertEqual(failing_lane.reconcile_last_error, "reconcile_failed")
        self.assertEqual(healthy_lane.reconcile_last_error, None)

    def test_broker_activity_backfill_isolated_per_lane(self) -> None:
        scheduler = TradingScheduler()
        failing_lane = _PipelineIterationStub(
            account_label="paper-a",
            account_activity_fail=True,
        )
        healthy_lane = _PipelineIterationStub(account_label="paper-b")
        scheduler._pipelines = [failing_lane, healthy_lane]
        scheduler._pipeline = failing_lane

        asyncio.run(scheduler._run_broker_account_activity_iteration())

        self.assertEqual(failing_lane.account_activity_calls, 1)
        self.assertEqual(healthy_lane.account_activity_calls, 1)
        self.assertEqual(
            scheduler.state.metrics.broker_account_activity_errors_total,
            1,
        )
        self.assertIsNone(scheduler.state.last_trading_error)
        self.assertIsNone(scheduler.state.last_reconcile_error)

    def test_recovery_worker_failure_is_counted_and_fails_reconciliation(self) -> None:
        class _FailingRecoveryWorker:
            def run_once(self) -> None:
                raise BrokerMutationRecoveryRunError("recovery unavailable")

        scheduler = TradingScheduler()
        lane = _PipelineIterationStub(
            account_label="paper-a",
            reconcile_return=0,
        )
        scheduler._pipelines = [lane]
        scheduler._pipeline = lane
        scheduler._broker_mutation_recovery_worker = cast(
            BrokerMutationRecoveryWorker,
            _FailingRecoveryWorker(),
        )
        scheduler._evaluate_safety_controls = lambda: None

        asyncio.run(scheduler._run_reconcile_iteration())

        self.assertEqual(
            scheduler.state.metrics.broker_mutation_recovery_total,
            {"failed": 1},
        )
        self.assertEqual(
            scheduler.state.last_reconcile_error,
            "reconcile_lane_failures:broker-mutation-recovery",
        )
        self.assertIsNone(scheduler.state.last_reconcile_at)

    def test_reconcile_success_timestamp_advances_only_after_all_lanes_succeed(
        self,
    ) -> None:
        scheduler = TradingScheduler()
        previous_success = datetime(2000, 1, 1, tzinfo=timezone.utc)
        failing_lane = _PipelineIterationStub(
            account_label="paper-a",
            reconcile_fail=True,
        )
        healthy_lane = _PipelineIterationStub(
            account_label="paper-b",
            reconcile_return=2,
        )
        scheduler._pipelines = [failing_lane, healthy_lane]
        scheduler._pipeline = failing_lane
        scheduler.state.last_reconcile_at = previous_success
        scheduler._evaluate_safety_controls = lambda: None

        asyncio.run(scheduler._run_reconcile_iteration())

        self.assertEqual(scheduler.state.last_reconcile_at, previous_success)
        self.assertEqual(
            scheduler.state.last_reconcile_error,
            "reconcile_lane_failures:paper-a",
        )

        failing_lane.reconcile_fail = False
        asyncio.run(scheduler._run_reconcile_iteration())

        self.assertIsNotNone(scheduler.state.last_reconcile_at)
        assert scheduler.state.last_reconcile_at is not None
        self.assertGreater(scheduler.state.last_reconcile_at, previous_success)
        self.assertIsNone(scheduler.state.last_reconcile_error)

    def test_run_autonomy_iteration_triggers_rollback_when_failure_streak_exceeds_limit(
        self,
    ) -> None:
        original_emergency_stop = settings.trading_emergency_stop_enabled
        original_autonomy_rollback_limit = (
            settings.trading_rollback_autonomy_failure_streak_limit
        )
        original_critical_reasons = (
            settings.trading_signal_staleness_alert_critical_reasons_raw
        )

        try:
            settings.trading_emergency_stop_enabled = True
            settings.trading_rollback_autonomy_failure_streak_limit = 1
            settings.trading_signal_staleness_alert_critical_reasons_raw = ""

            with tempfile.TemporaryDirectory() as tmpdir:
                scheduler, _deps = self._build_scheduler_with_fixtures(
                    tmpdir,
                    allow_live=False,
                    approval_token=None,
                    no_signals=True,
                    no_signal_reason=None,
                )

                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._run_autonomous_cycle",
                    side_effect=RuntimeError("autonomy-cycle-failed"),
                ):
                    asyncio.run(scheduler._run_autonomy_iteration())

                self.assertEqual(
                    scheduler.state.last_error,
                    "emergency_stop_triggered reasons=autonomy_failure_streak_exceeded:1",
                )
                self.assertEqual(
                    scheduler.state.last_autonomy_error, "autonomy-cycle-failed"
                )
                self.assertEqual(scheduler.state.autonomy_failure_streak, 1)
                self.assertTrue(scheduler.state.emergency_stop_active)
                self.assertIn(
                    "autonomy_failure_streak_exceeded:1",
                    scheduler.state.emergency_stop_reason or "",
                )
                self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)
                self.assertEqual(scheduler.state.rollback_incidents_total, 1)
        finally:
            settings.trading_emergency_stop_enabled = original_emergency_stop
            settings.trading_rollback_autonomy_failure_streak_limit = (
                original_autonomy_rollback_limit
            )
            settings.trading_signal_staleness_alert_critical_reasons_raw = (
                original_critical_reasons
            )

    def test_build_pipeline_for_account_scopes_broker_ingestors(self) -> None:
        scheduler = TradingScheduler()
        lane = TradingAccountLane(
            label="paper-x",
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            enabled=True,
        )
        pipeline = scheduler._build_pipeline_for_account(lane)

        self.assertEqual(
            pipeline.order_feed_ingestor.default_account_label,
            "paper-x",
        )
        self.assertEqual(
            pipeline.broker_account_activity_ingestor.account_label,
            "paper-x",
        )

    def test_run_autonomous_cycle_passes_autonomy_execution_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch.dict(
                os.environ,
                {
                    "GITHUB_REPOSITORY": "acme/torghut",
                    "GITHUB_BASE_REF": "release",
                    "GITHUB_HEAD_REF": "feature/abc-123",
                    "PRIORITY_ID": "42",
                },
                clear=False,
            ):
                with patch(
                    "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                    side_effect=self._fake_run_autonomous_lane(deps),
                ):
                    scheduler._run_autonomous_cycle()

            governance_inputs = deps.call_kwargs.get("governance_inputs")
            self.assertIsInstance(governance_inputs, dict)
            execution_context = governance_inputs.get("execution_context")
            self.assertIsInstance(execution_context, dict)
            self.assertEqual(execution_context.get("repository"), "acme/torghut")
            self.assertEqual(execution_context.get("base"), "release")
            self.assertEqual(execution_context.get("head"), "feature/abc-123")
            self.assertEqual(
                execution_context.get("artifactPath"),
                str(Path(deps.call_kwargs.get("output_dir")).parent),
            )
            self.assertEqual(execution_context.get("priorityId"), "42")

    def test_run_autonomous_cycle_writes_iteration_notes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(_deps),
            ):
                scheduler._run_autonomous_cycle()

            notes_path = (
                Path(scheduler.state.last_autonomy_iteration_notes_path or "")
                if scheduler.state.last_autonomy_iteration_notes_path
                else None
            )
            self.assertIsNotNone(notes_path)
            assert notes_path is not None
            self.assertTrue(notes_path.exists())
            self.assertEqual(notes_path.parent.name, "notes")
            self.assertEqual(notes_path.name, "iteration-1.md")
            self.assertEqual(
                scheduler.state.last_autonomy_iteration,
                1,
            )

            notes_payload = json.loads(notes_path.read_text(encoding="utf-8"))
            self.assertEqual(notes_payload.get("status"), "lane_completed")
            self.assertEqual(
                notes_payload.get("phase_manifest_path"),
                scheduler.state.last_autonomy_phase_manifest,
            )

    def test_append_runtime_governance_updates_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler.state.drift_last_detection_path = str(
                Path(tmpdir) / "drift-detection.json"
            )
            scheduler.state.drift_last_action_path = str(
                Path(tmpdir) / "drift-action.json"
            )
            scheduler.state.drift_last_outcome_path = str(
                Path(tmpdir) / "drift-outcome.json"
            )
            scheduler.state.rollback_incident_evidence_path = str(
                Path(tmpdir) / "rollback-evidence.json"
            )
            Path(scheduler.state.drift_last_detection_path).write_text(
                "{}", encoding="utf-8"
            )
            Path(scheduler.state.drift_last_action_path).write_text(
                "{}", encoding="utf-8"
            )
            Path(scheduler.state.drift_last_outcome_path).write_text(
                "{}", encoding="utf-8"
            )
            Path(scheduler.state.rollback_incident_evidence_path).write_text(
                "{}", encoding="utf-8"
            )
            scheduler.state.emergency_stop_active = True

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            preexisting_top_level_ref = str(
                Path(tmpdir) / "backtest" / "walkforward-results.json"
            )
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-1",
                "candidate_id": "cand-1",
                "phases": [
                    {"name": "gate-evaluation", "status": "pass", "artifact_refs": []},
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "rollback-proof", "status": "pass", "artifact_refs": []},
                ],
                "artifact_refs": [preexisting_top_level_ref],
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2), encoding="utf-8"
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "drift_detected",
                    "detection": {"reason_codes": ["performance_drawdown_exceeded"]},
                    "action": {
                        "action_type": "quarantine",
                        "triggered": True,
                        "reason_codes": ["performance_drawdown_exceeded"],
                    },
                    "reasons": ["evidence_anomaly"],
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            phases = updated_manifest["phases"]
            self.assertEqual(
                [phase["name"] for phase in phases],
                [
                    "gate-evaluation",
                    "promotion-prerequisites",
                    "rollback-readiness",
                    "drift-gate",
                    "paper-canary",
                    "runtime-governance",
                    "rollback-proof",
                ],
            )
            self.assertEqual(
                phases[5]["status"],
                "fail",
                "drift detected should fail runtime governance",
            )
            self.assertEqual(
                phases[6]["status"],
                "pass",
                "rollback proof should pass when evidence is attached",
            )
            self.assertIn(
                "rollback_incident_evidence_path",
                updated_manifest["rollback_proof"],
            )
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence_path"],
                str(scheduler.state.rollback_incident_evidence_path),
            )
            self.assertIn(
                str(scheduler.state.rollback_incident_evidence_path),
                updated_manifest["artifact_refs"],
            )
            self.assertIn(preexisting_top_level_ref, updated_manifest["artifact_refs"])
            self.assertIn(
                {"from": "drift-gate", "to": "paper-canary", "status": "pass"},
                updated_manifest["phase_transitions"],
            )

    def test_append_runtime_governance_updates_manifest_fails_when_rollback_triggered_without_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-2",
                "candidate_id": "cand-2",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "rollback-proof", "status": "pass", "artifact_refs": []},
                ],
                "artifact_refs": [
                    str(Path(tmpdir) / "backtest" / "walkforward-results.json")
                ],
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2), encoding="utf-8"
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "stable",
                    "reasons": ["watchlist_signal"],
                    "rollback_triggered": True,
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            phases = updated_manifest["phases"]
            self.assertEqual(
                [phase["name"] for phase in phases],
                [
                    "gate-evaluation",
                    "promotion-prerequisites",
                    "rollback-readiness",
                    "drift-gate",
                    "paper-canary",
                    "runtime-governance",
                    "rollback-proof",
                ],
            )
            self.assertEqual(phases[5]["status"], "fail")
            self.assertEqual(phases[6]["status"], "fail")
            self.assertEqual(updated_manifest["rollback_proof"]["status"], "fail")
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"],
                "",
            )
            self.assertEqual(
                updated_manifest["runtime_governance"]["reasons"], ["watchlist_signal"]
            )
            self.assertEqual(
                updated_manifest["rollback_proof"]["reasons"], ["watchlist_signal"]
            )
            self.assertIn(
                {
                    "from": "runtime-governance",
                    "to": "rollback-proof",
                    "status": "fail",
                },
                updated_manifest["phase_transitions"],
            )

    def test_append_runtime_governance_adds_missing_runtime_and_rollback_phases(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-3",
                "candidate_id": "cand-3",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                ],
                "artifact_refs": [
                    str(Path(tmpdir) / "backtest" / "walkforward-results.json")
                ],
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2), encoding="utf-8"
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "stable",
                    "action": {"action_type": "none", "triggered": False},
                    "detection": {"reason_codes": []},
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                [phase["name"] for phase in updated_manifest["phases"]],
                [
                    "gate-evaluation",
                    "promotion-prerequisites",
                    "rollback-readiness",
                    "drift-gate",
                    "paper-canary",
                    "runtime-governance",
                    "rollback-proof",
                ],
            )
            self.assertEqual(updated_manifest["phases"][5]["status"], "pass")
            self.assertEqual(updated_manifest["phases"][6]["status"], "pass")
            self.assertEqual(
                updated_manifest["runtime_governance"]["governance_status"], "pass"
            )
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"], ""
            )
            phase_transition = {
                (transition.get("from"), transition.get("to")): transition.get("status")
                for transition in updated_manifest["phase_transitions"]
                if isinstance(transition, dict)
            }
            self.assertEqual(
                phase_transition.get(("runtime-governance", "rollback-proof")),
                "pass",
            )

    def test_run_autonomy_cycle_appends_runtime_governance_with_rollback_trigger_and_state_evidence_path(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler.state.rollback_incident_evidence_path = str(
                Path(tmpdir) / "state-incident.json"
            )
            Path(scheduler.state.rollback_incident_evidence_path).write_text(
                json.dumps(
                    {
                        "triggered_by": "state-fallback",
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )

            drift_payload = {
                "drift_status": "drift_detected",
                "reasons": ["fallback_ratio_regression"],
                "detection": {
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "action": {
                    "action_type": "quarantine",
                    "triggered": True,
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "rollback_triggered": True,
            }

            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._evaluate_drift_governance",
                    return_value=drift_payload,
                ):
                    scheduler._run_autonomous_cycle()

            manifest_path = deps.phase_manifest_path
            self.assertIsNotNone(manifest_path)
            assert manifest_path is not None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            phases_by_name = {
                phase["name"]: phase
                for phase in manifest["phases"]
                if isinstance(phase, dict)
            }
            self.assertEqual(phases_by_name["runtime-governance"]["status"], "fail")
            self.assertEqual(phases_by_name["rollback-proof"]["status"], "pass")
            self.assertEqual(
                manifest["rollback_proof"]["rollback_incident_evidence_path"],
                str(scheduler.state.rollback_incident_evidence_path),
            )
            self.assertIn(
                str(scheduler.state.rollback_incident_evidence_path),
                manifest["artifact_refs"],
            )
            self.assertIn(
                {
                    "from": "runtime-governance",
                    "to": "rollback-proof",
                    "status": "pass",
                },
                manifest["phase_transitions"],
            )

    def test_run_autonomy_cycle_appends_runtime_governance_fails_on_trigger_without_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )

            drift_payload = {
                "drift_status": "drift_detected",
                "reasons": ["fallback_ratio_regression"],
                "detection": {
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "action": {
                    "action_type": "quarantine",
                    "triggered": True,
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "rollback_triggered": True,
            }

            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._evaluate_drift_governance",
                    return_value=drift_payload,
                ):
                    scheduler._run_autonomous_cycle()

            manifest_path = deps.phase_manifest_path
            self.assertIsNotNone(manifest_path)
            assert manifest_path is not None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            phases_by_name = {
                phase["name"]: phase
                for phase in manifest["phases"]
                if isinstance(phase, dict)
            }
            self.assertEqual(phases_by_name["runtime-governance"]["status"], "fail")
            self.assertEqual(phases_by_name["rollback-proof"]["status"], "fail")
            self.assertEqual(
                manifest["rollback_proof"]["rollback_incident_evidence"], ""
            )
            self.assertIn(
                {
                    "from": "runtime-governance",
                    "to": "rollback-proof",
                    "status": "fail",
                },
                manifest["phase_transitions"],
            )

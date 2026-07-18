from __future__ import annotations

import asyncio

from tests.trading_scheduler_autonomy.support import (
    Path,
    SimpleNamespace,
    _TestTradingSchedulerAutonomyBase,
    datetime,
    json,
    patch,
    settings,
    tempfile,
    timedelta,
    timezone,
)


class TestRunAutonomousCycleUsesLivePromotionWhenTokenPresent(
    _TestTradingSchedulerAutonomyBase
):
    def test_run_autonomy_iteration_preserves_handled_cycle_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler._set_trading_iteration_error("trading_lane_failures:acct-a")
            scheduler._set_autonomy_iteration_error("stale_error")

            def handled_failure() -> None:
                scheduler._set_autonomy_iteration_error("lane_failed")

            with patch.object(
                scheduler,
                "_run_autonomous_cycle",
                side_effect=handled_failure,
            ):
                asyncio.run(scheduler._run_autonomy_iteration())

            self.assertEqual(scheduler.state.last_autonomy_error, "lane_failed")
            self.assertEqual(
                scheduler.state.last_error,
                "trading_lane_failures:acct-a;lane_failed",
            )

    def test_run_autonomy_iteration_clears_stale_error_after_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler._set_trading_iteration_error("trading_lane_failures:acct-a")
            scheduler._set_autonomy_iteration_error("stale_error")

            with patch.object(scheduler, "_run_autonomous_cycle"):
                asyncio.run(scheduler._run_autonomy_iteration())

            self.assertIsNone(scheduler.state.last_autonomy_error)
            self.assertEqual(
                scheduler.state.last_error,
                "trading_lane_failures:acct-a",
            )

    def test_run_autonomous_cycle_uses_live_promotion_when_token_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            outcome_path = Path(tmpdir) / "drift-outcome.json"
            outcome_path.write_text(
                json.dumps(
                    {
                        "checked_at": datetime.now(timezone.utc).isoformat(),
                        "eligible_for_live_promotion": True,
                        "reasons": [],
                    }
                ),
                encoding="utf-8",
            )
            scheduler.state.drift_last_outcome_path = str(outcome_path)
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "live")
            self.assertEqual(deps.call_kwargs["approval_token"], "live-approve-token")

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_drift_evidence_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_token_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_uses_strategy_paths_from_settings(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                deps.call_kwargs["strategy_config_path"],
                Path(settings.trading_strategy_config_path),
            )
            self.assertEqual(
                deps.call_kwargs["gate_policy_path"],
                Path(settings.trading_autonomy_gate_policy_path),
            )
            configmap_path = deps.call_kwargs["strategy_configmap_path"]
            self.assertEqual(
                configmap_path,
                Path(deps.call_kwargs["output_dir"]) / "strategy-configmap-source.yaml",
            )
            configmap_payload = json.loads(configmap_path.read_text(encoding="utf-8"))
            self.assertEqual(configmap_payload["apiVersion"], "v1")
            self.assertEqual(configmap_payload["kind"], "ConfigMap")
            self.assertEqual(
                configmap_payload["metadata"],
                {
                    "name": "torghut-strategy-config",
                    "namespace": "torghut",
                },
            )
            self.assertEqual(
                configmap_payload["data"]["strategies.yaml"],
                Path(settings.trading_strategy_config_path).read_text(encoding="utf-8"),
            )

    def test_run_autonomous_cycle_passes_persistence_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertTrue(deps.call_kwargs["persist_results"])
            self.assertIsNotNone(deps.call_kwargs["session_factory"])
            self.assertIsNotNone(deps.call_kwargs["session_factory"])
            self.assertEqual(
                deps.call_kwargs["governance_repository"], "proompteng/lab"
            )
            self.assertEqual(deps.call_kwargs["governance_base"], "main")
            self.assertEqual(
                deps.call_kwargs["governance_change"], "autonomous-promotion"
            )
            self.assertEqual(
                deps.call_kwargs["governance_reason"],
                "Autonomous recommendation for paper target.",
            )
            self.assertTrue(
                str(deps.call_kwargs["governance_head"]).startswith(
                    "agentruns/torghut-autonomy-"
                )
            )
            run_output_dir = Path(deps.call_kwargs["output_dir"])
            self.assertEqual(
                deps.call_kwargs["governance_artifact_path"], str(run_output_dir)
            )
            self.assertTrue(
                deps.call_kwargs["governance_artifact_path"].startswith(
                    str(Path(tmpdir) / "autonomy-artifacts")
                )
            )
            self.assertIsNone(deps.call_kwargs["priority_id"])

    def test_run_autonomous_cycle_accepts_governance_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            governance_root = Path(tmpdir) / "custom-autonomy-artifacts"
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle(
                    governance_repository="acme/lab",
                    governance_base="release",
                    governance_head="manual-autonomy-head",
                    governance_artifact_root=str(governance_root),
                    priority_id="priority-123",
                )

            self.assertEqual(deps.call_kwargs["governance_repository"], "acme/lab")
            self.assertEqual(deps.call_kwargs["governance_base"], "release")
            self.assertEqual(
                deps.call_kwargs["governance_head"], "manual-autonomy-head"
            )
            self.assertEqual(deps.call_kwargs["priority_id"], "priority-123")
            run_output_dir = Path(deps.call_kwargs["output_dir"])
            self.assertTrue(str(run_output_dir).startswith(str(governance_root)))
            self.assertEqual(
                deps.call_kwargs["governance_artifact_path"], str(run_output_dir)
            )

    def test_run_autonomous_cycle_records_gate_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_gates, str(deps.gate_report_path)
            )
            self.assertEqual(scheduler.state.last_autonomy_run_id, "test-run-id")
            self.assertEqual(scheduler.state.last_autonomy_recommendation, "paper")
            self.assertEqual(
                scheduler.state.last_autonomy_actuation_intent,
                str(deps.actuation_intent_path),
            )
            self.assertIn("drift_promotion_evidence", deps.call_kwargs)

    def test_run_autonomous_cycle_tracks_promotion_and_throughput_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "promotion_recommendation": {
                    "action": "promote",
                    "eligible": True,
                    "trace_id": "rec-trace-123",
                },
                "throughput": {
                    "signal_count": 9,
                    "decision_count": 7,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                    "no_signal_window": False,
                    "no_signal_reason": None,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                    "reason_codes": [],
                },
            }
            deps.actuation_payload = {
                "schema_version": "torghut.autonomy.actuation-intent.v1",
                "run_id": "test-run-id",
                "candidate_id": "cand-test",
                "actuation_allowed": True,
                "gates": {
                    "recommendation_trace_id": "rec-trace-123",
                    "gate_report_trace_id": "gate-trace-test",
                    "recommendation_reasons": ["unit_test"],
                },
                "artifact_refs": [],
                "audit": {
                    "rollback_readiness_readout": {
                        "kill_switch_dry_run_passed": True,
                        "gitops_revert_dry_run_passed": True,
                        "strategy_disable_dry_run_passed": True,
                    }
                },
            }
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.last_autonomy_promotion_action, "promote")
            self.assertTrue(scheduler.state.last_autonomy_promotion_eligible)
            self.assertEqual(
                scheduler.state.last_autonomy_recommendation_trace_id, "rec-trace-123"
            )
            self.assertEqual(scheduler.state.metrics.autonomy_promotions_total, 1)
            self.assertEqual(scheduler.state.metrics.autonomy_last_signal_count, 9)
            self.assertEqual(scheduler.state.metrics.autonomy_last_decision_count, 7)
            self.assertEqual(scheduler.state.metrics.autonomy_last_trade_count, 3)
            self.assertEqual(
                scheduler.state.metrics.autonomy_last_fold_metrics_count, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_last_stress_metrics_count, 4
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_signal_throughput_total, 9
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_decision_throughput_total, 7
            )
            self.assertEqual(scheduler.state.metrics.autonomy_trade_throughput_total, 3)
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_allowed_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total, 0
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_recommendation_total.get("paper"), 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("promoted_paper"), 1
            )

    def test_run_autonomous_cycle_blocks_promotion_when_actuation_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            deps.actuation_payload = {
                "schema_version": "torghut.autonomy.actuation-intent.v1",
                "run_id": "test-run-id",
                "candidate_id": "cand-test",
                "actuation_allowed": False,
                "gates": {
                    "recommendation_trace_id": "blocked-trace",
                    "gate_report_trace_id": "gate-trace-test",
                    "recommendation_reasons": ["rollback_checks_missing"],
                    "promotion_allowed": True,
                },
                "artifact_refs": [],
                "audit": {
                    "rollback_evidence_missing_checks": ["killSwitchDryRunFailed"],
                    "rollback_readiness_readout": {
                        "kill_switch_dry_run_passed": False,
                        "gitops_revert_dry_run_passed": False,
                        "strategy_disable_dry_run_passed": False,
                        "human_approved": False,
                        "rollback_target": "live",
                        "dry_run_completed_at": "",
                    },
                },
            }
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "promotion_recommendation": {
                    "action": "promote",
                    "eligible": True,
                    "trace_id": "rec-trace-blocked",
                },
                "throughput": {
                    "signal_count": 9,
                    "decision_count": 7,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                    "no_signal_window": False,
                    "no_signal_reason": None,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                    "reason_codes": [],
                },
            }
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.last_autonomy_promotion_action, "promote")
            self.assertTrue(scheduler.state.last_autonomy_promotion_eligible)
            self.assertEqual(
                scheduler.state.last_autonomy_recommendation_trace_id, "blocked-trace"
            )
            self.assertEqual(scheduler.state.metrics.autonomy_promotions_total, 1)
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_allowed_total, 0
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("blocked_paper"), 1
            )

    def test_run_autonomous_cycle_records_ingest_reason_when_no_signals(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ) as persist_no_signal:
                with patch(
                    "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                    side_effect=RuntimeError("should_not_run"),
                ):
                    scheduler._run_autonomous_cycle()

            persist_no_signal.assert_called_once()
            args = persist_no_signal.call_args.kwargs
            self.assertEqual(args["no_signal_reason"], "cursor_ahead_of_stream")
            self.assertIsNotNone(args["query_start"])
            self.assertIsNotNone(args["query_end"])

            self.assertEqual(
                scheduler.state.last_ingest_reason, "cursor_ahead_of_stream"
            )
            self.assertEqual(
                scheduler.state.last_autonomy_reason, "cursor_ahead_of_stream"
            )
            self.assertEqual(scheduler.state.last_autonomy_run_id, "no-signal-run-id")
            self.assertIn("no-signals.json", scheduler.state.last_autonomy_gates or "")
            self.assertIsNone(scheduler.state.last_autonomy_actuation_intent)
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total,
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_recommendation_total.get("shadow"),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("skipped_no_signal"),
                1,
            )

    def test_run_autonomous_cycle_uses_simulation_clock_for_no_signal_window(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            simulation_now = datetime(2026, 3, 11, 14, 5, 40, tzinfo=timezone.utc)
            lookback = timedelta(
                minutes=max(1, int(settings.trading_autonomy_signal_lookback_minutes))
            )
            with (
                patch.object(settings, "trading_simulation_enabled", True),
                patch(
                    "app.trading.scheduler.governance.governance_mixin_lifecycle_methods.trading_now",
                    return_value=simulation_now,
                ),
                patch(
                    "app.trading.scheduler.governance.governance_mixin_decision_methods.upsert_autonomy_no_signal_run",
                    return_value="no-signal-run-id",
                ) as persist_no_signal,
                patch(
                    "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                    side_effect=RuntimeError("should_not_run"),
                ),
            ):
                scheduler._run_autonomous_cycle()

            args = persist_no_signal.call_args.kwargs
            self.assertEqual(args["query_end"], simulation_now)
            self.assertEqual(args["query_start"], simulation_now - lookback)
            self.assertEqual(scheduler.state.last_autonomy_run_at, simulation_now)

    def test_run_autonomous_cycle_updates_ingest_metadata_on_signal_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            stale_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
            scheduler.state.last_ingest_window_start = stale_time
            scheduler.state.last_ingest_window_end = stale_time
            scheduler.state.last_ingest_reason = "stale-no-signal"

            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertIsNone(scheduler.state.last_ingest_reason)
            assert scheduler.state.last_ingest_window_start is not None
            assert scheduler.state.last_ingest_window_end is not None
            self.assertGreater(scheduler.state.last_ingest_window_start, stale_time)
            self.assertGreater(scheduler.state.last_ingest_window_end, stale_time)
            self.assertEqual(scheduler.state.last_ingest_signals_total, 1)
            self.assertEqual(scheduler.state.autonomy_signals_total, 1)

    def test_run_autonomous_cycle_alerts_on_repeated_no_signal_reasons(self) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 2
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak,
                {"cursor_ahead_of_stream": 1},
            )
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "cursor_ahead_of_stream"
                ),
            )

            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak,
                {"cursor_ahead_of_stream": 2},
            )
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "cursor_ahead_of_stream"
                ),
                1,
            )

    def test_run_autonomous_cycle_alerts_on_signal_lag(self) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 99
        settings.trading_signal_stale_lag_alert_seconds = 30
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="empty_batch_advanced",
                no_signal_lag_seconds=61.2,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.metrics.signal_lag_seconds, 61)
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "empty_batch_advanced"
                ),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak.get(
                    "empty_batch_advanced"
                ),
                1,
            )

    def test_run_autonomous_cycle_treats_market_closed_no_signal_as_expected(
        self,
    ) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 1
        settings.trading_signal_stale_lag_alert_seconds = 30
        settings.trading_signal_market_closed_expected_reasons_raw = (
            "no_signals_in_window,cursor_tail_stable,empty_batch_advanced"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="empty_batch_advanced",
                no_signal_lag_seconds=120.0,
                market_session_open=False,
            )
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_signal_continuity_state,
                "expected_market_closed_staleness",
            )
            self.assertFalse(bool(scheduler.state.last_signal_continuity_actionable))
            self.assertEqual(
                scheduler.state.metrics.signal_expected_staleness_total.get(
                    "empty_batch_advanced"
                ),
                1,
            )
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "empty_batch_advanced"
                )
            )

    def test_run_autonomous_cycle_records_error_on_lane_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler.state.last_autonomy_run_id = "stale-run-id"
            scheduler.state.last_autonomy_candidate_id = "stale-candidate-id"
            scheduler.state.last_autonomy_gates = str(Path(tmpdir) / "stale-gates.json")
            scheduler.state.last_autonomy_actuation_intent = str(
                Path(tmpdir) / "stale-actuation-intent.json"
            )
            scheduler.state.last_autonomy_patch = str(Path(tmpdir) / "stale-patch.yaml")
            scheduler.state.last_autonomy_recommendation = "paper"
            scheduler.state.last_autonomy_recommendation_trace_id = "stale-rec-trace"
            scheduler.state.last_autonomy_promotion_action = "promote"
            scheduler.state.last_autonomy_promotion_eligible = True
            scheduler._set_trading_iteration_error("trading_lane_failures:acct-a")
            with patch(
                "app.trading.scheduler.governance.governance_mixin_decision_methods.run_autonomous_lane",
                side_effect=RuntimeError("lane_failed"),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_reason, "lane_execution_failed"
            )
            self.assertEqual(scheduler.state.last_autonomy_error, "lane_failed")
            self.assertEqual(
                scheduler.state.last_error,
                "trading_lane_failures:acct-a;lane_failed",
            )
            self.assertIsNone(scheduler.state.last_autonomy_run_id)
            self.assertIsNone(scheduler.state.last_autonomy_candidate_id)
            self.assertIsNone(scheduler.state.last_autonomy_gates)
            self.assertIsNone(scheduler.state.last_autonomy_actuation_intent)
            self.assertIsNone(scheduler.state.last_autonomy_patch)
            self.assertIsNone(scheduler.state.last_autonomy_recommendation)
            self.assertIsNone(scheduler.state.last_autonomy_promotion_action)
            self.assertIsNone(scheduler.state.last_autonomy_promotion_eligible)
            self.assertIsNone(scheduler.state.last_autonomy_recommendation_trace_id)
            self.assertIsNone(scheduler.state.last_autonomy_throughput)

    def test_run_evidence_continuity_check_updates_scheduler_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_evidence_continuity_run_limit = 3
            with patch(
                "app.trading.scheduler.governance.governance_mixin_lifecycle_methods.evaluate_evidence_continuity"
            ) as mock_check:
                mock_check.return_value = SimpleNamespace(
                    checked_at=datetime(2026, 2, 19, 1, 0, tzinfo=timezone.utc),
                    checked_runs=2,
                    failed_runs=1,
                    run_ids=["run-1", "run-2"],
                    to_payload=lambda: {
                        "checked_runs": 2,
                        "failed_runs": 1,
                        "ok": False,
                    },
                )
                scheduler._run_evidence_continuity_check()

            mock_check.assert_called_once()
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_checks_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_failures_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_last_failed_runs, 1
            )
            self.assertEqual(
                scheduler.state.last_evidence_continuity_report,
                {"checked_runs": 2, "failed_runs": 1, "ok": False},
            )

    def test_safety_controls_trigger_emergency_stop_on_critical_staleness_streak(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "cursor_ahead_of_stream"
            )
            scheduler.state.metrics.no_signal_reason_streak = {
                "cursor_ahead_of_stream": 2
            }
            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)
            self.assertIn(
                "signal_staleness_streak_exceeded:cursor_ahead_of_stream:2",
                scheduler.state.emergency_stop_reason or "",
            )

    def test_safety_controls_suppress_fresh_no_signal_staleness_streak(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            settings.trading_signal_stale_lag_alert_seconds = 300
            settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "no_signals_in_window"
            )
            scheduler.state.metrics.signal_lag_seconds = 68
            scheduler.state.metrics.no_signal_reason_streak = {
                "no_signals_in_window": 2
            }
            with patch.object(
                type(scheduler),
                "_is_market_session_open",
                return_value=True,
            ):
                scheduler._evaluate_safety_controls()

            self.assertFalse(scheduler.state.emergency_stop_active)
            self.assertIsNone(scheduler.state.emergency_stop_reason)

    def test_safety_controls_trigger_emergency_stop_when_universe_unavailable(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_universe_source = "jangar"
            scheduler.state.universe_source_status = "unavailable"
            scheduler.state.universe_source_reason = "jangar_symbols_fetch_failed"

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "universe_source_unavailable:unavailable:jangar_symbols_fetch_failed",
                scheduler.state.emergency_stop_reason or "",
            )

from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_empirical_promotion_jobs.support import (
    RunEmpiricalPromotionJobsTestCase,
    SimpleNamespace,
    datetime,
    json,
    patch,
    renewal,
    timezone,
)


class TestRunEmpiricalPromotionJobsRuntimeWindowImportB(
    RunEmpiricalPromotionJobsTestCase
):
    def test_runtime_window_import_runs_multiple_observed_paper_imports(self) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        tsmom_path = self.tmp_dir / "h-tsmom-01.json"
        tsmom_path.write_text(
            json.dumps(
                {
                    "candidate_id": "spec-83161ae16d17828eabcc58cc",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        micro_path = self.tmp_dir / "h-micro-01.json"
        micro_path.write_text(
            json.dumps(
                {
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                }
            ),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"inserted_windows": 1, "promotion_decision": "blocked"})
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[
                (
                    "hypothesis_id=H-TSMOM-01,candidate_id=spec-83161ae16d17828eabcc58cc,"
                    f"strategy_family=intraday_tsmom_consistent,strategy_name=intraday-tsmom-profit-v3,"
                    f"source_manifest_ref={tsmom_path}"
                ),
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=chip-paper-microbar-composite@execution-proof,"
                    f"strategy_family=microstructure_breakout,"
                    f"strategy_name=microbar-volume-continuation-long-top2-chip-v1,"
                    f"source_manifest_ref={micro_path},"
                    f"dataset_snapshot_ref=torghut-chip-full-day-20260505-4c330ce9-r1,"
                    "delay_adjusted_depth_stress_report_ref=/proof/h-micro-delay-depth.json"
                ),
            ],
            runtime_window_hypothesis_id="H-TSMOM-01",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="intraday_tsmom_consistent",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="intraday-tsmom-profit-v3",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="2026-05-18T13:30:00Z",
            runtime_window_end="2026-05-18T20:00:00Z",
            runtime_window_dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref=str(tsmom_path),
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal.subprocess, "run", return_value=completed
        ) as run_mock:
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={
                    "candidate_id": "stale-empirical-candidate",
                    "dataset_snapshot_ref": "stale-empirical-dataset",
                },
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 18, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["target_count"], 2)
        self.assertEqual(payload["proof_status"], "blocked")
        blocker_codes = [item["blocker"] for item in payload["proof_blockers"]]
        self.assertEqual(
            blocker_codes,
            [
                "runtime_window_import_promotion_decision_not_allowed",
                "runtime_observation_missing",
                "runtime_window_import_promotion_decision_not_allowed",
                "runtime_observation_missing",
            ],
        )
        self.assertEqual(
            [item["hypothesis_id"] for item in payload["imports"]],
            ["H-TSMOM-01", "H-MICRO-01"],
        )
        commands = [call.args[0] for call in run_mock.call_args_list]
        self.assertEqual(len(commands), 2)
        joined = "\n".join(" ".join(command) for command in commands)
        self.assertIn("spec-83161ae16d17828eabcc58cc", joined)
        self.assertIn("chip-paper-microbar-composite@execution-proof", joined)
        self.assertIn("microbar-volume-continuation-long-top2-chip-v1", joined)
        self.assertIn("torghut-chip-full-day-20260505-4c330ce9-r1", joined)
        self.assertIn("--delay-adjusted-depth-stress-report-ref", joined)
        self.assertIn("/proof/h-micro-delay-depth.json", joined)
        for command in commands:
            self.assertEqual(
                command[command.index("--dependency-quorum-decision") + 1], ""
            )
            self.assertEqual(command[command.index("--continuity-ok") + 1], "")
            self.assertEqual(command[command.index("--drift-ok") + 1], "")

    def test_runtime_window_import_uses_latest_source_activity_window_when_unpinned(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        micro_path = self.tmp_dir / "h-micro-01.json"
        micro_path.write_text(
            json.dumps(
                {
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                }
            ),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"inserted_windows": 1, "promotion_decision": "blocked"})
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=chip-paper-microbar-composite@execution-proof,"
                    "strategy_family=microstructure_breakout,"
                    "strategy_name=microbar-volume-continuation-long-top2-chip-v1,"
                    f"source_manifest_ref={micro_path},"
                    "dataset_snapshot_ref=torghut-chip-full-day-20260505-4c330ce9-r1"
                )
            ],
            runtime_window_hypothesis_id="H-TSMOM-01",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="intraday_tsmom_consistent",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="intraday-tsmom-profit-v3",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="",
            runtime_window_end="",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref=str(micro_path),
            runtime_window_source_kind="paper_runtime_observed",
        )
        source_window = (
            datetime(2026, 5, 6, 13, 30, tzinfo=timezone.utc),
            datetime(2026, 5, 15, 20, 0, tzinfo=timezone.utc),
        )

        with (
            patch.object(renewal.subprocess, "run", return_value=completed) as run_mock,
            patch.object(
                renewal,
                "_latest_source_activity_window",
                return_value=source_window,
            ) as source_window_mock,
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={
                    "candidate_id": "stale-empirical-candidate",
                    "dataset_snapshot_ref": "stale-empirical-dataset",
                },
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 19, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        source_window_mock.assert_called_once()
        self.assertEqual(payload["window_start"], "2026-05-06T13:30:00Z")
        self.assertEqual(payload["window_end"], "2026-05-15T20:00:00Z")
        self.assertEqual(payload["window_selection"], "source_execution_activity_span")
        command = run_mock.call_args.args[0]
        self.assertIn("--window-start", command)
        self.assertEqual(
            command[command.index("--window-start") + 1],
            "2026-05-06T13:30:00Z",
        )
        self.assertEqual(
            command[command.index("--window-end") + 1],
            "2026-05-15T20:00:00Z",
        )

    def test_runtime_window_import_keeps_explicit_window_pinned(self) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        micro_path = self.tmp_dir / "h-micro-01.json"
        micro_path.write_text(
            json.dumps({"candidate_id": "candidate-1"}),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"inserted_windows": 1, "promotion_decision": "blocked"})
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=candidate-1,"
                    "strategy_family=microstructure_breakout,"
                    f"strategy_name=microbar-volume-continuation-long-top2-chip-v1,source_manifest_ref={micro_path}"
                )
            ],
            runtime_window_hypothesis_id="H-TSMOM-01",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="intraday_tsmom_consistent",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="intraday-tsmom-profit-v3",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="2026-05-18T13:30:00Z",
            runtime_window_end="2026-05-18T20:00:00Z",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref=str(micro_path),
            runtime_window_source_kind="paper_runtime_observed",
        )

        with (
            patch.object(renewal.subprocess, "run", return_value=completed),
            patch.object(
                renewal,
                "_latest_source_activity_window",
                return_value=(
                    datetime(2026, 5, 15, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 5, 15, 20, 0, tzinfo=timezone.utc),
                ),
            ) as source_window_mock,
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 19, 21, 23, tzinfo=timezone.utc),
            )

        source_window_mock.assert_not_called()
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["window_start"], "2026-05-18T13:30:00Z")
        self.assertEqual(payload["window_end"], "2026-05-18T20:00:00Z")

    def test_runtime_window_import_uses_target_plan_window_and_artifacts(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-exact-replay"}),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-exact-replay",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "source_manifest_ref": str(hypothesis_path),
                                "source_kind": "simulation_exact_replay_runtime_ledger",
                                "runtime_ledger_artifact_ref": "proof/exact-replay-ledger.json",
                                "window_start": "2026-05-18T13:30:00Z",
                                "window_end": "2026-05-18T20:00:00Z",
                            }
                        ]
                    }
                }
            ),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"inserted_windows": 1, "promotion_decision": "blocked"})
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="",
            runtime_window_end="",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with (
            patch.object(renewal.subprocess, "run", return_value=completed) as run_mock,
            patch.object(
                renewal,
                "_latest_source_activity_window",
                return_value=(
                    datetime(2026, 5, 15, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 5, 15, 20, 0, tzinfo=timezone.utc),
                ),
            ) as source_window_mock,
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 19, 21, 23, tzinfo=timezone.utc),
            )

        source_window_mock.assert_not_called()
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["window_selection"], "target_plan_window")
        command = run_mock.call_args.args[0]
        self.assertEqual(
            command[command.index("--window-start") + 1],
            "2026-05-18T13:30:00Z",
        )
        self.assertEqual(
            command[command.index("--window-end") + 1],
            "2026-05-18T20:00:00Z",
        )
        self.assertIn("proof/exact-replay-ledger.json", command)

    def test_runtime_window_import_defers_future_target_plan_window(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "paper-route-plan.json"
        plan_path.write_text(
            json.dumps(
                {
                    "next_paper_route_runtime_window_targets": {
                        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-paper-route",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "source_manifest_ref": str(hypothesis_path),
                                "source_dsn_env": "SIM_DB_DSN",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "window_start": "2026-05-26T13:30:00Z",
                                "window_end": "2026-05-26T20:00:00Z",
                                "paper_route_probe_next_session_max_notional": "25",
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_target_plan_url=[],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=True,
            runtime_window_target_plan_required=True,
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_targets_from_registry=True,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="",
            runtime_window_end="",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with (
            patch.object(
                renewal.subprocess,
                "run",
                side_effect=AssertionError("future target window should not import"),
            ),
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
                side_effect=AssertionError("autoresearch fallback should not run"),
            ),
            patch.object(
                renewal,
                "_registry_runtime_window_targets",
                side_effect=AssertionError("registry fallback should not run"),
            ),
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 24, 20, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["status"], "deferred")
        self.assertEqual(
            payload["reason"], "runtime_window_target_plan_window_not_closed"
        )
        self.assertEqual(payload["window_selection"], "target_plan_window")
        self.assertEqual(payload["window_start"], "2026-05-26T13:30:00Z")
        self.assertEqual(payload["window_end"], "2026-05-26T20:00:00Z")
        self.assertEqual(payload["proof_status"], "deferred")
        self.assertEqual(
            payload["proof_blockers"][0]["type"],
            "runtime_window_target_plan_window_not_closed",
        )
        self.assertEqual(
            payload["target_metadata"]["paper_route_probe_next_session_max_notional"],
            "25",
        )

    def test_deferred_paper_route_targets_emit_offline_replay_triage(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        ranking_path = self.tmp_dir / "exact-replay-ledger-ranking.json"
        ranking_path.write_text(
            json.dumps(
                {
                    "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                    "candidate_count": 1,
                    "candidates": [
                        {
                            "candidate_id": "cand-replay-triage",
                            "artifact_ref": "proof/exact-replay-ledger.json",
                            "promotion_status": "blocked_pending_runtime_promotion_proof",
                            "promotion_blockers": ["replay_artifact_only_not_live"],
                            "runtime_ledger_blockers": [],
                            "window_start": "2026-05-25T13:30:00Z",
                            "window_end": "2026-05-25T20:00:00Z",
                            "window_net_pnl_per_day": "625",
                            "total_net_pnl_after_costs": "625",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "paper-route-plan.json"
        plan_path.write_text(
            json.dumps(
                {
                    "next_paper_route_runtime_window_targets": {
                        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-paper-route",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "source_manifest_ref": str(hypothesis_path),
                                "source_dsn_env": "SIM_DB_DSN",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "artifact_refs": [str(ranking_path)],
                                "exact_replay_ledger_artifact_ref": "proof/exact-replay-ledger.json",
                                "window_start": "2026-05-26T13:30:00Z",
                                "window_end": "2026-05-26T20:00:00Z",
                                "paper_route_probe_next_session_max_notional": "25",
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_allowed": False,
                                "runtime_ledger_target_metadata_blockers": [
                                    "replay_artifact_only_not_live"
                                ],
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_target_plan_url=[],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=True,
            runtime_window_target_plan_required=True,
            runtime_window_target_plan_settlement_seconds=0,
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_targets_from_registry=True,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="",
            runtime_window_end="",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with (
            patch.object(
                renewal.subprocess,
                "run",
                side_effect=AssertionError("future target window should not import"),
            ),
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
                side_effect=AssertionError("autoresearch fallback should not run"),
            ),
            patch.object(
                renewal,
                "_registry_runtime_window_targets",
                side_effect=AssertionError("registry fallback should not run"),
            ),
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 25, 20, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["status"], "deferred")
        self.assertEqual(payload["proof_status"], "deferred")
        self.assertEqual(
            payload["reason"], "runtime_window_target_plan_window_not_closed"
        )
        self.assertEqual(
            payload["proof_blockers"][0]["type"],
            "runtime_window_target_plan_window_not_closed",
        )
        triage = payload["offline_replay_triage"]
        self.assertEqual(triage["authority"], "non_authoritative_research_triage")
        self.assertFalse(triage["promotion_allowed"])
        self.assertEqual(triage["promotion_authority"], "blocked")
        self.assertTrue(triage["excluded_from_runtime_window_import_proof"])
        self.assertEqual(
            triage["source_kind"], "simulation_exact_replay_runtime_ledger"
        )
        self.assertEqual(triage["proof_status_effect"], "none")
        self.assertEqual(triage["runtime_window_import_proof_effect"], "none")
        self.assertEqual(triage["lifecycle_count_effect"], "none")
        self.assertEqual(triage["doc29_live_scale_gate_effect"], "none")
        self.assertEqual(triage["post_cost_pnl_target_gate_effect"], "none")
        self.assertEqual(
            triage["deferred_reasons"],
            ["runtime_window_target_plan_window_not_closed"],
        )
        self.assertEqual(triage["candidates"][0]["candidate_id"], "cand-paper-route")
        self.assertFalse(triage["candidates"][0]["promotion_allowed"])
        self.assertTrue(
            triage["candidates"][0]["excluded_from_runtime_window_import_proof"]
        )
        self.assertEqual(
            triage["candidates"][0]["source_kind"],
            "simulation_exact_replay_runtime_ledger",
        )
        self.assertEqual(
            triage["source_reports"][0]["schema_version"],
            "torghut.exact-replay-ledger-ranking.v1",
        )
        self.assertEqual(
            triage["source_report_candidates"][0]["candidate_id"],
            "cand-replay-triage",
        )
        self.assertFalse(triage["source_report_candidates"][0]["promotion_allowed"])

    def test_offline_replay_triage_does_not_displace_import_ready_paper_route(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "paper-route-plan.json"
        plan_path.write_text(
            json.dumps(
                {
                    "next_paper_route_runtime_window_targets": {
                        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-paper-route",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "source_manifest_ref": str(hypothesis_path),
                                "source_dsn_env": "SIM_DB_DSN",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "runtime_ledger_artifact_ref": "proof/exact-replay-ledger.json",
                                "window_start": "2026-05-25T13:30:00Z",
                                "window_end": "2026-05-25T20:00:00Z",
                                "paper_route_probe_next_session_max_notional": "25",
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "status": "ok",
                    "promotion_allowed": False,
                    "promotion_blocking_reasons": [
                        "paper_stage_evidence_collection_only"
                    ],
                    "runtime_observation": {
                        "authoritative": False,
                        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                    },
                }
            )
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_target_plan_url=[],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=True,
            runtime_window_target_plan_required=True,
            runtime_window_target_plan_settlement_seconds=0,
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="",
            runtime_window_end="",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal.subprocess,
            "run",
            return_value=completed,
        ) as run_mock:
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 25, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["proof_status"], "blocked")
        self.assertNotIn("offline_replay_triage", payload)
        command = run_mock.call_args.args[0]
        self.assertIn("scripts/import_hypothesis_runtime_windows.py", command)
        self.assertIn("cand-paper-route", command)
        self.assertIn("proof/exact-replay-ledger.json", command)

    def test_offline_replay_triage_handles_multi_deferred_bounded_sources(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        ranking_path = self.tmp_dir / "exact-replay-ledger-ranking.json"
        ranking_path.write_text(
            json.dumps(
                {
                    "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                    "candidates": [
                        {
                            "candidate_id": f"cand-replay-triage-{index}",
                            "artifact_ref": f"proof/exact-replay-ledger-{index}.json",
                            "promotion_status": "blocked_pending_runtime_promotion_proof",
                        }
                        for index in range(7)
                    ],
                }
            ),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "paper-route-plan.json"
        plan_path.write_text(
            json.dumps(
                {
                    "next_paper_route_runtime_window_targets": {
                        "targets": [
                            {
                                "candidate_id": "cand-paper-route-a",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "source_manifest_ref": str(hypothesis_path),
                                "source_dsn_env": "SIM_DB_DSN",
                                "source_kind": "research_handoff",
                                "artifact_refs": [str(ranking_path)],
                                "exact_replay_ledger_artifact_refs": [
                                    "proof/exact-replay-ledger-a.json"
                                ],
                                "runtime_ledger_artifact_refs": [
                                    "proof/runtime-ledger-a.json"
                                ],
                                "candidate_selection": "exact_replay_ledger_best_candidate",
                                "selected_by": "replay_runtime_window_handoff_ranking",
                                "selection_reason": "blocked_pending_runtime_proof",
                                "handoff": "runtime_window_import_from_exact_replay_ledger",
                                "window_start": "2026-05-26T13:30:00Z",
                                "window_end": "2026-05-26T20:00:00Z",
                                "paper_route_probe_next_session_max_notional": "25",
                            },
                            {
                                "candidate_id": "cand-paper-route-b",
                                "hypothesis_id": "H-PAIRS-02",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "paper-route-candidate-v2",
                                "source_manifest_ref": str(hypothesis_path),
                                "source_dsn_env": "SIM_DB_DSN",
                                "source_kind": "research_handoff",
                                "artifact_refs": [str(ranking_path)],
                                "exact_replay_ledger_artifact_refs": [
                                    "proof/exact-replay-ledger-b.json"
                                ],
                                "runtime_ledger_artifact_refs": [
                                    "proof/runtime-ledger-b.json"
                                ],
                                "handoff": "runtime_window_import_from_exact_replay_ledger",
                                "window_start": "2026-05-26T13:30:00Z",
                                "window_end": "2026-05-26T20:00:00Z",
                                "paper_route_probe_next_session_max_notional": "25",
                            },
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_target_plan_url=[],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=True,
            runtime_window_target_plan_required=True,
            runtime_window_target_plan_settlement_seconds=0,
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="",
            runtime_window_end="",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal.subprocess,
            "run",
            side_effect=AssertionError("future target window should not import"),
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 25, 20, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["target_count"], 2)
        self.assertEqual(
            [item["status"] for item in payload["imports"]],
            ["deferred", "deferred"],
        )
        triage = payload["offline_replay_triage"]
        self.assertEqual(
            triage["source_kind"], "simulation_exact_replay_runtime_ledger"
        )
        self.assertEqual(len(triage["source_reports"]), 1)
        self.assertEqual(len(triage["source_report_candidates"]), 5)
        self.assertEqual(
            triage["candidates"][0]["selection"]["selected_by"],
            "replay_runtime_window_handoff_ranking",
        )
        self.assertEqual(
            triage["candidates"][0]["handoff"],
            "runtime_window_import_from_exact_replay_ledger",
        )
        self.assertEqual(
            triage["candidates"][0]["exact_replay_ledger_artifact_refs"],
            ["proof/exact-replay-ledger-a.json"],
        )
        self.assertIn(
            "proof/runtime-ledger-a.json",
            triage["candidates"][0]["source_artifact_refs"],
        )

    def test_offline_replay_triage_artifact_payload_variants(
        self,
    ) -> None:
        handoff_report = renewal._offline_replay_triage_from_artifact_payload(
            payload={
                "schema_version": "torghut.replay-runtime-window-handoff.v1",
                "source": "",
                "ranking": {"candidates": []},
                "best_exact_replay_ledger_candidate": {
                    "candidate_id": "cand-handoff",
                    "artifact_ref": "proof/handoff-ledger.json",
                },
            },
            source_ref="handoff.json",
        )
        self.assertIsNotNone(handoff_report)
        assert handoff_report is not None
        self.assertEqual(
            handoff_report["source"], "exact_replay_ledger_runtime_window_handoff"
        )
        self.assertEqual(
            handoff_report["candidates"][0]["candidate_id"], "cand-handoff"
        )

        candidate_board_report = renewal._offline_replay_triage_from_artifact_payload(
            payload={
                "candidate_board": {
                    "schema_version": "torghut.strategy-autoresearch-candidate-board.v1",
                    "best_exact_replay_ledger_candidate": {
                        "candidate_id": "cand-board",
                        "artifact_ref": "proof/board-ledger.json",
                    },
                }
            },
            source_ref="candidate-board.json",
        )
        self.assertIsNotNone(candidate_board_report)
        assert candidate_board_report is not None
        self.assertEqual(
            candidate_board_report["source"], "autoresearch_candidate_board"
        )
        self.assertEqual(
            candidate_board_report["candidates"][0]["candidate_id"], "cand-board"
        )

        self.assertEqual(
            renewal._offline_replay_triage_candidates_from_ranking(
                ranking={"candidates": "not-a-list"},
                source_ref="ranking.json",
            ),
            [],
        )
        self.assertEqual(
            renewal._offline_replay_triage_candidates_from_ranking(
                ranking={"candidates": ["not-a-mapping", {"candidate_id": "cand-ok"}]},
                source_ref="ranking.json",
            )[0]["candidate_id"],
            "cand-ok",
        )

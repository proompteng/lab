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


class TestRunEmpiricalPromotionJobsRuntimeWindowImportA(
    RunEmpiricalPromotionJobsTestCase
):
    def test_latest_completed_regular_session_uses_prior_session_before_close(
        self,
    ) -> None:
        start, end = renewal._latest_completed_regular_session(
            datetime(2026, 5, 18, 12, 23, tzinfo=timezone.utc)
        )

        self.assertEqual(start.isoformat(), "2026-05-15T13:30:00+00:00")
        self.assertEqual(end.isoformat(), "2026-05-15T20:00:00+00:00")

    def test_latest_completed_regular_session_uses_today_after_close(self) -> None:
        start, end = renewal._latest_completed_regular_session(
            datetime(2026, 5, 18, 21, 23, tzinfo=timezone.utc)
        )

        self.assertEqual(start.isoformat(), "2026-05-18T13:30:00+00:00")
        self.assertEqual(end.isoformat(), "2026-05-18T20:00:00+00:00")

    def test_runtime_window_import_runs_observed_paper_import(self) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-tsmom-01.json"
        hypothesis_path.write_text(
            json.dumps(
                {
                    "candidate_id": "spec-83161ae16d17828eabcc58cc",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"inserted_windows": 1, "promotion_decision": "blocked"})
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_hypothesis_id="H-TSMOM-01",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="intraday_tsmom_consistent",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_target_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="intraday-tsmom-profit-v3",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_start="2026-05-18T13:30:00Z",
            runtime_window_end="2026-05-18T20:00:00Z",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref=str(hypothesis_path),
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
        self.assertEqual(payload["hypothesis_id"], "H-TSMOM-01")
        self.assertEqual(payload["window_start"], "2026-05-18T13:30:00Z")
        self.assertEqual(payload["window_end"], "2026-05-18T20:00:00Z")
        command = run_mock.call_args.args[0]
        self.assertIn("scripts/import_hypothesis_runtime_windows.py", command)
        self.assertIn("--candidate-id", command)
        self.assertIn("spec-83161ae16d17828eabcc58cc", command)
        self.assertNotIn("stale-empirical-candidate", command)
        self.assertIn("--source-dsn-env", command)
        self.assertIn("SIM_DB_DSN", command)
        self.assertIn("--target-dsn-env", command)
        self.assertIn("SIM_DB_DSN", command)
        self.assertIn("--dataset-snapshot-ref", command)
        self.assertIn("portfolio-profit-autoresearch-500-v1", command)
        self.assertNotIn("stale-empirical-dataset", command)

    def test_runtime_window_import_audit_only_never_counts_as_promotion_proof(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-tsmom-01.json"
        hypothesis_path.write_text(
            json.dumps(
                {
                    "candidate_id": "spec-83161ae16d17828eabcc58cc",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "schema_version": "torghut.runtime-window-import-source-audit.v1",
                    "audit_only": True,
                    "would_persist": False,
                    "verdict": "profit_proof_present",
                    "runtime_observation": {
                        "authoritative": True,
                        "promotion_authority": "runtime_ledger_profit_proof",
                    },
                    "promotion_allowed": True,
                }
            )
        )
        args = SimpleNamespace(
            runtime_window_import=True,
            runtime_window_import_audit_only=True,
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
            runtime_window_source_manifest_ref=str(hypothesis_path),
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal.subprocess, "run", return_value=completed
        ) as run_mock:
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 18, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["status"], "audit_only")
        self.assertEqual(payload["proof_status"], "blocked")
        command = run_mock.call_args.args[0]
        self.assertIn("--audit-only", command)
        blocker_codes = [item["blocker"] for item in payload["proof_blockers"]]
        self.assertEqual(
            blocker_codes,
            ["runtime_window_import_audit_only_no_persistence"],
        )
        self.assertTrue(payload["summary"]["audit_only"])
        self.assertFalse(payload["summary"]["would_persist"])

    def test_runtime_window_import_discards_contaminated_target_plan_window(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_SIM",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
            window_start=window_start.isoformat(),
            window_end=window_end.isoformat(),
            target_metadata={
                "runtime_window_import_audit_state": (
                    "import_due_account_contamination_detected"
                ),
                "runtime_window_import_audit_blockers": [
                    "paper_route_account_contamination_detected",
                    "unlinked_order_events_present",
                    "foreign_order_events_present",
                ],
            },
        )
        args = SimpleNamespace(runtime_window_target_plan_settlement_seconds=3600)

        with patch.object(
            renewal.subprocess,
            "run",
            side_effect=AssertionError("dirty paper windows must not import"),
        ) as run_mock:
            payload = renewal._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=window_start,
                window_end=window_end,
                now=datetime(2026, 6, 1, 21, 5, tzinfo=timezone.utc),
            )

        run_mock.assert_not_called()
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["proof_status"], "blocked")
        self.assertEqual(
            payload["reason"],
            "runtime_window_target_plan_import_blocked:"
            "import_due_account_contamination_detected",
        )
        blocker_codes = [item["blocker"] for item in payload["proof_blockers"]]
        self.assertEqual(
            blocker_codes,
            [
                "import_due_account_contamination_detected",
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
                "foreign_order_events_present",
            ],
        )
        self.assertIsNone(payload["summary"])

    def test_runtime_window_import_blocked_result_ignores_source_collection_targets(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        window_start = datetime(2026, 5, 13, 15, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 13, 16, 0, tzinfo=timezone.utc)
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-TSMOM-LIQ-01",
            candidate_id="ca4e6e3c7d639e3363dc5860",
            observed_stage="paper",
            strategy_family="intraday_tsmom",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="intraday-tsmom-v2",
            account_label="TORGHUT_REPLAY",
            source_account_label="TORGHUT_REPLAY",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
            source_kind="runtime_ledger_source_collection_candidate",
            delay_adjusted_depth_stress_report_ref="",
            window_start=window_start.isoformat(),
            window_end=window_end.isoformat(),
            target_metadata={
                "runtime_window_import_audit_state": (
                    "import_due_account_contamination_detected"
                ),
                "runtime_window_import_audit_blockers": [
                    "paper_route_account_contamination_detected",
                ],
                "handoff": "runtime_ledger_source_collection_import",
            },
        )

        self.assertIsNone(
            renewal._runtime_window_target_plan_import_blocked_result(
                target=target,
                candidate_id=target.candidate_id,
                manifest_path=manifest_path,
                window_start=window_start,
                window_end=window_end,
                window_selection="target_plan_window",
            )
        )

    def test_runtime_window_import_passes_probation_metadata_and_artifacts(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-micro-01.json"
        hypothesis_path.write_text(
            json.dumps(
                {
                    "candidate_id": "cand-paper-probation",
                    "dataset_snapshot_ref": "snapshot-paper-probation",
                }
            ),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-paper-probation",
                                "hypothesis_id": "H-MICRO-01",
                                "observed_stage": "paper",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_manifest_ref": str(hypothesis_path),
                                "dataset_snapshot_ref": "snapshot-paper-probation",
                                "artifact_refs": ["proof/replay-summary.json"],
                                "paper_probation_authorized": True,
                                "evidence_collection_stage": "paper",
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_allowed": False,
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
            runtime_window_start="2026-05-18T13:30:00Z",
            runtime_window_end="2026-05-18T20:00:00Z",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal.subprocess, "run", return_value=completed
        ) as run_mock:
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 18, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["candidate_id"], "cand-paper-probation")
        self.assertEqual(payload["artifact_refs"][1:], ["proof/replay-summary.json"])
        self.assertFalse(payload["target_metadata"]["promotion_allowed"])
        command = run_mock.call_args.args[0]
        self.assertIn("--artifact-ref", command)
        self.assertIn("proof/replay-summary.json", command)
        self.assertIn("--target-metadata-json", command)
        metadata_json = command[command.index("--target-metadata-json") + 1]
        metadata = json.loads(metadata_json)
        self.assertTrue(metadata["paper_probation_authorized"])
        self.assertEqual(metadata["evidence_collection_stage"], "paper")
        self.assertFalse(metadata["promotion_allowed"])
        self.assertFalse(metadata["final_promotion_authorized"])

    def test_runtime_window_import_repairs_source_windows_before_source_collection_import(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps(
                {
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        window_start = datetime(2026, 5, 13, 17, 0, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 13, 17, 30, tzinfo=timezone.utc)
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_PAPER",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref=str(hypothesis_path),
            source_kind="runtime_ledger_source_collection_candidate",
            delay_adjusted_depth_stress_report_ref="",
            window_start=window_start.isoformat(),
            window_end=window_end.isoformat(),
            target_metadata={
                "source_collection_next_action": (
                    "materialize_runtime_ledger_source_window_refs"
                ),
            },
        )
        args = SimpleNamespace(
            runtime_window_target_plan_settlement_seconds=0,
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_import_audit_only=False,
        )

        repair_completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "status": "ok",
                    "apply": True,
                    "source_window_only": False,
                    "backfill_execution_events": True,
                    "execution_event_backfill_enabled": True,
                    "selected": 2,
                    "source_windows_created": 1,
                    "source_windows_reused": 1,
                    "events_linked": 2,
                    "execution_event_backfill_events_created": 1,
                }
            )
        )
        import_completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "inserted_windows": 1,
                    "promotion_decision": "blocked",
                    "source_window_ids": ["window-1", "window-2"],
                }
            )
        )

        with patch.object(
            renewal.subprocess,
            "run",
            side_effect=[repair_completed, import_completed],
        ) as run_mock:
            payload = renewal._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=window_start,
                window_end=window_end,
                now=datetime(2026, 5, 13, 18, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(run_mock.call_count, 2)
        repair_command = run_mock.call_args_list[0].args[0]
        import_command = run_mock.call_args_list[1].args[0]
        self.assertIn("scripts/repair_order_feed_source_windows.py", repair_command)
        self.assertIn("--apply", repair_command)
        self.assertIn("--backfill-execution-events", repair_command)
        self.assertNotIn("--source-window-only", repair_command)
        self.assertIn("--window-start", repair_command)
        self.assertEqual(
            repair_command[repair_command.index("--window-start") + 1],
            "2026-05-13T17:00:00Z",
        )
        self.assertEqual(
            repair_command[repair_command.index("--window-end") + 1],
            "2026-05-13T17:30:00Z",
        )
        self.assertEqual(
            repair_command[repair_command.index("--account-label") + 1],
            "TORGHUT_PAPER",
        )
        self.assertEqual(
            repair_command[repair_command.index("--canonical-account-label") + 1],
            "TORGHUT_SIM",
        )
        self.assertIn("scripts/import_hypothesis_runtime_windows.py", import_command)
        self.assertEqual(
            import_command[import_command.index("--source-account-label") + 1],
            "TORGHUT_PAPER",
        )
        self.assertEqual(payload["source_window_repair"]["events_linked"], 2)
        self.assertFalse(payload["source_window_repair"]["source_window_only"])
        self.assertTrue(payload["source_window_repair"]["backfill_execution_events"])
        self.assertTrue(
            payload["source_window_repair"]["execution_event_backfill_enabled"]
        )
        self.assertEqual(payload["summary"]["source_window_repair"]["events_linked"], 2)

    def test_runtime_window_import_audit_only_dry_runs_source_window_repair(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps(
                {
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        window_start = datetime(2026, 5, 13, 17, 0, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 13, 17, 30, tzinfo=timezone.utc)
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_SIM",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref=str(hypothesis_path),
            source_kind="runtime_ledger_source_collection_candidate",
            delay_adjusted_depth_stress_report_ref="",
            window_start=window_start.isoformat(),
            window_end=window_end.isoformat(),
            target_metadata={
                "source_collection_next_action": (
                    "materialize_runtime_ledger_source_window_refs"
                ),
            },
        )
        args = SimpleNamespace(
            runtime_window_target_plan_settlement_seconds=0,
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_import_audit_only=True,
        )

        repair_completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "status": "ok",
                    "apply": False,
                    "source_window_only": False,
                    "backfill_execution_events": True,
                    "execution_event_backfill_enabled": True,
                    "selected": 2,
                    "source_windows_created": 1,
                    "source_windows_reused": 1,
                    "events_linked": 2,
                }
            )
        )
        import_completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "schema_version": "torghut.runtime-window-import-source-audit.v1",
                    "audit_only": True,
                    "would_persist": False,
                    "promotion_allowed": True,
                }
            )
        )

        with patch.object(
            renewal.subprocess,
            "run",
            side_effect=[repair_completed, import_completed],
        ) as run_mock:
            payload = renewal._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=window_start,
                window_end=window_end,
                now=datetime(2026, 5, 13, 18, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(run_mock.call_count, 2)
        repair_command = run_mock.call_args_list[0].args[0]
        import_command = run_mock.call_args_list[1].args[0]
        self.assertIn("--backfill-execution-events", repair_command)
        self.assertNotIn("--source-window-only", repair_command)
        self.assertNotIn("--apply", repair_command)
        self.assertIn("--audit-only", import_command)
        self.assertEqual(payload["status"], "audit_only")
        self.assertEqual(payload["proof_status"], "blocked")
        self.assertFalse(payload["source_window_repair"]["apply"])
        self.assertFalse(payload["source_window_repair"]["source_window_only"])
        self.assertTrue(payload["source_window_repair"]["backfill_execution_events"])
        blocker_codes = [item["blocker"] for item in payload["proof_blockers"]]
        self.assertIn("runtime_window_import_audit_only_no_persistence", blocker_codes)

    def test_runtime_window_source_window_repair_rejects_non_mapping_payload(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 13, 17, 0, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 13, 17, 30, tzinfo=timezone.utc)
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            source_account_label="TORGHUT_SIM",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="runtime_ledger_source_collection_candidate",
            delay_adjusted_depth_stress_report_ref="",
            window_start=window_start.isoformat(),
            window_end=window_end.isoformat(),
            target_metadata={
                "source_collection_next_action": (
                    "materialize_runtime_ledger_source_window_refs"
                ),
            },
        )

        with patch.object(
            renewal.subprocess,
            "run",
            return_value=SimpleNamespace(stdout="[]"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_source_window_repair_payload_not_mapping",
            ):
                renewal._run_runtime_window_source_window_repair(
                    target=target,
                    window_start=window_start,
                    window_end=window_end,
                    audit_only=False,
                )

    def test_runtime_window_target_metadata_defaults_source_collection_blockers(
        self,
    ) -> None:
        metadata = renewal._runtime_window_target_metadata(
            {
                "source_collection_authorized": True,
                "source_collection_reason_codes": [
                    "source_window_evidence_collection_pending"
                ],
                "source_collection_priority": "profit_target_source_materialization",
                "source_collection_profit_target_candidate": True,
                "source_collection_profit_target_net_pnl_after_costs": "567.44720578",
                "source_collection_filled_notional": "127090.02495200",
                "source_collection_net_strategy_pnl_after_costs": "567.44720578",
                "source_collection_post_cost_expectancy_bps": "44.64923238",
                "source_collection_next_action": (
                    "materialize_runtime_ledger_source_window_refs"
                ),
                "bounded_evidence_collection_authorized": True,
                "bounded_evidence_collection_scope": (
                    "paper_route_probe_next_session_only"
                ),
                "bounded_evidence_collection_max_notional": "63180",
                "paper_route_probe_effective_max_notional": "63180",
                "source_window_start": "2026-05-13T17:00:00+00:00",
                "source_window_end": "2026-05-13T17:30:00+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "order_feed_source_windows": 2,
                },
                "source_window_ids": ["window-1", "window-2"],
                "trade_decision_ids": ["decision-1", "decision-2"],
                "execution_ids": ["execution-1", "execution-2"],
                "execution_tca_metric_ids": ["tca-1", "tca-2"],
                "execution_order_event_ids": ["event-1", "event-2"],
                "source_offsets": [
                    {
                        "topic": "torghut.trade-updates.v1",
                        "partition": 1,
                        "offset": 7091,
                    }
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                "source_decision_mode": "route_acquisition_probe",
                "profit_proof_eligible": False,
            }
        )

        self.assertTrue(metadata["source_collection_authorized"])
        self.assertEqual(
            metadata["source_collection_authorization_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertEqual(metadata["evidence_collection_stage"], "paper")
        self.assertEqual(
            metadata["source_collection_reason_codes"],
            ["source_window_evidence_collection_pending"],
        )
        self.assertEqual(
            metadata["source_collection_priority"],
            "profit_target_source_materialization",
        )
        self.assertTrue(metadata["source_collection_profit_target_candidate"])
        self.assertEqual(
            metadata["source_collection_profit_target_net_pnl_after_costs"],
            "567.44720578",
        )
        self.assertEqual(
            metadata["source_collection_filled_notional"], "127090.02495200"
        )
        self.assertEqual(
            metadata["source_collection_net_strategy_pnl_after_costs"],
            "567.44720578",
        )
        self.assertEqual(
            metadata["source_collection_post_cost_expectancy_bps"],
            "44.64923238",
        )
        self.assertEqual(metadata["source_window_start"], "2026-05-13T17:00:00+00:00")
        self.assertEqual(metadata["source_window_ids"], ["window-1", "window-2"])
        self.assertEqual(
            metadata["source_refs"],
            [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(metadata["trade_decision_ids"], ["decision-1", "decision-2"])
        self.assertEqual(metadata["execution_ids"], ["execution-1", "execution-2"])
        self.assertEqual(metadata["execution_tca_metric_ids"], ["tca-1", "tca-2"])
        self.assertEqual(metadata["execution_order_event_ids"], ["event-1", "event-2"])
        self.assertEqual(metadata["source_materialization"], "execution_order_events")
        self.assertEqual(
            metadata["authority_class"], "runtime_order_feed_execution_source"
        )
        self.assertEqual(
            metadata["authority_reason"], "event_sourced_runtime_ledger_profit_proof"
        )
        self.assertEqual(
            metadata["source_collection_next_action"],
            "materialize_runtime_ledger_source_window_refs",
        )
        self.assertTrue(metadata["bounded_evidence_collection_authorized"])
        self.assertEqual(
            metadata["bounded_evidence_collection_scope"],
            "paper_route_probe_next_session_only",
        )
        self.assertEqual(metadata["bounded_evidence_collection_max_notional"], "63180")
        self.assertEqual(metadata["paper_route_probe_effective_max_notional"], "63180")
        self.assertEqual(metadata["source_decision_mode"], "route_acquisition_probe")
        self.assertFalse(metadata["profit_proof_eligible"])
        self.assertFalse(metadata["promotion_allowed"])
        self.assertFalse(metadata["final_promotion_authorized"])
        self.assertFalse(metadata["final_promotion_allowed"])

    def test_runtime_window_import_runs_same_hypothesis_plan_candidate_lanes(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        first_path = self.tmp_dir / "h-micro-first.json"
        first_path.write_text(
            json.dumps(
                {
                    "candidate_id": "cand-plan-a",
                    "dataset_snapshot_ref": "snapshot-plan-a",
                }
            ),
            encoding="utf-8",
        )
        second_path = self.tmp_dir / "h-micro-second.json"
        second_path.write_text(
            json.dumps(
                {
                    "candidate_id": "cand-plan-b",
                    "dataset_snapshot_ref": "snapshot-plan-b",
                }
            ),
            encoding="utf-8",
        )
        plan_path = self.tmp_dir / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-plan-a",
                                "hypothesis_id": "H-MICRO-01",
                                "observed_stage": "paper",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_manifest_ref": str(first_path),
                            },
                            {
                                "candidate_id": "cand-plan-b",
                                "hypothesis_id": "H-MICRO-01",
                                "observed_stage": "paper",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_manifest_ref": str(second_path),
                            },
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
            runtime_window_start="2026-05-18T13:30:00Z",
            runtime_window_end="2026-05-18T20:00:00Z",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal.subprocess, "run", return_value=completed
        ) as run_mock:
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 18, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["target_count"], 2)
        self.assertEqual(
            [item["candidate_id"] for item in payload["imports"]],
            ["cand-plan-a", "cand-plan-b"],
        )
        commands = [call.args[0] for call in run_mock.call_args_list]
        self.assertEqual(len(commands), 2)
        joined = "\n".join(" ".join(command) for command in commands)
        self.assertIn("cand-plan-a", joined)
        self.assertIn("cand-plan-b", joined)

from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_empirical_promotion_jobs.support import (
    MagicMock,
    RunEmpiricalPromotionJobsTestCase,
    SimpleNamespace,
    datetime,
    json,
    patch,
    renewal,
    timezone,
)


class TestRunEmpiricalPromotionJobsRuntimeWindowBlockers(
    RunEmpiricalPromotionJobsTestCase
):
    def test_offline_replay_triage_early_exit_guards(self) -> None:
        now = datetime(2026, 5, 25, 20, 23, tzinfo=timezone.utc)
        args = SimpleNamespace(runtime_window_target_plan_exclusive=False)
        deferred = {
            "status": "deferred",
            "reason": "runtime_window_target_plan_window_not_closed",
            "source_kind": "paper_route_probe_runtime_observed",
            "target_metadata": {},
        }

        self.assertIsNone(
            renewal._offline_replay_triage_for_deferred_imports(
                args=args,
                imports=[deferred],
                now=now,
            )
        )
        args.runtime_window_target_plan_exclusive = True
        self.assertIsNone(
            renewal._offline_replay_triage_for_deferred_imports(
                args=args,
                imports=[],
                now=now,
            )
        )
        self.assertIsNone(
            renewal._offline_replay_triage_for_deferred_imports(
                args=args,
                imports=[
                    {
                        **deferred,
                        "reason": "runtime_window_import_blocked_for_other_reason",
                    }
                ],
                now=now,
            )
        )
        self.assertIsNone(
            renewal._offline_replay_triage_for_deferred_imports(
                args=args,
                imports=[
                    {
                        **deferred,
                        "source_kind": "research_handoff",
                    }
                ],
                now=now,
            )
        )

    def test_runtime_window_import_future_target_plan_requires_candidate_id(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"strategy_name": "paper-route-candidate-v1"}),
            encoding="utf-8",
        )
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref=str(hypothesis_path),
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
            window_start="2026-05-26T13:30:00Z",
            window_end="2026-05-26T20:00:00Z",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "runtime_window_candidate_id_missing",
        ):
            renewal._run_runtime_window_import_target(
                args=SimpleNamespace(),
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=datetime(2026, 5, 18, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 5, 18, 20, 0, tzinfo=timezone.utc),
                now=datetime(2026, 5, 24, 20, 23, tzinfo=timezone.utc),
            )

    def test_runtime_window_import_defers_target_plan_settlement_grace(
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
                    "runtime_window_import_plan": {
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
                            }
                        ]
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
            runtime_window_target_plan_settlement_seconds=3600,
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
            side_effect=AssertionError("settlement grace should defer import"),
        ):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 26, 20, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["status"], "deferred")
        self.assertEqual(
            payload["reason"], "runtime_window_target_plan_window_settlement_pending"
        )
        self.assertEqual(payload["proof_status"], "deferred")
        self.assertEqual(
            payload["proof_blockers"][0]["type"],
            "runtime_window_target_plan_window_settlement_pending",
        )
        self.assertEqual(payload["proof_blockers"][0]["settlement_seconds"], 3600)
        self.assertEqual(
            payload["proof_blockers"][0]["settlement_ready_at"],
            "2026-05-26T21:00:00Z",
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"inserted_windows": 1, "promotion_decision": "blocked"})
        )

        with patch.object(
            renewal.subprocess, "run", return_value=completed
        ) as run_mock:
            imported = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 26, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(imported)
        assert imported is not None
        self.assertEqual(imported["status"], "ok")
        command = run_mock.call_args.args[0]
        self.assertEqual(
            command[command.index("--window-start") + 1],
            "2026-05-26T13:30:00Z",
        )
        self.assertEqual(
            command[command.index("--window-end") + 1],
            "2026-05-26T20:00:00Z",
        )

    def test_runtime_window_import_blocks_non_authoritative_import_summary(
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
                    "runtime_window_import_plan": {
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
                            }
                        ]
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
                        "paper_stage_evidence_collection_only",
                        "runtime_ledger_pnl_basis_missing",
                    ],
                    "runtime_observation": {
                        "authoritative": False,
                        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                        "promotion_authority": "blocked",
                        "runtime_ledger_profit_proof_present": False,
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
            runtime_window_target_plan_settlement_seconds=3600,
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

        with patch.object(renewal.subprocess, "run", return_value=completed):
            payload = renewal._run_runtime_window_import(
                args=args,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                now=datetime(2026, 5, 26, 21, 23, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["proof_status"], "blocked")
        blocker_codes = [item["blocker"] for item in payload["proof_blockers"]]
        self.assertEqual(
            blocker_codes,
            [
                "paper_stage_evidence_collection_only",
                "runtime_ledger_pnl_basis_missing",
                "runtime_without_runtime_ledger_profit_proof",
            ],
        )

    def test_runtime_window_import_payload_keeps_existing_proof_blockers(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )

        blockers = renewal._runtime_window_import_payload_proof_blockers(
            payload={
                "proof_blockers": [
                    {
                        "blocker": "runtime_ledger_pnl_basis_missing",
                        "candidate_id": "cand-paper-route",
                    }
                ],
                "promotion_allowed": False,
                "promotion_blocking_reasons": ["ignored_when_blockers_exist"],
            },
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(
            blockers,
            [
                {
                    "blocker": "runtime_ledger_pnl_basis_missing",
                    "candidate_id": "cand-paper-route",
                }
            ],
        )

    def test_runtime_window_import_payload_promotes_source_diagnostics_to_blockers(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )

        blockers = renewal._runtime_window_import_payload_proof_blockers(
            payload={
                "promotion_allowed": False,
                "promotion_blocking_reasons": ["generic_not_allowed"],
                "source_activity_diagnostic_blockers": [
                    "source_lineage_filter_excluded_activity",
                    "order_feed_fill_lifecycle_missing",
                ],
                "runtime_observation": {
                    "authoritative": False,
                    "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                },
            },
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(
            [item["blocker"] for item in blockers],
            [
                "source_lineage_filter_excluded_activity",
                "order_feed_fill_lifecycle_missing",
                "runtime_without_runtime_ledger_profit_proof",
            ],
        )
        self.assertNotIn("generic_not_allowed", [item["blocker"] for item in blockers])

    def test_runtime_window_import_blocker_ladder_points_to_next_missing_artifact(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        payload = {
            "promotion_allowed": False,
            "source_activity_diagnostics": {
                "decision_rows_before_lineage_filter": 2,
                "decision_rows_after_lineage_filter": 2,
                "execution_rows_before_lineage_filter": 0,
                "execution_rows_after_lineage_filter": 0,
                "runtime_ledger_source_bucket_count": 0,
                "runtime_ledger_source_bucket_profit_proof_count": 0,
            },
            "source_activity_diagnostic_blockers": [
                "execution_rows_missing_for_matched_decisions",
                "runtime_ledger_source_bucket_missing",
            ],
            "runtime_observation": {
                "authoritative": False,
                "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                "promotion_authority": "blocked",
                "runtime_ledger_profit_proof_present": False,
            },
        }
        proof_blockers = renewal._runtime_window_import_payload_proof_blockers(
            payload=payload,
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        ladder = renewal._runtime_window_import_blocker_ladder(
            payload=payload,
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
            proof_blockers=proof_blockers,
        )
        next_blocker = renewal._runtime_window_import_next_blocker(ladder)

        self.assertEqual(
            [(item["step"], item["status"]) for item in ladder[:3]],
            [
                ("source_activity_present", "pass"),
                ("decisions_present", "pass"),
                ("executions_present", "blocked"),
            ],
        )
        self.assertEqual(next_blocker["step"], "executions_present")
        self.assertEqual(
            next_blocker["blocker_codes"],
            ["execution_rows_missing_for_matched_decisions"],
        )

    def test_runtime_window_import_blocker_ladder_passes_runtime_authority(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        payload = {
            "promotion_allowed": True,
            "decision_count": 2,
            "execution_count": 2,
            "order_count": 4,
            "tca_row_count": 2,
            "runtime_observation": {
                "authoritative": True,
                "authority_reason": "runtime_ledger_profit_proof",
                "promotion_authority": "runtime_ledger",
                "runtime_ledger_profit_proof_present": True,
                "runtime_ledger_source_bucket_count": 1,
                "runtime_ledger_source_execution_materialized_bucket_count": 1,
                "runtime_ledger_tca_profit_proof_count": 1,
            },
        }

        ladder = renewal._runtime_window_import_blocker_ladder(
            payload=payload,
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
            proof_blockers=[],
        )

        self.assertTrue(all(item["status"] == "pass" for item in ladder))
        self.assertIsNone(renewal._runtime_window_import_next_blocker(ladder))

    def test_runtime_window_import_payload_deduplicates_fallback_blockers(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )

        blockers = renewal._runtime_window_import_payload_proof_blockers(
            payload={
                "promotion_allowed": False,
                "promotion_blocking_reasons": [
                    "",
                    "paper_stage_evidence_collection_only",
                    "paper_stage_evidence_collection_only",
                ],
                "runtime_observation": {
                    "authoritative": False,
                    "authority_reason": "",
                    "promotion_authority": "blocked",
                    "runtime_ledger_profit_proof_present": False,
                },
            },
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(
            [item["blocker"] for item in blockers],
            [
                "paper_stage_evidence_collection_only",
                "runtime_observation_not_authoritative",
            ],
        )

    def test_runtime_window_import_payload_prefers_evidence_blockers(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )

        blockers = renewal._runtime_window_import_payload_proof_blockers(
            payload={
                "promotion_allowed": False,
                "evidence_blocking_reasons": [],
                "promotion_blocking_reasons": [
                    "paper_stage_evidence_collection_only",
                    "drift_checks_not_ok",
                ],
                "runtime_observation": {
                    "authoritative": True,
                    "authority_reason": "runtime_ledger_profit_proof",
                    "promotion_authority": "runtime_ledger",
                    "runtime_ledger_profit_proof_present": True,
                },
            },
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(blockers, [])

        blockers = renewal._runtime_window_import_payload_proof_blockers(
            payload={
                "promotion_allowed": False,
                "evidence_blocking_reasons": [
                    "runtime_ledger_pnl_basis_missing",
                    "runtime_ledger_pnl_basis_missing",
                ],
                "promotion_blocking_reasons": ["drift_checks_not_ok"],
                "runtime_observation": {
                    "authoritative": False,
                    "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                    "promotion_authority": "blocked",
                    "runtime_ledger_profit_proof_present": False,
                },
            },
            target=target,
            candidate_id="cand-paper-route",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(
            [item["blocker"] for item in blockers],
            [
                "runtime_ledger_pnl_basis_missing",
                "runtime_without_runtime_ledger_profit_proof",
            ],
        )

    def test_runtime_window_import_health_gate_args_do_not_synthesize_passes(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="manifest.json",
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )

        self.assertEqual(
            renewal._runtime_window_import_health_gate_args(
                target=target,
                runtime_manifest={},
            ),
            ("", "", ""),
        )

    def test_runtime_window_import_target_passes_source_account_label(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref=str(hypothesis_path),
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
            source_account_label="TORGHUT_REPLAY",
        )
        args = SimpleNamespace(
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_target_plan_settlement_seconds=0,
        )
        completed = SimpleNamespace(
            stdout=json.dumps({"status": "skipped", "proof_status": "blocked"})
        )

        with patch.object(
            renewal.subprocess,
            "run",
            return_value=completed,
        ) as run_mock:
            payload = renewal._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
                now=datetime(2026, 5, 26, 21, 23, tzinfo=timezone.utc),
            )

        command = run_mock.call_args.args[0]
        self.assertIn("--source-account-label", command)
        self.assertEqual(
            command[command.index("--source-account-label") + 1],
            "TORGHUT_SIM",
        )
        self.assertEqual(payload["account_label"], "TORGHUT_SIM")
        self.assertEqual(payload["source_account_label"], "TORGHUT_SIM")

    def test_runtime_window_import_rejects_non_mapping_import_payload(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref=str(hypothesis_path),
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        completed = SimpleNamespace(stdout=json.dumps(["not", "a", "mapping"]))
        args = SimpleNamespace(
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_target_plan_settlement_seconds=0,
        )

        with (
            patch.object(renewal.subprocess, "run", return_value=completed),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_import_payload_not_mapping",
            ),
        ):
            renewal._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
                now=datetime(2026, 5, 26, 21, 23, tzinfo=timezone.utc),
            )

    def test_as_text_list_rejects_scalar_values(self) -> None:
        self.assertEqual(renewal._as_text_list("single-reason"), [])
        self.assertEqual(renewal._as_text_list({"reason": "value"}), [])

    def test_runtime_window_import_rejects_negative_target_plan_settlement_grace(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        hypothesis_path = self.tmp_dir / "h-pairs-01.json"
        hypothesis_path.write_text(
            json.dumps({"candidate_id": "cand-paper-route"}),
            encoding="utf-8",
        )
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="cand-paper-route",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="paper-route-candidate-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref=str(hypothesis_path),
            source_kind="paper_route_probe_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
            window_start="2026-05-26T13:30:00Z",
            window_end="2026-05-26T20:00:00Z",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "runtime_window_target_plan_settlement_seconds_negative",
        ):
            renewal._run_runtime_window_import_target(
                args=SimpleNamespace(
                    runtime_window_target_plan_settlement_seconds=-1,
                ),
                target=target,
                manifest={},
                run_id="renew-1",
                manifest_path=manifest_path,
                window_start=datetime(2026, 5, 18, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 5, 18, 20, 0, tzinfo=timezone.utc),
                now=datetime(2026, 5, 26, 20, 23, tzinfo=timezone.utc),
            )

    def test_runtime_window_target_plan_bounds_fail_closed(self) -> None:
        base = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "candidate-1",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "source_dsn_env": "SIM_DB_DSN",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_REPLAY",
            "dataset_snapshot_ref": "snapshot-1",
            "source_manifest_ref": "h-pairs-01.json",
            "source_kind": "simulation_exact_replay_runtime_ledger",
            "delay_adjusted_depth_stress_report_ref": "",
        }
        with self.assertRaisesRegex(
            RuntimeError,
            "runtime_window_target_plan_bounds_require_start_and_end",
        ):
            renewal._runtime_window_target_plan_bounds(
                renewal.RuntimeWindowImportTarget(
                    **base,
                    window_start="2026-05-18T13:30:00Z",
                )
            )
        with self.assertRaisesRegex(
            RuntimeError,
            "runtime_window_target_plan_end_must_be_after_start",
        ):
            renewal._runtime_window_target_plan_bounds(
                renewal.RuntimeWindowImportTarget(
                    **base,
                    window_start="2026-05-18T20:00:00Z",
                    window_end="2026-05-18T13:30:00Z",
                )
            )

    def test_latest_source_activity_window_uses_execution_eligible_decisions(
        self,
    ) -> None:
        target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-MICRO-01",
            candidate_id="candidate-1",
            observed_stage="paper",
            strategy_family="microstructure_breakout",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-volume-continuation-long-top2-chip-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="snapshot-1",
            source_manifest_ref="h-micro-01.json",
            source_kind="paper_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        earliest = datetime(2026, 5, 6, 18, 0, tzinfo=timezone.utc)
        latest = datetime(2026, 5, 15, 17, 25, tzinfo=timezone.utc)
        connection = MagicMock()
        cursor_context = MagicMock()
        cursor = MagicMock()
        cursor.fetchone.return_value = (earliest, latest)
        cursor_context.__enter__.return_value = cursor
        connection.cursor.return_value = cursor_context
        connection_context = MagicMock()
        connection_context.__enter__.return_value = connection

        with (
            patch.dict(renewal.os.environ, {"SIM_DB_DSN": "postgresql://sim"}),
            patch.object(renewal.psycopg, "connect", return_value=connection_context),
        ):
            window = renewal._latest_source_activity_window(
                target=target,
                runtime_manifest={
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper"
                },
            )

        self.assertEqual(
            window,
            (
                datetime(2026, 5, 6, 13, 30, tzinfo=timezone.utc),
                datetime(2026, 5, 15, 20, 0, tzinfo=timezone.utc),
            ),
        )
        _, params = cursor.execute.call_args.args
        self.assertIn("microbar-volume-continuation-long-top2-chip-v1", params[0])
        self.assertIn("microbar_volume_continuation_long_top2_chip_v1", params[0])
        self.assertEqual(params[1], "TORGHUT_SIM")
        self.assertEqual(params[2], list(renewal.EXECUTION_ELIGIBLE_DECISION_STATUSES))

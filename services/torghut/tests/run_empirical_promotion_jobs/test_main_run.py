from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_empirical_promotion_jobs.support import *


class TestRunEmpiricalPromotionJobsMainRun(RunEmpiricalPromotionJobsTestCase):
    def test_runtime_window_import_surfaces_multi_target_proof_blockers(
        self,
    ) -> None:
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
                    "entry_requirements": {
                        "require_delay_adjusted_depth_stress": True,
                    },
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
                    "strategy_family=intraday_tsmom_consistent,strategy_name=intraday-tsmom-profit-v3,"
                    f"source_manifest_ref={tsmom_path}"
                ),
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=chip-paper-microbar-composite@execution-proof,"
                    "strategy_family=microstructure_breakout,"
                    "strategy_name=microbar-volume-continuation-long-top2-chip-v1,"
                    f"source_manifest_ref={micro_path},"
                    "dataset_snapshot_ref=torghut-chip-full-day-20260505-4c330ce9-r1"
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
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref=str(tsmom_path),
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(renewal.subprocess, "run", return_value=completed):
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
        self.assertEqual(payload["proof_status"], "blocked")
        blocker_codes = [item["blocker"] for item in payload["proof_blockers"]]
        self.assertIn("delay_adjusted_depth_stress_report_ref_missing", blocker_codes)
        self.assertIn(
            "runtime_window_import_promotion_decision_not_allowed",
            blocker_codes,
        )
        self.assertIn("runtime_observation_missing", blocker_codes)
        self.assertEqual(
            [item["proof_status"] for item in payload["imports"]],
            ["blocked", "blocked"],
        )

    def test_runtime_window_import_reports_missing_required_delay_depth_ref(
        self,
    ) -> None:
        manifest_path = self.tmp_dir / "empirical-promotion-manifest.yaml"
        manifest_path.write_text("run_id: renew-1\n", encoding="utf-8")
        micro_path = self.tmp_dir / "h-micro-01.json"
        micro_path.write_text(
            json.dumps(
                {
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                    "entry_requirements": {
                        "require_delay_adjusted_depth_stress": True,
                        "min_delay_adjusted_depth_stress_checks": 2,
                        "max_delay_adjusted_depth_stress_age_minutes": 30,
                    },
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
            runtime_window_start="2026-05-18T13:30:00Z",
            runtime_window_end="2026-05-18T20:00:00Z",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_bucket_minutes=30,
            runtime_window_sample_minutes=5,
            runtime_window_source_manifest_ref=str(micro_path),
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
        self.assertEqual(payload["proof_status"], "blocked")
        self.assertEqual(
            payload["proof_blockers"][0]["blocker"],
            "delay_adjusted_depth_stress_report_ref_missing",
        )
        self.assertEqual(payload["proof_blockers"][0]["min_checks"], 2)
        self.assertIn(
            "delay_adjusted_depth_stress_report_ref",
            payload["proof_blockers"][0]["remediation"],
        )
        command = run_mock.call_args.args[0]
        self.assertNotIn("--delay-adjusted-depth-stress-report-ref", command)

    def test_main_writes_manifest_and_runs_empirical_promotion_job(self) -> None:
        created_at = datetime(2026, 5, 18, 8, 13, tzinfo=timezone.utc)
        manifest = {
            "schema_version": "torghut-empirical-promotion-manifest-v1",
            "run_id": "renew-prefix-20260518T081300Z",
            "candidate_id": "candidate-1",
            "dataset_snapshot_ref": "snapshot-1",
            "promotion_authority_eligible": True,
        }
        session = MagicMock()
        execute_result = MagicMock()
        execute_result.scalars.return_value.all.return_value = []
        session.execute.return_value = execute_result
        session_context = MagicMock()
        session_context.__enter__.return_value = session
        session_context.__exit__.return_value = None
        completed = SimpleNamespace(stdout=json.dumps({"persisted_jobs": []}))

        with (
            patch.object(
                renewal,
                "_parse_args",
                return_value=SimpleNamespace(
                    output_dir=str(self.tmp_dir),
                    strategy_spec_ref="strategy@paper",
                    run_id_prefix="renew-prefix",
                    hpairs_source_proof_census_file=None,
                    json=True,
                ),
            ),
            patch.object(renewal, "datetime") as datetime_mock,
            patch.object(renewal, "SessionLocal", return_value=session_context),
            patch.object(renewal, "_latest_authoritative_rows", return_value={}),
            patch.object(renewal, "_runtime_version_ref", return_value="runtime@sha"),
            patch.object(renewal, "build_renewal_manifest", return_value=manifest),
            patch.object(renewal.subprocess, "run", return_value=completed) as run_mock,
            patch("builtins.print") as print_mock,
        ):
            datetime_mock.now.return_value = created_at
            self.assertEqual(renewal.main(), 0)

        manifest_path = (
            self.tmp_dir
            / "renew-prefix-20260518T081300Z"
            / "empirical-promotion-manifest.yaml"
        )
        self.assertTrue(manifest_path.exists())
        run_mock.assert_called_once()
        command = run_mock.call_args.args[0]
        self.assertIn("scripts/run_empirical_promotion_jobs.py", command)
        self.assertIn(str(manifest_path), command)
        print_mock.assert_called_once()

    def setUp(self) -> None:
        super().setUp()
        from tempfile import TemporaryDirectory

        self._tmp_dir_context = TemporaryDirectory()
        self.tmp_dir = Path(self._tmp_dir_context.name)

    def tearDown(self) -> None:
        self._tmp_dir_context.cleanup()
        super().tearDown()

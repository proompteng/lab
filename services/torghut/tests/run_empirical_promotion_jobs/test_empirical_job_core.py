from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_empirical_promotion_jobs.support import (
    Any,
    EMPIRICAL_JOB_TYPES,
    Path,
    RunEmpiricalPromotionJobsTestCase,
    SimpleNamespace,
    StaticPool,
    VNextEmpiricalJobRun,
    _build_janus_summary,
    build_empirical_benchmark_parity_report,
    build_empirical_foundation_router_parity_report,
    build_renewal_manifest,
    cast,
    create_engine,
    datetime,
    json,
    patch,
    promote_janus_payload_to_empirical,
    renewal,
    sessionmaker,
    timezone,
)


class TestRunEmpiricalPromotionJobsCore(RunEmpiricalPromotionJobsTestCase):
    def test_build_janus_summary_requires_truthful_child_artifacts(self) -> None:
        event_payload = promote_janus_payload_to_empirical(
            payload={
                "schema_version": "janus-event-car-v1",
                "summary": {"event_count": 3},
                "manifest_hash": "event-hash",
            },
            dataset_snapshot_ref="snapshot-1",
            job_run_id="job-event",
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
            promotion_authority_eligible=True,
        )
        reward_payload = promote_janus_payload_to_empirical(
            payload={
                "schema_version": "janus-hgrm-reward-v1",
                "summary": {
                    "reward_count": 3,
                    "event_mapped_count": 3,
                    "direction_gate_pass_ratio": "1",
                },
                "manifest_hash": "reward-hash",
            },
            dataset_snapshot_ref="snapshot-1",
            job_run_id="job-reward",
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
            promotion_authority_eligible=True,
        )

        summary = _build_janus_summary(
            event_car_payload=event_payload,
            hgrm_reward_payload=reward_payload,
            event_car_artifact_ref="s3://artifacts/event.json",
            hgrm_reward_artifact_ref="s3://artifacts/reward.json",
            dataset_snapshot_ref="snapshot-1",
            job_run_id="job-summary",
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
        )

        self.assertTrue(summary["promotion_authority_eligible"])
        self.assertTrue(summary["artifact_authority"]["authoritative"])
        self.assertEqual(summary["reasons"], [])
        self.assertEqual(summary["hgrm_reward"]["event_mapped_count"], 3)

    def test_build_janus_summary_blocks_non_truthful_child_artifacts(self) -> None:
        event_payload = promote_janus_payload_to_empirical(
            payload={
                "schema_version": "janus-event-car-v1",
                "summary": {"event_count": 3},
                "manifest_hash": "event-hash",
            },
            dataset_snapshot_ref="snapshot-1",
            job_run_id="job-event",
            runtime_version_refs=[],
            model_refs=["models/candidate@sha256:def"],
            promotion_authority_eligible=True,
        )
        reward_payload = promote_janus_payload_to_empirical(
            payload={
                "schema_version": "janus-hgrm-reward-v1",
                "summary": {
                    "reward_count": 3,
                    "event_mapped_count": 3,
                    "direction_gate_pass_ratio": "1",
                },
                "manifest_hash": "reward-hash",
            },
            dataset_snapshot_ref="snapshot-1",
            job_run_id="job-reward",
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
            promotion_authority_eligible=True,
        )

        summary = _build_janus_summary(
            event_car_payload=event_payload,
            hgrm_reward_payload=reward_payload,
            event_car_artifact_ref="s3://artifacts/event.json",
            hgrm_reward_artifact_ref="s3://artifacts/reward.json",
            dataset_snapshot_ref="snapshot-1",
            job_run_id="job-summary",
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
        )

        self.assertFalse(summary["promotion_authority_eligible"])
        self.assertFalse(summary["artifact_authority"]["authoritative"])
        self.assertIn("janus_event_car_not_truthful", summary["reasons"])

    def test_build_renewal_manifest_preserves_source_job_lineage(self) -> None:
        created_at = datetime(2026, 5, 18, 8, 13, tzinfo=timezone.utc)
        benchmark = build_empirical_benchmark_parity_report(
            candidate_id="chip-paper-microbar-composite@execution-proof",
            baseline_candidate_id="baseline",
            benchmark_runs=[
                {
                    "schema_version": "benchmark-parity-run-v1",
                    "dataset_ref": "dataset-1",
                    "window_ref": "window-1",
                    "family": family,
                    "metrics": {},
                    "slice_metrics": {},
                    "policy_violations": {"deterministic_gate_compatible": True},
                    "run_hash": f"hash-{family}",
                }
                for family in ("ai-trader", "fev-bench", "gift-eval")
            ],
            scorecards={
                "decision_quality": {"status": "pass", "decision_count": 4},
                "reasoning_quality": {"status": "pass"},
                "forecast_quality": {"status": "pass"},
            },
            degradation_summary={},
            dataset_snapshot_ref="snapshot-1",
            job_run_id="source-benchmark",
            runtime_version_refs=["services/torghut@sha256:old"],
            model_refs=["rules/chip-paper-microbar-composite"],
            now=created_at,
        )
        foundation = build_empirical_foundation_router_parity_report(
            candidate_id="chip-paper-microbar-composite@execution-proof",
            router_policy_version="forecast_router_policy_v1",
            adapters=["deterministic", "chronos", "timesfm"],
            slice_metrics={},
            calibration_metrics={},
            latency_metrics={},
            fallback_metrics={},
            drift_metrics={},
            dataset_snapshot_ref="snapshot-1",
            job_run_id="source-foundation",
            runtime_version_refs=["services/torghut@sha256:old"],
            model_refs=["rules/chip-paper-microbar-composite"],
            now=created_at,
        )
        event = promote_janus_payload_to_empirical(
            payload={"summary": {"event_count": 4}, "manifest_hash": "event-hash"},
            dataset_snapshot_ref="snapshot-1",
            job_run_id="source-event",
            runtime_version_refs=["services/torghut@sha256:old"],
            model_refs=["rules/chip-paper-microbar-composite"],
            promotion_authority_eligible=True,
        )
        reward = promote_janus_payload_to_empirical(
            payload={
                "summary": {"reward_count": 4, "event_mapped_count": 4},
                "manifest_hash": "reward-hash",
            },
            dataset_snapshot_ref="snapshot-1",
            job_run_id="source-reward",
            runtime_version_refs=["services/torghut@sha256:old"],
            model_refs=["rules/chip-paper-microbar-composite"],
            promotion_authority_eligible=True,
        )

        def row(
            job_type: str, payload: dict[str, object], job_run_id: str
        ) -> SimpleNamespace:
            return SimpleNamespace(
                job_type=job_type,
                status="completed",
                authority="empirical",
                promotion_authority_eligible=True,
                candidate_id="chip-paper-microbar-composite@execution-proof",
                dataset_snapshot_ref="snapshot-1",
                job_run_id=job_run_id,
                created_at=created_at,
                payload_json=payload,
            )

        manifest = build_renewal_manifest(
            latest=cast(
                Any,
                {
                    "benchmark_parity": row(
                        "benchmark_parity", benchmark, "source-benchmark"
                    ),
                    "foundation_router_parity": row(
                        "foundation_router_parity", foundation, "source-foundation"
                    ),
                    "janus_event_car": row("janus_event_car", event, "source-event"),
                    "janus_hgrm_reward": row(
                        "janus_hgrm_reward", reward, "source-reward"
                    ),
                },
            ),
            run_id="renew-1",
            strategy_spec_ref="microbar_volume_continuation_long_top2_chip_v1@paper",
            runtime_version_ref="services/torghut@sha256:new",
        )

        self.assertEqual(manifest["run_id"], "renew-1")
        self.assertEqual(manifest["dataset_snapshot_ref"], "snapshot-1")
        self.assertEqual(
            manifest["runtime_version_refs"], ["services/torghut@sha256:new"]
        )
        self.assertEqual(
            manifest["authority"]["source_artifacts"]["source_empirical_job_run_ids"][
                "benchmark_parity"
            ],
            "source-benchmark",
        )
        self.assertTrue(manifest["promotion_authority_eligible"])

    def test_latest_authoritative_rows_rejects_non_empirical_latest_job(self) -> None:
        created_at = datetime(2026, 5, 18, 8, 13, tzinfo=timezone.utc)
        rows = [
            SimpleNamespace(
                job_type="benchmark_parity",
                status="degraded",
                authority="empirical",
                promotion_authority_eligible=True,
                payload_json={},
                created_at=created_at,
            )
        ]

        with self.assertRaisesRegex(
            RuntimeError,
            "latest_empirical_job_not_authoritative:benchmark_parity:degraded:empirical",
        ):
            renewal._latest_authoritative_rows(cast(Any, rows))

    def test_latest_authoritative_rows_requires_all_job_types(self) -> None:
        created_at = datetime(2026, 5, 18, 8, 13, tzinfo=timezone.utc)
        benchmark = build_empirical_benchmark_parity_report(
            candidate_id="chip-paper-microbar-composite@execution-proof",
            baseline_candidate_id="baseline",
            benchmark_runs=[
                {
                    "schema_version": "benchmark-parity-run-v1",
                    "dataset_ref": "dataset-1",
                    "window_ref": "window-1",
                    "family": family,
                    "metrics": {},
                    "slice_metrics": {},
                    "policy_violations": {"deterministic_gate_compatible": True},
                    "run_hash": f"hash-{family}",
                }
                for family in ("ai-trader", "fev-bench", "gift-eval")
            ],
            scorecards={
                "decision_quality": {"status": "pass", "decision_count": 4},
                "reasoning_quality": {"status": "pass"},
                "forecast_quality": {"status": "pass"},
            },
            degradation_summary={},
            dataset_snapshot_ref="snapshot-1",
            job_run_id="source-benchmark",
            runtime_version_refs=["services/torghut@sha256:old"],
            model_refs=["rules/chip-paper-microbar-composite"],
            now=created_at,
        )
        rows = [
            SimpleNamespace(
                job_type="benchmark_parity",
                status="completed",
                authority="empirical",
                promotion_authority_eligible=True,
                payload_json=benchmark,
                created_at=created_at,
            )
        ]

        with self.assertRaisesRegex(
            RuntimeError,
            "latest_empirical_jobs_missing:foundation_router_parity,janus_event_car,janus_hgrm_reward",
        ):
            renewal._latest_authoritative_rows(cast(Any, rows))

    def test_load_latest_empirical_job_rows_reads_latest_per_job_type(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        VNextEmpiricalJobRun.__table__.create(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        old_at = datetime(2026, 5, 18, 8, 13, tzinfo=timezone.utc)
        new_at = datetime(2026, 5, 19, 8, 13, tzinfo=timezone.utc)

        with session_local() as session:
            for job_type in EMPIRICAL_JOB_TYPES:
                session.add(
                    VNextEmpiricalJobRun(
                        run_id=f"old-{job_type}",
                        candidate_id="candidate-old",
                        job_name=f"{job_type}-old",
                        job_type=job_type,
                        job_run_id=f"{job_type}-old",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-old",
                        artifact_refs=[],
                        payload_json={"marker": "old"},
                        created_at=old_at,
                        updated_at=old_at,
                    )
                )
                session.add(
                    VNextEmpiricalJobRun(
                        run_id=f"new-{job_type}",
                        candidate_id="candidate-new",
                        job_name=f"{job_type}-new",
                        job_type=job_type,
                        job_run_id=f"{job_type}-new",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-new",
                        artifact_refs=[],
                        payload_json={"marker": "new"},
                        created_at=new_at,
                        updated_at=new_at,
                    )
                )
            session.add(
                VNextEmpiricalJobRun(
                    run_id="irrelevant",
                    candidate_id="candidate-new",
                    job_name="irrelevant",
                    job_type="irrelevant",
                    job_run_id="irrelevant-new",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref="snapshot-new",
                    artifact_refs=[],
                    payload_json={"marker": "irrelevant"},
                    created_at=new_at,
                    updated_at=new_at,
                )
            )
            session.commit()

            rows = renewal._load_latest_empirical_job_rows(session)

        self.assertEqual({row.job_type for row in rows}, set(EMPIRICAL_JOB_TYPES))
        self.assertEqual({row.payload_json["marker"] for row in rows}, {"new"})
        self.assertEqual(
            {row.job_run_id for row in rows},
            {f"{job_type}-new" for job_type in EMPIRICAL_JOB_TYPES},
        )

    def test_runtime_version_ref_prefers_runtime_digest(self) -> None:
        with patch.dict(
            renewal.os.environ,
            {
                "TORGHUT_IMAGE_DIGEST": "sha256:new",
                "BUILD_IMAGE_DIGEST": "sha256:old",
            },
            clear=True,
        ):
            self.assertEqual(
                renewal._runtime_version_ref(),
                "services/torghut@sha256:new",
            )

    def test_runtime_version_ref_falls_back_to_unknown(self) -> None:
        with patch.dict(renewal.os.environ, {}, clear=True):
            self.assertEqual(
                renewal._runtime_version_ref(),
                "services/torghut@unknown",
            )

    def test_parse_args_accepts_strategy_and_json_flag(self) -> None:
        with patch.object(
            renewal.sys,
            "argv",
            [
                "renew_latest_empirical_promotion_jobs.py",
                "--output-dir",
                "/tmp/out",
                "--strategy-spec-ref",
                "strategy@paper",
                "--run-id-prefix",
                "renew-prefix",
                "--runtime-window-import",
                "--runtime-window-import-audit-only",
                "--runtime-window-hypothesis-id",
                "H-TSMOM-01",
                "--runtime-window-candidate-id",
                "spec-83161ae16d17828eabcc58cc",
                "--runtime-window-strategy-family",
                "intraday_tsmom_consistent",
                "--runtime-window-strategy-name",
                "intraday-tsmom-profit-v3",
                "--runtime-window-dataset-snapshot-ref",
                "portfolio-profit-autoresearch-500-v1",
                "--runtime-window-target",
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=chip-paper-microbar-composite@execution-proof,"
                    "strategy_family=microstructure_breakout,"
                    "strategy_name=microbar-volume-continuation-long-top2-chip-v1,"
                    "source_manifest_ref=config/trading/hypotheses/h-micro-01.json,"
                    "dataset_snapshot_ref=torghut-chip-full-day-20260505-4c330ce9-r1"
                ),
                "--json",
            ],
        ):
            args = renewal._parse_args()

        self.assertEqual(args.output_dir, "/tmp/out")
        self.assertEqual(args.strategy_spec_ref, "strategy@paper")
        self.assertEqual(args.run_id_prefix, "renew-prefix")
        self.assertTrue(args.runtime_window_import)
        self.assertTrue(args.runtime_window_import_audit_only)
        self.assertEqual(args.runtime_window_hypothesis_id, "H-TSMOM-01")
        self.assertEqual(
            args.runtime_window_candidate_id, "spec-83161ae16d17828eabcc58cc"
        )
        self.assertEqual(
            args.runtime_window_strategy_family, "intraday_tsmom_consistent"
        )
        self.assertEqual(args.runtime_window_strategy_name, "intraday-tsmom-profit-v3")
        self.assertEqual(
            args.runtime_window_dataset_snapshot_ref,
            "portfolio-profit-autoresearch-500-v1",
        )
        self.assertEqual(len(args.runtime_window_target), 1)
        self.assertIn("H-MICRO-01", args.runtime_window_target[0])
        self.assertTrue(args.json)

    def test_runtime_window_target_accepts_json_payload(self) -> None:
        args = SimpleNamespace(
            runtime_window_target=[
                json.dumps(
                    {
                        "hypothesis-id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                        "optional_null": None,
                    }
                )
            ],
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].hypothesis_id, "H-PAIRS-01")
        self.assertEqual(targets[0].strategy_family, "microbar_cross_sectional_pairs")
        self.assertEqual(
            targets[0].source_manifest_ref,
            "config/trading/hypotheses/h-pairs-01.json",
        )

    def test_runtime_window_targets_from_candidate_board_plan(self) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "schema_version": "torghut.runtime-window-import-plan.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-paper-probation",
                                "hypothesis_id": "H-MICRO-01",
                                "observed_stage": "paper",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_kind": "paper_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-micro-01.json",
                                "dataset_snapshot_ref": "snapshot-paper-probation",
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-paper-probation")
        self.assertEqual(targets[0].hypothesis_id, "H-MICRO-01")
        self.assertEqual(targets[0].observed_stage, "paper")
        self.assertEqual(targets[0].strategy_family, "microstructure_breakout")
        self.assertEqual(
            targets[0].strategy_name, "microbar-volume-continuation-long-top2-chip-v1"
        )
        self.assertEqual(
            targets[0].source_manifest_ref,
            "config/trading/hypotheses/h-micro-01.json",
        )
        self.assertEqual(targets[0].dataset_snapshot_ref, "snapshot-paper-probation")

    def test_runtime_window_targets_from_live_gate_plan_url_preserve_window_targets(
        self,
    ) -> None:
        status_path = Path(self.tmp_dir) / "trading-status.json"
        status_path.write_text(
            json.dumps(
                {
                    "live_submission_gate": {
                        "runtime_ledger_paper_probation_import_plan": {
                            "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                            "targets": [
                                {
                                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                                    "hypothesis_id": "H-PAIRS-01",
                                    "observed_stage": "paper",
                                    "strategy_family": "microbar_cross_sectional_pairs",
                                    "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "runtime_strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                                    "strategy_lookup_names": [
                                        "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                        "microbar-cross-sectional-pairs-v1",
                                    ],
                                    "account_label": "TORGHUT_REPLAY",
                                    "source_dsn_env": "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN",
                                    "source_kind": "durable_runtime_ledger_bucket",
                                    "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                                    "window_start": "2026-05-13T17:00:00+00:00",
                                    "window_end": "2026-05-13T17:30:00+00:00",
                                    "paper_probation_authorized": True,
                                    "promotion_allowed": False,
                                    "final_promotion_authorized": False,
                                    "final_promotion_allowed": False,
                                    "max_notional": "0",
                                    "runtime_ledger_bucket_ref": "bucket:first",
                                },
                                {
                                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                                    "hypothesis_id": "H-PAIRS-01",
                                    "observed_stage": "paper",
                                    "strategy_family": "microbar_cross_sectional_pairs",
                                    "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "runtime_strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                                    "strategy_lookup_names": [
                                        "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                        "microbar-cross-sectional-pairs-v1",
                                    ],
                                    "account_label": "TORGHUT_REPLAY",
                                    "source_dsn_env": "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN",
                                    "source_kind": "durable_runtime_ledger_bucket",
                                    "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                                    "window_start": "2026-05-21T17:00:00+00:00",
                                    "window_end": "2026-05-21T17:30:00+00:00",
                                    "paper_probation_authorized": True,
                                    "promotion_allowed": False,
                                    "final_promotion_authorized": False,
                                    "final_promotion_allowed": False,
                                    "max_notional": "0",
                                    "runtime_ledger_bucket_ref": "bucket:second",
                                },
                            ],
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[],
            runtime_window_target_plan_url=[status_path.as_uri()],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=False,
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets(args)

        self.assertEqual(len(targets), 2)
        self.assertEqual(
            [target.window_start for target in targets],
            [
                "2026-05-13T17:00:00+00:00",
                "2026-05-21T17:00:00+00:00",
            ],
        )
        self.assertEqual(
            targets[0].source_dsn_env,
            "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN",
        )
        self.assertEqual(targets[0].strategy_name, "microbar-cross-sectional-pairs-v1")
        assert targets[0].target_metadata is not None
        self.assertEqual(
            targets[0].target_metadata["runtime_strategy_name"],
            "69cf50e3-4815-47c2-b802-1efbaac09ecb",
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_ledger_bucket_ref"], "bucket:first"
        )
        self.assertEqual(targets[0].target_metadata["max_notional"], "0")
        self.assertEqual(targets[0].target_metadata["promotion_allowed"], False)
        self.assertEqual(targets[0].target_metadata["final_promotion_allowed"], False)

    def test_runtime_window_target_plan_exclusive_skips_fallback_targets(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-plan",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                            }
                        ]
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_target_plan_url=[],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_targets_from_registry=True,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with (
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
                side_effect=AssertionError("autoresearch fallback should be skipped"),
            ),
            patch.object(
                renewal,
                "_registry_runtime_window_targets",
                side_effect=AssertionError("registry fallback should be skipped"),
            ),
        ):
            targets = renewal._runtime_window_targets(args)

        self.assertEqual([target.hypothesis_id for target in targets], ["H-PAIRS-01"])
        self.assertEqual(targets[0].candidate_id, "cand-plan")

    def test_runtime_window_target_plan_exclusive_blocks_fallback_when_plan_empty(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps({"runtime_window_import_plan": {"targets": []}}),
            encoding="utf-8",
        )
        fallback_target = renewal.RuntimeWindowImportTarget(
            hypothesis_id="H-FALLBACK-01",
            candidate_id="cand-fallback",
            observed_stage="paper",
            strategy_family="fallback_family",
            source_dsn_env="SIM_DB_DSN",
            strategy_name="fallback-strategy-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="",
            source_manifest_ref="",
            source_kind="paper_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
            window_start="",
            window_end="",
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[str(plan_path)],
            runtime_window_target_plan_url=[],
            runtime_window_target_plan_url_timeout_seconds=2.0,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with patch.object(
            renewal,
            "_latest_autoresearch_runtime_window_targets",
            return_value=[fallback_target],
        ) as latest_autoresearch:
            targets = renewal._runtime_window_targets(args)

        latest_autoresearch.assert_not_called()
        self.assertEqual(targets, [])

    def test_runtime_window_target_plan_required_fails_closed_when_plan_empty(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "empty-paper-route-plan.json"
        plan_path.write_text(
            json.dumps(
                {
                    "next_paper_route_runtime_window_targets": {
                        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                        "target_count": 0,
                        "targets": [],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
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
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with (
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
            self.assertRaisesRegex(
                RuntimeError, "runtime_window_target_plan_required_but_empty"
            ),
        ):
            renewal._runtime_window_targets(args)

    def test_runtime_window_target_plan_required_requires_ref(self) -> None:
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[],
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
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        with self.assertRaisesRegex(
            RuntimeError, "runtime_window_target_plan_required_without_ref"
        ):
            renewal._runtime_window_targets(args)

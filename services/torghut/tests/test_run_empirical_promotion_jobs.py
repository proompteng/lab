from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import MagicMock, patch

from app.trading.empirical_jobs import (
    build_empirical_benchmark_parity_report,
    build_empirical_foundation_router_parity_report,
    promote_janus_payload_to_empirical,
)
from scripts import renew_latest_empirical_promotion_jobs as renewal
from scripts.renew_latest_empirical_promotion_jobs import build_renewal_manifest
from scripts.run_empirical_promotion_jobs import _build_janus_summary


class TestRunEmpiricalPromotionJobs(TestCase):
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
                        "candidate_id": "spec-d74b07b2aaab8d0cfa8a4c38",
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

    def test_runtime_window_targets_from_registry_imports_all_hypotheses(
        self,
    ) -> None:
        hypothesis_dir = self.tmp_dir / "hypotheses"
        family_dir = self.tmp_dir / "families"
        hypothesis_dir.mkdir()
        family_dir.mkdir()
        (family_dir / "intraday_tsmom_v2.yaml").write_text(
            "\n".join(
                [
                    "family_id: intraday_tsmom_v2",
                    "runtime_harness:",
                    "  family: intraday_tsmom_consistent",
                    "  strategy_name: intraday-tsmom-profit-v3",
                ]
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-tsmom-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-TSMOM-01",
                    "strategy_family": "stale_family",
                    "strategy_id": "intraday_tsmom_v2@research",
                    "candidate_id": "spec-83161ae16d17828eabcc58cc",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-micro-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-MICRO-01",
                    "strategy_family": "microstructure_breakout",
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                }
            ),
            encoding="utf-8",
        )
        (hypothesis_dir / "h-cont-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-CONT-01",
                    "strategy_family": "intraday_continuation",
                    "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                    "strategy_id": "intraday_tsmom_v1@paper",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_targets_from_registry=True,
            runtime_window_hypothesis_dir=str(hypothesis_dir),
            runtime_window_family_dir=str(family_dir),
            runtime_window_target=[],
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

        self.assertEqual(
            [target.hypothesis_id for target in targets],
            ["H-CONT-01", "H-MICRO-01", "H-TSMOM-01"],
        )
        by_id = {target.hypothesis_id: target for target in targets}
        self.assertEqual(
            by_id["H-CONT-01"].strategy_name,
            "microbar-volume-continuation-long-top2-chip-v1",
        )
        self.assertEqual(
            by_id["H-TSMOM-01"].strategy_name,
            "intraday-tsmom-profit-v3",
        )
        self.assertEqual(
            by_id["H-MICRO-01"].strategy_name,
            "microbar-volume-continuation-long-top2-chip-v1",
        )
        self.assertEqual(by_id["H-MICRO-01"].source_dsn_env, "SIM_DB_DSN")

    def test_runtime_window_target_rejects_invalid_specs(self) -> None:
        invalid_specs = [
            "{}",
            "hypothesis_id=H-PAIRS-01,strategy_name=pairs",
            "hypothesis_id=H-PAIRS-01,strategy_family=pairs",
            "hypothesis_id=H-PAIRS-01,bad-token",
            "hypothesis_id=H-PAIRS-01,strategy_family=,strategy_name=pairs",
            "[1, 2, 3]",
        ]
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        for spec in invalid_specs:
            with self.subTest(spec=spec):
                args.runtime_window_target = [spec]
                with self.assertRaises(RuntimeError):
                    renewal._runtime_window_targets(args)

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
        self.assertIn("--dataset-snapshot-ref", command)
        self.assertIn("portfolio-profit-autoresearch-500-v1", command)
        self.assertNotIn("stale-empirical-dataset", command)

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
        self.assertEqual(payload["proof_status"], "ok")
        self.assertEqual(payload["proof_blockers"], [])
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
        self.assertEqual(
            payload["proof_blockers"][0]["blocker"],
            "delay_adjusted_depth_stress_report_ref_missing",
        )
        self.assertEqual(
            [item["proof_status"] for item in payload["imports"]],
            ["ok", "blocked"],
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

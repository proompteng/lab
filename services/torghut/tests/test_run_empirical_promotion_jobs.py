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
                "--json",
            ],
        ):
            args = renewal._parse_args()

        self.assertEqual(args.output_dir, "/tmp/out")
        self.assertEqual(args.strategy_spec_ref, "strategy@paper")
        self.assertEqual(args.run_id_prefix, "renew-prefix")
        self.assertTrue(args.json)

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

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

    def test_runtime_window_target_plan_payload_accepts_top_level_gate_plan_and_fallback(
        self,
    ) -> None:
        top_level_plan = renewal._runtime_window_target_plan_from_payload(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "targets": [{"hypothesis_id": "H-PAIRS-01"}]
                }
            }
        )
        fallback_plan = renewal._runtime_window_target_plan_from_payload(
            {"targets": [{"hypothesis_id": "H-FALLBACK-01"}]}
        )

        self.assertEqual(top_level_plan["targets"][0]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(fallback_plan["targets"][0]["hypothesis_id"], "H-FALLBACK-01")

    def test_runtime_window_target_plan_payload_prefers_source_runtime_plan(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "targets": [
                        {
                            "candidate_id": "cand-empty-hpairs",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                        }
                    ]
                },
                "source_runtime_window_import_plan": {
                    "source": "live_submission_gate_runtime_ledger_source_collection",
                    "purpose": "runtime_ledger_source_collection_import",
                    "targets": [
                        {
                            "candidate_id": "cand-source-volume",
                            "hypothesis_id": "H-MICRO-01",
                            "strategy_family": "microstructure_breakout",
                            "strategy_name": (
                                "microbar-volume-continuation-long-top2-chip-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_SIM",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                            "source_collection_authorized": True,
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-micro-01.json"
                            ),
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "targets": [
                        {
                            "candidate_id": "cand-next-hpairs",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                        }
                    ]
                },
                "runtime_window_import_audit": {
                    "state": "import_due_source_activity_missing",
                    "blockers": ["paper_route_source_activity_missing"],
                },
            }
        )

        self.assertEqual(
            plan["source"], "live_submission_gate_runtime_ledger_source_collection"
        )
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "cand-source-volume")
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertEqual(
            target["runtime_window_import_audit_state"],
            "import_due_source_activity_missing",
        )
        self.assertIn(
            "paper_route_source_activity_missing",
            target["runtime_window_import_audit_blockers"],
        )

        args = SimpleNamespace(
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_target_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
            runtime_window_delay_adjusted_depth_stress_report_ref="",
            runtime_window_dependency_quorum_decision="",
            runtime_window_continuity_ok="",
            runtime_window_drift_ok="",
            runtime_window_source_account_label="",
        )
        import_targets = renewal._runtime_window_targets_from_plan(
            plan=plan,
            ref="target-plan-payload",
            args=args,
        )

        self.assertEqual(len(import_targets), 1)
        self.assertEqual(import_targets[0].candidate_id, "cand-source-volume")
        self.assertEqual(
            import_targets[0].source_kind,
            "runtime_ledger_source_collection_candidate",
        )
        self.assertIsNone(
            renewal._runtime_window_target_plan_import_blocked_result(
                target=import_targets[0],
                candidate_id=import_targets[0].candidate_id,
                manifest_path=Path("config/trading/hypotheses/h-micro-01.json"),
                window_start=datetime(2026, 6, 2, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 6, 2, 20, tzinfo=timezone.utc),
                window_selection="target-plan-payload",
            )
        )

    def test_runtime_window_target_plan_payload_marks_contaminated_import_audit(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.next-paper-route-runtime-window-targets.v1"
                    ),
                    "targets": [
                        {
                            "candidate_id": "cand-contaminated",
                            "hypothesis_id": "H-CONTAMINATED",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-05-29T13:30:00+00:00",
                            "window_end": "2026-05-29T20:00:00+00:00",
                        }
                    ],
                },
                "runtime_window_import_audit": {
                    "state": "import_due_account_contamination_detected",
                    "next_action": "import_with_blockers",
                    "blockers": [
                        "paper_route_account_contamination_detected",
                        "unlinked_order_events_present",
                    ],
                    "target_blockers": [
                        {
                            "candidate_id": "cand-contaminated",
                            "hypothesis_id": "H-CONTAMINATED",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-05-29T13:30:00+00:00",
                            "window_end": "2026-05-29T20:00:00+00:00",
                            "blockers": [
                                "runtime_ledger_evidence_grade_bucket_missing"
                            ],
                        }
                    ],
                },
            }
        )

        target = plan["targets"][0]
        self.assertEqual(
            target["runtime_window_import_audit_state"],
            "import_due_account_contamination_detected",
        )
        self.assertIn(
            "paper_route_account_contamination_detected",
            target["runtime_ledger_target_metadata_blockers"],
        )
        self.assertIn(
            "unlinked_order_events_present",
            target["runtime_window_import_health_gate_blockers"],
        )
        self.assertIn(
            "runtime_ledger_evidence_grade_bucket_missing",
            target["runtime_window_import_audit_target_blockers"],
        )

    def test_runtime_window_import_audit_annotation_helper_fallbacks(
        self,
    ) -> None:
        self.assertEqual(
            renewal._extend_unique_text_items(" existing ", ["new", "existing"]),
            ["existing", "new"],
        )
        self.assertEqual(
            renewal._runtime_window_import_audit_blockers(
                {"state": "import_due_source_activity_missing"}
            ),
            ["import_due_source_activity_missing"],
        )
        self.assertTrue(
            renewal._runtime_window_audit_target_blocker_matches(
                target_blocker={
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_lookup_names": ["runtime-strategy"],
                },
                target={
                    "hypothesis_id": "H-PAIRS-01",
                    "runtime_strategy_name": "runtime-strategy",
                },
            )
        )
        self.assertFalse(
            renewal._runtime_window_audit_target_blocker_matches(
                target_blocker={"candidate_id": "different"},
                target={"candidate_id": "candidate"},
            )
        )
        self.assertFalse(
            renewal._runtime_window_audit_target_blocker_matches(
                target_blocker={"strategy_lookup_names": ["missing-strategy"]},
                target={"runtime_strategy_name": "runtime-strategy"},
            )
        )
        payload = {
            "runtime_window_import_audit": {
                "state": "import_due_source_activity_missing",
            }
        }
        self.assertEqual(
            renewal._runtime_window_target_plan_with_import_audit_blockers(
                payload=payload,
                plan={"targets": "invalid"},
            ),
            {"targets": "invalid"},
        )
        annotated = renewal._runtime_window_target_plan_with_import_audit_blockers(
            payload=payload,
            plan={
                "targets": [
                    None,
                    {
                        "candidate_id": "candidate",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "runtime-strategy",
                    },
                ]
            },
        )

        self.assertIsNone(annotated["targets"][0])
        self.assertIn(
            "import_due_source_activity_missing",
            annotated["targets"][1]["runtime_ledger_target_metadata_blockers"],
        )

    def test_runtime_window_target_plan_payload_blocks_contaminated_import_audit_without_targets(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            (
                "runtime_window_target_plan_import_blocked:"
                "import_due_account_contamination_detected:.*"
                "unlinked_order_events_present"
            ),
        ):
            renewal._runtime_window_target_plan_from_payload(
                {
                    "schema_version": "torghut.paper-route-target-plan.v1",
                    "runtime_window_import_plan": {
                        "schema_version": (
                            "torghut.next-paper-route-runtime-window-targets.v1"
                        ),
                        "targets": [],
                    },
                    "runtime_window_import_audit": {
                        "state": "import_due_account_contamination_detected",
                        "blockers": [
                            "paper_route_account_contamination_detected",
                            "unlinked_order_events_present",
                        ],
                    },
                }
            )

    def test_runtime_window_target_plan_payload_prefers_next_paper_route_plan(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "source_runtime_window_import_plan": {
                    "schema_version": ("torghut.source-runtime-window-import-plan.v1"),
                    "target_count": 5,
                    "targets": [
                        {
                            "candidate_id": "cand-source-superset",
                            "hypothesis_id": "H-SOURCE-SUPERSET",
                            "window_start": "2026-05-20T13:30:00+00:00",
                            "window_end": "2026-05-20T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-stale-paper",
                                "hypothesis_id": "H-STALE-PAPER",
                                "window_start": "2026-05-21T17:00:00+00:00",
                                "window_end": "2026-05-21T17:30:00+00:00",
                            }
                        ],
                    }
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                        }
                    ],
                },
                "targets": [
                    {
                        "candidate_id": "cand-top-level-audit",
                        "hypothesis_id": "H-TOP-LEVEL-AUDIT",
                        "window_start": "2026-05-13T17:00:00+00:00",
                        "window_end": "2026-05-13T17:30:00+00:00",
                    }
                ],
            }
        )

        self.assertEqual(
            plan["schema_version"], "torghut.next-paper-route-runtime-window-targets.v1"
        )
        self.assertEqual(plan["targets"][0]["hypothesis_id"], "H-PAPER-ROUTE")
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-05-26T13:30:00+00:00"
        )

    def test_runtime_window_target_plan_payload_accepts_paper_route_evidence_plan(
        self,
    ) -> None:
        paper_route_plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "source_dsn_env": "SIM_DB_DSN",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                            "dependency_quorum_decision": "missing",
                            "continuity_ok": "false",
                            "drift_ok": "false",
                            "runtime_window_import_health_gate": {
                                "schema_version": "torghut.runtime-window-import-health-gate.v1",
                                "dependency_quorum_decision": "missing",
                                "continuity_ok": "false",
                                "drift_ok": "false",
                                "ready": False,
                                "blockers": [
                                    "runtime_window_import_dependency_quorum_missing"
                                ],
                            },
                            "runtime_window_import_health_gate_blockers": [
                                "runtime_window_import_dependency_quorum_missing"
                            ],
                            "runtime_window_import_promotion_blockers": [
                                "runtime_window_import_drift_missing"
                            ],
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL"],
                            "paper_route_probe_symbol_count": 1,
                            "paper_route_probe_next_session_max_notional": "25",
                            "paper_route_probe_window_start": "2026-05-26T13:30:00+00:00",
                            "paper_route_probe_window_end": "2026-05-26T20:00:00+00:00",
                            "paper_route_session_readiness_state": "waiting_for_session_open",
                            "paper_route_session_import_ready": False,
                            "paper_route_session_import_blockers": [
                                "paper_route_session_window_not_open"
                            ],
                            "paper_route_runtime_window_import_not_before": "2026-05-26T20:00:00+00:00",
                            "paper_route_runtime_import_handoff": {
                                "runner": "scripts/renew_latest_empirical_promotion_jobs.py",
                                "target_plan_endpoint": "/trading/paper-route-evidence",
                                "required_flags": [
                                    "--runtime-window-import",
                                    "--runtime-window-target-plan-url",
                                    "--runtime-window-target-plan-exclusive",
                                    "--runtime-window-target-plan-required",
                                    "--runtime-window-target-plan-settlement-seconds",
                                ],
                                "source_dsn_env": "SIM_DB_DSN",
                                "target_dsn_env": "SIM_DB_DSN",
                                "account_label": "TORGHUT_SIM",
                                "import_ready": False,
                                "import_blockers": [
                                    "paper_route_session_window_not_open"
                                ],
                            },
                            "paper_probation_authorized": True,
                            "promotion_allowed": False,
                            "final_promotion_authorized": False,
                            "final_promotion_allowed": False,
                            "max_notional": "0",
                        },
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "source_dsn_env": "SIM_DB_DSN",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL"],
                            "paper_route_probe_symbol_count": 1,
                            "paper_route_probe_next_session_max_notional": "25",
                            "paper_route_probe_window_start": "2026-05-26T13:30:00+00:00",
                            "paper_route_probe_window_end": "2026-05-26T20:00:00+00:00",
                            "paper_probation_authorized": True,
                            "promotion_allowed": False,
                            "final_promotion_authorized": False,
                            "final_promotion_allowed": False,
                            "max_notional": "0",
                        },
                    ],
                },
            }
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="DB_DSN",
            runtime_window_target_dsn_env="",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets_from_plan(
            plan=paper_route_plan,
            ref="paper-route-evidence",
            args=args,
        )

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].hypothesis_id, "H-PAPER-ROUTE")
        self.assertEqual(targets[0].source_dsn_env, "SIM_DB_DSN")
        self.assertEqual(targets[0].target_dsn_env, "SIM_DB_DSN")
        self.assertEqual(targets[0].source_kind, "paper_route_probe_runtime_observed")
        self.assertEqual(targets[0].dependency_quorum_decision, "missing")
        self.assertEqual(targets[0].continuity_ok, "false")
        self.assertEqual(targets[0].drift_ok, "false")
        self.assertEqual(targets[0].window_start, "2026-05-26T13:30:00+00:00")
        assert targets[0].target_metadata is not None
        self.assertEqual(
            targets[0].target_metadata["runtime_window_import_health_gate"][
                "schema_version"
            ],
            "torghut.runtime-window-import-health-gate.v1",
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_window_import_health_gate_blockers"],
            ["runtime_window_import_dependency_quorum_missing"],
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_window_import_promotion_blockers"],
            ["runtime_window_import_drift_missing"],
        )
        self.assertEqual(targets[0].target_metadata["max_notional"], "0")
        self.assertEqual(
            targets[0].target_metadata["paper_route_probe_symbols"], ["AAPL"]
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_probe_next_session_max_notional"],
            "25",
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_session_readiness_state"],
            "waiting_for_session_open",
        )
        self.assertFalse(targets[0].target_metadata["paper_route_session_import_ready"])
        self.assertEqual(
            targets[0].target_metadata["paper_route_session_import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_runtime_window_import_not_before"],
            "2026-05-26T20:00:00+00:00",
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_runtime_import_handoff"][
                "target_plan_endpoint"
            ],
            "/trading/paper-route-evidence",
        )
        self.assertFalse(targets[0].target_metadata["promotion_allowed"])
        self.assertFalse(targets[0].target_metadata["final_promotion_allowed"])

    def test_runtime_window_target_plan_payload_keeps_live_gate_source_collection(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-01T13:30:00+00:00",
                            "window_end": "2026-06-01T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "cand-source-collection",
                                "hypothesis_id": "H-SOURCE-COLLECTION",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "source-collection-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "runtime_ledger_source_collection_candidate",
                                "source_collection_authorized": True,
                                "window_start": "2026-05-13T17:00:00+00:00",
                                "window_end": "2026-05-13T17:30:00+00:00",
                            }
                        ],
                    },
                },
            }
        )

        self.assertTrue(plan["merged_live_submission_gate_source_collection"])
        self.assertEqual(plan["source_collection_target_count"], 1)
        self.assertEqual(plan["paper_route_target_count"], 1)
        self.assertEqual(plan["target_count"], 2)
        self.assertEqual(
            [target["hypothesis_id"] for target in plan["targets"]],
            ["H-SOURCE-COLLECTION", "H-PAPER-ROUTE"],
        )

    def test_runtime_window_target_plan_payload_keeps_sim_gate_source_collection(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "cand-source-collection",
                                "hypothesis_id": "H-SOURCE-COLLECTION",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "source-collection-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "runtime_ledger_source_collection_candidate",
                                "source_collection_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
                                "window_start": "2026-05-13T17:00:00+00:00",
                                "window_end": "2026-05-13T17:30:00+00:00",
                            }
                        ],
                    },
                },
            }
        )

        self.assertTrue(plan["merged_live_submission_gate_source_collection"])
        self.assertEqual(plan["source_collection_target_count"], 1)
        self.assertEqual(plan["paper_route_target_count"], 1)
        self.assertEqual(plan["target_count"], 2)
        self.assertEqual(
            [target["hypothesis_id"] for target in plan["targets"]],
            ["H-SOURCE-COLLECTION", "H-PAPER-ROUTE"],
        )
        self.assertFalse(plan["targets"][0]["promotion_allowed"])
        self.assertFalse(plan["targets"][0]["final_promotion_allowed"])

    def test_runtime_window_gate_source_collection_merge_requires_pending_or_sim_count(
        self,
    ) -> None:
        self.assertFalse(
            renewal._runtime_window_gate_allows_source_collection_merge(
                gate={"reason": "non_live_mode", "blocked_reasons": []},
                gate_plan={"source_collection_target_count": "not-an-int"},
            )
        )
        self.assertFalse(
            renewal._runtime_window_gate_allows_source_collection_merge(
                gate={"reason": "promotion_certificate_valid", "blocked_reasons": []},
                gate_plan={"source_collection_target_count": 1},
            )
        )
        self.assertTrue(
            renewal._runtime_window_gate_allows_source_collection_merge(
                gate={
                    "reason": "simple_submit_disabled",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                },
                gate_plan={"source_collection_target_count": "not-an-int"},
            )
        )

    def test_runtime_window_target_plan_url_failures_are_fail_closed(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError, "runtime_window_target_plan_url_empty"
        ):
            renewal._read_runtime_window_target_plan_url("", timeout_seconds=1.0)

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=renewal.urllib.error.URLError("connection refused"),
            ),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_fetch_failed",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"x" * 5_000_001
        with (
            patch.object(renewal.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_too_large",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"{"
        with (
            patch.object(renewal.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_invalid",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"[]"
        with (
            patch.object(renewal.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_url_invalid",
            ),
        ):
            renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
            )

    def test_runtime_window_target_plan_url_retries_transport_failure(self) -> None:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "runtime_window_import_plan": {
                    "targets": [
                        {
                            "candidate_id": "cand-retry",
                            "hypothesis_id": "H-RETRY",
                        }
                    ]
                }
            }
        ).encode("utf-8")

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[
                    renewal.urllib.error.URLError("connection refused"),
                    response,
                ],
            ) as urlopen,
            patch.object(renewal.wall_time, "sleep") as sleep,
        ):
            plan = renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
                attempts=2,
                retry_backoff_seconds=0.0,
            )

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)
        self.assertEqual(plan["targets"][0]["candidate_id"], "cand-retry")

    def test_runtime_window_target_plan_url_retries_transient_empty_paper_route(
        self,
    ) -> None:
        transient = MagicMock()
        transient.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "summary": {"blockers": ["paper_probation_import_plan_missing"]},
                "runtime_window_import_audit": {
                    "state": "paper_probation_import_plan_missing",
                    "blockers": ["paper_probation_import_plan_missing"],
                },
                "live_submission_gate": {
                    "paper_route_target_plan_error": (
                        "paper_route_target_plan_fetch_failed:timed out"
                    ),
                    "runtime_ledger_paper_probation_import_plan": {
                        "targets": [],
                        "skipped_targets": [
                            {
                                "reason": "external_paper_route_target_plan_unavailable",
                                "missing_or_blocking_fields": [
                                    "paper_route_target_plan_fetch_failed:timed out"
                                ],
                            }
                        ],
                    },
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
            }
        ).encode("utf-8")
        success = MagicMock()
        success.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                        }
                    ],
                },
            }
        ).encode("utf-8")

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[transient, success],
            ) as urlopen,
            patch.object(renewal.wall_time, "sleep") as sleep,
        ):
            plan = renewal._read_runtime_window_target_plan_url(
                "http://torghut.invalid/status",
                timeout_seconds=1.0,
                attempts=2,
                retry_backoff_seconds=0.0,
            )

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)
        self.assertEqual(
            plan["schema_version"],
            "torghut.next-paper-route-runtime-window-targets.v1",
        )
        self.assertEqual(plan["targets"][0]["candidate_id"], "cand-paper-route")

    def test_runtime_window_target_plan_required_stays_fail_closed_after_retries(
        self,
    ) -> None:
        transient = MagicMock()
        transient.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "summary": {"blockers": ["paper_probation_import_plan_missing"]},
                "live_submission_gate": {
                    "paper_route_target_plan_error": (
                        "paper_route_target_plan_fetch_failed:timed out"
                    )
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
            }
        ).encode("utf-8")
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[],
            runtime_window_target_plan_url=["http://torghut.invalid/status"],
            runtime_window_target_plan_url_timeout_seconds=1.0,
            runtime_window_target_plan_url_attempts=2,
            runtime_window_target_plan_url_retry_backoff_seconds=0.0,
            runtime_window_target_plan_required=True,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_targets_from_registry=True,
        )

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[transient, transient],
            ) as urlopen,
            patch.object(renewal.wall_time, "sleep") as sleep,
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
            ) as latest,
            patch.object(renewal, "_registry_runtime_window_targets") as registry,
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_required_but_empty",
            ),
        ):
            renewal._runtime_window_targets(args)

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)
        latest.assert_not_called()
        registry.assert_not_called()

    def test_runtime_window_targets_from_candidate_board_plan_preserve_probation_handoff(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "schema_version": "torghut.runtime-window-import-plan.v1",
                        "targets": [
                            {
                                "candidate_spec_id": "spec-paper",
                                "candidate_id": "cand-paper-probation",
                                "hypothesis_id": "H-MICRO-01",
                                "observed_stage": "paper",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_kind": "paper_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-micro-01.json",
                                "dataset_snapshot_ref": "snapshot-paper-probation",
                                "artifact_refs": [
                                    "proof/replay-summary.json",
                                    "proof/replay-summary.json",
                                    "",
                                ],
                                "candidate_selection": "oracle_recommended_paper_probation",
                                "replay_selection_reason": "paper_contract_exploration",
                                "paper_contract_candidate": True,
                                "paper_contract_selected_for_replay": True,
                                "paper_contract_prior_score": "31.5",
                                "paper_mechanism_overlay_ids": [
                                    "mixed_market_limit_execution_policy",
                                    "queue_position_survival_fill_curve",
                                ],
                                "paper_required_evidence_tokens": [
                                    "live_paper_parity",
                                    "route_tca",
                                    "runtime_ledger",
                                ],
                                "paper_required_evidence_count": 3,
                                "paper_probation_authorized": True,
                                "paper_probation_authorization_scope": "evidence_collection_only",
                                "evidence_collection_stage": "paper",
                                "probation_allowed": True,
                                "selection_reason": "best_lower_bound_candidate",
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_allowed": False,
                                "final_promotion_blockers": [
                                    "runtime_ledger_pnl_basis_missing"
                                ],
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
        self.assertEqual(targets[0].artifact_refs, ("proof/replay-summary.json",))
        self.assertEqual(
            targets[0].target_metadata,
            {
                "candidate_spec_id": "spec-paper",
                "candidate_selection": "oracle_recommended_paper_probation",
                "replay_selection_reason": "paper_contract_exploration",
                "paper_contract_candidate": True,
                "paper_contract_selected_for_replay": True,
                "paper_contract_prior_score": "31.5",
                "paper_mechanism_overlay_ids": [
                    "mixed_market_limit_execution_policy",
                    "queue_position_survival_fill_curve",
                ],
                "paper_required_evidence_tokens": [
                    "live_paper_parity",
                    "route_tca",
                    "runtime_ledger",
                ],
                "paper_required_evidence_count": 3,
                "paper_probation_authorized": True,
                "paper_probation_authorization_scope": "evidence_collection_only",
                "evidence_collection_stage": "paper",
                "probation_allowed": True,
                "selection_reason": "best_lower_bound_candidate",
                "promotion_allowed": False,
                "final_promotion_authorized": False,
                "final_promotion_allowed": False,
                "final_promotion_blockers": ["runtime_ledger_pnl_basis_missing"],
            },
        )

    def test_runtime_window_targets_from_plan_preserve_exact_replay_artifact_handoff(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "schema_version": "torghut.runtime-window-import-plan.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-exact-replay",
                                "hypothesis_id": "H-PAIRS-01",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "source_kind": "simulation_exact_replay_runtime_ledger",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "dataset_snapshot_ref": "snapshot-exact",
                                "artifact_refs": ["proof/replay-summary.json"],
                                "runtime_ledger_artifact_ref": "proof/exact-replay-ledger.json",
                                "runtime_ledger_artifact_row_count": 12,
                                "runtime_ledger_artifact_fill_count": 4,
                                "window_start": "2026-05-18T13:30:00Z",
                                "window_end": "2026-05-18T20:00:00Z",
                                "runtime_ledger_target_metadata_blockers": [
                                    "replay_artifact_only_not_live"
                                ],
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_allowed": False,
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
        self.assertEqual(
            targets[0].artifact_refs,
            ("proof/replay-summary.json", "proof/exact-replay-ledger.json"),
        )
        self.assertEqual(targets[0].window_start, "2026-05-18T13:30:00Z")
        self.assertEqual(targets[0].window_end, "2026-05-18T20:00:00Z")
        assert targets[0].target_metadata is not None
        self.assertEqual(
            targets[0].target_metadata["runtime_ledger_artifact_ref"],
            "proof/exact-replay-ledger.json",
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_ledger_artifact_row_count"],
            12,
        )
        self.assertEqual(
            targets[0].target_metadata["window_start"],
            "2026-05-18T13:30:00Z",
        )

    def test_runtime_window_targets_from_latest_autoresearch_epoch(self) -> None:
        args = SimpleNamespace(
            runtime_window_autoresearch_status=[],
            runtime_window_observed_stage="paper",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
            runtime_window_delay_adjusted_depth_stress_report_ref="",
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_strategy_family="",
            runtime_window_strategy_name="",
        )
        skipped_epoch = SimpleNamespace(
            epoch_id="epoch-running",
            status="running",
            summary_json={
                "candidate_board": {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-running",
                                "hypothesis_id": "H-TSMOM-01",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": "intraday-tsmom-profit-v3",
                            }
                        ]
                    }
                }
            },
        )
        latest_epoch = SimpleNamespace(
            epoch_id="epoch-paper-probation",
            status="no_profit_target_candidate",
            summary_json={
                "candidate_board": {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-paper-probation",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                                "source_manifest_ref": "config/trading/hypotheses/h-micro-01.json",
                                "dataset_snapshot_ref": "snapshot-paper-probation",
                            }
                        ]
                    }
                }
            },
        )

        targets = renewal._runtime_window_targets_from_autoresearch_epochs(
            args=args,
            epochs=[skipped_epoch, latest_epoch],
        )

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-paper-probation")
        self.assertEqual(targets[0].hypothesis_id, "H-MICRO-01")
        self.assertEqual(targets[0].source_dsn_env, "SIM_DB_DSN")
        self.assertEqual(targets[0].dataset_snapshot_ref, "snapshot-paper-probation")

    def test_latest_autoresearch_targets_query_uses_persisted_candidate_board(
        self,
    ) -> None:
        epoch = SimpleNamespace(
            epoch_id="epoch-latest",
            status="ok",
            summary_json={
                "candidate_board": {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-latest",
                                "hypothesis_id": "H-TSMOM-01",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": "intraday-tsmom-profit-v3",
                            }
                        ]
                    }
                }
            },
        )

        class FakeResult:
            def scalars(self) -> "FakeResult":
                return self

            def all(self) -> list[SimpleNamespace]:
                return [epoch]

        class FakeSession:
            statement: object | None = None

            def __enter__(self) -> "FakeSession":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def execute(self, statement: object) -> FakeResult:
                self.statement = statement
                return FakeResult()

        fake_session = FakeSession()
        args = SimpleNamespace(
            runtime_window_targets_from_latest_autoresearch=True,
            runtime_window_autoresearch_status=[],
            runtime_window_autoresearch_scan_limit=5,
            runtime_window_observed_stage="paper",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
            runtime_window_delay_adjusted_depth_stress_report_ref="",
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_strategy_family="",
            runtime_window_strategy_name="",
        )

        with patch.object(renewal, "SessionLocal", return_value=fake_session):
            targets = renewal._latest_autoresearch_runtime_window_targets(args)

        self.assertIsNotNone(fake_session.statement)
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-latest")

    def test_runtime_window_target_plan_errors_are_explicit(self) -> None:
        invalid_json_path = Path(self.tmp_dir) / "invalid-candidate-board.json"
        invalid_json_path.write_text("{", encoding="utf-8")
        empty_json_path = Path(self.tmp_dir) / "empty-candidate-board.json"
        empty_json_path.write_text("[]", encoding="utf-8")
        missing_targets_path = Path(self.tmp_dir) / "missing-targets-board.json"
        missing_targets_path.write_text(
            json.dumps({"runtime_window_import_plan": {"targets": "not-a-list"}}),
            encoding="utf-8",
        )
        invalid_target_path = Path(self.tmp_dir) / "invalid-target-board.json"
        invalid_target_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [{"candidate_id": "cand-missing-fields"}]
                    }
                }
            ),
            encoding="utf-8",
        )
        cases = (
            (
                Path(self.tmp_dir) / "missing-candidate-board.json",
                "runtime_window_target_plan_ref_missing",
            ),
            (invalid_json_path, "runtime_window_target_plan_ref_invalid"),
            (empty_json_path, "runtime_window_target_plan_ref_invalid"),
            (missing_targets_path, "runtime_window_target_plan_targets_missing"),
            (invalid_target_path, "runtime_window_target_plan_target_invalid"),
        )
        args = SimpleNamespace(
            runtime_window_target=[],
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

        for path, message in cases:
            with self.subTest(path=path):
                args.runtime_window_target_plan_ref = [str(path)]
                with self.assertRaisesRegex(RuntimeError, message):
                    renewal._runtime_window_targets(args)

    def test_explicit_runtime_window_target_takes_precedence_over_plan(self) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-from-plan",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                            }
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        args = SimpleNamespace(
            runtime_window_target=[
                (
                    "hypothesis_id=H-MICRO-01,candidate_id=cand-explicit,"
                    "strategy_family=microstructure_breakout,"
                    "strategy_name=microbar-volume-continuation-long-top2-chip-v1"
                )
            ],
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
        self.assertEqual(targets[0].candidate_id, "cand-explicit")

    def test_runtime_window_targets_from_plan_keep_same_hypothesis_candidate_lanes(
        self,
    ) -> None:
        plan_path = Path(self.tmp_dir) / "candidate-board.json"
        plan_path.write_text(
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "cand-plan-a",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                            },
                            {
                                "candidate_id": "cand-plan-b",
                                "hypothesis_id": "H-MICRO-01",
                                "strategy_family": "microstructure_breakout",
                                "strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
                            },
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

        self.assertEqual(
            [target.candidate_id for target in targets],
            ["cand-plan-a", "cand-plan-b"],
        )
        self.assertEqual(
            [target.hypothesis_id for target in targets],
            ["H-MICRO-01", "H-MICRO-01"],
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
        (hypothesis_dir / "h-tsmom-liq-01.json").write_text(
            json.dumps(
                {
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                    "strategy_family": "stale_family",
                    "strategy_id": "intraday_tsmom_v2@research",
                    "candidate_id": "H-TSMOM-LIQ-01",
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
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
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
            ["H-CONT-01", "H-MICRO-01", "H-TSMOM-01", "H-TSMOM-LIQ-01"],
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
            by_id["H-TSMOM-LIQ-01"].candidate_id,
            "H-TSMOM-LIQ-01",
        )
        self.assertEqual(
            by_id["H-TSMOM-LIQ-01"].strategy_name,
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
            "TORGHUT_REPLAY",
        )
        self.assertEqual(payload["account_label"], "TORGHUT_SIM")
        self.assertEqual(payload["source_account_label"], "TORGHUT_REPLAY")

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

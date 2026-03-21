from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.trading.empirical_jobs import (
    EMPIRICAL_JOB_TYPES,
    artifact_is_truthful,
    build_empirical_benchmark_parity_report,
    build_empirical_foundation_router_parity_report,
    build_empirical_jobs_status,
    empirical_artifact_truthfulness_reasons,
    promote_janus_payload_to_empirical,
    upsert_empirical_job_run,
)


class TestEmpiricalJobs(TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine,
            expire_on_commit=False,
            future=True,
        )

    def test_empirical_benchmark_report_is_authoritative_when_required_families_present(self) -> None:
        report = build_empirical_benchmark_parity_report(
            candidate_id="cand-1",
            baseline_candidate_id="base-1",
            dataset_snapshot_ref="s3://datasets/snapshot.json",
            job_run_id="job-1",
            benchmark_runs=[
                {
                    "schema_version": "benchmark-parity-run-v1",
                    "dataset_ref": "benchmarks/obs-1",
                    "window_ref": "20260306T000000Z",
                    "family": family,
                    "metrics": {},
                    "slice_metrics": {},
                    "policy_violations": {"deterministic_gate_compatible": True},
                    "run_hash": f"hash-{family}",
                }
                for family in ("ai-trader", "fev-bench", "gift-eval")
            ],
            scorecards={
                "decision_quality": {
                    "status": "pass",
                    "advisory_output_rate": 1.0,
                    "advisory_output_rate_baseline": 1.0,
                    "policy_violation_rate": 0.0,
                    "policy_violation_rate_baseline": 0.0,
                    "deterministic_gate_compatible": True,
                    "decision_count": 5,
                },
                "reasoning_quality": {
                    "status": "pass",
                    "policy_violation_rate": 0.0,
                    "policy_violation_rate_baseline": 0.0,
                    "advisory_output_rate": 1.0,
                    "advisory_output_rate_baseline": 1.0,
                    "deterministic_gate_compatible": True,
                },
                "forecast_quality": {
                    "status": "pass",
                    "confidence_calibration_error": 0.01,
                    "confidence_calibration_error_baseline": 0.01,
                    "risk_veto_alignment": 0.99,
                    "risk_veto_alignment_baseline": 0.99,
                    "policy_violation_rate": 0.0,
                    "policy_violation_rate_baseline": 0.0,
                    "advisory_output_rate": 1.0,
                    "advisory_output_rate_baseline": 1.0,
                    "deterministic_gate_compatible": True,
                },
            },
            degradation_summary={"confidence_calibration_error": {"degradation": 0.0}},
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
        )

        self.assertTrue(report["promotion_authority_eligible"])
        self.assertTrue(report["artifact_authority"]["authoritative"])
        self.assertEqual(report["contract"]["generation_mode"], "empirical_benchmark_parity_v1")

    def test_empirical_benchmark_report_requires_runtime_and_model_lineage(self) -> None:
        report = build_empirical_benchmark_parity_report(
            candidate_id="cand-1",
            baseline_candidate_id="base-1",
            dataset_snapshot_ref="s3://datasets/snapshot.json",
            job_run_id="job-1",
            benchmark_runs=[
                {
                    "schema_version": "benchmark-parity-run-v1",
                    "dataset_ref": "benchmarks/obs-1",
                    "window_ref": "20260306T000000Z",
                    "family": family,
                    "metrics": {},
                    "slice_metrics": {},
                    "policy_violations": {"deterministic_gate_compatible": True},
                    "run_hash": f"hash-{family}",
                }
                for family in ("ai-trader", "fev-bench", "gift-eval")
            ],
            scorecards={
                "decision_quality": {
                    "status": "pass",
                    "advisory_output_rate": 1.0,
                    "advisory_output_rate_baseline": 1.0,
                    "policy_violation_rate": 0.0,
                    "policy_violation_rate_baseline": 0.0,
                    "deterministic_gate_compatible": True,
                    "decision_count": 5,
                },
                "reasoning_quality": {
                    "status": "pass",
                    "policy_violation_rate": 0.0,
                    "policy_violation_rate_baseline": 0.0,
                    "advisory_output_rate": 1.0,
                    "advisory_output_rate_baseline": 1.0,
                    "deterministic_gate_compatible": True,
                },
                "forecast_quality": {
                    "status": "pass",
                    "confidence_calibration_error": 0.01,
                    "confidence_calibration_error_baseline": 0.01,
                    "risk_veto_alignment": 0.99,
                    "risk_veto_alignment_baseline": 0.99,
                    "policy_violation_rate": 0.0,
                    "policy_violation_rate_baseline": 0.0,
                    "advisory_output_rate": 1.0,
                    "advisory_output_rate_baseline": 1.0,
                    "deterministic_gate_compatible": True,
                },
            },
            degradation_summary={"confidence_calibration_error": {"degradation": 0.0}},
        )

        self.assertFalse(report["promotion_authority_eligible"])
        self.assertFalse(report["artifact_authority"]["authoritative"])
        self.assertIn(
            "lineage_runtime_version_refs_missing",
            empirical_artifact_truthfulness_reasons(report),
        )
        self.assertIn(
            "lineage_model_refs_missing",
            empirical_artifact_truthfulness_reasons(report),
        )

    def test_empirical_jobs_status_tracks_freshness_per_job_type(self) -> None:
        foundation = build_empirical_foundation_router_parity_report(
            candidate_id="cand-1",
            router_policy_version="router-v1",
            adapters=["deterministic", "chronos", "timesfm"],
            slice_metrics={"by_symbol": {}, "by_horizon": {}, "by_regime": {}},
            calibration_metrics={"minimum": 0.93},
            latency_metrics={"p95_ms": 110},
            fallback_metrics={"fallback_rate": 0.01},
            drift_metrics={"max": 0.01},
            dataset_snapshot_ref="s3://datasets/snapshot.json",
            job_run_id="job-foundation-1",
            runtime_version_refs=["services/torghut@sha256:abc"],
            model_refs=["models/candidate@sha256:def"],
        )
        with self.session_local() as session:
            upsert_empirical_job_run(
                session=session,
                run_id="run-1",
                candidate_id="cand-1",
                job_name="foundation router parity",
                job_type="foundation_router_parity",
                job_run_id="job-foundation-1",
                status="completed",
                authority="empirical",
                promotion_authority_eligible=True,
                dataset_snapshot_ref="s3://datasets/snapshot.json",
                artifact_refs=["s3://artifacts/foundation.json"],
                payload=foundation,
            )
            session.commit()

            status = build_empirical_jobs_status(session=session, stale_after_seconds=86400)

        self.assertEqual(status["status"], "degraded")
        self.assertFalse(status["ready"])
        self.assertEqual(status["message"], "missing empirical jobs: benchmark_parity, janus_event_car, janus_hgrm_reward")
        self.assertEqual(status["eligible_jobs"], ["foundation_router_parity"])
        self.assertEqual(
            status["missing_jobs"],
            ["benchmark_parity", "janus_event_car", "janus_hgrm_reward"],
        )
        self.assertEqual(status["jobs"]["foundation_router_parity"]["authority"], "empirical")
        self.assertEqual(status["jobs"]["benchmark_parity"]["status"], "missing")

    def test_promoted_janus_payload_requires_summary_and_lineage_refs(self) -> None:
        payload = promote_janus_payload_to_empirical(
            payload={
                "schema_version": "janus-event-car-v1",
                "summary": {"event_count": 3},
            },
            dataset_snapshot_ref="s3://datasets/snapshot.json",
            job_run_id="job-janus-1",
            runtime_version_refs=[],
            model_refs=["models/candidate@sha256:def"],
            promotion_authority_eligible=True,
        )

        self.assertFalse(payload["promotion_authority_eligible"])
        self.assertFalse(payload["artifact_authority"]["authoritative"])
        self.assertFalse(artifact_is_truthful(payload))

    def test_empirical_jobs_status_blocks_non_truthful_payload_rows(self) -> None:
        benchmark_payload = {
            "schema_version": "benchmark-parity-report-v1",
            "promotion_authority_eligible": True,
            "artifact_authority": {
                "provenance": "historical_market_replay",
                "maturity": "empirically_validated",
                "authoritative": True,
                "placeholder": False,
            },
            "lineage": {
                "dataset_snapshot_ref": "s3://datasets/snapshot.json",
                "job_run_id": "job-benchmark-1",
                "runtime_version_refs": ["services/torghut@sha256:abc"],
                "model_refs": ["models/candidate@sha256:def"],
            },
        }
        with self.session_local() as session:
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                payload = dict(benchmark_payload)
                if job_type == "janus_hgrm_reward":
                    payload = {
                        **payload,
                        "promotion_authority_eligible": False,
                        "artifact_authority": {
                            **benchmark_payload["artifact_authority"],
                            "authoritative": False,
                        },
                    }
                upsert_empirical_job_run(
                    session=session,
                    run_id="run-1",
                    candidate_id="cand-1",
                    job_name=job_type,
                    job_type=job_type,
                    job_run_id=f"job-{job_type}",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref="s3://datasets/snapshot.json",
                    artifact_refs=[f"s3://artifacts/{job_type}.json"],
                    payload=payload,
                )
            session.commit()

            status = build_empirical_jobs_status(session=session, stale_after_seconds=86400)

        self.assertEqual(status["authority"], "blocked")
        self.assertFalse(status["ready"])
        self.assertEqual(status["message"], "ineligible empirical jobs: janus_hgrm_reward")
        self.assertEqual(status["eligible_jobs"], ["benchmark_parity", "foundation_router_parity", "janus_event_car"])
        self.assertEqual(status["ineligible_jobs"], ["janus_hgrm_reward"])
        self.assertFalse(status["jobs"]["janus_hgrm_reward"]["truthful"])
        self.assertEqual(status["jobs"]["janus_hgrm_reward"]["authority"], "blocked")
        self.assertIn(
            "artifact_authority_not_authoritative",
            status["jobs"]["janus_hgrm_reward"]["blocked_reasons"],
        )

    def test_empirical_jobs_status_blocks_cross_job_lineage_mismatch(self) -> None:
        payload = {
            "schema_version": "benchmark-parity-report-v1",
            "promotion_authority_eligible": True,
            "artifact_authority": {
                "provenance": "historical_market_replay",
                "maturity": "empirically_validated",
                "authoritative": True,
                "placeholder": False,
            },
            "lineage": {
                "dataset_snapshot_ref": "s3://datasets/snapshot-a.json",
                "job_run_id": "job-benchmark-1",
                "runtime_version_refs": ["services/torghut@sha256:abc"],
                "model_refs": ["models/candidate@sha256:def"],
            },
        }
        with self.session_local() as session:
            for index, job_type in enumerate(EMPIRICAL_JOB_TYPES):
                dataset_snapshot_ref = (
                    "s3://datasets/snapshot-a.json"
                    if index < 2
                    else "s3://datasets/snapshot-b.json"
                )
                candidate_id = "cand-a" if index < 2 else "cand-b"
                upsert_empirical_job_run(
                    session=session,
                    run_id="run-1",
                    candidate_id=candidate_id,
                    job_name=job_type,
                    job_type=job_type,
                    job_run_id=f"job-{job_type}",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref=dataset_snapshot_ref,
                    artifact_refs=[f"s3://artifacts/{job_type}.json"],
                    payload={
                        **payload,
                        "lineage": {
                            **payload["lineage"],
                            "dataset_snapshot_ref": dataset_snapshot_ref,
                            "job_run_id": f"job-{job_type}",
                        },
                    },
                )
            session.commit()

            status = build_empirical_jobs_status(session=session, stale_after_seconds=86400)

        self.assertFalse(status["ready"])
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(
            status["message"],
            "empirical job bundle invalid: candidate_id_mismatch, dataset_snapshot_ref_mismatch",
        )
        self.assertEqual(
            status["blocked_reasons"],
            ["candidate_id_mismatch", "dataset_snapshot_ref_mismatch"],
        )
        self.assertEqual(status["candidate_ids"], ["cand-a", "cand-b"])
        self.assertEqual(
            status["dataset_snapshot_refs"],
            ["s3://datasets/snapshot-a.json", "s3://datasets/snapshot-b.json"],
        )

    def test_empirical_jobs_status_warns_before_stale_cutoff(self) -> None:
        payload = {
            "schema_version": "benchmark-parity-report-v1",
            "promotion_authority_eligible": True,
            "artifact_authority": {
                "provenance": "historical_market_replay",
                "maturity": "empirically_validated",
                "authoritative": True,
                "placeholder": False,
            },
            "lineage": {
                "dataset_snapshot_ref": "s3://datasets/snapshot.json",
                "runtime_version_refs": ["services/torghut@sha256:abc"],
                "model_refs": ["models/candidate@sha256:def"],
            },
        }
        with self.session_local() as session:
            for job_type in EMPIRICAL_JOB_TYPES:
                record = upsert_empirical_job_run(
                    session=session,
                    run_id="run-1",
                    candidate_id="cand-1",
                    job_name=job_type,
                    job_type=job_type,
                    job_run_id=f"job-{job_type}",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref="s3://datasets/snapshot.json",
                    artifact_refs=[f"s3://artifacts/{job_type}.json"],
                    payload={
                        **payload,
                        "lineage": {
                            **payload["lineage"],
                            "job_run_id": f"job-{job_type}",
                        },
                    },
                )
                record.created_at = datetime.now(timezone.utc) - timedelta(hours=13)
            session.commit()

            status = build_empirical_jobs_status(
                session=session,
                stale_after_seconds=86400,
                warn_after_seconds=43200,
            )

        self.assertTrue(status["ready"])
        self.assertEqual(status["status"], "warning")
        self.assertEqual(
            status["message"],
            "empirical jobs nearing staleness: benchmark_parity, foundation_router_parity, janus_event_car, janus_hgrm_reward",
        )
        self.assertEqual(status["warning_after_seconds"], 43200)
        self.assertEqual(status["warning_jobs"], list(EMPIRICAL_JOB_TYPES))
        self.assertTrue(status["jobs"]["benchmark_parity"]["warning"])
        self.assertGreaterEqual(status["jobs"]["benchmark_parity"]["age_seconds"], 13 * 60 * 60)

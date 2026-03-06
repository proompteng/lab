from __future__ import annotations

from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.trading.empirical_jobs import (
    build_empirical_benchmark_parity_report,
    build_empirical_foundation_router_parity_report,
    build_empirical_jobs_status,
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
        )

        self.assertTrue(report["promotion_authority_eligible"])
        self.assertTrue(report["artifact_authority"]["authoritative"])
        self.assertEqual(report["contract"]["generation_mode"], "empirical_benchmark_parity_v1")

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
        self.assertEqual(status["jobs"]["foundation_router_parity"]["authority"], "empirical")
        self.assertEqual(status["jobs"]["benchmark_parity"]["status"], "missing")

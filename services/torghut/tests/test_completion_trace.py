from __future__ import annotations

from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, VNextEmpiricalJobRun
from app.trading.completion import (
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    TRACE_STATUS_SATISFIED,
    build_completion_trace,
    build_doc29_completion_status,
    persist_completion_trace,
    runtime_and_doc_completion_matrices_match,
)


class TestCompletionTrace(TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            'sqlite+pysqlite:///:memory:',
            future=True,
            connect_args={'check_same_thread': False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine,
            expire_on_commit=False,
            future=True,
        )

    def test_runtime_and_doc_completion_matrices_match(self) -> None:
        self.assertTrue(runtime_and_doc_completion_matrices_match())

    def test_persist_completion_trace_round_trips_gate_rows(self) -> None:
        trace = build_completion_trace(
            doc_id='doc29',
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id='sim-2026-03-06-full-day',
            dataset_snapshot_ref='snapshot-1',
            candidate_id='cand-1',
            workflow_name='torghut-historical-simulation',
            analysis_run_names=['analysis-1'],
            artifact_refs=['s3://artifacts/run-full-lifecycle-manifest.json'],
            db_row_refs={'simulation_postgres_db': 'torghut_sim_full_day'},
            status_snapshot={'activity_classification': 'success'},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    'status': TRACE_STATUS_SATISFIED,
                    'artifact_ref': 's3://artifacts/run-full-lifecycle-manifest.json',
                    'acceptance_snapshot': {
                        'trade_decisions': 640,
                        'executions': 320,
                        'execution_tca_metrics': 320,
                        'execution_order_events': 320,
                        'coverage_ratio': 0.99,
                    },
                }
            },
            blocked_reasons={},
            git_revision='abc123',
            image_digest='sha256:test',
            workflow_template_revision='abc123',
        )

        with self.session_local() as session:
            row_ids = persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref='s3://artifacts/completion-trace.json',
            )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        self.assertIn(DOC29_SIMULATION_FULL_DAY_GATE, row_ids)
        gate = next(
            item for item in status['gates'] if item['gate_id'] == DOC29_SIMULATION_FULL_DAY_GATE
        )
        self.assertEqual(gate['status'], 'satisfied')
        self.assertEqual(gate['latest_run'], 'sim-2026-03-06-full-day')

    def test_doc29_completion_status_derives_empirical_jobs_gate(self) -> None:
        benchmark_payload = {
            'artifact_authority': {'authoritative': True},
            'lineage': {'missing_families': []},
        }
        with self.session_local() as session:
            for job_type in (
                'benchmark_parity',
                'foundation_router_parity',
                'janus_event_car',
                'janus_hgrm_reward',
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id='run-1',
                        candidate_id='cand-1',
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f'job-{job_type}',
                        status='completed',
                        authority='empirical',
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref='snapshot-1',
                        artifact_refs=[f's3://artifacts/{job_type}.json'],
                        payload_json=benchmark_payload,
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_EMPIRICAL_JOBS_GATE)
        self.assertEqual(gate['status'], 'satisfied')
        self.assertEqual(gate['source'], 'derived_from_empirical_jobs')

    def test_doc29_completion_status_blocks_paper_gate_without_fill_price_budget(self) -> None:
        trace = build_completion_trace(
            doc_id='doc29',
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id='sim-2026-03-06-full-day',
            dataset_snapshot_ref='snapshot-1',
            candidate_id='cand-1',
            workflow_name='torghut-historical-simulation',
            analysis_run_names=[],
            artifact_refs=['s3://artifacts/run-full-lifecycle-manifest.json'],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    'status': TRACE_STATUS_SATISFIED,
                    'artifact_ref': 's3://artifacts/run-full-lifecycle-manifest.json',
                    'acceptance_snapshot': {
                        'trade_decisions': 640,
                        'executions': 320,
                        'execution_tca_metrics': 320,
                        'execution_order_events': 320,
                        'coverage_ratio': 0.99,
                    },
                }
            },
            blocked_reasons={},
            git_revision='abc123',
            image_digest='sha256:test',
        )
        with self.session_local() as session:
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref='s3://artifacts/completion-trace.json',
            )
            for job_type in (
                'benchmark_parity',
                'foundation_router_parity',
                'janus_event_car',
                'janus_hgrm_reward',
            ):
                payload = {
                    'artifact_authority': {'authoritative': True},
                    'lineage': {'missing_families': []},
                }
                session.add(
                    VNextEmpiricalJobRun(
                        run_id='run-1',
                        candidate_id='cand-1',
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f'job-{job_type}',
                        status='completed',
                        authority='empirical',
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref='snapshot-1',
                        artifact_refs=[f's3://artifacts/{job_type}.json'],
                        payload_json=payload,
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        paper_gate = next(item for item in status['gates'] if item['gate_id'] == 'paper_gate_satisfied')
        self.assertEqual(paper_gate['status'], 'blocked')
        self.assertEqual(paper_gate['blocked_reason'], 'fill_price_error_budget_not_recorded')

from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, StrategyHypothesisMetricWindow, VNextEmpiricalJobRun
from app.trading.completion import (
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
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

    def test_doc29_completion_status_satisfies_paper_gate_with_fill_price_budget(self) -> None:
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
                        'fill_price_error_budget_status': 'within_budget',
                        'fill_price_error_budget_artifact_ref': (
                            's3://artifacts/gates/fill-price-error-budget-report-v1.json'
                        ),
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
                        payload_json={
                            'artifact_authority': {'authoritative': True},
                            'lineage': {'missing_families': []},
                        },
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        paper_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_PAPER_GATE)
        self.assertEqual(paper_gate['status'], 'satisfied')
        self.assertIn(
            's3://artifacts/gates/fill-price-error-budget-report-v1.json',
            paper_gate['artifact_refs'],
        )

    def test_doc29_completion_status_derives_live_canary_and_scale_gates(self) -> None:
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
                        'fill_price_error_budget_status': 'within_budget',
                        'fill_price_error_budget_artifact_ref': (
                            's3://artifacts/gates/fill-price-error-budget-report-v1.json'
                        ),
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
                        payload_json={
                            'artifact_authority': {'authoritative': True},
                            'lineage': {'missing_families': []},
                        },
                    )
                )

            paper_window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
            for index in range(4):
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=f'paper-run-{index}',
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        observed_stage='paper',
                        window_started_at=paper_window_start,
                        window_ended_at=paper_window_start,
                        market_session_count=10,
                        decision_count=200,
                        trade_count=194,
                        order_count=194,
                        evidence_provenance='paper_runtime_observed',
                        evidence_maturity='empirically_validated',
                        decision_alignment_ratio='0.97',
                        avg_abs_slippage_bps='4.2',
                        slippage_budget_bps='8.0',
                        post_cost_expectancy_bps='1.1',
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision='allow',
                        capital_stage='shadow',
                        payload_json={},
                    )
                )

            live_window_start = datetime(2026, 3, 7, 14, 30, tzinfo=timezone.utc)
            for index in range(10):
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=f'live-run-{index}',
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        observed_stage='live',
                        window_started_at=live_window_start,
                        window_ended_at=live_window_start,
                        market_session_count=12,
                        decision_count=220,
                        trade_count=215,
                        order_count=215,
                        evidence_provenance='live_runtime_observed',
                        evidence_maturity='empirically_validated',
                        decision_alignment_ratio='0.98',
                        avg_abs_slippage_bps='4.5',
                        slippage_budget_bps='8.0',
                        post_cost_expectancy_bps='1.4',
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision='allow',
                        capital_stage='0.50x live',
                        payload_json={},
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        canary_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_LIVE_CANARY_GATE)
        scale_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_LIVE_SCALE_GATE)
        self.assertEqual(canary_gate['status'], 'satisfied')
        self.assertEqual(scale_gate['status'], 'satisfied')

    def test_doc29_completion_status_scopes_paper_gate_to_empirical_lineage(self) -> None:
        trace_matching = build_completion_trace(
            doc_id='doc29',
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id='sim-match',
            dataset_snapshot_ref='snapshot-1',
            candidate_id='cand-1',
            workflow_name='torghut-historical-simulation',
            analysis_run_names=[],
            artifact_refs=['s3://artifacts/match.json'],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    'status': TRACE_STATUS_SATISFIED,
                    'artifact_ref': 's3://artifacts/match.json',
                    'acceptance_snapshot': {
                        'trade_decisions': 640,
                        'executions': 320,
                        'execution_tca_metrics': 320,
                        'execution_order_events': 320,
                        'coverage_ratio': 0.99,
                        'fill_price_error_budget_status': 'within_budget',
                    },
                }
            },
            blocked_reasons={},
            git_revision='abc123',
            image_digest='sha256:test',
        )
        trace_matching['measured_at'] = '2026-03-07T00:00:00+00:00'
        trace_newer_wrong = build_completion_trace(
            doc_id='doc29',
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id='sim-wrong',
            dataset_snapshot_ref='snapshot-2',
            candidate_id='cand-2',
            workflow_name='torghut-historical-simulation',
            analysis_run_names=[],
            artifact_refs=['s3://artifacts/wrong.json'],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    'status': TRACE_STATUS_SATISFIED,
                    'artifact_ref': 's3://artifacts/wrong.json',
                    'acceptance_snapshot': {
                        'trade_decisions': 900,
                        'executions': 450,
                        'execution_tca_metrics': 450,
                        'execution_order_events': 450,
                        'coverage_ratio': 0.99,
                        'fill_price_error_budget_status': 'within_budget',
                    },
                }
            },
            blocked_reasons={},
            git_revision='abc123',
            image_digest='sha256:test',
        )
        trace_newer_wrong['measured_at'] = '2026-03-08T00:00:00+00:00'

        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace_matching)
            persist_completion_trace(session=session, trace_payload=trace_newer_wrong)
            for job_type in (
                'benchmark_parity',
                'foundation_router_parity',
                'janus_event_car',
                'janus_hgrm_reward',
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id='empirical-1',
                        candidate_id='cand-1',
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f'job-{job_type}',
                        status='completed',
                        authority='empirical',
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref='snapshot-1',
                        artifact_refs=[f's3://artifacts/{job_type}.json'],
                        payload_json={
                            'artifact_authority': {'authoritative': True},
                            'lineage': {'missing_families': []},
                        },
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        paper_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_PAPER_GATE)
        self.assertEqual(paper_gate['status'], 'satisfied')
        self.assertEqual(paper_gate['latest_run'], 'sim-match')

    def test_doc29_completion_status_scopes_live_canary_windows_to_paper_candidate(self) -> None:
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
                        'fill_price_error_budget_status': 'within_budget',
                    },
                }
            },
            blocked_reasons={},
            git_revision='abc123',
            image_digest='sha256:test',
        )
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            for job_type in (
                'benchmark_parity',
                'foundation_router_parity',
                'janus_event_car',
                'janus_hgrm_reward',
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id='empirical-1',
                        candidate_id='cand-1',
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f'job-{job_type}',
                        status='completed',
                        authority='empirical',
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref='snapshot-1',
                        artifact_refs=[f's3://artifacts/{job_type}.json'],
                        payload_json={
                            'artifact_authority': {'authoritative': True},
                            'lineage': {'missing_families': []},
                        },
                    )
                )

            paper_window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
            for index in range(4):
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=f'paper-run-{index}',
                        candidate_id='cand-2',
                        hypothesis_id='legacy_macd_rsi',
                        observed_stage='paper',
                        window_started_at=paper_window_start,
                        window_ended_at=paper_window_start,
                        market_session_count=10,
                        decision_count=200,
                        trade_count=194,
                        order_count=194,
                        evidence_provenance='paper_runtime_observed',
                        evidence_maturity='empirically_validated',
                        decision_alignment_ratio='0.97',
                        avg_abs_slippage_bps='4.2',
                        slippage_budget_bps='8.0',
                        post_cost_expectancy_bps='1.1',
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision='allow',
                        capital_stage='shadow',
                        payload_json={},
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        canary_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_LIVE_CANARY_GATE)
        self.assertEqual(canary_gate['status'], 'blocked')
        self.assertEqual(canary_gate['blocked_reason'], 'insufficient_paper_runtime_sessions')

    def test_doc29_completion_status_blocks_stale_live_windows(self) -> None:
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
                        'fill_price_error_budget_status': 'within_budget',
                        'fill_price_error_budget_artifact_ref': (
                            's3://artifacts/gates/fill-price-error-budget-report-v1.json'
                        ),
                    },
                }
            },
            blocked_reasons={},
            git_revision='abc123',
            image_digest='sha256:test',
        )
        stale_time = datetime(2026, 2, 20, tzinfo=timezone.utc)
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
                        payload_json={
                            'artifact_authority': {'authoritative': True},
                            'lineage': {'missing_families': []},
                        },
                    )
                )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id='paper-old',
                    candidate_id='cand-1',
                    hypothesis_id='legacy_macd_rsi',
                    observed_stage='paper',
                    window_started_at=stale_time,
                    window_ended_at=stale_time,
                    market_session_count=50,
                    decision_count=200,
                    trade_count=194,
                    order_count=194,
                    evidence_provenance='paper_runtime_observed',
                    evidence_maturity='empirically_validated',
                    decision_alignment_ratio='0.97',
                    avg_abs_slippage_bps='4.2',
                    slippage_budget_bps='8.0',
                    post_cost_expectancy_bps='1.1',
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision='allow',
                    capital_stage='shadow',
                    payload_json={},
                    created_at=stale_time,
                    updated_at=stale_time,
                )
            )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision='abc123',
                current_image_digest='sha256:test',
            )

        canary_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_LIVE_CANARY_GATE)
        self.assertEqual(canary_gate['status'], 'blocked')
        self.assertEqual(canary_gate['blocked_reason'], 'insufficient_paper_runtime_sessions')

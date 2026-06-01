from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextEmpiricalJobRun,
)
from app.trading.completion import (
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    TRACE_STATUS_SATISFIED,
    _median_decimal,
    _p10_decimal,
    _runtime_ledger_bucket_matches_window,
    _runtime_ledger_bucket_refs_for_windows,
    _runtime_ledger_daily_summary,
    _runtime_ledger_trading_day_key,
    build_completion_trace,
    build_doc29_completion_status,
    persist_completion_trace,
    runtime_and_doc_completion_matrices_match,
)


def _truthful_empirical_payload(
    *,
    job_run_id: str,
    dataset_snapshot_ref: str = 'snapshot-1',
) -> dict[str, object]:
    return {
        'promotion_authority_eligible': True,
        'artifact_authority': {
            'provenance': 'historical_market_replay',
            'maturity': 'empirically_validated',
            'authoritative': True,
            'placeholder': False,
        },
        'lineage': {
            'dataset_snapshot_ref': dataset_snapshot_ref,
            'job_run_id': job_run_id,
            'runtime_version_refs': ['services/torghut@sha256:abc'],
            'model_refs': ['models/candidate@sha256:def'],
        },
    }


def _promotion_decision(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    promotion_target: str,
    state: str,
    allowed: bool = True,
) -> StrategyPromotionDecision:
    return StrategyPromotionDecision(
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        promotion_target=promotion_target,
        state=state,
        allowed=allowed,
        reason_summary='runtime_evidence_thresholds_satisfied' if allowed else 'runtime_evidence_denied',
    )


def _runtime_ledger_source_authority_payload(
    *,
    cost_basis: str | None = 'alpaca_2026_equity_fee_schedule',
    cost_basis_counts: dict[str, int] | None = None,
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    trade_decision_ids = [f'trade-decision-{index}' for index in range(24)]
    execution_ids = [f'execution-{index}' for index in range(12)]
    execution_order_event_ids = [
        f'execution-order-event-{index}' for index in range(12)
    ]
    source_window_ids = [f'source-window-{index}' for index in range(12)]
    source_offsets = [
        {
            'topic': 'torghut.trade-updates.v2',
            'partition': 0,
            'offset': 42 + index,
        }
        for index in range(12)
    ]
    payload: dict[str, object] = {
        'source': 'runtime-order-feed',
        'source_window_start': '2026-03-06T14:30:00+00:00',
        'source_window_end': '2026-03-06T15:00:00+00:00',
        'source_refs': [
            'postgres:trade_decisions',
            'postgres:executions',
            'postgres:execution_order_events',
            'postgres:order_feed_source_windows',
        ],
        'source_row_counts': {
            'trade_decisions': 24,
            'executions': 12,
            'execution_order_events': 12,
            'order_feed_source_windows': 12,
        },
        'source_window_ids': source_window_ids,
        'trade_decision_ids': trade_decision_ids,
        'execution_ids': execution_ids,
        'execution_order_event_ids': execution_order_event_ids,
        'source_offsets': source_offsets,
        'source_materialization': 'execution_order_events',
        'authority_class': 'runtime_order_feed_execution_source',
    }
    if cost_basis is not None:
        payload['cost_basis'] = cost_basis
        payload['cost_basis_counts'] = cost_basis_counts or {cost_basis: 12}
    if extra:
        payload.update(extra)
    return payload


def _runtime_ledger_bucket(
    *,
    run_id: str,
    candidate_id: str = 'cand-1',
    hypothesis_id: str = 'legacy_macd_rsi',
    observed_stage: str = 'live',
    bucket_started_at: datetime,
    bucket_ended_at: datetime,
    ledger_schema_version: str = 'torghut.runtime-ledger-bucket.v1',
    payload_json: dict[str, object] | None = None,
) -> StrategyRuntimeLedgerBucket:
    return StrategyRuntimeLedgerBucket(
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        runtime_strategy_name='legacy-macd-rsi',
        strategy_family='breakout_continuation_consistent',
        fill_count=12,
        decision_count=24,
        submitted_order_count=12,
        cancelled_order_count=0,
        rejected_order_count=0,
        unfilled_order_count=0,
        closed_trade_count=6,
        open_position_count=0,
        filled_notional=Decimal('120000'),
        gross_strategy_pnl=Decimal('20'),
        cost_amount=Decimal('3.2'),
        net_strategy_pnl_after_costs=Decimal('16.8'),
        post_cost_expectancy_bps=Decimal('1.4'),
        ledger_schema_version=ledger_schema_version,
        pnl_basis='realized_strategy_pnl_after_explicit_costs',
        execution_policy_hash_counts={'policy-hash': 12},
        cost_model_hash_counts={'cost-hash': 12},
        lineage_hash_counts={'lineage-hash': 12},
        blockers_json=[],
        payload_json=_runtime_ledger_source_authority_payload() if payload_json is None else payload_json,
    )


def _add_truthful_empirical_jobs(
    session: Any,
    *,
    run_id: str = 'run-1',
    candidate_id: str = 'cand-1',
    dataset_snapshot_ref: str = 'snapshot-1',
) -> None:
    for job_type in (
        'benchmark_parity',
        'foundation_router_parity',
        'janus_event_car',
        'janus_hgrm_reward',
    ):
        session.add(
            VNextEmpiricalJobRun(
                run_id=run_id,
                candidate_id=candidate_id,
                job_name=job_type,
                job_type=job_type,
                job_run_id=f'job-{job_type}',
                status='completed',
                authority='empirical',
                promotion_authority_eligible=True,
                dataset_snapshot_ref=dataset_snapshot_ref,
                artifact_refs=[f's3://artifacts/{job_type}.json'],
                payload_json=_truthful_empirical_payload(
                    job_run_id=f'job-{job_type}',
                    dataset_snapshot_ref=dataset_snapshot_ref,
                ),
            )
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

    def test_runtime_ledger_daily_summary_counts_day_distribution_and_drawdown(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_trading_day_key(datetime(2026, 3, 6, 14, 30)),
            '2026-03-06',
        )
        self.assertEqual(
            _median_decimal([Decimal('3'), Decimal('1'), Decimal('2')]),
            Decimal('2'),
        )
        self.assertEqual(_p10_decimal([Decimal('5'), Decimal('-1')]), Decimal('-1'))

        rows = [
            _runtime_ledger_bucket(
                run_id='daily-positive',
                bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                payload_json={'source': 'raw-runtime-ledger'},
            ),
            _runtime_ledger_bucket(
                run_id='daily-drawdown',
                bucket_started_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                bucket_ended_at=datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                payload_json={'source': 'raw-runtime-ledger'},
            ),
            _runtime_ledger_bucket(
                run_id='persisted-summary',
                bucket_started_at=datetime(2026, 3, 9, 13, 30, tzinfo=timezone.utc),
                bucket_ended_at=datetime(2026, 3, 9, 14, 0, tzinfo=timezone.utc),
                payload_json={
                    'runtime_ledger_daily_summary': {
                        'runtime_ledger_observed_trading_day_count': 25,
                        'runtime_ledger_mean_daily_net_pnl_after_costs': '24',
                    }
                },
            ),
        ]
        rows[0].net_strategy_pnl_after_costs = Decimal('100')
        rows[1].net_strategy_pnl_after_costs = Decimal('-40')

        summary = _runtime_ledger_daily_summary(rows[:2])
        self.assertEqual(
            summary['runtime_ledger_net_pnl_by_trading_day'],
            {'2026-03-06': '60'},
        )
        self.assertEqual(summary['runtime_ledger_max_intraday_drawdown'], '40')
        self.assertEqual(
            summary['runtime_ledger_closed_trade_count_by_day'],
            {'2026-03-06': 12},
        )

        persisted_summary = _runtime_ledger_daily_summary(rows)
        self.assertEqual(
            persisted_summary['runtime_ledger_observed_trading_day_count'],
            25,
        )
        self.assertEqual(
            persisted_summary['runtime_ledger_mean_daily_net_pnl_after_costs'],
            '24',
        )

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
        gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_SIMULATION_FULL_DAY_GATE)
        self.assertEqual(gate['status'], 'satisfied')
        self.assertEqual(gate['latest_run'], 'sim-2026-03-06-full-day')

    def test_doc29_completion_status_derives_empirical_jobs_gate(self) -> None:
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
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

    def test_doc29_completion_status_blocks_paper_gate_without_fill_price_budget(
        self,
    ) -> None:
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
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

    def test_doc29_completion_status_satisfies_paper_gate_with_fill_price_budget(
        self,
    ) -> None:
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
                    )
                )

            now = datetime.now(timezone.utc)
            paper_window_start = now - timedelta(days=2)
            for index in range(4):
                run_id = f'paper-run-{index}'
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
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
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        promotion_target='paper',
                        state='0.10x canary',
                    )
                )

            live_window_start = now - timedelta(days=1)
            runtime_daily_summary = {
                'runtime_ledger_observed_trading_day_count': 25,
                'runtime_ledger_net_pnl_by_trading_day': {
                    '2026-03-06': '600',
                    '2026-03-09': '0',
                },
                'runtime_ledger_mean_daily_net_pnl_after_costs': '24',
                'runtime_ledger_median_daily_net_pnl_after_costs': '0',
                'runtime_ledger_p10_daily_net_pnl_after_costs': '0',
                'runtime_ledger_worst_day_net_pnl_after_costs': '0',
                'runtime_ledger_max_intraday_drawdown': '0',
                'runtime_ledger_avg_daily_filled_notional': '4800',
                'runtime_ledger_closed_trade_count_by_day': {
                    '2026-03-06': 6,
                    '2026-03-09': 0,
                },
            }
            for index in range(10):
                run_id = f'live-run-{index}'
                live_window_end = live_window_start + timedelta(minutes=index + 1)
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        observed_stage='live',
                        window_started_at=live_window_start,
                        window_ended_at=live_window_end,
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
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        promotion_target='live',
                        state='0.50x live',
                    )
                )
                session.add(
                    _runtime_ledger_bucket(
                        run_id=run_id,
                        bucket_started_at=live_window_start,
                        bucket_ended_at=live_window_end,
                        payload_json=_runtime_ledger_source_authority_payload(
                            extra={'runtime_ledger_daily_summary': runtime_daily_summary}
                        ),
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
        self.assertEqual(
            len(scale_gate['db_row_refs']['strategy_runtime_ledger_buckets']),
            10,
        )
        self.assertEqual(
            scale_gate['runtime_ledger_summary']['runtime_ledger_post_cost_expectancy_bps'],
            1.4,
        )
        self.assertEqual(
            scale_gate['runtime_ledger_summary']['runtime_ledger_observed_trading_day_count'],
            25,
        )
        self.assertEqual(
            scale_gate['runtime_ledger_summary']['runtime_ledger_mean_daily_net_pnl_after_costs'],
            '24',
        )

    def test_runtime_ledger_daily_summary_falls_back_to_bucket_rows(self) -> None:
        first = _runtime_ledger_bucket(
            run_id='fallback-day-1a',
            bucket_started_at=datetime(2026, 3, 6, 14, 30),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0),
        )
        first.net_strategy_pnl_after_costs = Decimal('100')
        first.filled_notional = Decimal('1000')
        first.closed_trade_count = 2
        second = _runtime_ledger_bucket(
            run_id='fallback-day-1b',
            bucket_started_at=datetime(2026, 3, 6, 15, 0),
            bucket_ended_at=datetime(2026, 3, 6, 15, 30),
        )
        second.net_strategy_pnl_after_costs = Decimal('-130')
        second.filled_notional = Decimal('500')
        second.closed_trade_count = -2
        third = _runtime_ledger_bucket(
            run_id='fallback-day-2',
            bucket_started_at=datetime(2026, 3, 9, 14, 30),
            bucket_ended_at=datetime(2026, 3, 9, 15, 0),
        )
        third.net_strategy_pnl_after_costs = Decimal('10')
        third.filled_notional = Decimal('100')
        third.closed_trade_count = 0

        summary = _runtime_ledger_daily_summary([first, second, third])

        self.assertEqual(summary['runtime_ledger_observed_trading_day_count'], 2)
        self.assertEqual(
            summary['runtime_ledger_net_pnl_by_trading_day'],
            {'2026-03-06': '-30', '2026-03-09': '10'},
        )
        self.assertEqual(summary['runtime_ledger_mean_daily_net_pnl_after_costs'], '-10')
        self.assertEqual(summary['runtime_ledger_median_daily_net_pnl_after_costs'], '-10')
        self.assertEqual(summary['runtime_ledger_p10_daily_net_pnl_after_costs'], '-30')
        self.assertEqual(summary['runtime_ledger_worst_day_net_pnl_after_costs'], '-30')
        self.assertEqual(summary['runtime_ledger_max_intraday_drawdown'], '130')
        self.assertEqual(summary['runtime_ledger_avg_daily_filled_notional'], '800')
        self.assertEqual(
            summary['runtime_ledger_closed_trade_count_by_day'],
            {'2026-03-06': 2, '2026-03-09': 0},
        )

    def test_runtime_ledger_bucket_match_requires_full_event_time_containment(
        self,
    ) -> None:
        window = StrategyHypothesisMetricWindow(
            run_id='strict-window',
            candidate_id='cand-1',
            hypothesis_id='legacy_macd_rsi',
            observed_stage='live',
            window_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            window_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
        )

        overlapping = _runtime_ledger_bucket(
            run_id='strict-window',
            bucket_started_at=datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 15, tzinfo=timezone.utc),
        )
        containing = _runtime_ledger_bucket(
            run_id='strict-window',
            bucket_started_at=datetime(2026, 3, 6, 14, 0, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
        )
        missing_event_time = _runtime_ledger_bucket(
            run_id='strict-window',
            bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
        )
        missing_event_time.bucket_started_at = None

        self.assertFalse(_runtime_ledger_bucket_matches_window(overlapping, window))
        self.assertTrue(_runtime_ledger_bucket_matches_window(containing, window))
        self.assertFalse(_runtime_ledger_bucket_matches_window(missing_event_time, window))

    def test_runtime_ledger_window_refs_prefer_exact_boundaries_over_broad_buckets(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id='exact-boundary-run',
                candidate_id='cand-1',
                hypothesis_id='legacy_macd_rsi',
                observed_stage='live',
                window_started_at=window_start,
                window_ended_at=window_end,
                market_session_count=1,
                decision_count=20,
                trade_count=12,
                order_count=12,
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
            broad = _runtime_ledger_bucket(
                run_id='exact-boundary-run',
                bucket_started_at=window_start - timedelta(minutes=30),
                bucket_ended_at=window_end + timedelta(minutes=30),
            )
            exact = _runtime_ledger_bucket(
                run_id='exact-boundary-run',
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
            )
            partial = _runtime_ledger_bucket(
                run_id='exact-boundary-run',
                bucket_started_at=window_start + timedelta(minutes=1),
                bucket_ended_at=window_end + timedelta(minutes=1),
            )
            session.add_all([window, broad, exact, partial])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = _runtime_ledger_bucket_refs_for_windows(
                session,
                [window],
            )

        self.assertEqual(backed_windows, [window])
        self.assertEqual(matched_buckets, [exact])
        self.assertEqual(unbacked_window_refs, [])

    def test_runtime_ledger_window_refs_reject_legacy_aggregate_only_bucket(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id='legacy-aggregate-run',
                candidate_id='cand-1',
                hypothesis_id='legacy_macd_rsi',
                observed_stage='live',
                window_started_at=window_start,
                window_ended_at=window_end,
            )
            source_less = _runtime_ledger_bucket(
                run_id='legacy-aggregate-run',
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                payload_json={'source': 'legacy-aggregate-runtime-ledger'},
            )
            session.add_all([window, source_less])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = _runtime_ledger_bucket_refs_for_windows(
                session,
                [window],
            )

        self.assertEqual(backed_windows, [])
        self.assertEqual(matched_buckets, [])
        self.assertEqual(unbacked_window_refs, [str(window.id)])

    def test_runtime_ledger_window_refs_reject_non_promotion_cost_basis(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id='modeled-cost-run',
                candidate_id='cand-1',
                hypothesis_id='legacy_macd_rsi',
                observed_stage='live',
                window_started_at=window_start,
                window_ended_at=window_end,
            )
            modeled_cost = _runtime_ledger_bucket(
                run_id='modeled-cost-run',
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                payload_json=_runtime_ledger_source_authority_payload(
                    cost_basis='modeled_paper_cost_budget',
                    cost_basis_counts={'modeled_paper_cost_budget': 12},
                ),
            )
            session.add_all([window, modeled_cost])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = _runtime_ledger_bucket_refs_for_windows(
                session,
                [window],
            )

        self.assertEqual(backed_windows, [])
        self.assertEqual(matched_buckets, [])
        self.assertEqual(unbacked_window_refs, [str(window.id)])

    def test_doc29_live_scale_blocks_non_runtime_ledger_window_pnl(self) -> None:
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
            _add_truthful_empirical_jobs(session)

            now = datetime.now(timezone.utc)
            paper_window_start = now - timedelta(days=2)
            for index in range(4):
                run_id = f'paper-ledger-missing-{index}'
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
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
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        promotion_target='paper',
                        state='0.10x canary',
                    )
                )

            live_window_start = now - timedelta(days=1)
            for index in range(10):
                run_id = f'live-ledger-missing-{index}'
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        observed_stage='live',
                        window_started_at=live_window_start,
                        window_ended_at=live_window_start + timedelta(minutes=index + 1),
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
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        promotion_target='live',
                        state='0.50x live',
                    )
                )
                if index == 0:
                    session.add(
                        _runtime_ledger_bucket(
                            run_id=run_id,
                            candidate_id='other-candidate',
                            bucket_started_at=live_window_start,
                            bucket_ended_at=live_window_start + timedelta(minutes=index + 1),
                        )
                    )
                if index == 1:
                    session.add(
                        _runtime_ledger_bucket(
                            run_id=run_id,
                            bucket_started_at=live_window_start,
                            bucket_ended_at=live_window_start + timedelta(minutes=index + 1),
                            ledger_schema_version='torghut.loose_runtime_ledger.v0',
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
        self.assertEqual(scale_gate['status'], 'blocked')
        self.assertEqual(scale_gate['blocked_reason'], 'runtime_ledger_profit_proof_missing')
        self.assertEqual(scale_gate['db_row_refs']['strategy_runtime_ledger_buckets'], [])
        self.assertEqual(
            len(scale_gate['db_row_refs']['runtime_ledger_unbacked_hypothesis_metric_windows']),
            10,
        )

    def test_doc29_live_canary_requires_allowed_promotion_decision(self) -> None:
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
        window_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            _add_truthful_empirical_jobs(session)
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id='paper-denied',
                    candidate_id='cand-1',
                    hypothesis_id='legacy_macd_rsi',
                    observed_stage='paper',
                    window_started_at=window_time,
                    window_ended_at=window_time,
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
                )
            )
            session.add(
                _promotion_decision(
                    run_id='paper-denied',
                    candidate_id='cand-1',
                    hypothesis_id='legacy_macd_rsi',
                    promotion_target='paper',
                    state='0.10x canary',
                    allowed=False,
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
        self.assertEqual(canary_gate['blocked_reason'], 'promotion_decision_not_allowed')

    def test_doc29_live_scale_requires_allowed_promotion_decision(self) -> None:
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
        window_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            _add_truthful_empirical_jobs(session)
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id='paper-allowed',
                    candidate_id='cand-1',
                    hypothesis_id='legacy_macd_rsi',
                    observed_stage='paper',
                    window_started_at=window_time,
                    window_ended_at=window_time,
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
                )
            )
            session.add(
                _promotion_decision(
                    run_id='paper-allowed',
                    candidate_id='cand-1',
                    hypothesis_id='legacy_macd_rsi',
                    promotion_target='paper',
                    state='0.10x canary',
                )
            )
            for index in range(10):
                run_id = f'live-missing-decision-{index}'
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id='cand-1',
                        hypothesis_id='legacy_macd_rsi',
                        observed_stage='live',
                        window_started_at=window_time,
                        window_ended_at=window_time,
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
        self.assertEqual(scale_gate['status'], 'blocked')
        self.assertEqual(scale_gate['blocked_reason'], 'promotion_decision_evidence_missing')

    def test_doc29_completion_status_scopes_paper_gate_to_empirical_lineage(
        self,
    ) -> None:
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
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

    def test_doc29_completion_status_scopes_live_canary_windows_to_paper_candidate(
        self,
    ) -> None:
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
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

    def test_doc29_completion_status_uses_manifest_canary_threshold(self) -> None:
        candidate_id = 'chip-paper-microbar-composite@execution-proof'
        dataset_snapshot_ref = 'torghut-chip-full-day-20260505-4c330ce9-r1'
        trace = build_completion_trace(
            doc_id='doc29',
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id='sim-2026-05-06-full-day',
            dataset_snapshot_ref=dataset_snapshot_ref,
            candidate_id=candidate_id,
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
        paper_window_time = datetime.now(timezone.utc) - timedelta(minutes=5)
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
                        candidate_id=candidate_id,
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f'job-{job_type}',
                        status='completed',
                        authority='empirical',
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref=dataset_snapshot_ref,
                        artifact_refs=[f's3://artifacts/{job_type}.json'],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                            dataset_snapshot_ref=dataset_snapshot_ref,
                        ),
                    )
                )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id='paper-h-micro-50',
                    candidate_id=candidate_id,
                    hypothesis_id='H-MICRO-01',
                    observed_stage='paper',
                    window_started_at=paper_window_time,
                    window_ended_at=paper_window_time,
                    market_session_count=50,
                    decision_count=50,
                    trade_count=49,
                    order_count=49,
                    evidence_provenance='paper_runtime_observed',
                    evidence_maturity='empirically_validated',
                    decision_alignment_ratio='0.98',
                    avg_abs_slippage_bps='4.2',
                    slippage_budget_bps='8.0',
                    post_cost_expectancy_bps='10.5',
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision='allow',
                    capital_stage='shadow',
                    payload_json={},
                )
            )
            session.add(
                _promotion_decision(
                    run_id='paper-h-micro-50',
                    candidate_id=candidate_id,
                    hypothesis_id='H-MICRO-01',
                    promotion_target='paper',
                    state='0.10x canary',
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
        canary_gate = next(item for item in status['gates'] if item['gate_id'] == DOC29_LIVE_CANARY_GATE)
        self.assertEqual(paper_gate['status'], 'satisfied')
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
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f'job-{job_type}',
                        ),
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

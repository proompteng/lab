from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
)
from app.trading.runtime_window_import import (
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
)


class TestRuntimeWindowImport(TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            'sqlite+pysqlite:///:memory:',
            future=True,
            connect_args={'check_same_thread': False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_build_regular_session_buckets_counts_session_samples(self) -> None:
        buckets = build_regular_session_buckets(
            window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 3, 6, 16, 30, tzinfo=timezone.utc),
            bucket_minutes=30,
            sample_minutes=5,
        )

        self.assertEqual(len(buckets), 4)
        self.assertEqual([item[2] for item in buckets], [6, 6, 6, 6])

    def test_build_observed_runtime_buckets_treats_idle_window_as_aligned(self) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision='allow',
        )

        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].decision_alignment_ratio, Decimal('1'))
        self.assertEqual(buckets[0].avg_abs_slippage_bps, Decimal('0'))

    def test_persist_observed_runtime_windows_creates_governance_rows(self) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    6,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    'computed_at': datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    'abs_slippage_bps': Decimal('4'),
                    'post_cost_expectancy_bps': Decimal('3'),
                },
                {
                    'computed_at': datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    'abs_slippage_bps': Decimal('5'),
                    'post_cost_expectancy_bps': Decimal('2'),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision='allow',
        )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id='import-live-1',
                candidate_id='cand-1',
                hypothesis_id='H-CONT-01',
                observed_stage='live',
                strategy_family='intraday_continuation',
                source_manifest_ref='config/trading/hypotheses/h-cont-01.json',
                buckets=buckets,
            )
            session.commit()

            hypotheses = session.execute(select(StrategyHypothesis)).scalars().all()
            versions = session.execute(select(StrategyHypothesisVersion)).scalars().all()
            windows = session.execute(select(StrategyHypothesisMetricWindow)).scalars().all()
            allocations = session.execute(select(StrategyCapitalAllocation)).scalars().all()
            decisions = session.execute(select(StrategyPromotionDecision)).scalars().all()

        self.assertEqual(len(hypotheses), 1)
        self.assertEqual(len(versions), 1)
        self.assertEqual(len(windows), 2)
        self.assertEqual(len(allocations), 1)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(summary['market_session_samples'], 12)
        self.assertEqual(summary['latest_three_within_budget'], True)

    def test_persist_observed_runtime_windows_does_not_promote_bucket_early(self) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    40,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    40,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    'computed_at': datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    'abs_slippage_bps': Decimal('4'),
                    'post_cost_expectancy_bps': Decimal('3'),
                },
                {
                    'computed_at': datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    'abs_slippage_bps': Decimal('5'),
                    'post_cost_expectancy_bps': Decimal('2'),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision='allow',
        )

        with self.session_local() as session:
            persist_observed_runtime_windows(
                session=session,
                run_id='import-live-threshold',
                candidate_id='cand-1',
                hypothesis_id='H-CONT-01',
                observed_stage='live',
                strategy_family='intraday_continuation',
                source_manifest_ref='config/trading/hypotheses/h-cont-01.json',
                buckets=buckets,
            )
            session.commit()
            windows = session.execute(
                select(StrategyHypothesisMetricWindow).order_by(
                    StrategyHypothesisMetricWindow.window_started_at
                )
            ).scalars().all()

        self.assertEqual([window.capital_stage for window in windows], ['0.10x canary', '0.50x live'])

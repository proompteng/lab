from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.evaluation_trace import (
    GateTrace,
    NearMissRecord,
    ReplayFunnelBucket,
    ReplayFunnelReport,
    ReplayTraceRecord,
    StrategyTrace,
    SweepCandidateResult,
    ThresholdTrace,
)


class TestEvaluationTrace(TestCase):
    def test_strategy_trace_helpers_and_payload_serialize_nested_values(self) -> None:
        failed_threshold = ThresholdTrace(
            metric='recent_quote_invalid_ratio',
            comparator='max_lte',
            value=Decimal('0.22'),
            threshold=Decimal('0.10'),
            passed=False,
            missing_policy='fail_closed',
            distance_to_pass=None,
        )
        passed_threshold = ThresholdTrace(
            metric='recent_microprice_bias_bps_avg',
            comparator='min_gte',
            value=Decimal('0.45'),
            threshold=Decimal('0.10'),
            passed=True,
            missing_policy='fail_closed',
            distance_to_pass=Decimal('0'),
        )
        trace = StrategyTrace(
            strategy_id='breakout@prod',
            strategy_type='breakout_continuation_long',
            symbol='AAPL',
            event_ts='2026-03-27T17:30:24+00:00',
            timeframe='1Sec',
            passed=False,
            action=None,
            rationale=('near_miss',),
            gates=(
                GateTrace(
                    gate='feed_quality',
                    category='feed_quality',
                    passed=False,
                    thresholds=(failed_threshold, passed_threshold),
                    context={
                        'captured_at': datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
                        'window_day': date(2026, 3, 27),
                        'bands': (Decimal('0.10'), Decimal('0.20')),
                        'flags': [True, False],
                        'nested': {'score': Decimal('1.25')},
                    },
                ),
            ),
            first_failed_gate='feed_quality',
            context={'family': 'breakout'},
        )

        updated = trace.with_context(region='US').with_updates(action='buy')

        self.assertEqual(updated.action, 'buy')
        self.assertEqual(updated.failed_gate(), trace.gates[0])
        self.assertEqual(updated.distance_score(), Decimal('1'))

        payload = updated.to_payload()
        gate_payload = payload['gates'][0]
        threshold_payload = gate_payload['thresholds'][0]
        self.assertEqual(payload['schema_version'], 'torghut.strategy-trace.v1')
        self.assertEqual(payload['context']['region'], 'US')
        self.assertEqual(gate_payload['context']['captured_at'], '2026-03-27T17:30:24+00:00')
        self.assertEqual(gate_payload['context']['window_day'], '2026-03-27')
        self.assertEqual(gate_payload['context']['bands'], ['0.10', '0.20'])
        self.assertEqual(gate_payload['context']['nested']['score'], '1.25')
        self.assertEqual(threshold_payload['value'], '0.22')
        self.assertEqual(threshold_payload['distance_to_pass'], None)

    def test_trace_records_and_reports_payloads_cover_optional_paths(self) -> None:
        no_failed_gate = StrategyTrace(
            strategy_id='late-day@prod',
            strategy_type='late_day_continuation_long',
            symbol='MSFT',
            event_ts='2026-03-27T19:05:00+00:00',
            timeframe='1Sec',
            passed=True,
            action='buy',
            gates=(),
        )
        missing_failed_gate = StrategyTrace(
            strategy_id='mean-reversion@prod',
            strategy_type='mean_reversion_rebound_long',
            symbol='META',
            event_ts='2026-03-27T18:15:00+00:00',
            timeframe='1Sec',
            passed=False,
            action=None,
            first_failed_gate='confirmation',
            gates=(),
        )

        self.assertIsNone(no_failed_gate.failed_gate())
        self.assertEqual(no_failed_gate.distance_score(), Decimal('0'))
        self.assertIsNone(missing_failed_gate.failed_gate())
        self.assertEqual(missing_failed_gate.distance_score(), Decimal('0'))

        replay_trace = ReplayTraceRecord(
            trading_day='2026-03-27',
            strategy_trace=no_failed_gate,
            decision_emitted=True,
            fill_status='filled',
            decision_strategy_id='late-day@prod',
            fill_price=Decimal('451.25'),
        ).with_updates(block_reason='filled_same_tick')
        replay_payload = replay_trace.to_payload()
        self.assertEqual(replay_payload['schema_version'], 'torghut.replay-trace.v1')
        self.assertEqual(replay_payload['fill_price'], '451.25')
        self.assertEqual(replay_payload['block_reason'], 'filled_same_tick')

        bucket = ReplayFunnelBucket(
            trading_day='2026-03-27',
            symbol='AAPL',
            retained_rows=10,
            runtime_evaluable_rows=8,
            quote_valid_rows=9,
            strategy_evaluations=5,
            gate_pass_counts={'b:confirmation': 2, 'a:eligibility': 4},
            decision_count=2,
            filled_count=1,
            filled_notional=Decimal('451.25'),
            closed_trade_count=1,
            gross_pnl=Decimal('10.50'),
            net_pnl=Decimal('9.75'),
            cost_total=Decimal('0.75'),
        )
        report = ReplayFunnelReport(
            start_date='2026-03-24',
            end_date='2026-03-27',
            buckets=(bucket,),
        )
        report_payload = report.to_payload()
        self.assertEqual(report_payload['schema_version'], 'torghut.replay-funnel.v1')
        self.assertEqual(
            report_payload['buckets'][0]['gate_pass_counts'],
            {'a:eligibility': 4, 'b:confirmation': 2},
        )

        near_miss = NearMissRecord(
            trading_day='2026-03-27',
            symbol='AAPL',
            strategy_id='breakout@prod',
            strategy_type='breakout_continuation_long',
            event_ts='2026-03-27T18:00:00+00:00',
            action='buy',
            first_failed_gate='confirmation',
            distance_score=Decimal('0.15'),
            thresholds=(
                ThresholdTrace(
                    metric='continuation_rank',
                    comparator='min_gte',
                    value=Decimal('0.70'),
                    threshold=Decimal('0.85'),
                    passed=False,
                    missing_policy='fail_closed',
                    distance_to_pass=Decimal('0.15'),
                ),
            ),
        )
        near_miss_payload = near_miss.to_payload()
        self.assertEqual(near_miss_payload['distance_score'], '0.15')
        self.assertEqual(near_miss_payload['thresholds'][0]['threshold'], '0.85')

        candidate = SweepCandidateResult(
            candidate_id='candidate-1',
            family='breakout_continuation',
            strategy_name='breakout-continuation-long-v1',
            train_net_per_day=Decimal('12.5'),
            holdout_net_per_day=Decimal('51.6'),
            train_total_net=Decimal('62.5'),
            holdout_total_net=Decimal('258.0'),
            active_holdout_days=2,
            max_holdout_drawdown_day=Decimal('0'),
            profit_factor=None,
            wins=2,
            losses=0,
            score=Decimal('-646.6'),
            replay_config={'params': {'rank': Decimal('0.45')}},
        )
        candidate_payload = candidate.to_payload()
        self.assertEqual(candidate_payload['schema_version'], 'torghut.sweep-candidate-result.v1')
        self.assertEqual(candidate_payload['profit_factor'], None)
        self.assertEqual(candidate_payload['replay_config']['params']['rank'], '0.45')

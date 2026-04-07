from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery.dataset_snapshot import (
    build_dataset_snapshot_receipt,
    ensure_fresh_snapshot,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.family_templates import load_family_template
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    evaluate_vetoes,
    rank_scorecards,
)


class TestDiscoveryHarnessV2(TestCase):
    def test_dataset_snapshot_receipt_flags_stale_and_missing_days(self) -> None:
        responses = {
            "SELECT DISTINCT toDate(event_ts) AS trading_day FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S'   AND toDate(event_ts) >= toDate('2026-04-03')   AND toDate(event_ts) <= toDate('2026-04-07') ORDER BY trading_day ASC FORMAT TSVRaw": "2026-04-03\n2026-04-04\n",
            "SELECT count() FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S'   AND toDate(event_ts) >= toDate('2026-04-03')   AND toDate(event_ts) <= toDate('2026-04-07') FORMAT TSVRaw": "123",
            "SELECT count() FROM torghut.ta_microbars WHERE source = 'ta'   AND window_size = 'PT1S'   AND toDate(event_ts) >= toDate('2026-04-03')   AND toDate(event_ts) <= toDate('2026-04-07') FORMAT TSVRaw": "456",
            "SELECT toString(max(event_ts)) FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "2026-04-04 20:00:00",
            "SELECT toString(max(event_ts)) FROM torghut.ta_microbars WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "2026-04-04 20:00:00",
            "SELECT toString(max(toDate(event_ts))) FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "2026-04-04",
            "SELECT toString(max(toDate(event_ts))) FROM torghut.ta_microbars WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "2026-04-04",
        }

        def fake_http_query(*, url: str, username: str | None, password: str | None, query: str) -> str:
            del url, username, password
            return responses[query]

        with patch('app.trading.discovery.dataset_snapshot._http_query', side_effect=fake_http_query):
            receipt = build_dataset_snapshot_receipt(
                clickhouse_http_url='http://example.invalid',
                clickhouse_username='torghut',
                clickhouse_password='secret',
                start_day=date(2026, 4, 3),
                end_day=date(2026, 4, 7),
                expected_last_trading_day=date(2026, 4, 7),
                expected_trading_days=(
                    date(2026, 4, 3),
                    date(2026, 4, 4),
                    date(2026, 4, 7),
                ),
            )

        self.assertFalse(receipt.is_fresh)
        self.assertEqual(receipt.missing_days, (date(2026, 4, 7),))
        self.assertEqual(receipt.row_count, 123)
        self.assertEqual(receipt.to_payload()['witnesses'][0]['payload']['latest_observed_day'], '2026-04-04')
        with self.assertRaisesRegex(ValueError, 'stale_tape'):
            ensure_fresh_snapshot(receipt, allow_stale_tape=False)

    def test_family_template_loader_reads_checked_in_template(self) -> None:
        root = Path(__file__).resolve().parents[1] / 'config' / 'trading' / 'families'
        template = load_family_template('breakout_reclaim_v2', directory=root)
        self.assertEqual(template.family_id, 'breakout_reclaim_v2')
        self.assertIn('quote_quality_veto', template.risk_controls)
        self.assertEqual(template.default_hard_vetoes['required_min_daily_notional'], '300000')

    def test_decomposition_reports_family_symbol_and_regime_concentration(self) -> None:
        decomposition = build_replay_decomposition(
            replay_payload={
                'filled_count': 3,
                'daily': {
                    '2026-04-03': {'net_pnl': '120', 'filled_notional': '250000', 'filled_count': 1},
                    '2026-04-04': {'net_pnl': '80', 'filled_notional': '220000', 'filled_count': 2},
                },
                'funnel': {
                    'buckets': [
                        {'trading_day': '2026-04-03', 'symbol': 'NVDA', 'filled_count': 1, 'filled_notional': '250000', 'net_pnl': '120'},
                        {'trading_day': '2026-04-04', 'symbol': 'AMAT', 'filled_count': 2, 'filled_notional': '220000', 'net_pnl': '80'},
                    ]
                },
                'trace': [
                    {
                        'fill_status': 'filled',
                        'strategy_trace': {
                            'strategy_type': 'breakout_reclaim_v2',
                            'passed': True,
                            'action': 'buy',
                            'context': {'entry_motif': 'breakout_reclaim', 'regime_label': 'trend'},
                        },
                    },
                    {
                        'fill_status': 'none',
                        'strategy_trace': {
                            'strategy_type': 'breakout_reclaim_v2',
                            'passed': False,
                            'action': 'buy',
                            'context': {'entry_motif': 'breakout_reclaim', 'regime_label': 'trend'},
                        },
                    },
                ],
            },
            family_id='breakout_reclaim_v2',
            normalization_regime='trading_value_scaled',
        )

        self.assertEqual(decomposition.families['breakout_reclaim_v2']['fills'], 1)
        self.assertEqual(decomposition.entry_motifs['breakout_reclaim']['evaluations'], 2)
        self.assertEqual(decomposition.normalization_regimes['trading_value_scaled']['filled_count'], 3)
        self.assertEqual(regime_slice_pass_rate(decomposition), Decimal('0.5'))
        self.assertGreater(max_symbol_concentration_share(decomposition), Decimal('0'))
        self.assertEqual(max_family_contribution_share(decomposition), Decimal('1'))

    def test_rank_scorecards_prefers_non_vetoed_pareto_frontier_candidates(self) -> None:
        policy = ObjectiveVetoPolicy(
            required_min_active_day_ratio=Decimal('0.5'),
            required_min_daily_notional=Decimal('100000'),
            required_max_best_day_share=Decimal('0.60'),
            required_max_worst_day_loss=Decimal('250'),
            required_max_drawdown=Decimal('500'),
            required_min_regime_slice_pass_rate=Decimal('0.40'),
        )
        steady = build_scorecard(
            candidate_id='steady',
            trading_day_count=6,
            net_pnl_per_day=Decimal('320'),
            active_days=5,
            positive_days=5,
            avg_filled_notional_per_day=Decimal('160000'),
            avg_filled_notional_per_active_day=Decimal('192000'),
            worst_day_loss=Decimal('80'),
            max_drawdown=Decimal('140'),
            best_day_share=Decimal('0.28'),
            negative_day_count=1,
            rolling_3d_lower_bound=Decimal('180'),
            rolling_5d_lower_bound=Decimal('150'),
            regime_slice_pass_rate=Decimal('0.55'),
            symbol_concentration_share=Decimal('0.35'),
            entry_family_contribution_share=Decimal('1'),
        )
        lottery = build_scorecard(
            candidate_id='lottery',
            trading_day_count=6,
            net_pnl_per_day=Decimal('450'),
            active_days=2,
            positive_days=2,
            avg_filled_notional_per_day=Decimal('90000'),
            avg_filled_notional_per_active_day=Decimal('270000'),
            worst_day_loss=Decimal('420'),
            max_drawdown=Decimal('800'),
            best_day_share=Decimal('0.82'),
            negative_day_count=2,
            rolling_3d_lower_bound=Decimal('-50'),
            rolling_5d_lower_bound=Decimal('10'),
            regime_slice_pass_rate=Decimal('0.25'),
            symbol_concentration_share=Decimal('0.88'),
            entry_family_contribution_share=Decimal('1'),
        )
        veto_lookup = {
            'steady': evaluate_vetoes(steady, policy=policy, is_fresh=True),
            'lottery': evaluate_vetoes(lottery, policy=policy, is_fresh=True),
        }
        ranked = rank_scorecards([steady, lottery], veto_lookup=veto_lookup)

        self.assertEqual(ranked[0].candidate_id, 'steady')
        self.assertFalse(ranked[0].veto_reasons)
        self.assertIn('best_day_share_above_max', ranked[1].veto_reasons)

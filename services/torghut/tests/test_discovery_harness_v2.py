from __future__ import annotations

import importlib
import io
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib import error
from unittest import TestCase
from unittest.mock import patch

import app.trading.alpha as alpha_module
import app.trading.discovery as discovery_module
from app.trading.discovery.dataset_snapshot import (
    _b64,
    _business_days,
    _http_query,
    _most_recent_business_day,
    build_dataset_snapshot_receipt,
    ensure_fresh_snapshot,
    resolve_expected_last_trading_day,
    witness_map,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.family_templates import derive_family_template_id, load_family_template
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    dominates,
    evaluate_vetoes,
    rank_scorecards,
    tie_breaker,
)


class TestDiscoveryHarnessV2(TestCase):
    def test_lazy_package_exports_and_attribute_errors(self) -> None:
        reloaded_alpha = importlib.reload(alpha_module)
        self.assertEqual(reloaded_alpha.PerformanceSummary.__name__, 'PerformanceSummary')
        with self.assertRaises(AttributeError):
            getattr(reloaded_alpha, 'missing_export')

        reloaded_discovery = importlib.reload(discovery_module)
        self.assertEqual(
            reloaded_discovery.build_strategy_factory_evaluation.__name__,
            'build_strategy_factory_evaluation',
        )
        with self.assertRaises(AttributeError):
            getattr(reloaded_discovery, 'missing_export')

    def test_dataset_snapshot_helpers_and_transport_branches(self) -> None:
        self.assertEqual(_business_days(date(2026, 4, 7), date(2026, 4, 6)), ())
        self.assertEqual(
            _business_days(date(2026, 4, 3), date(2026, 4, 6)),
            (date(2026, 4, 3), date(2026, 4, 6)),
        )
        self.assertEqual(_most_recent_business_day(date(2026, 4, 5)), date(2026, 4, 3))
        self.assertEqual(
            resolve_expected_last_trading_day(
                explicit_day=None,
                now_utc=datetime(2026, 4, 6, 18, 0, tzinfo=timezone.utc),
            ),
            date(2026, 4, 3),
        )
        self.assertEqual(
            resolve_expected_last_trading_day(
                explicit_day=date(2026, 4, 7),
                now_utc=datetime(2026, 4, 6, 18, 0, tzinfo=timezone.utc),
            ),
            date(2026, 4, 7),
        )
        self.assertTrue(_b64(b'codex'))

        class _Response:
            def __init__(self, body: bytes) -> None:
                self._body = body

            def __enter__(self) -> '_Response':
                return self

            def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
                del exc_type, exc, tb
                return False

            def read(self) -> bytes:
                return self._body

        with patch('app.trading.discovery.dataset_snapshot.request.urlopen', return_value=_Response(b'ok')):
            self.assertEqual(
                _http_query(
                    url='http://example.invalid',
                    username='torghut',
                    password='secret',
                    query='SELECT 1',
                ),
                'ok',
            )

        http_error = error.HTTPError(
            url='http://example.invalid',
            code=403,
            msg='forbidden',
            hdrs=None,
            fp=io.BytesIO(b'bad auth'),
        )
        with patch('app.trading.discovery.dataset_snapshot.request.urlopen', side_effect=http_error):
            with self.assertRaisesRegex(RuntimeError, 'clickhouse_http_error: 403: bad auth'):
                _http_query(
                    url='http://example.invalid',
                    username='torghut',
                    password='secret',
                    query='SELECT 1',
                )

        with patch(
            'app.trading.discovery.dataset_snapshot.request.urlopen',
            side_effect=__import__('http').client.IncompleteRead(b'partial', 10),
        ):
            self.assertEqual(
                _http_query(
                    url='http://example.invalid',
                    username=None,
                    password=None,
                    query='SELECT 1',
                ),
                'partial',
            )

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

    def test_dataset_snapshot_receipt_handles_empty_latest_days_and_override(self) -> None:
        responses = {
            "SELECT DISTINCT toDate(event_ts) AS trading_day FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S'   AND toDate(event_ts) >= toDate('2026-04-03')   AND toDate(event_ts) <= toDate('2026-04-04') ORDER BY trading_day ASC FORMAT TSVRaw": "2026-04-03\n",
            "SELECT count() FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S'   AND toDate(event_ts) >= toDate('2026-04-03')   AND toDate(event_ts) <= toDate('2026-04-04') FORMAT TSVRaw": "12",
            "SELECT count() FROM torghut.ta_microbars WHERE source = 'ta'   AND window_size = 'PT1S'   AND toDate(event_ts) >= toDate('2026-04-03')   AND toDate(event_ts) <= toDate('2026-04-04') FORMAT TSVRaw": "10",
            "SELECT toString(max(event_ts)) FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "",
            "SELECT toString(max(event_ts)) FROM torghut.ta_microbars WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "",
            "SELECT toString(max(toDate(event_ts))) FROM torghut.ta_signals WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "",
            "SELECT toString(max(toDate(event_ts))) FROM torghut.ta_microbars WHERE source = 'ta'   AND window_size = 'PT1S' FORMAT TSVRaw": "",
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
                end_day=date(2026, 4, 4),
                expected_last_trading_day=date(2026, 4, 4),
                allow_stale_tape=True,
            )

        self.assertFalse(receipt.is_fresh)
        self.assertTrue(receipt.stale_override_used)
        self.assertEqual(receipt.to_payload()['witnesses'][0]['payload']['max_event_ts'], '')
        self.assertIn('ta_signals', witness_map(receipt))
        ensure_fresh_snapshot(receipt, allow_stale_tape=True)

    def test_family_template_loader_reads_checked_in_template(self) -> None:
        root = Path(__file__).resolve().parents[1] / 'config' / 'trading' / 'families'
        template = load_family_template('breakout_reclaim_v2', directory=root)
        self.assertEqual(template.family_id, 'breakout_reclaim_v2')
        self.assertIn('quote_quality_veto', template.risk_controls)
        self.assertEqual(template.default_hard_vetoes['required_min_daily_notional'], '300000')
        self.assertEqual(
            template.runtime_harness['strategy_name'],
            'breakout-continuation-long-v1',
        )
        self.assertEqual(
            derive_family_template_id(explicit_id=' custom ', family='ignored'),
            'custom',
        )

    def test_family_template_loader_validation_branches(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with self.assertRaisesRegex(ValueError, 'family_template_id_required'):
                load_family_template('   ', directory=root)

            (root / 'bad.yaml').write_text('- nope\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'family_template_not_mapping:bad'):
                load_family_template('bad', directory=root)

            (root / 'wrong-schema.yaml').write_text(
                'schema_version: bad\nfamily_id: wrong-schema\n',
                encoding='utf-8',
            )
            with self.assertRaisesRegex(ValueError, 'family_template_schema_invalid:wrong-schema:bad'):
                load_family_template('wrong-schema', directory=root)

            (root / 'mismatch.yaml').write_text(
                'schema_version: torghut.family-template.v1\nfamily_id: other\n',
                encoding='utf-8',
            )
            with self.assertRaisesRegex(ValueError, 'family_template_id_mismatch:mismatch'):
                load_family_template('mismatch', directory=root)

        self.assertEqual(
            derive_family_template_id(explicit_id=None, family='new-family'),
            'new-family',
        )

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

    def test_objective_vetoes_and_domination_cover_stale_and_dominated_branches(self) -> None:
        dominant = build_scorecard(
            candidate_id='dominant',
            trading_day_count=5,
            net_pnl_per_day=Decimal('400'),
            active_days=5,
            positive_days=5,
            avg_filled_notional_per_day=Decimal('250000'),
            avg_filled_notional_per_active_day=Decimal('250000'),
            worst_day_loss=Decimal('40'),
            max_drawdown=Decimal('60'),
            best_day_share=Decimal('0.20'),
            negative_day_count=0,
            rolling_3d_lower_bound=Decimal('220'),
            rolling_5d_lower_bound=Decimal('200'),
            regime_slice_pass_rate=Decimal('0.90'),
            symbol_concentration_share=Decimal('0.20'),
            entry_family_contribution_share=Decimal('0.30'),
        )
        dominated = build_scorecard(
            candidate_id='dominated',
            trading_day_count=5,
            net_pnl_per_day=Decimal('150'),
            active_days=2,
            positive_days=2,
            avg_filled_notional_per_day=Decimal('50000'),
            avg_filled_notional_per_active_day=Decimal('125000'),
            worst_day_loss=Decimal('350'),
            max_drawdown=Decimal('500'),
            best_day_share=Decimal('0.80'),
            negative_day_count=3,
            rolling_3d_lower_bound=Decimal('-10'),
            rolling_5d_lower_bound=Decimal('5'),
            regime_slice_pass_rate=Decimal('0.10'),
            symbol_concentration_share=Decimal('0.80'),
            entry_family_contribution_share=Decimal('0.90'),
        )
        self.assertTrue(dominates(dominant, dominated))
        self.assertFalse(dominates(dominated, dominant))
        self.assertGreater(tie_breaker(dominant), tie_breaker(dominated))

        vetoes = evaluate_vetoes(
            dominated,
            policy=ObjectiveVetoPolicy(
                required_min_active_day_ratio=Decimal('0.5'),
                required_min_daily_notional=Decimal('100000'),
                required_max_best_day_share=Decimal('0.60'),
                required_max_worst_day_loss=Decimal('200'),
                required_max_drawdown=Decimal('400'),
                required_min_regime_slice_pass_rate=Decimal('0.40'),
            ),
            is_fresh=False,
        )
        self.assertIn('worst_day_loss_above_max', vetoes)
        self.assertIn('regime_slice_pass_rate_below_min', vetoes)
        self.assertIn('stale_tape', vetoes)

        ranked = rank_scorecards(
            [dominated, dominant],
            veto_lookup={'dominated': vetoes, 'dominant': ()},
        )
        self.assertEqual([item.candidate_id for item in ranked], ['dominant', 'dominated'])

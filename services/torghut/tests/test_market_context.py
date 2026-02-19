from __future__ import annotations

import io
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.llm.schema import MarketContextBundle
from app.trading.market_context import MarketContextClient, evaluate_market_context


class TestMarketContextClient(TestCase):
    def setUp(self) -> None:
        self._original_url = config.settings.trading_market_context_url
        self._original_timeout = config.settings.trading_market_context_timeout_seconds
        self._original_required = config.settings.trading_market_context_required
        self._original_min_quality = config.settings.trading_market_context_min_quality
        self._original_max_staleness = config.settings.trading_market_context_max_staleness_seconds

    def tearDown(self) -> None:
        config.settings.trading_market_context_url = self._original_url
        config.settings.trading_market_context_timeout_seconds = self._original_timeout
        config.settings.trading_market_context_required = self._original_required
        config.settings.trading_market_context_min_quality = self._original_min_quality
        config.settings.trading_market_context_max_staleness_seconds = self._original_max_staleness

    def test_fetch_parses_bundle(self) -> None:
        config.settings.trading_market_context_url = 'http://jangar.test/api/torghut/market-context'
        config.settings.trading_market_context_timeout_seconds = 2

        payload = io.BytesIO(
            b'{"ok":true,"context":{"contextVersion":"torghut.market-context.v1","symbol":"AAPL","asOfUtc":"2026-02-19T12:00:00Z","freshnessSeconds":10,"qualityScore":0.8,"sourceCount":1,"riskFlags":[],"domains":{"technicals":{"domain":"technicals","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":60,"sourceCount":1,"qualityScore":1,"payload":{"price":100},"citations":[],"riskFlags":[]},"fundamentals":{"domain":"fundamentals","state":"missing","asOf":null,"freshnessSeconds":null,"maxFreshnessSeconds":86400,"sourceCount":0,"qualityScore":0,"payload":{},"citations":[],"riskFlags":["fundamentals_missing"]},"news":{"domain":"news","state":"missing","asOf":null,"freshnessSeconds":null,"maxFreshnessSeconds":300,"sourceCount":0,"qualityScore":0,"payload":{},"citations":[],"riskFlags":["news_missing"]},"regime":{"domain":"regime","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":120,"sourceCount":1,"qualityScore":1,"payload":{"volatility":0.1},"citations":[],"riskFlags":[]}}}}'
        )

        with patch('app.trading.market_context.urlopen', return_value=payload):
            bundle = MarketContextClient().fetch('AAPL')
        self.assertIsNotNone(bundle)
        self.assertEqual(bundle.symbol, 'AAPL')
        self.assertEqual(bundle.context_version, 'torghut.market-context.v1')

    def test_evaluate_blocks_low_quality_or_stale(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.7
        config.settings.trading_market_context_max_staleness_seconds = 30

        status_missing = evaluate_market_context(None)
        self.assertFalse(status_missing.allow_llm)
        self.assertEqual(status_missing.reason, 'market_context_required_missing')

        bundle = MarketContextBundle.model_validate(
            {
                'contextVersion': 'torghut.market-context.v1',
                'symbol': 'AAPL',
                'asOfUtc': '2026-02-19T12:00:00Z',
                'freshnessSeconds': 45,
                'qualityScore': 0.4,
                'sourceCount': 1,
                'riskFlags': [],
                'domains': {
                    'technicals': {
                        'domain': 'technicals',
                        'state': 'ok',
                        'asOf': '2026-02-19T12:00:00Z',
                        'freshnessSeconds': 45,
                        'maxFreshnessSeconds': 60,
                        'sourceCount': 1,
                        'qualityScore': 1,
                        'payload': {},
                        'citations': [],
                        'riskFlags': [],
                    },
                    'fundamentals': {
                        'domain': 'fundamentals',
                        'state': 'missing',
                        'asOf': None,
                        'freshnessSeconds': None,
                        'maxFreshnessSeconds': 86400,
                        'sourceCount': 0,
                        'qualityScore': 0,
                        'payload': {},
                        'citations': [],
                        'riskFlags': ['fundamentals_missing'],
                    },
                    'news': {
                        'domain': 'news',
                        'state': 'missing',
                        'asOf': None,
                        'freshnessSeconds': None,
                        'maxFreshnessSeconds': 300,
                        'sourceCount': 0,
                        'qualityScore': 0,
                        'payload': {},
                        'citations': [],
                        'riskFlags': ['news_missing'],
                    },
                    'regime': {
                        'domain': 'regime',
                        'state': 'ok',
                        'asOf': '2026-02-19T12:00:00Z',
                        'freshnessSeconds': 45,
                        'maxFreshnessSeconds': 120,
                        'sourceCount': 1,
                        'qualityScore': 1,
                        'payload': {},
                        'citations': [],
                        'riskFlags': [],
                    },
                },
            }
        )
        status = evaluate_market_context(bundle)
        self.assertFalse(status.allow_llm)
        self.assertIn('market_context_stale', status.risk_flags)
        self.assertIn('market_context_quality_low', status.risk_flags)

    def test_evaluate_allows_informational_risk_flags(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.7
        config.settings.trading_market_context_max_staleness_seconds = 30

        bundle = MarketContextBundle.model_validate(
            {
                'contextVersion': 'torghut.market-context.v1',
                'symbol': 'AAPL',
                'asOfUtc': '2026-02-19T12:00:00Z',
                'freshnessSeconds': 10,
                'qualityScore': 0.9,
                'sourceCount': 1,
                'riskFlags': ['fundamentals_missing', 'news_missing'],
                'domains': {
                    'technicals': {
                        'domain': 'technicals',
                        'state': 'ok',
                        'asOf': '2026-02-19T12:00:00Z',
                        'freshnessSeconds': 10,
                        'maxFreshnessSeconds': 60,
                        'sourceCount': 1,
                        'qualityScore': 1,
                        'payload': {},
                        'citations': [],
                        'riskFlags': [],
                    },
                    'fundamentals': {
                        'domain': 'fundamentals',
                        'state': 'missing',
                        'asOf': None,
                        'freshnessSeconds': None,
                        'maxFreshnessSeconds': 86400,
                        'sourceCount': 0,
                        'qualityScore': 0,
                        'payload': {},
                        'citations': [],
                        'riskFlags': ['fundamentals_missing'],
                    },
                    'news': {
                        'domain': 'news',
                        'state': 'missing',
                        'asOf': None,
                        'freshnessSeconds': None,
                        'maxFreshnessSeconds': 300,
                        'sourceCount': 0,
                        'qualityScore': 0,
                        'payload': {},
                        'citations': [],
                        'riskFlags': ['news_missing'],
                    },
                    'regime': {
                        'domain': 'regime',
                        'state': 'ok',
                        'asOf': '2026-02-19T12:00:00Z',
                        'freshnessSeconds': 10,
                        'maxFreshnessSeconds': 120,
                        'sourceCount': 1,
                        'qualityScore': 1,
                        'payload': {},
                        'citations': [],
                        'riskFlags': [],
                    },
                },
            }
        )
        status = evaluate_market_context(bundle)
        self.assertTrue(status.allow_llm)
        self.assertIsNone(status.reason)
        self.assertIn('fundamentals_missing', status.risk_flags)
        self.assertIn('news_missing', status.risk_flags)

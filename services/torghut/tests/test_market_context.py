from __future__ import annotations

import io
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.llm.schema import MarketContextBundle
from app.trading.market_context import (
    _HttpRequest,
    MarketContextClient,
    evaluate_market_context,
    urlopen,
)
from app.trading.market_context_domains import (
    active_market_context_bundle_domains,
    active_market_context_freshness_seconds,
    active_market_context_quality_score,
    active_market_context_reasons,
    is_retired_market_context_reason,
)


class _MarketContextResponse:
    def __init__(self, payload: bytes, *, status: object = 200) -> None:
        self.status = status
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_MarketContextResponse":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> bool:
        return False


class _FakeConnection:
    last: "_FakeConnection | None" = None

    def __init__(self, host: str, port: int | None = None, timeout: int = 1) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.request_method: str | None = None
        self.request_path: str | None = None
        self.request_headers: dict[str, str] | None = None
        self.closed = False
        _FakeConnection.last = self

    def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
        self.request_method = method
        self.request_path = path
        self.request_headers = dict(headers)

    def getresponse(self) -> _MarketContextResponse:
        return _MarketContextResponse(b"{}", status="204")

    def close(self) -> None:
        self.closed = True


class TestMarketContextClient(TestCase):
    def setUp(self) -> None:
        self._original_url = config.settings.trading_market_context_url
        self._original_timeout = config.settings.trading_market_context_timeout_seconds
        self._original_required = config.settings.trading_market_context_required
        self._original_min_quality = config.settings.trading_market_context_min_quality
        self._original_max_staleness = (
            config.settings.trading_market_context_max_staleness_seconds
        )

    def tearDown(self) -> None:
        config.settings.trading_market_context_url = self._original_url
        config.settings.trading_market_context_timeout_seconds = self._original_timeout
        config.settings.trading_market_context_required = self._original_required
        config.settings.trading_market_context_min_quality = self._original_min_quality
        config.settings.trading_market_context_max_staleness_seconds = (
            self._original_max_staleness
        )

    def test_urlopen_validates_url_and_preserves_query(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError, "market_context_invalid_url_scheme:ftp"
        ):
            urlopen(
                _HttpRequest(
                    full_url="ftp://jangar.test/api/context",
                    method="GET",
                    headers={},
                ),
                timeout=1,
            )

        with self.assertRaisesRegex(RuntimeError, "market_context_invalid_url_host"):
            urlopen(
                _HttpRequest(
                    full_url="http:///api/context",
                    method="GET",
                    headers={},
                ),
                timeout=1,
            )

        _FakeConnection.last = None
        request = _HttpRequest(
            full_url="http://jangar.test:8080/api/context?symbol=AAPL",
            method="GET",
            headers={"accept": "application/json"},
        )
        with patch("app.trading.market_context.HTTPConnection", _FakeConnection):
            with urlopen(request, timeout=0) as response:
                self.assertEqual(response.status, 204)
                self.assertEqual(response.read(), b"{}")

        connection = _FakeConnection.last
        assert connection is not None
        self.assertEqual(connection.host, "jangar.test")
        self.assertEqual(connection.port, 8080)
        self.assertEqual(connection.timeout, 1)
        self.assertEqual(connection.request_method, "GET")
        self.assertEqual(connection.request_path, "/api/context?symbol=AAPL")
        self.assertEqual(connection.request_headers, {"accept": "application/json"})
        self.assertTrue(connection.closed)

    def test_fetch_parses_bundle(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2

        payload = io.BytesIO(
            b'{"ok":true,"context":{"contextVersion":"torghut.market-context.v1","symbol":"AAPL","asOfUtc":"2026-02-19T12:00:00Z","freshnessSeconds":10,"qualityScore":0.8,"sourceCount":1,"riskFlags":[],"domains":{"technicals":{"domain":"technicals","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":60,"sourceCount":1,"qualityScore":1,"payload":{"price":100},"citations":[],"riskFlags":[]},"fundamentals":{"domain":"fundamentals","state":"missing","asOf":null,"freshnessSeconds":null,"maxFreshnessSeconds":86400,"sourceCount":0,"qualityScore":0,"payload":{},"citations":[],"riskFlags":["fundamentals_missing"]},"news":{"domain":"news","state":"missing","asOf":null,"freshnessSeconds":null,"maxFreshnessSeconds":300,"sourceCount":0,"qualityScore":0,"payload":{},"citations":[],"riskFlags":["news_missing"]},"regime":{"domain":"regime","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":120,"sourceCount":1,"qualityScore":1,"payload":{"volatility":0.1},"citations":[],"riskFlags":[]}}}}'
        )

        with patch("app.trading.market_context.urlopen", return_value=payload):
            bundle = MarketContextClient().fetch("AAPL")
        self.assertIsNotNone(bundle)
        self.assertEqual(bundle.symbol, "AAPL")
        self.assertEqual(bundle.context_version, "torghut.market-context.v1")
        self.assertFalse(hasattr(bundle.domains, "fundamentals"))
        self.assertFalse(hasattr(bundle.domains, "news"))

    def test_fetch_parses_active_domain_bundle_without_retired_context(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2

        payload = io.BytesIO(
            b'{"ok":true,"context":{"contextVersion":"torghut.market-context.v1","symbol":"AAPL","asOfUtc":"2026-02-19T12:00:00Z","freshnessSeconds":10,"qualityScore":1,"sourceCount":2,"riskFlags":[],"domains":{"technicals":{"domain":"technicals","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":60,"sourceCount":1,"qualityScore":1,"payload":{"price":100},"citations":[],"riskFlags":[]},"regime":{"domain":"regime","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":120,"sourceCount":1,"qualityScore":1,"payload":{"volatility":0.1},"citations":[],"riskFlags":[]}}}}'
        )

        with patch("app.trading.market_context.urlopen", return_value=payload):
            bundle = MarketContextClient().fetch("AAPL")

        self.assertIsNotNone(bundle)
        self.assertEqual(bundle.symbol, "AAPL")
        self.assertEqual(bundle.domains.technicals.domain, "technicals")
        self.assertEqual(bundle.domains.regime.domain, "regime")

    def test_fetch_rejects_non_success_status(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2

        with patch(
            "app.trading.market_context.urlopen",
            return_value=_MarketContextResponse(b"{}", status=503),
        ):
            with self.assertRaisesRegex(RuntimeError, "market_context_http_503"):
                MarketContextClient().fetch("AAPL")

    def test_fetch_appends_as_of_timestamp(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        payload = io.BytesIO(
            b'{"ok":true,"context":{"contextVersion":"torghut.market-context.v1","symbol":"AAPL","asOfUtc":"2026-02-19T12:00:00Z","freshnessSeconds":10,"qualityScore":0.8,"sourceCount":1,"riskFlags":[],"domains":{"technicals":{"domain":"technicals","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":60,"sourceCount":1,"qualityScore":1,"payload":{"price":100},"citations":[],"riskFlags":[]},"fundamentals":{"domain":"fundamentals","state":"missing","asOf":null,"freshnessSeconds":null,"maxFreshnessSeconds":86400,"sourceCount":0,"qualityScore":0,"payload":{},"citations":[],"riskFlags":["fundamentals_missing"]},"news":{"domain":"news","state":"missing","asOf":null,"freshnessSeconds":null,"maxFreshnessSeconds":300,"sourceCount":0,"qualityScore":0,"payload":{},"citations":[],"riskFlags":["news_missing"]},"regime":{"domain":"regime","state":"ok","asOf":"2026-02-19T12:00:00Z","freshnessSeconds":10,"maxFreshnessSeconds":120,"sourceCount":1,"qualityScore":1,"payload":{"volatility":0.1},"citations":[],"riskFlags":[]}}}}'
        )

        as_of = datetime(2026, 3, 6, 18, 15, tzinfo=timezone.utc)
        with patch(
            "app.trading.market_context.urlopen", return_value=payload
        ) as mock_urlopen:
            MarketContextClient().fetch("AAPL", as_of=as_of)
        request = mock_urlopen.call_args.args[0]
        self.assertIn("asOf=2026-03-06T18%3A15%3A00%2B00%3A00", request.full_url)

    def test_fetch_health_appends_as_of_timestamp(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        payload = _MarketContextResponse(
            b'{"ok":true,"health":{"overallState":"ok","activeDomains":["technicals","regime"]}}'
        )

        as_of = datetime(2026, 3, 6, 18, 15, tzinfo=timezone.utc)
        with patch(
            "app.trading.market_context.urlopen", return_value=payload
        ) as mock_urlopen:
            health = MarketContextClient().fetch_health("aapl", as_of=as_of)

        self.assertEqual(
            health, {"overallState": "ok", "activeDomains": ["technicals", "regime"]}
        )
        request = mock_urlopen.call_args.args[0]
        self.assertIn("/market-context/health?symbol=aapl", request.full_url)
        self.assertIn("asOf=2026-03-06T18%3A15%3A00%2B00%3A00", request.full_url)

    def test_active_market_context_helpers_ignore_retired_edges(self) -> None:
        self.assertFalse(is_retired_market_context_reason(" "))
        self.assertEqual(active_market_context_reasons("news-stale"), [])
        self.assertEqual(
            active_market_context_reasons("regime_stale"), ["regime_stale"]
        )
        self.assertEqual(active_market_context_reasons(object()), [])

        fallback_bundle = SimpleNamespace(freshness_seconds=77, quality_score=0.42)
        self.assertEqual(active_market_context_bundle_domains(fallback_bundle), {})
        self.assertEqual(active_market_context_freshness_seconds(fallback_bundle), 77)
        self.assertEqual(active_market_context_quality_score(fallback_bundle), 0.42)

    def test_evaluate_blocks_low_quality_or_stale(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.7
        config.settings.trading_market_context_max_staleness_seconds = 30

        status_missing = evaluate_market_context(None)
        self.assertFalse(status_missing.allow_llm)
        self.assertEqual(status_missing.reason, "market_context_required_missing")

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 45,
                "qualityScore": 0.4,
                "sourceCount": 1,
                "riskFlags": [],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 45,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 0.4,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "missing",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["fundamentals_missing"],
                    },
                    "news": {
                        "domain": "news",
                        "state": "missing",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["news_missing"],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 45,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )
        status = evaluate_market_context(bundle)
        self.assertFalse(status.allow_llm)
        self.assertIn("market_context_stale", status.risk_flags)
        self.assertIn("market_context_quality_low", status.risk_flags)

    def test_evaluate_allows_informational_risk_flags(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.7
        config.settings.trading_market_context_max_staleness_seconds = 30

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 10,
                "qualityScore": 0.9,
                "sourceCount": 1,
                "riskFlags": ["fundamentals_missing", "news_missing"],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 10,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "missing",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["fundamentals_missing"],
                    },
                    "news": {
                        "domain": "news",
                        "state": "missing",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["news_missing"],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 10,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )
        status = evaluate_market_context(bundle)
        self.assertTrue(status.allow_llm)
        self.assertIsNone(status.reason)
        self.assertNotIn("fundamentals_missing", status.risk_flags)
        self.assertNotIn("news_missing", status.risk_flags)

    def test_evaluate_ignores_retired_domain_error_states(self) -> None:
        config.settings.trading_market_context_required = False
        config.settings.trading_market_context_min_quality = 0.2
        config.settings.trading_market_context_max_staleness_seconds = 300

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 20,
                "qualityScore": 0.8,
                "sourceCount": 2,
                "riskFlags": ["news_error"],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "asOf": "2026-02-19T11:00:00Z",
                        "freshnessSeconds": 3600,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "error",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["news_error"],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )
        status = evaluate_market_context(bundle)
        self.assertTrue(status.allow_llm)
        self.assertIsNone(status.reason)
        self.assertNotIn("news_error", status.risk_flags)
        self.assertNotIn("market_context_domain_error", status.risk_flags)

    def test_evaluate_prioritizes_domain_error_reason_over_staleness(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.2
        config.settings.trading_market_context_max_staleness_seconds = 30

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "MSFT",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 120,
                "qualityScore": 0.8,
                "sourceCount": 2,
                "riskFlags": ["technicals_source_error"],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "error",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["technicals_source_error"],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "asOf": "2026-02-19T11:00:00Z",
                        "freshnessSeconds": 3600,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "ok",
                        "asOf": "2026-02-19T11:59:00Z",
                        "freshnessSeconds": 60,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 120,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )
        status = evaluate_market_context(bundle)
        self.assertFalse(status.allow_llm)
        self.assertEqual(status.reason, "market_context_domain_error")
        self.assertIn("market_context_stale", status.risk_flags)

    def test_evaluate_uses_active_domains_for_staleness_and_quality(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.8
        config.settings.trading_market_context_max_staleness_seconds = 60

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 120,
                "qualityScore": 0.55,
                "sourceCount": 4,
                "riskFlags": [
                    "market_context_degraded_last_good",
                    "news_generation_failed_all_models",
                ],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 15,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "asOf": "2026-02-19T11:00:00Z",
                        "freshnessSeconds": 3600,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 1,
                        "qualityScore": 0.9,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "stale",
                        "asOf": "2026-02-19T11:40:00Z",
                        "freshnessSeconds": 1200,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 2,
                        "qualityScore": 0.3,
                        "payload": {
                            "generationFailed": True,
                            "lastSuccessfulAsOfUtc": "2026-02-19T11:40:00Z",
                        },
                        "citations": [],
                        "riskFlags": [
                            "news_stale",
                            "news_generation_failed_all_models",
                            "market_context_degraded_last_good",
                        ],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 15,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )

        status = evaluate_market_context(bundle)
        self.assertTrue(status.allow_llm)
        self.assertIsNone(status.reason)
        self.assertIn("market_context_degraded_last_good", status.risk_flags)

    def test_evaluate_blocks_stale_active_domain(self) -> None:
        config.settings.trading_market_context_required = True
        config.settings.trading_market_context_min_quality = 0.8
        config.settings.trading_market_context_max_staleness_seconds = 60

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 120,
                "qualityScore": 0.55,
                "sourceCount": 4,
                "riskFlags": [
                    "market_context_degraded_last_good",
                    "news_generation_failed_all_models",
                ],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 15,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "ok",
                        "asOf": "2026-02-19T11:00:00Z",
                        "freshnessSeconds": 3600,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 1,
                        "qualityScore": 0.9,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "stale",
                        "asOf": "2026-02-19T11:40:00Z",
                        "freshnessSeconds": 1200,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 2,
                        "qualityScore": 0.3,
                        "payload": {"generationFailed": True},
                        "citations": [],
                        "riskFlags": [
                            "news_stale",
                            "news_generation_failed_all_models",
                            "market_context_degraded_last_good",
                        ],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T11:58:00Z",
                        "freshnessSeconds": 120,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )

        status = evaluate_market_context(bundle)
        self.assertFalse(status.allow_llm)
        self.assertEqual(status.reason, "market_context_stale")

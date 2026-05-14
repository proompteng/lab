from __future__ import annotations

import json
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.llm.schema import MarketContextBundle
from app.trading.scheduler.runtime import TradingScheduler


class _FakeResponse:
    status = 200

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> bool:
        return False


class _BrokenUniverseResolver:
    def get_resolution(self) -> object:
        raise RuntimeError("universe unavailable")


class _PipelineWithBrokenUniverse:
    universe_resolver = _BrokenUniverseResolver()


class TestTradingSchedulerMarketContextStatus(TestCase):
    def setUp(self) -> None:
        self._original_url = config.settings.trading_market_context_url
        self._original_timeout = config.settings.trading_market_context_timeout_seconds
        self._original_static_symbols = config.settings.trading_static_symbols_raw
        self._original_min_quality = config.settings.trading_market_context_min_quality
        self._original_max_staleness = (
            config.settings.trading_market_context_max_staleness_seconds
        )

    def tearDown(self) -> None:
        config.settings.trading_market_context_url = self._original_url
        config.settings.trading_market_context_timeout_seconds = self._original_timeout
        config.settings.trading_static_symbols_raw = self._original_static_symbols
        config.settings.trading_market_context_min_quality = self._original_min_quality
        config.settings.trading_market_context_max_staleness_seconds = (
            self._original_max_staleness
        )

    def test_status_fetches_jangar_context_when_runtime_state_is_empty(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        config.settings.trading_static_symbols_raw = "AAPL,NVDA"
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_market_context_max_staleness_seconds = 300

        bundle = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-05-14T13:35:00Z",
                "freshnessSeconds": 20,
                "qualityScore": 0.82,
                "sourceCount": 4,
                "riskFlags": [],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-05-14T13:35:00Z",
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
                        "asOf": "2026-05-14T13:20:00Z",
                        "freshnessSeconds": 920,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 3,
                        "qualityScore": 0.95,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "news": {
                        "domain": "news",
                        "state": "ok",
                        "asOf": "2026-05-14T13:34:00Z",
                        "freshnessSeconds": 80,
                        "maxFreshnessSeconds": 600,
                        "sourceCount": 3,
                        "qualityScore": 0.9,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-05-14T13:35:00Z",
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
        responses = iter(
            [
                _FakeResponse({"ok": True, "health": {"ok": True}}),
                _FakeResponse(
                    {
                        "ok": True,
                        "context": bundle.model_dump(mode="json", by_alias=True),
                    }
                ),
            ]
        )
        request_urls: list[str] = []

        def fake_urlopen(request: Any, _timeout: int) -> _FakeResponse:
            request_urls.append(str(request.full_url))
            return next(responses)

        scheduler = TradingScheduler()
        with patch("app.trading.market_context.urlopen", side_effect=fake_urlopen):
            status = scheduler.market_context_status()

        self.assertIn("/api/torghut/market-context/health?symbol=AAPL", request_urls[0])
        self.assertIn("/api/torghut/market-context?symbol=AAPL", request_urls[1])
        self.assertEqual(status["last_symbol"], "AAPL")
        self.assertEqual(scheduler.state.last_market_context_symbol, "AAPL")
        self.assertEqual(status["last_freshness_seconds"], 20)
        self.assertEqual(scheduler.state.last_market_context_freshness_seconds, 20)
        self.assertEqual(status["last_quality_score"], 0.82)
        self.assertEqual(
            status["last_domain_states"],
            {
                "technicals": "ok",
                "fundamentals": "ok",
                "news": "ok",
                "regime": "ok",
            },
        )
        self.assertFalse(status["alert_active"])
        self.assertFalse(scheduler.state.market_context_alert_active)

    def test_status_records_context_fetch_error(self) -> None:
        config.settings.trading_market_context_url = (
            "http://jangar.test/api/torghut/market-context"
        )
        config.settings.trading_market_context_timeout_seconds = 2
        config.settings.trading_static_symbols_raw = "AAPL"

        request_urls: list[str] = []

        def fake_urlopen(request: Any, _timeout: int) -> _FakeResponse:
            request_urls.append(str(request.full_url))
            if len(request_urls) == 1:
                return _FakeResponse({"ok": True, "health": {"ok": True}})
            raise RuntimeError("context unavailable")

        scheduler = TradingScheduler()
        with patch("app.trading.market_context.urlopen", side_effect=fake_urlopen):
            status = scheduler.market_context_status()

        self.assertIn("/api/torghut/market-context/health?symbol=AAPL", request_urls[0])
        self.assertIn("/api/torghut/market-context?symbol=AAPL", request_urls[1])
        self.assertEqual(status["last_fetch_error"], "context unavailable")
        self.assertEqual(
            scheduler.state.last_market_context_fetch_error,
            "context unavailable",
        )

    def test_probe_symbol_falls_back_when_universe_resolution_fails(self) -> None:
        config.settings.trading_static_symbols_raw = "MSFT,AAPL"

        scheduler = TradingScheduler()
        cast(Any, scheduler)._pipeline = _PipelineWithBrokenUniverse()

        self.assertEqual(
            cast(Any, scheduler)._market_context_probe_symbol(),
            "MSFT",
        )

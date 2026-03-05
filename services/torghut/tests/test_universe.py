from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.universe import UniverseCache, UniverseResolver


class TestUniverseResolver(TestCase):
    def setUp(self) -> None:
        self._original_source = config.settings.trading_universe_source
        self._original_symbols = config.settings.trading_static_symbols_raw
        self._original_url = config.settings.trading_jangar_symbols_url
        self._original_enabled = config.settings.trading_enabled
        self._original_autonomy = config.settings.trading_autonomy_enabled
        self._original_mode = config.settings.trading_mode
        self._original_crypto_enabled = config.settings.trading_crypto_enabled
        self._original_max_stale_seconds = config.settings.trading_universe_max_stale_seconds
        self._original_cache_seconds = config.settings.trading_universe_cache_seconds
        self._original_static_fallback_enabled = (
            config.settings.trading_universe_static_fallback_enabled
        )
        self._original_static_fallback_symbols = (
            config.settings.trading_universe_static_fallback_symbols_raw
        )

    def tearDown(self) -> None:
        config.settings.trading_universe_source = self._original_source
        config.settings.trading_static_symbols_raw = self._original_symbols
        config.settings.trading_jangar_symbols_url = self._original_url
        config.settings.trading_enabled = self._original_enabled
        config.settings.trading_autonomy_enabled = self._original_autonomy
        config.settings.trading_mode = self._original_mode
        config.settings.trading_crypto_enabled = self._original_crypto_enabled
        config.settings.trading_universe_max_stale_seconds = self._original_max_stale_seconds
        config.settings.trading_universe_cache_seconds = self._original_cache_seconds
        config.settings.trading_universe_static_fallback_enabled = (
            self._original_static_fallback_enabled
        )
        config.settings.trading_universe_static_fallback_symbols_raw = (
            self._original_static_fallback_symbols
        )

    def test_static_universe_fails_closed_on_empty(self) -> None:
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = ""
        resolver = UniverseResolver()
        self.assertEqual(resolver.get_symbols(), set())

    def test_static_universe_filters_invalid_symbols(self) -> None:
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL, AAPL;DROP, MSFT"
        resolver = UniverseResolver()
        self.assertEqual(resolver.get_symbols(), {"AAPL", "MSFT"})

    def test_jangar_failure_fails_closed(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        resolver = UniverseResolver()
        with patch("app.trading.universe.urlopen", side_effect=RuntimeError("boom")):
            self.assertEqual(resolver.get_symbols(), set())

    def test_active_trading_rejects_static_universe_source(self) -> None:
        config.settings.trading_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,MSFT"
        resolver = UniverseResolver()
        self.assertEqual(resolver.get_symbols(), set())

    def test_jangar_failure_uses_cached_symbols(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_cache_seconds = 0
        config.settings.trading_universe_max_stale_seconds = 120

        resolver = UniverseResolver()

        sample_payload = json.dumps(["MSFT", "NVDA", "invalid!"])
        with patch("app.trading.universe.urlopen") as mock_urlopen:
            response = mock_urlopen.return_value.__enter__.return_value
            response.read.return_value = sample_payload.encode()
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "ok")
            self.assertEqual(resolution.reason, "jangar_fetch_ok")
            self.assertEqual(resolution.symbols, {"MSFT", "NVDA"})

        with patch("app.trading.universe.urlopen", side_effect=RuntimeError("boom")):
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "degraded")
            self.assertEqual(
                resolution.reason,
                "jangar_fetch_failed_using_stale_cache",
            )
            self.assertEqual(resolution.symbols, {"MSFT", "NVDA"})

    def test_jangar_failure_uses_cached_symbols_warning_backoff(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_cache_seconds = 1
        config.settings.trading_universe_max_stale_seconds = 1200
        resolver = UniverseResolver()
        resolver._cache = UniverseCache(
            symbols={"MSFT"},
            fetched_at=datetime.now(timezone.utc) - timedelta(seconds=2),
        )

        with patch("app.trading.universe.logger.warning") as mock_warning, patch(
            "app.trading.universe.urlopen",
            side_effect=RuntimeError("boom"),
        ):
            self.assertEqual(resolver.get_symbols(), {"MSFT"})
            self.assertEqual(resolver.get_symbols(), {"MSFT"})
            self.assertEqual(mock_warning.call_count, 1)

    def test_jangar_failure_rejects_expired_cache(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_max_stale_seconds = 5
        config.settings.trading_universe_cache_seconds = 1
        resolver = UniverseResolver()
        resolver._cache = UniverseCache(
            symbols={"MSFT"},
            fetched_at=datetime.now(timezone.utc) - timedelta(seconds=60),
        )

        with patch("app.trading.universe.urlopen", side_effect=RuntimeError("boom")):
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "error")
            self.assertEqual(resolution.reason, "jangar_fetch_failed_cache_stale")
            self.assertEqual(resolution.symbols, set())

    def test_jangar_failure_without_cache_uses_static_fallback_when_enabled(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = (
            "AAPL, MSFT, INVALID!, BTC/USD"
        )
        config.settings.trading_crypto_enabled = False
        resolver = UniverseResolver()

        with patch("app.trading.universe.urlopen", side_effect=RuntimeError("boom")):
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "degraded")
            self.assertEqual(
                resolution.reason,
                "jangar_fetch_failed_using_static_fallback",
            )
            self.assertEqual(resolution.symbols, {"AAPL", "MSFT"})

    def test_jangar_failure_with_stale_cache_uses_static_fallback_when_enabled(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL, MSFT"
        config.settings.trading_universe_max_stale_seconds = 5
        config.settings.trading_universe_cache_seconds = 1
        resolver = UniverseResolver()
        resolver._cache = UniverseCache(
            symbols={"NVDA"},
            fetched_at=datetime.now(timezone.utc) - timedelta(seconds=60),
        )

        with patch("app.trading.universe.urlopen", side_effect=RuntimeError("boom")):
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "degraded")
            self.assertEqual(
                resolution.reason,
                "jangar_fetch_failed_cache_stale_using_static_fallback",
            )
            self.assertEqual(resolution.symbols, {"AAPL", "MSFT"})

    def test_jangar_empty_payload_with_no_cache_fails_closed(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        resolver = UniverseResolver()

        with patch("app.trading.universe.urlopen") as mock_urlopen:
            response = mock_urlopen.return_value.__enter__.return_value
            response.read.return_value = json.dumps([]).encode()
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "error")
            self.assertEqual(resolution.reason, "jangar_payload_empty")
            self.assertEqual(resolution.symbols, set())

    def test_jangar_empty_payload_uses_cached_symbols_within_stale_window(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_cache_seconds = 1
        config.settings.trading_universe_max_stale_seconds = 1200
        resolver = UniverseResolver()
        resolver._cache = UniverseCache(
            symbols={"MSFT"},
            fetched_at=datetime.now(timezone.utc) - timedelta(seconds=2),
        )

        with patch("app.trading.universe.urlopen") as mock_urlopen:
            response = mock_urlopen.return_value.__enter__.return_value
            response.read.return_value = json.dumps([]).encode()
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "degraded")
            self.assertEqual(
                resolution.reason,
                "jangar_payload_empty_using_stale_cache",
            )
            self.assertEqual(resolution.symbols, {"MSFT"})

    def test_jangar_empty_payload_rejects_expired_cache(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_max_stale_seconds = 5
        config.settings.trading_universe_cache_seconds = 1
        resolver = UniverseResolver()
        resolver._cache = UniverseCache(
            symbols={"MSFT"},
            fetched_at=datetime.now(timezone.utc) - timedelta(seconds=60),
        )

        with patch("app.trading.universe.urlopen") as mock_urlopen:
            response = mock_urlopen.return_value.__enter__.return_value
            response.read.return_value = json.dumps([]).encode()
            resolution = resolver.get_resolution()
            self.assertEqual(resolution.status, "error")
            self.assertEqual(resolution.reason, "jangar_payload_empty_cache_stale")
            self.assertEqual(resolution.symbols, set())

    def test_jangar_resolution_reason_transitions_from_ok_to_degraded_and_stale(self) -> None:
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_jangar_symbols_url = "http://example"
        config.settings.trading_universe_cache_seconds = 1
        config.settings.trading_universe_max_stale_seconds = 20

        resolver = UniverseResolver()
        with patch("app.trading.universe.urlopen") as mock_urlopen:
            response = mock_urlopen.return_value.__enter__.return_value
            response.read.return_value = json.dumps(["MSFT"]).encode()
            first_resolution = resolver.get_resolution()
            self.assertEqual(first_resolution.status, "ok")
            self.assertEqual(first_resolution.reason, "jangar_fetch_ok")

        resolver._cache = UniverseCache(
            symbols={"MSFT"},
            fetched_at=datetime.now(timezone.utc) - timedelta(seconds=10),
        )
        with patch("app.trading.universe.urlopen", side_effect=RuntimeError("boom")):
            degraded_resolution = resolver.get_resolution()
            self.assertEqual(degraded_resolution.status, "degraded")
            self.assertEqual(
                degraded_resolution.reason,
                "jangar_fetch_failed_using_stale_cache",
            )
            self.assertEqual(degraded_resolution.symbols, {"MSFT"})

    def test_static_universe_filters_crypto_when_disabled(self) -> None:
        config.settings.trading_universe_source = "static"
        config.settings.trading_crypto_enabled = False
        config.settings.trading_static_symbols_raw = "AAPL,BTC/USD,ETH/USD,MSFT"
        resolver = UniverseResolver()
        self.assertEqual(resolver.get_symbols(), {"AAPL", "MSFT"})

    def test_static_universe_allows_crypto_when_enabled(self) -> None:
        config.settings.trading_universe_source = "static"
        config.settings.trading_crypto_enabled = True
        config.settings.trading_static_symbols_raw = "AAPL,BTC/USD,ETH/USD,MSFT"
        resolver = UniverseResolver()
        self.assertEqual(resolver.get_symbols(), {"AAPL", "BTC/USD", "ETH/USD", "MSFT"})

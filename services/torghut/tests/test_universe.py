from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.universe import UniverseResolver


class TestUniverseResolver(TestCase):
    def setUp(self) -> None:
        self._original_source = config.settings.trading_universe_source
        self._original_symbols = config.settings.trading_static_symbols_raw
        self._original_url = config.settings.trading_jangar_symbols_url

    def tearDown(self) -> None:
        config.settings.trading_universe_source = self._original_source
        config.settings.trading_static_symbols_raw = self._original_symbols
        config.settings.trading_jangar_symbols_url = self._original_url

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

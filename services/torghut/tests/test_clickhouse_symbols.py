from unittest import TestCase

from app.trading.clickhouse import normalize_symbol


class TestClickHouseSymbols(TestCase):
    def test_accepts_crypto_slash_pairs(self) -> None:
        self.assertEqual(normalize_symbol("BTC/USD"), "BTC/USD")
        self.assertEqual(normalize_symbol(" ETH/USD "), "ETH/USD")
        self.assertEqual(normalize_symbol("SOL/USD"), "SOL/USD")

    def test_rejects_invalid_or_non_string_symbols(self) -> None:
        self.assertIsNone(normalize_symbol("BTC USD"))
        self.assertIsNone(normalize_symbol(""))
        self.assertIsNone(normalize_symbol(None))

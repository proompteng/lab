from __future__ import annotations

from typing import Any, cast
from unittest import TestCase

from scripts.verify_alpaca_broker import _load_reference_price


class _BarsClient:
    def __init__(self, payload: dict[str, list[dict[str, Any]]]) -> None:
        self.payload = payload

    def get_bars(
        self,
        *,
        symbols: list[str],
        timeframe: str,
        lookback_bars: int,
    ) -> dict[str, list[dict[str, Any]]]:
        return self.payload


class _FailingBarsClient:
    def get_bars(
        self,
        *,
        symbols: list[str],
        timeframe: str,
        lookback_bars: int,
    ) -> dict[str, list[dict[str, Any]]]:
        raise RuntimeError("market data unavailable")


class TestVerifyAlpacaBroker(TestCase):
    def test_load_reference_price_uses_latest_alpaca_bar_close(self) -> None:
        lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"close": "123.45"}]})),
            "NVDA",
        )

        self.assertEqual(lookup.reference_price, 123.45)
        self.assertEqual(lookup.source, "alpaca_bars")
        self.assertIsNone(lookup.error)

    def test_load_reference_price_falls_back_when_market_data_fails(self) -> None:
        lookup = _load_reference_price(cast(Any, _FailingBarsClient()), "NVDA")

        self.assertEqual(lookup.reference_price, 1.0)
        self.assertEqual(lookup.source, "fallback_default")
        self.assertIn("RuntimeError:market data unavailable", lookup.error or "")

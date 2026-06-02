#!/usr/bin/env python3
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

import protective_preflight


class AlpacaBaseUrlTest(unittest.TestCase):
    def test_normalizes_provider_v2_base_url(self) -> None:
        self.assertEqual(
            protective_preflight.normalize_alpaca_base_url("https://paper-api.alpaca.markets/v2"),
            "https://paper-api.alpaca.markets",
        )

    def test_normalizes_v2_base_url_with_trailing_slash(self) -> None:
        self.assertEqual(
            protective_preflight.normalize_alpaca_base_url("https://paper-api.alpaca.markets/v2/"),
            "https://paper-api.alpaca.markets",
        )

    def test_alpaca_client_uses_normalized_env_base_url(self) -> None:
        with patch.dict(
            os.environ,
            {
                "APCA_API_BASE_URL": "https://paper-api.alpaca.markets/v2",
                "APCA_API_KEY_ID": "key",
                "APCA_API_SECRET_KEY": "secret",
            },
            clear=True,
        ):
            client = protective_preflight.AlpacaClient()

        self.assertEqual(client.base_url, "https://paper-api.alpaca.markets")


class SmokeExposureReadbackTest(unittest.TestCase):
    def test_waits_for_stale_open_order_readback_to_clear(self) -> None:
        payload = {
            "symbol": "SPY",
            "client_order_id": "smoke-1",
        }
        broker_order = {
            "id": "parent-1",
            "client_order_id": "smoke-1",
            "legs": [
                {"id": "take-profit-1", "client_order_id": "take-profit-1"},
                {"id": "stop-loss-1", "client_order_id": "stop-loss-1"},
            ],
        }

        class FakeAlpaca:
            def __init__(self) -> None:
                self.open_order_reads = 0

            def list_open_orders(self, symbol: str) -> list[dict[str, object]]:
                self.open_order_reads += 1
                if self.open_order_reads == 1:
                    return [broker_order]
                return []

            def get_open_position(self, symbol: str) -> None:
                return None

        fake_alpaca = FakeAlpaca()

        open_orders, smoke_open_orders, position = protective_preflight.wait_for_smoke_exposure_clear(
            fake_alpaca,  # type: ignore[arg-type]
            payload,
            broker_order,
            timeout_seconds=0.1,
            poll_seconds=0,
        )

        self.assertEqual(open_orders, [])
        self.assertEqual(smoke_open_orders, [])
        self.assertIsNone(position)
        self.assertEqual(fake_alpaca.open_order_reads, 2)


if __name__ == "__main__":
    unittest.main()

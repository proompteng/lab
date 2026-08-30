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


class EntryGateTest(unittest.TestCase):
    def test_skips_submitted_smoke_when_account_is_entry_ineligible(self) -> None:
        class FakeAlpaca:
            def __init__(self, *, base_url: str | None, timeout_seconds: float) -> None:
                self.base_url = base_url
                self.timeout_seconds = timeout_seconds
                self.calls: list[tuple[str, str]] = []

            def get(self, path: str) -> dict[str, object]:
                self.calls.append(("GET", path))
                if path == "/v2/account":
                    return {
                        "id": "paper-account",
                        "equity": "29989.14",
                        "cash": "29989.14",
                        "buying_power": "59978.28",
                        "daytrading_buying_power": "0",
                        "daytrade_count": 5,
                    }
                raise AssertionError(f"unexpected GET {path}")

            def patch(self, path: str, payload: dict[str, object]) -> dict[str, object]:
                raise AssertionError(f"unexpected PATCH {path}")

            def post(self, path: str, payload: dict[str, object]) -> dict[str, object]:
                raise AssertionError(f"unexpected POST {path}")

            def delete(self, path: str) -> dict[str, object]:
                raise AssertionError(f"unexpected DELETE {path}")

        fake_alpaca = FakeAlpaca(base_url=None, timeout_seconds=10.0)
        args = protective_preflight.build_parser().parse_args(
            [
                "--submit-smoke",
                "--client-order-id",
                "autonomous-trader-test-protective-preflight-0001",
            ]
        )

        with patch.object(protective_preflight, "AlpacaClient", lambda **kwargs: fake_alpaca):
            report = protective_preflight.run_preflight(args)

        self.assertTrue(report["ok"])
        self.assertEqual(report["mode"], "entry_ineligible_smoke_skipped")
        self.assertFalse(report["submitted"])
        self.assertEqual(report["skipReason"], "entry_ineligible_for_intraday_equity_smoke")
        self.assertEqual(
            report["entryBlockers"],
            [
                "daytrading_buying_power_not_positive",
                "pdt_daytrade_count_at_or_above_four_without_dtbp",
            ],
        )
        self.assertEqual(fake_alpaca.calls, [("GET", "/v2/account")])

    def test_skips_submitted_smoke_when_account_read_shape_is_invalid(self) -> None:
        class FakeAlpaca:
            def get(self, path: str) -> list[object]:
                if path == "/v2/account":
                    return []
                raise AssertionError(f"unexpected GET {path}")

        args = protective_preflight.build_parser().parse_args(["--submit-smoke"])

        with patch.object(protective_preflight, "AlpacaClient", lambda **kwargs: FakeAlpaca()):
            report = protective_preflight.run_preflight(args)

        self.assertTrue(report["ok"])
        self.assertEqual(report["mode"], "entry_ineligible_smoke_skipped")
        self.assertEqual(report["entryBlockers"], ["account_read_invalid"])


if __name__ == "__main__":
    unittest.main()

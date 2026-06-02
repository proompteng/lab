#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import live_scan_cycle


class LiveScanCycleTest(unittest.TestCase):
    def test_normalizes_watchlist(self) -> None:
        self.assertEqual(live_scan_cycle.normalize_watchlist([" spy ", "SPY", "nvda"]), ["SPY", "NVDA"])

    def test_picks_next_cycle_number(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cycle-1").mkdir()
            (root / "cycle-3").mkdir()
            (root / "cycle-other").mkdir()

            self.assertEqual(live_scan_cycle.next_cycle_number(root), 4)

    def test_normalizes_alpaca_data_base_url(self) -> None:
        self.assertEqual(
            live_scan_cycle.normalize_alpaca_data_base_url("https://data.alpaca.markets"),
            "https://data.alpaca.markets/v2",
        )
        self.assertEqual(
            live_scan_cycle.normalize_alpaca_data_base_url("https://data.alpaca.markets/v2/"),
            "https://data.alpaca.markets/v2",
        )

    def test_formats_latest_quotes_for_scanner(self) -> None:
        payload = {
            "quotes": {
                "SPY": {"bp": 100.1, "ap": 100.2},
                "NVDA": {"bid": 200.1, "ask": 200.3},
            }
        }

        self.assertEqual(
            live_scan_cycle.format_latest_quotes(payload, ["SPY", "NVDA", "QQQ"]),
            {
                "quotes": {
                    "SPY": {"symbol": "SPY", "bid": 100.1, "ask": 100.2},
                    "NVDA": {"symbol": "NVDA", "bid": 200.1, "ask": 200.3},
                    "QQQ": {"symbol": "QQQ", "bid": None, "ask": None},
                }
            },
        )

    def test_market_open_start_uses_new_york_timezone(self) -> None:
        self.assertEqual(
            live_scan_cycle.market_open_start(datetime(2026, 6, 2, 13, 45, tzinfo=UTC)),
            "2026-06-02T13:30:00Z",
        )
        self.assertEqual(
            live_scan_cycle.market_open_start(datetime(2026, 1, 5, 15, 0, tzinfo=UTC)),
            "2026-01-05T14:30:00Z",
        )

    def test_summarizes_scan_without_runtime_ledger(self) -> None:
        summary = live_scan_cycle.summarize_scan(
            2,
            Path("/tmp/autonomous-trader-work/cycle-2"),
            {
                "results": [
                    {
                        "symbol": "NVDA",
                        "bars": 10,
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "A",
                        "fat_pitch": False,
                        "expected_r": 2.0,
                        "no_trade_reason": None,
                        "last": 123.45,
                        "vwap": 122.0,
                        "spread_pct": 0.02,
                        "liquidity_score": 2.0,
                        "momentum_score": 3.0,
                        "risk_notes": ["limited_bar_history"],
                    }
                ]
            },
            ["NVDA"],
        )

        self.assertEqual(summary["cycle"], 2)
        self.assertEqual(summary["resultCount"], 1)
        self.assertEqual(summary["topResults"][0]["symbol"], "NVDA")

    def test_run_cycle_returns_summary_without_summary_file(self) -> None:
        case = self

        class FakeAlpaca:
            def __init__(self, *, timeout_seconds: float) -> None:
                self.timeout_seconds = timeout_seconds

            def trading_get(self, path: str, query: dict[str, str] | None = None) -> object:
                if path == "/v2/account":
                    return {
                        "id": "paper-account",
                        "equity": "30000",
                        "cash": "30000",
                        "buying_power": "60000",
                    }
                if path == "/v2/positions":
                    return []
                if path == "/v2/orders":
                    case.assertEqual(query, {"status": "open", "nested": "true"})
                    return []
                raise AssertionError(f"unexpected trading path {path}")

            def data_get(self, path: str, query: dict[str, str]) -> object:
                case.assertIn(path, {"/stocks/bars", "/stocks/quotes/latest"})
                if path.endswith("quotes/latest"):
                    return {"quotes": {"NVDA": {"bp": 100.0, "ap": 100.1}}}
                return {"bars": {}}

        class FakeSynthesis:
            def __init__(self, *, base_url: str | None, timeout_seconds: float) -> None:
                self.base_url = base_url
                self.timeout_seconds = timeout_seconds

            def get(self, path: str, query: dict[str, str]) -> object:
                case.assertEqual(path, "/api/autotrader/scorecards")
                case.assertEqual(query, {"limit": "20"})
                return {"scorecards": []}

        def fake_scan(**kwargs: object) -> dict[str, object]:
            return {"results": [{"symbol": "NVDA", "bars": 9, "no_trade_reason": "limited_live_bars"}]}

        with tempfile.TemporaryDirectory() as directory:
            args = live_scan_cycle.build_parser().parse_args(["--work-dir", directory, "--watchlist", "NVDA"])
            with (
                patch.object(live_scan_cycle, "AlpacaRestClient", FakeAlpaca),
                patch.object(live_scan_cycle, "SynthesisClient", FakeSynthesis),
                patch.object(live_scan_cycle, "run_stock_analysis_scan", fake_scan),
            ):
                summary = live_scan_cycle.run_cycle(args)

            cycle_dir = Path(directory) / "cycle-1"
            self.assertEqual(summary["cycle"], 1)
            self.assertEqual(summary["resultCount"], 1)
            self.assertTrue((cycle_dir / "account.json").exists())
            self.assertTrue((cycle_dir / "watchlist.json").exists())
            self.assertFalse((cycle_dir / "summary.json").exists())


if __name__ == "__main__":
    unittest.main()

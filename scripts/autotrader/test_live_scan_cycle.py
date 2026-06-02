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

    def test_prunes_old_cycle_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for cycle in range(1, 7):
                cycle_dir = root / f"cycle-{cycle}"
                cycle_dir.mkdir()
                (cycle_dir / "scratch.json").write_text("{}\n", encoding="utf-8")
            (root / "cycle-other").mkdir()

            self.assertEqual(live_scan_cycle.prune_old_cycle_dirs(root, 3), ["cycle-1", "cycle-2", "cycle-3"])
            self.assertFalse((root / "cycle-1").exists())
            self.assertTrue((root / "cycle-4").exists())
            self.assertTrue((root / "cycle-other").exists())

    def test_does_not_prune_when_retention_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cycle-1").mkdir()

            self.assertEqual(live_scan_cycle.prune_old_cycle_dirs(root, 0), [])
            self.assertTrue((root / "cycle-1").exists())

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

    def test_stock_analysis_cli_defaults_to_work_dir(self) -> None:
        with patch.dict("os.environ", {"AUTONOMOUS_TRADER_WORK_DIR": "/tmp/trader-work"}, clear=False):
            self.assertEqual(live_scan_cycle.stock_analysis_cli_path(None), "/tmp/trader-work/stock_analysis")

    def test_formats_intraday_entry_gate_for_zero_dtbp(self) -> None:
        self.assertEqual(
            live_scan_cycle.format_account(
                {
                    "id": "paper-account",
                    "equity": "29989.14",
                    "cash": "29989.14",
                    "buying_power": "59978.28",
                    "daytrading_buying_power": "0",
                    "daytrade_count": 5,
                    "pattern_day_trader": "true",
                    "trading_blocked": "false",
                    "account_blocked": False,
                }
            ),
            {
                "account": {
                    "id": "paper-account",
                    "equity": "29989.14",
                    "cash": "29989.14",
                    "buying_power": "59978.28",
                    "daytrading_buying_power": "0",
                    "daytrade_count": 5,
                    "pattern_day_trader": True,
                    "trading_blocked": False,
                    "account_blocked": False,
                    "intraday_equity_entry": {
                        "status": "blocked",
                        "reasons": [
                            "daytrading_buying_power_not_positive",
                            "pdt_daytrade_count_at_or_above_four_without_dtbp",
                        ],
                    },
                }
            },
        )

    def test_summarizes_account_gate_as_monitor_only_when_entry_blocked_and_flat(self) -> None:
        summary = live_scan_cycle.summarize_account_gate(
            raw_account={
                "id": "paper-account",
                "equity": "29989.14",
                "buying_power": "59978.28",
                "daytrading_buying_power": "0",
                "daytrade_count": 5,
            },
            raw_positions=[],
            raw_orders=[],
        )

        self.assertEqual(summary["mode"], "account_gate")
        self.assertEqual(summary["action"], "monitor_only")
        self.assertTrue(summary["skipFullScan"])
        self.assertFalse(summary["hasOpenBrokerState"])
        self.assertEqual(summary["openPositionCount"], 0)
        self.assertEqual(summary["openOrderCount"], 0)
        self.assertEqual(summary["account"]["intraday_equity_entry"]["status"], "blocked")

    def test_summarizes_account_gate_as_manage_state_when_entry_blocked_with_position(self) -> None:
        summary = live_scan_cycle.summarize_account_gate(
            raw_account={
                "id": "paper-account",
                "equity": "29989.14",
                "buying_power": "59978.28",
                "daytrading_buying_power": "0",
                "daytrade_count": 5,
            },
            raw_positions=[{"symbol": "AAPL", "qty": "1"}],
            raw_orders=[],
        )

        self.assertEqual(summary["action"], "manage_existing_broker_state")
        self.assertFalse(summary["skipFullScan"])
        self.assertTrue(summary["hasOpenBrokerState"])
        self.assertEqual(summary["openPositionCount"], 1)

    def test_run_account_gate_fetches_only_broker_state(self) -> None:
        case = self

        class FakeAlpaca:
            def __init__(self, *, timeout_seconds: float) -> None:
                self.timeout_seconds = timeout_seconds

            def trading_get(self, path: str, query: dict[str, str] | None = None) -> object:
                if path == "/v2/account":
                    return {
                        "id": "paper-account",
                        "equity": "30000",
                        "buying_power": "60000",
                        "daytrading_buying_power": "0",
                        "daytrade_count": "5",
                    }
                if path == "/v2/positions":
                    case.assertIsNone(query)
                    return []
                if path == "/v2/orders":
                    case.assertEqual(query, {"status": "open", "nested": "true"})
                    return []
                raise AssertionError(f"unexpected trading path {path}")

        args = live_scan_cycle.build_parser().parse_args(["--account-gate-only", "--timeout-seconds", "3"])
        with patch.object(live_scan_cycle, "AlpacaRestClient", FakeAlpaca):
            summary = live_scan_cycle.run_account_gate(args)

        self.assertEqual(summary["action"], "monitor_only")
        self.assertTrue(summary["skipFullScan"])

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
            retained_cycles=5,
            removed_cycle_dirs=[],
        )

        self.assertEqual(summary["cycle"], 2)
        self.assertEqual(summary["resultCount"], 1)
        self.assertEqual(summary["topResults"][0]["symbol"], "NVDA")
        self.assertEqual(summary["retainedCycles"], 5)
        self.assertEqual(summary["removedCycleDirs"], [])

    def test_builds_ticket_payload_from_scanner_candidate(self) -> None:
        payload = live_scan_cycle.ticket_payload_for_scan_result(
            session_id="session-1",
            cycle=3,
            index=1,
            result={
                "symbol": "nvda",
                "setup_type": "vwap_reclaim",
                "setup_grade": "A",
                "expected_r": "2.50",
                "last": "100.25",
                "fat_pitch": True,
                "regime": "trend_up",
                "instrument": "equity",
                "side": "long",
            },
        )

        assert payload is not None
        self.assertEqual(payload["sessionId"], "session-1")
        self.assertEqual(payload["idempotencyKey"], "scan-cycle-3-1-NVDA-vwap_reclaim-A")
        self.assertEqual(payload["symbol"], "NVDA")
        self.assertEqual(payload["instrument"], "stock")
        self.assertEqual(payload["side"], "buy")
        self.assertEqual(payload["setupType"], "vwap_reclaim")
        self.assertEqual(payload["setupGrade"], "A")
        self.assertEqual(payload["expectedR"], "2.50")
        self.assertEqual(payload["entryLimitPrice"], "100.25")
        self.assertEqual(payload["status"], "candidate")
        self.assertIsNone(payload["noTradeReason"])
        self.assertEqual(payload["protectionType"], "bracket_required")

    def test_builds_blocked_ticket_payload_from_scanner_no_trade(self) -> None:
        payload = live_scan_cycle.ticket_payload_for_scan_result(
            session_id="session-1",
            cycle=3,
            index=2,
            result={
                "symbol": "AMD",
                "setup_type": "opening_range_breakout",
                "setup_grade": "C",
                "expected_r": "0.61",
                "no_trade_reason": "C_setup_blocked;wide_spread",
            },
        )

        assert payload is not None
        self.assertEqual(payload["idempotencyKey"], "scan-cycle-3-2-AMD-opening_range_breakout-C")
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["noTradeReason"], "C_setup_blocked;wide_spread")
        self.assertEqual(payload["protectionType"], "none_no_order")
        self.assertEqual(payload["entryTrigger"], "blocked_by_scanner")
        self.assertEqual(payload["brokerOrderPlan"]["source"], "live_scan_cycle")

    def test_records_scan_tickets_to_synthesis_with_ticket_ids(self) -> None:
        class FakeSynthesis:
            def __init__(self) -> None:
                self.posts: list[tuple[str, dict[str, object]]] = []

            def post(self, path: str, payload: dict[str, object]) -> object:
                self.posts.append((path, payload))
                return {"ticket": {"id": f"ticket-{len(self.posts)}"}}

        synthesis = FakeSynthesis()
        recorded = live_scan_cycle.record_scan_tickets(
            synthesis=synthesis,  # type: ignore[arg-type]
            session_id="session-1",
            cycle=4,
            scan={
                "results": [
                    {"symbol": "AAPL", "setup_type": "vwap_reclaim", "setup_grade": "B", "expected_r": "1.2"},
                    {
                        "symbol": "AMD",
                        "setup_type": "no_trade",
                        "setup_grade": "C",
                        "no_trade_reason": "no_confirmed_setup",
                    },
                ]
            },
            limit=10,
        )

        self.assertEqual([path for path, _ in synthesis.posts], ["/api/autotrader/trade-tickets"] * 2)
        self.assertEqual(recorded[0]["ticketId"], "ticket-1")
        self.assertEqual(recorded[0]["status"], "candidate")
        self.assertEqual(recorded[1]["ticketId"], "ticket-2")
        self.assertEqual(recorded[1]["status"], "blocked")
        self.assertEqual(recorded[1]["noTradeReason"], "no_confirmed_setup")

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
                self.posts: list[tuple[str, dict[str, object]]] = []

            def get(self, path: str, query: dict[str, str]) -> object:
                case.assertEqual(path, "/api/autotrader/scorecards")
                case.assertEqual(query, {"limit": "20"})
                return {"scorecards": []}

            def post(self, path: str, payload: dict[str, object]) -> object:
                self.posts.append((path, payload))
                return {"ticket": {"id": "ticket-nvda"}}

        def fake_scan(**kwargs: object) -> dict[str, object]:
            return {
                "results": [
                    {
                        "symbol": "NVDA",
                        "bars": 9,
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "blocked",
                        "no_trade_reason": "limited_live_bars",
                    }
                ]
            }

        with tempfile.TemporaryDirectory() as directory:
            old_cycle = Path(directory) / "cycle-1"
            old_cycle.mkdir()
            args = live_scan_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    directory,
                    "--watchlist",
                    "NVDA",
                    "--retain-cycles",
                    "1",
                    "--session-id",
                    "session-1",
                    "--record-tickets",
                ]
            )
            with (
                patch.object(live_scan_cycle, "AlpacaRestClient", FakeAlpaca),
                patch.object(live_scan_cycle, "SynthesisClient", FakeSynthesis),
                patch.object(live_scan_cycle, "run_stock_analysis_scan", fake_scan),
            ):
                summary = live_scan_cycle.run_cycle(args)

            cycle_dir = Path(directory) / "cycle-2"
            self.assertEqual(summary["cycle"], 2)
            self.assertEqual(summary["resultCount"], 1)
            self.assertTrue((cycle_dir / "account.json").exists())
            self.assertTrue((cycle_dir / "watchlist.json").exists())
            self.assertFalse((cycle_dir / "summary.json").exists())
            self.assertFalse(old_cycle.exists())
            self.assertEqual(summary["removedCycleDirs"], ["cycle-1"])
            self.assertEqual(summary["recordedTickets"][0]["ticketId"], "ticket-nvda")
            self.assertEqual(summary["recordedTickets"][0]["status"], "blocked")


if __name__ == "__main__":
    unittest.main()

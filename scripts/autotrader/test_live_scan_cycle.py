#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import threading
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

    def test_fetch_broker_state_fetches_account_positions_and_orders_concurrently(self) -> None:
        case = self
        barrier = threading.Barrier(3)

        class FakeAlpaca:
            def trading_get(self, path: str, query: dict[str, str] | None = None) -> object:
                case.assertIn(path, {"/v2/account", "/v2/positions", "/v2/orders"})
                if path == "/v2/orders":
                    case.assertEqual(query, {"status": "open", "nested": "true"})
                else:
                    case.assertIsNone(query)
                barrier.wait(timeout=1)
                if path == "/v2/account":
                    return {"id": "paper-account", "equity": "30000"}
                if path == "/v2/positions":
                    return [{"symbol": "NVDA"}]
                return [{"id": "order-1"}]

        state, metrics = live_scan_cycle.fetch_broker_state_with_metrics(FakeAlpaca())  # type: ignore[arg-type]

        self.assertEqual(state["account"]["id"], "paper-account")
        self.assertEqual(state["positions"][0]["symbol"], "NVDA")
        self.assertEqual(state["orders"][0]["id"], "order-1")
        self.assertEqual(metrics["parallelFetchCount"], 3)
        self.assertGreaterEqual(metrics["totalMs"], 0)

    def test_fetch_scan_inputs_fetches_market_data_and_scorecards_concurrently(self) -> None:
        case = self
        barrier = threading.Barrier(3)

        class FakeAlpaca:
            def data_get(self, path: str, query: dict[str, str]) -> object:
                case.assertIn(path, {"/stocks/bars", "/stocks/quotes/latest"})
                barrier.wait(timeout=1)
                if path == "/stocks/bars":
                    return {"bars": {"NVDA": []}}
                return {"quotes": {"NVDA": {"bp": 100.0, "ap": 100.1}}}

        class FakeSynthesis:
            def get(self, path: str, query: dict[str, str]) -> object:
                case.assertEqual(path, "/api/autotrader/scorecards")
                case.assertEqual(query, {"limit": "20"})
                barrier.wait(timeout=1)
                return {"scorecards": [{"symbol": "NVDA", "sampleSize": 5}], "setupExamples": []}

        inputs, metrics = live_scan_cycle.fetch_scan_inputs_with_metrics(
            alpaca=FakeAlpaca(),  # type: ignore[arg-type]
            synthesis=FakeSynthesis(),  # type: ignore[arg-type]
            symbols=["NVDA"],
            start="2026-06-03T13:30:00Z",
            end="2026-06-03T14:00:00Z",
            feed="iex",
            scorecard_limit=20,
            broker_state={
                "account": {"id": "paper-account", "equity": "30000", "buying_power": "60000"},
                "positions": [],
                "orders": [],
            },
        )

        self.assertEqual(inputs["bars.json"], {"bars": {"NVDA": []}})
        self.assertEqual(inputs["quotes.json"]["quotes"]["NVDA"]["bid"], 100.0)
        self.assertEqual(inputs["scorecards.json"]["scorecards"][0]["symbol"], "NVDA")
        self.assertEqual(metrics["brokerStateSource"], "provided")
        self.assertEqual(metrics["brokerStateMs"], 0)
        self.assertEqual(metrics["parallelFetchCount"], 3)
        self.assertGreaterEqual(metrics["totalMs"], 0)

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
            raw_positions=[
                {
                    "symbol": "AAPL",
                    "qty": "1",
                    "market_value": "180.50",
                    "avg_entry_price": "179.00",
                    "unrealized_pl": "1.50",
                }
            ],
            raw_orders=[
                {
                    "id": "order-1",
                    "client_order_id": "agent-AAPL-protect",
                    "symbol": "AAPL",
                    "status": "new",
                }
            ],
        )

        self.assertEqual(summary["action"], "manage_existing_broker_state")
        self.assertTrue(summary["skipFullScan"])
        self.assertTrue(summary["hasOpenBrokerState"])
        self.assertEqual(summary["openPositionCount"], 1)
        self.assertEqual(summary["openOrderCount"], 1)
        self.assertEqual(
            summary["openPositions"][0],
            {
                "symbol": "AAPL",
                "assetClass": None,
                "side": None,
                "qty": "1",
                "marketValue": "180.50",
                "avgEntryPrice": "179.00",
                "currentPrice": None,
                "unrealizedPnl": "1.50",
            },
        )
        self.assertEqual(summary["openOrders"][0]["clientOrderId"], "agent-AAPL-protect")

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
        self.assertEqual(summary["stageTimingsMs"]["brokerState"]["parallelFetchCount"], 3)
        self.assertGreaterEqual(summary["stageTimingsMs"]["totalMs"], 0)

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
                        "scorecard_sample_size": 4,
                        "scorecard_avg_realized_r": 1.25,
                        "scorecard_confidence": 0.8,
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
        self.assertEqual(summary["topResults"][0]["scorecard_sample_size"], 4)
        self.assertEqual(summary["scorecardInfluence"]["scorecardInfluencedResultCount"], 1)
        self.assertEqual(summary["scorecardInfluence"]["topResults"][0]["scorecardAvgRealizedR"], "1.25")
        self.assertEqual(summary["retainedCycles"], 5)
        self.assertEqual(summary["removedCycleDirs"], [])

    def test_summarizes_scorecard_readback_payload(self) -> None:
        summary = live_scan_cycle.scorecard_readback_summary(
            {
                "scorecards": [
                    {
                        "key": "AMD|vwap_reclaim|A|trend|open",
                        "symbol": "amd",
                        "setupType": "vwap_reclaim",
                        "setupGrade": "A",
                        "regime": "trend",
                        "timeBucket": "open",
                        "sampleSize": 4,
                        "avgRealizedR": "1.25",
                        "confidence": "0.8",
                    },
                    {
                        "symbol": "NVDA",
                        "setup_type": "opening_range_breakout",
                        "setup_grade": "B",
                        "sample_size": "2",
                        "avg_realized_r": "-0.25",
                        "confidence": "0.5",
                    },
                ],
                "setupExamples": [{}, {}, {}],
            }
        )

        self.assertEqual(summary["stage"], "before_stock_analysis_scan")
        self.assertEqual(summary["scorecardCount"], 2)
        self.assertEqual(summary["setupExampleCount"], 3)
        self.assertEqual(summary["totalSampleSize"], 6)
        self.assertEqual(summary["nonzeroSampleScorecardCount"], 2)
        self.assertEqual(summary["positiveAvgRScorecardCount"], 1)
        self.assertEqual(summary["negativeAvgRScorecardCount"], 1)
        self.assertEqual(summary["symbols"], ["AMD", "NVDA"])
        self.assertEqual(summary["topScorecards"][0]["avgRealizedR"], "1.25")
        self.assertEqual(len(summary["payloadHash"]), 64)

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

    def test_decision_summary_selects_best_actionable_candidate_with_ticket(self) -> None:
        summary = live_scan_cycle.decision_summary_for_scan(
            cycle=3,
            scan={
                "results": [
                    {
                        "symbol": "AMD",
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "B",
                        "expected_r": "2.5",
                        "scorecard_sample_size": 2,
                    },
                    {
                        "symbol": "NVDA",
                        "setup_type": "opening_range_breakout",
                        "setup_grade": "A",
                        "expected_r": "2.6",
                        "scorecard_sample_size": 7,
                        "scorecard_avg_realized_r": "0.9",
                        "scorecard_confidence": "0.75",
                    },
                    {
                        "symbol": "QQQ",
                        "setup_type": "no_trade",
                        "setup_grade": "C",
                        "no_trade_reason": "wide_spread",
                    },
                ]
            },
            recorded_tickets=[
                {
                    "idempotencyKey": "scan-cycle-3-2-NVDA-opening_range_breakout-A",
                    "ticketId": "ticket-nvda",
                }
            ],
        )

        self.assertEqual(summary["action"], "run_strategy_order_guard")
        self.assertEqual(summary["actionableCandidateCount"], 2)
        self.assertEqual(summary["blockedResultCount"], 1)
        self.assertEqual(summary["bestCandidate"]["symbol"], "NVDA")
        self.assertEqual(summary["bestCandidate"]["side"], "buy")
        self.assertEqual(summary["bestCandidate"]["ticketId"], "ticket-nvda")
        self.assertEqual(summary["bestCandidate"]["scorecardSampleSize"], 7)
        self.assertEqual(summary["candidateSymbols"], ["NVDA", "AMD"])

    def test_decision_summary_prefers_edge_over_grade_after_threshold(self) -> None:
        summary = live_scan_cycle.decision_summary_for_scan(
            cycle=8,
            scan={
                "results": [
                    {
                        "symbol": "AVGO",
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "A+",
                        "expected_r": "2.1",
                    },
                    {
                        "symbol": "AMD",
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "A",
                        "expected_r": "4.0",
                    },
                ]
            },
            recorded_tickets=[
                {
                    "idempotencyKey": "scan-cycle-8-1-AVGO-vwap_reclaim-A+",
                    "ticketId": "ticket-avgo",
                },
                {
                    "idempotencyKey": "scan-cycle-8-2-AMD-vwap_reclaim-A",
                    "ticketId": "ticket-amd",
                },
            ],
        )

        self.assertEqual(summary["action"], "run_strategy_order_guard")
        self.assertEqual(summary["bestCandidate"]["symbol"], "AMD")
        self.assertEqual(summary["bestCandidate"]["expectedR"], "4.0")
        self.assertEqual(summary["bestCandidate"]["ticketId"], "ticket-amd")
        self.assertEqual(summary["candidateSymbols"], ["AMD", "AVGO"])

    def test_decision_summary_blocks_sub_two_r_candidates(self) -> None:
        result = {
            "symbol": "GOOGL",
            "setup_type": "vwap_reclaim",
            "setup_grade": "B",
            "expected_r": "1.786",
            "last": "364.10",
        }
        payload = live_scan_cycle.ticket_payload_for_scan_result(
            session_id="session-1",
            cycle=7,
            index=1,
            result=result,
        )
        summary = live_scan_cycle.decision_summary_for_scan(
            cycle=7,
            scan={"results": [result]},
            recorded_tickets=[
                {
                    "idempotencyKey": "scan-cycle-7-1-GOOGL-vwap_reclaim-B",
                    "ticketId": "ticket-googl",
                }
            ],
        )

        assert payload is not None
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["noTradeReason"], "expected_r_below_threshold")
        self.assertEqual(summary["action"], "no_actionable_candidate")
        self.assertEqual(summary["actionableCandidateCount"], 0)
        self.assertEqual(summary["blockedResultCount"], 1)
        self.assertIsNone(summary["bestCandidate"])

    def test_decision_summary_reports_no_actionable_candidate(self) -> None:
        summary = live_scan_cycle.decision_summary_for_scan(
            cycle=5,
            scan={
                "results": [
                    {
                        "symbol": "QQQ",
                        "setup_type": "no_trade",
                        "setup_grade": "C",
                        "no_trade_reason": "wide_spread",
                    }
                ]
            },
            recorded_tickets=[],
        )

        self.assertEqual(summary["action"], "no_actionable_candidate")
        self.assertEqual(summary["actionableCandidateCount"], 0)
        self.assertEqual(summary["blockedResultCount"], 1)
        self.assertIsNone(summary["bestCandidate"])

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
                    {
                        "symbol": "AAPL",
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "B",
                        "expected_r": "1.2",
                        "scorecard_sample_size": 3,
                        "scorecard_avg_realized_r": "0.75",
                        "scorecard_confidence": "0.6",
                    },
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
        self.assertEqual(recorded[0]["status"], "blocked")
        self.assertEqual(recorded[0]["noTradeReason"], "expected_r_below_threshold")
        self.assertEqual(recorded[0]["scorecardSampleSize"], 3)
        self.assertEqual(recorded[0]["scorecardAvgRealizedR"], "0.75")
        self.assertEqual(recorded[0]["scorecardConfidence"], "0.6")
        self.assertEqual(recorded[1]["ticketId"], "ticket-2")
        self.assertEqual(recorded[1]["status"], "blocked")
        self.assertEqual(recorded[1]["noTradeReason"], "no_confirmed_setup")

    def test_records_account_gate_to_synthesis(self) -> None:
        class FakeSynthesis:
            def __init__(self) -> None:
                self.posts: list[tuple[str, dict[str, object]]] = []

            def post(self, path: str, payload: dict[str, object]) -> object:
                self.posts.append((path, payload))
                if path.endswith("/risk-checks"):
                    return {"riskCheck": {"id": "risk-1"}}
                if path.endswith("/status"):
                    return {"status": {"sessionId": "session-1"}}
                raise AssertionError(f"unexpected Synthesis path {path}")

        gate = live_scan_cycle.summarize_account_gate(
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
        synthesis = FakeSynthesis()

        recorded = live_scan_cycle.record_account_gate(
            synthesis=synthesis,  # type: ignore[arg-type]
            session_id="session-1",
            cycle=7,
            gate=gate,
        )

        self.assertEqual(recorded["riskCheckId"], "risk-1")
        self.assertEqual(
            recorded["blocker"],
            "daytrading_buying_power_not_positive;pdt_daytrade_count_at_or_above_four_without_dtbp",
        )
        self.assertEqual([path for path, _ in synthesis.posts], ["/api/autotrader/risk-checks", "/api/autotrader/status"])
        risk_payload = synthesis.posts[0][1]
        status_payload = synthesis.posts[1][1]
        self.assertEqual(risk_payload["idempotencyKey"], "account-gate-cycle-7")
        self.assertFalse(risk_payload["passed"])
        self.assertEqual(status_payload["phase"], "idle")
        self.assertEqual(status_payload["currentAction"], "account gate blocked new entries; monitoring only")
        self.assertEqual(status_payload["equity"], "29989.14")
        self.assertEqual(status_payload["daytradeBuyingPower"], "0")

    def test_run_cycle_respects_account_gate_and_skips_scan_when_monitor_only(self) -> None:
        case = self

        class FakeAlpaca:
            def __init__(self, *, timeout_seconds: float) -> None:
                self.timeout_seconds = timeout_seconds

            def trading_get(self, path: str, query: dict[str, str] | None = None) -> object:
                if path == "/v2/account":
                    return {
                        "id": "paper-account",
                        "equity": "29989.14",
                        "buying_power": "59978.28",
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

            def data_get(self, path: str, query: dict[str, str]) -> object:
                raise AssertionError(f"scanner data fetch should be skipped: {path} {query}")

        class FakeSynthesis:
            def __init__(self, *, base_url: str | None, timeout_seconds: float) -> None:
                self.base_url = base_url
                self.timeout_seconds = timeout_seconds
                self.posts: list[tuple[str, dict[str, object]]] = []

            def get(self, path: str, query: dict[str, str]) -> object:
                raise AssertionError(f"scorecard fetch should be skipped: {path} {query}")

            def post(self, path: str, payload: dict[str, object]) -> object:
                self.posts.append((path, payload))
                if path.endswith("/risk-checks"):
                    return {"riskCheck": {"id": "risk-1"}}
                if path.endswith("/status"):
                    return {"status": {"sessionId": "session-1"}}
                raise AssertionError(f"unexpected Synthesis path {path}")

        with tempfile.TemporaryDirectory() as directory:
            args = live_scan_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    directory,
                    "--watchlist",
                    "NVDA",
                    "--session-id",
                    "session-1",
                    "--record-tickets",
                    "--respect-account-gate",
                ]
            )
            with (
                patch.object(live_scan_cycle, "AlpacaRestClient", FakeAlpaca),
                patch.object(live_scan_cycle, "SynthesisClient", FakeSynthesis),
                patch.object(
                    live_scan_cycle,
                    "run_stock_analysis_scan",
                    lambda **_: (_ for _ in ()).throw(AssertionError("scanner should be skipped")),
                ),
            ):
                summary = live_scan_cycle.run_cycle(args)

            self.assertEqual(summary["mode"], "cycle")
            self.assertEqual(summary["action"], "monitor_only")
            self.assertTrue(summary["skipFullScan"])
            self.assertEqual(summary["resultCount"], 0)
            self.assertEqual(summary["recordedTickets"], [])
            self.assertEqual(summary["recordedAccountGate"]["riskCheckId"], "risk-1")
            self.assertEqual(summary["stageTimingsMs"]["brokerState"]["parallelFetchCount"], 3)
            self.assertTrue((Path(directory) / "cycle-1").exists())

    def test_run_cycle_respects_account_gate_and_skips_scan_when_managing_existing_state(self) -> None:
        case = self

        class FakeAlpaca:
            def __init__(self, *, timeout_seconds: float) -> None:
                self.timeout_seconds = timeout_seconds

            def trading_get(self, path: str, query: dict[str, str] | None = None) -> object:
                if path == "/v2/account":
                    return {
                        "id": "paper-account",
                        "equity": "29989.14",
                        "buying_power": "59978.28",
                        "daytrading_buying_power": "0",
                        "daytrade_count": "5",
                    }
                if path == "/v2/positions":
                    case.assertIsNone(query)
                    return [{"symbol": "NVDA", "qty": "2", "market_value": "240.00"}]
                if path == "/v2/orders":
                    case.assertEqual(query, {"status": "open", "nested": "true"})
                    return [{"id": "order-1", "client_order_id": "agent-NVDA-protect", "symbol": "NVDA"}]
                raise AssertionError(f"unexpected trading path {path}")

            def data_get(self, path: str, query: dict[str, str]) -> object:
                raise AssertionError(f"scanner data fetch should be skipped: {path} {query}")

        class FakeSynthesis:
            def __init__(self, *, base_url: str | None, timeout_seconds: float) -> None:
                self.base_url = base_url
                self.timeout_seconds = timeout_seconds
                self.posts: list[tuple[str, dict[str, object]]] = []

            def get(self, path: str, query: dict[str, str]) -> object:
                raise AssertionError(f"scorecard fetch should be skipped: {path} {query}")

            def post(self, path: str, payload: dict[str, object]) -> object:
                self.posts.append((path, payload))
                if path.endswith("/risk-checks"):
                    return {"riskCheck": {"id": "risk-1"}}
                if path.endswith("/status"):
                    return {"status": {"sessionId": "session-1"}}
                raise AssertionError(f"unexpected Synthesis path {path}")

        with tempfile.TemporaryDirectory() as directory:
            args = live_scan_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    directory,
                    "--watchlist",
                    "NVDA",
                    "--session-id",
                    "session-1",
                    "--record-tickets",
                    "--respect-account-gate",
                ]
            )
            with (
                patch.object(live_scan_cycle, "AlpacaRestClient", FakeAlpaca),
                patch.object(live_scan_cycle, "SynthesisClient", FakeSynthesis),
                patch.object(
                    live_scan_cycle,
                    "run_stock_analysis_scan",
                    lambda **_: (_ for _ in ()).throw(AssertionError("scanner should be skipped")),
                ),
            ):
                summary = live_scan_cycle.run_cycle(args)

            self.assertEqual(summary["action"], "manage_existing_broker_state")
            self.assertTrue(summary["skipFullScan"])
            self.assertEqual(summary["resultCount"], 0)
            self.assertEqual(summary["recordedTickets"], [])
            self.assertEqual(summary["accountGate"]["openPositions"][0]["symbol"], "NVDA")
            self.assertEqual(summary["accountGate"]["openOrders"][0]["clientOrderId"], "agent-NVDA-protect")
            self.assertEqual(summary["stageTimingsMs"]["brokerState"]["parallelFetchCount"], 3)

    def test_run_cycle_returns_summary_without_summary_file(self) -> None:
        case = self
        posts: list[tuple[str, dict[str, object]]] = []

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
                return {
                    "scorecards": [
                        {
                            "key": "NVDA|vwap_reclaim|A|intraday_live_scan|market_session",
                            "symbol": "NVDA",
                            "setupType": "vwap_reclaim",
                            "setupGrade": "A",
                            "regime": "intraday_live_scan",
                            "timeBucket": "market_session",
                            "sampleSize": 5,
                            "avgRealizedR": "1.40",
                            "confidence": "0.9",
                        }
                    ],
                    "setupExamples": [{"id": "example-1"}],
                }

            def post(self, path: str, payload: dict[str, object]) -> object:
                posts.append((path, payload))
                if path.endswith("/risk-checks"):
                    return {"riskCheck": {"id": "risk-scorecard"}}
                return {"ticket": {"id": "ticket-nvda"}}

        def fake_scan(**kwargs: object) -> dict[str, object]:
            case.assertEqual(posts[0][0], "/api/autotrader/risk-checks")
            case.assertEqual(posts[0][1]["checkType"], "scorecard_readback_before_scan")
            return {
                "results": [
                    {
                        "symbol": "NVDA",
                        "bars": 9,
                        "setup_type": "vwap_reclaim",
                        "setup_grade": "blocked",
                        "no_trade_reason": "limited_live_bars",
                        "scorecard_sample_size": 5,
                        "scorecard_avg_realized_r": 1.4,
                        "scorecard_confidence": 0.9,
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
            self.assertEqual(summary["scorecardReadback"]["scorecardCount"], 1)
            self.assertEqual(summary["scorecardReadback"]["setupExampleCount"], 1)
            self.assertEqual(summary["recordedScorecardReadback"]["riskCheckId"], "risk-scorecard")
            self.assertTrue(summary["recordedScorecardReadback"]["passed"])
            self.assertEqual(summary["scorecardInfluence"]["scorecardInfluencedResultCount"], 1)
            self.assertEqual(summary["decisionSummary"]["action"], "no_actionable_candidate")
            self.assertGreaterEqual(summary["stageTimingsMs"]["totalMs"], 0)
            self.assertEqual(summary["stageTimingsMs"]["inputFetch"]["parallelFetchCount"], 3)
            self.assertEqual(summary["stageTimingsMs"]["inputFetch"]["brokerStateSource"], "fetched")
            self.assertEqual(summary["stageTimingsMs"]["inputFetch"]["brokerState"]["parallelFetchCount"], 3)
            self.assertGreaterEqual(summary["stageTimingsMs"]["stockAnalysisScanMs"], 0)
            self.assertEqual(summary["recordedTickets"][0]["ticketId"], "ticket-nvda")
            self.assertEqual(summary["recordedTickets"][0]["status"], "blocked")
            self.assertEqual(summary["recordedTickets"][0]["scorecardSampleSize"], 5)
            self.assertEqual([path for path, _ in posts], ["/api/autotrader/risk-checks", "/api/autotrader/trade-tickets"])


if __name__ == "__main__":
    unittest.main()

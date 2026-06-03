#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import market_open_cycle


class FakeSynthesis:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.posts.append((path, payload))
        return {"ok": True}


class MarketOpenCycleTest(unittest.TestCase):
    def test_loads_session_runs_guarded_scan_records_checkpoint_and_report(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"
            captured_args = []

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                captured_args.append(args)
                return {
                    "ok": True,
                    "mode": "cycle",
                    "cycle": 3,
                    "cycleDir": str(root / "cycle-3"),
                    "resultCount": 1,
                    "topResults": [
                        {
                            "symbol": "NVDA",
                            "setup_type": "vwap_reclaim",
                            "setup_grade": "A",
                            "scorecard_sample_size": 4,
                        }
                    ],
                    "scorecardReadback": {
                        "scorecardCount": 7,
                        "payloadHash": "hash",
                    },
                    "recordedScorecardReadback": {
                        "passed": True,
                        "scorecardCount": 7,
                    },
                    "recordedTickets": [
                        {
                            "symbol": "NVDA",
                            "ticketId": "ticket-1",
                            "idempotencyKey": "scan-cycle-3-1-NVDA-vwap_reclaim-A",
                        }
                    ],
                    "decisionSummary": {
                        "action": "run_strategy_order_guard",
                        "reason": "best_candidate_ready_for_strategy_guard",
                        "actionableCandidateCount": 1,
                        "bestCandidate": {
                            "symbol": "NVDA",
                            "side": "buy",
                            "setupType": "vwap_reclaim",
                            "setupGrade": "A",
                            "expectedR": "2.1",
                            "entryLimitPrice": "100.25",
                            "targetPrice": "103.00",
                            "stopPrice": "99.00",
                            "riskDollars": "75.00",
                            "plannedQuantity": "60",
                            "actualBracketR": "2.2000",
                            "riskDirective": {
                                "source": "account_equity_stop_distance",
                                "recommendedRiskDollars": "75.00",
                                "plannedQuantity": "60",
                                "plannedMaxLossDollars": "75.00",
                            },
                            "ticketId": "ticket-1",
                        },
                    },
                    "accountGate": {
                        "action": "scan",
                        "skipFullScan": False,
                        "account": {
                            "equity": "30000",
                            "buying_power": "60000",
                            "daytrading_buying_power": "60000",
                            "intraday_equity_entry": {
                                "status": "allowed",
                                "reasons": [],
                            },
                        },
                    },
                    "skipFullScan": False,
                    "action": "scan",
                    "stageTimingsMs": {
                        "inputFetchMs": 41,
                        "stockAnalysisScanMs": 22,
                        "totalMs": 88,
                    },
                }

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--cycle",
                    "3",
                    "--report-path",
                    str(report_path),
                    "--watchlist",
                    "NVDA",
                    "--agent-run-name",
                    "autonomous-trader-market-open-test",
                    "--now",
                    "2026-06-03T14:00:00Z",
                ]
            )
            guard_calls = []

            def fake_evaluate_order(args: Any) -> dict[str, Any]:
                guard_calls.append(args)
                return {
                    "ok": True,
                    "symbol": args.symbol,
                    "side": args.side,
                    "entryLimit": args.entry_limit,
                    "takeProfitLimit": args.take_profit_limit,
                    "stopLossStop": args.stop_loss_stop,
                    "allowed": True,
                    "reason": "fresh_strategy_order",
                    "latestBid": 100.20,
                    "latestAsk": 100.25,
                    "latestTrade": 100.22,
                }

            with (
                patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle),
                patch.object(market_open_cycle.strategy_order_guard, "evaluate_order", fake_evaluate_order),
            ):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertTrue(result["ok"])
            self.assertEqual(result["summary"]["strategyGuard"]["allowed"], True)
            self.assertEqual(result["sessionId"], "session-market-open")
            self.assertEqual(captured_args[0].session_id, "session-market-open")
            self.assertEqual(guard_calls[0].symbol, "NVDA")
            self.assertEqual(guard_calls[0].side, "buy")
            self.assertEqual(guard_calls[0].entry_limit, "100.25")
            self.assertEqual(guard_calls[0].take_profit_limit, "103.00")
            self.assertEqual(guard_calls[0].stop_loss_stop, "99.00")
            intent = result["summary"]["brokerOrderIntent"]
            self.assertEqual(intent["state"], "ready")
            self.assertEqual(intent["ticketId"], "ticket-1")
            self.assertEqual(intent["symbol"], "NVDA")
            self.assertEqual(intent["quantity"], "60")
            self.assertEqual(intent["riskDollars"], "75.00")
            self.assertLessEqual(len(intent["clientOrderId"]), 128)
            self.assertTrue(intent["clientOrderId"].startswith("autonomous-trader-market-open-test-c3-NVDA-"))
            self.assertEqual(intent["alpacaBracketPayload"]["client_order_id"], intent["clientOrderId"])
            self.assertEqual(intent["alpacaBracketPayload"]["qty"], "60")
            self.assertEqual(intent["alpacaBracketPayload"]["take_profit"]["limit_price"], "103.00")
            self.assertEqual(intent["alpacaBracketPayload"]["stop_loss"]["stop_price"], "99.00")
            self.assertEqual(intent["synthesisRecordOrderInput"]["clientOrderId"], intent["clientOrderId"])
            self.assertEqual(intent["synthesisRecordOrderInput"]["status"], "planned")
            self.assertTrue(captured_args[0].record_tickets)
            self.assertTrue(captured_args[0].respect_account_gate)
            self.assertEqual(captured_args[0].watchlist, ["NVDA"])
            self.assertEqual(captured_args[0].analysis_context, str(root / "analysis-context.json"))
            self.assertTrue((root / "last-cycle.json").exists())
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("cycle_runner: deterministic_market_open_cycle", report)
            self.assertIn("strategy_guard: allowed:fresh_strategy_order", report)
            self.assertIn("broker_order_intent: ready:", report)

        paths = [path for path, _ in synthesis.posts]
        self.assertEqual(paths, ["/api/autotrader/status", "/api/autotrader/events"])
        status_payload = synthesis.posts[0][1]
        event_payload = synthesis.posts[1][1]
        self.assertEqual(status_payload["sessionId"], "session-market-open")
        self.assertEqual(status_payload["phase"], "scan")
        self.assertEqual(
            status_payload["currentAction"],
            f"market_open_cycle_order_intent_ready; ticketId=ticket-1; symbol=NVDA; clientOrderId={intent['clientOrderId']}",
        )
        self.assertEqual(status_payload["payload"]["recordedTicketCount"], 1)
        self.assertEqual(status_payload["payload"]["stageTimingsMs"]["totalMs"], 88)
        self.assertEqual(status_payload["payload"]["decisionSummary"]["action"], "run_strategy_order_guard")
        self.assertEqual(status_payload["payload"]["strategyGuard"]["result"]["allowed"], True)
        self.assertEqual(status_payload["payload"]["brokerOrderIntent"]["clientOrderId"], intent["clientOrderId"])
        self.assertEqual(event_payload["eventType"], "market_open_cycle_complete")

    def test_blocks_allowed_guard_when_order_intent_fields_are_missing(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                return {
                    "ok": True,
                    "mode": "cycle",
                    "cycle": 4,
                    "cycleDir": str(root / "cycle-4"),
                    "resultCount": 1,
                    "topResults": [],
                    "recordedTickets": [
                        {
                            "symbol": "AMD",
                            "ticketId": "ticket-amd-1",
                            "idempotencyKey": "scan-cycle-4-1-AMD-vwap_reclaim-A",
                        }
                    ],
                    "decisionSummary": {
                        "action": "run_strategy_order_guard",
                        "bestCandidate": {
                            "symbol": "AMD",
                            "side": "buy",
                            "setupType": "vwap_reclaim",
                            "setupGrade": "A",
                            "expectedR": "2.2",
                            "entryLimitPrice": "140.00",
                            "targetPrice": "144.00",
                            "stopPrice": "138.00",
                            "ticketId": "ticket-amd-1",
                        },
                    },
                    "accountGate": {
                        "action": "scan",
                        "skipFullScan": False,
                        "account": {
                            "equity": "30000",
                            "buying_power": "60000",
                            "daytrading_buying_power": "60000",
                        },
                    },
                    "skipFullScan": False,
                    "action": "scan",
                }

            def fake_evaluate_order(args: Any) -> dict[str, Any]:
                return {
                    "ok": True,
                    "allowed": True,
                    "reason": "fresh_strategy_order",
                }

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(report_path),
                    "--now",
                    "2026-06-03T14:00:00Z",
                ]
            )
            with (
                patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle),
                patch.object(market_open_cycle.strategy_order_guard, "evaluate_order", fake_evaluate_order),
            ):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            intent = result["summary"]["brokerOrderIntent"]
            self.assertEqual(intent["state"], "blocked")
            self.assertEqual(intent["reason"], "broker_order_intent_missing_fields")
            self.assertEqual(
                intent["missingFields"],
                ["quantity", "riskDollars", "actualBracketR", "riskDirective"],
            )
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("broker_order_intent: blocked:broker_order_intent_missing_fields", report)

        status_payload = synthesis.posts[0][1]
        self.assertEqual(status_payload["blocker"], "broker_order_intent_missing_fields")
        self.assertEqual(
            status_payload["currentAction"],
            "market_open_cycle_order_intent_blocked; ticketId=ticket-amd-1; symbol=AMD; reason=broker_order_intent_missing_fields",
        )

    def test_records_missing_strategy_guard_inputs_without_calling_guard(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                return {
                    "ok": True,
                    "mode": "cycle",
                    "cycle": 2,
                    "cycleDir": str(root / "cycle-2"),
                    "resultCount": 1,
                    "topResults": [],
                    "recordedTickets": [],
                    "decisionSummary": {
                        "action": "run_strategy_order_guard",
                        "bestCandidate": {
                            "symbol": "NVDA",
                            "side": "buy",
                            "setupType": "vwap_reclaim",
                            "setupGrade": "A",
                            "ticketId": "ticket-1",
                        },
                    },
                    "accountGate": {
                        "action": "scan",
                        "skipFullScan": False,
                        "account": {
                            "equity": "30000",
                            "buying_power": "60000",
                            "daytrading_buying_power": "60000",
                        },
                    },
                    "skipFullScan": False,
                    "action": "scan",
                }

            def fake_evaluate_order(args: Any) -> dict[str, Any]:
                raise AssertionError("guard must not run without complete candidate prices")

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(report_path),
                    "--now",
                    "2026-06-03T14:00:00Z",
                ]
            )
            with (
                patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle),
                patch.object(market_open_cycle.strategy_order_guard, "evaluate_order", fake_evaluate_order),
            ):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertEqual(result["summary"]["strategyGuard"]["reason"], "strategy_guard_missing_inputs")
            self.assertEqual(
                result["summary"]["strategyGuard"]["missingFields"],
                ["entryLimitPrice", "targetPrice", "stopPrice"],
            )

        status_payload = synthesis.posts[0][1]
        self.assertEqual(status_payload["blocker"], "strategy_guard_missing_inputs")
        self.assertEqual(
            status_payload["currentAction"],
            "market_open_cycle_guard_blocked; ticketId=ticket-1; symbol=NVDA; reason=strategy_guard_missing_inputs",
        )
        self.assertEqual(status_payload["payload"]["strategyGuard"]["allowed"], False)

    def test_reports_account_gated_cycle_without_scan(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                return {
                    "ok": True,
                    "mode": "cycle",
                    "cycle": 1,
                    "cycleDir": str(root / "cycle-1"),
                    "skipFullScan": True,
                    "action": "monitor_only",
                    "resultCount": 0,
                    "topResults": [],
                    "recordedTickets": [],
                    "accountGate": {
                        "action": "monitor_only",
                        "skipFullScan": True,
                        "account": {
                            "equity": "29989.14",
                            "buying_power": "59978.28",
                            "daytrading_buying_power": "0",
                            "intraday_equity_entry": {
                                "status": "blocked",
                                "reasons": ["daytrading_buying_power_not_positive"],
                            },
                        },
                    },
                }

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(report_path),
                    "--now",
                    "2026-06-03T14:00:00Z",
                ]
            )
            with patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertTrue(result["summary"]["skipFullScan"])
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("phase: idle", report)
            self.assertIn("skip_full_scan: true", report)

        status_payload = synthesis.posts[0][1]
        self.assertEqual(status_payload["phase"], "idle")
        self.assertEqual(status_payload["blocker"], "daytrading_buying_power_not_positive")
        self.assertEqual(status_payload["currentAction"], "market_open_cycle_account_gated; action=monitor_only")

    def test_reports_position_management_directive_without_new_scan(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                return {
                    "ok": True,
                    "mode": "cycle",
                    "cycle": 5,
                    "cycleDir": str(root / "cycle-5"),
                    "skipFullScan": True,
                    "action": "manage_existing_broker_state",
                    "resultCount": 0,
                    "topResults": [],
                    "recordedTickets": [],
                    "accountGate": {
                        "action": "manage_existing_broker_state",
                        "skipFullScan": True,
                        "account": {
                            "equity": "30000",
                            "buying_power": "120000",
                            "daytrading_buying_power": "120000",
                        },
                        "positionManagement": {
                            "mode": "serial_position_management",
                            "actionRequired": True,
                            "primaryAction": "tighten_stop_to_breakeven",
                            "primaryReason": "open_profit_at_or_above_0_5r",
                            "positions": [
                                {
                                    "symbol": "AVGO",
                                    "openR": "0.7500",
                                    "stopR": "-1.0000",
                                    "recommendedStopPrice": "486.14",
                                }
                            ],
                        },
                    },
                }

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(report_path),
                    "--now",
                    "2026-06-03T14:00:00Z",
                ]
            )
            with patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertTrue(result["summary"]["skipFullScan"])
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("phase: manage", report)
            self.assertIn("position_management: tighten_stop_to_breakeven", report)
            self.assertIn("recommended_stop: 486.14", report)

        status_payload = synthesis.posts[0][1]
        self.assertEqual(status_payload["phase"], "manage")
        self.assertEqual(
            status_payload["currentAction"],
            "market_open_cycle_manage_existing; action=tighten_stop_to_breakeven; reason=open_profit_at_or_above_0_5r",
        )
        self.assertEqual(status_payload["payload"]["accountGate"]["positionManagement"]["primaryAction"], "tighten_stop_to_breakeven")

    def test_waits_before_regular_market_open_without_scanning(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                raise AssertionError("pre-open cycle must not call live scan")

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(report_path),
                    "--now",
                    "2026-06-03T13:15:00Z",
                ]
            )
            with patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertEqual(result["summary"]["action"], "waiting_for_market_open")
            self.assertTrue(result["summary"]["skipFullScan"])
            self.assertTrue((root / "cycle-1" / "market-window.json").exists())
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("action: market_open_cycle_waiting_for_open", report)
            self.assertIn("blocker: market_not_open", report)

        status_payload = synthesis.posts[0][1]
        event_payload = synthesis.posts[1][1]
        self.assertEqual(status_payload["phase"], "idle")
        self.assertEqual(status_payload["blocker"], "market_not_open")
        self.assertIn("marketOpenAt=2026-06-03T13:30:00Z", status_payload["currentAction"])
        self.assertEqual(event_payload["eventType"], "market_open_cycle_waiting_for_open")

    def test_stops_scanning_after_regular_market_close(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")
            report_path = root / "report.md"

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                raise AssertionError("post-close cycle must not call live scan")

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(report_path),
                    "--now",
                    "2026-06-03T20:05:00Z",
                ]
            )
            with patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertEqual(result["summary"]["action"], "market_closed")
            self.assertTrue(result["summary"]["skipFullScan"])
            self.assertIn("blocker: market_closed", report_path.read_text(encoding="utf-8"))

        status_payload = synthesis.posts[0][1]
        event_payload = synthesis.posts[1][1]
        self.assertEqual(status_payload["phase"], "idle")
        self.assertEqual(status_payload["blocker"], "market_closed")
        self.assertIn("marketCloseAt=2026-06-03T20:00:00Z", status_payload["currentAction"])
        self.assertEqual(event_payload["eventType"], "market_open_cycle_market_closed")

    def test_stops_scanning_on_weekend_clock_hours(self) -> None:
        synthesis = FakeSynthesis()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "session.json").write_text('{"sessionId":"session-market-open"}\n', encoding="utf-8")

            def fake_run_cycle(args: Any) -> dict[str, Any]:
                raise AssertionError("weekend cycle must not call live scan")

            args = market_open_cycle.build_parser().parse_args(
                [
                    "--work-dir",
                    str(root),
                    "--report-path",
                    str(root / "report.md"),
                    "--now",
                    "2026-06-06T14:00:00Z",
                ]
            )
            with patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertEqual(result["summary"]["marketWindow"]["state"], "market_closed")
            self.assertFalse(result["summary"]["marketWindow"]["regularSession"])

        status_payload = synthesis.posts[0][1]
        self.assertEqual(status_payload["blocker"], "market_closed_weekend")


if __name__ == "__main__":
    unittest.main()

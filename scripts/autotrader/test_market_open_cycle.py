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
                        }
                    ],
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
                ]
            )
            with patch.object(market_open_cycle.live_scan_cycle, "run_cycle", fake_run_cycle):
                result = market_open_cycle.run_market_open_cycle(args=args, synthesis=synthesis)  # type: ignore[arg-type]

            self.assertTrue(result["ok"])
            self.assertEqual(result["sessionId"], "session-market-open")
            self.assertEqual(captured_args[0].session_id, "session-market-open")
            self.assertTrue(captured_args[0].record_tickets)
            self.assertTrue(captured_args[0].respect_account_gate)
            self.assertEqual(captured_args[0].watchlist, ["NVDA"])
            self.assertEqual(captured_args[0].analysis_context, str(root / "analysis-context.json"))
            self.assertTrue((root / "last-cycle.json").exists())
            self.assertIn("cycle_runner: deterministic_market_open_cycle", report_path.read_text(encoding="utf-8"))

        paths = [path for path, _ in synthesis.posts]
        self.assertEqual(paths, ["/api/autotrader/status", "/api/autotrader/events"])
        status_payload = synthesis.posts[0][1]
        event_payload = synthesis.posts[1][1]
        self.assertEqual(status_payload["sessionId"], "session-market-open")
        self.assertEqual(status_payload["phase"], "scan")
        self.assertEqual(status_payload["currentAction"], "market_open_cycle_complete; top=NVDA A vwap_reclaim")
        self.assertEqual(status_payload["payload"]["recordedTicketCount"], 1)
        self.assertEqual(event_payload["eventType"], "market_open_cycle_complete")

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
                ["--work-dir", str(root), "--report-path", str(report_path)]
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


if __name__ == "__main__":
    unittest.main()

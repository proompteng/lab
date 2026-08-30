#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import market_open_bootstrap


class FakeSynthesis:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        self.posts.append((path, payload))
        if path == "/api/autotrader/sessions":
            return {"session": {"id": "session-market-open"}}
        if path in {"/api/autotrader/status", "/api/autotrader/events"}:
            return {"ok": True}
        raise AssertionError(f"unexpected POST {path}")


class FakeAlpaca:
    def trading_get(self, path: str, query: dict[str, str] | None = None) -> Any:
        if path == "/v2/account":
            return {
                "account_number": "PA30HY0S5MZY",
                "equity": "30000",
                "buying_power": "60000",
                "daytrading_buying_power": "60000",
                "daytrade_count": "0",
            }
        if path == "/v2/positions":
            return []
        if path == "/v2/orders":
            self.assertEqual(query, {"status": "open", "nested": "true"})
            return []
        raise AssertionError(f"unexpected Alpaca GET {path} {query}")

    def assertEqual(self, left: object, right: object) -> None:
        if left != right:
            raise AssertionError(f"{left!r} != {right!r}")


class MarketOpenBootstrapTest(unittest.TestCase):
    def test_starts_session_records_status_event_and_writes_readback_files(self) -> None:
        synthesis = FakeSynthesis()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            analysis_dir = root / "analysis"
            analysis_dir.mkdir()
            analysis_context = root / "analysis-context.json"
            analysis_context.write_text('{"ok":true}\n', encoding="utf-8")
            report_path = root / "report.md"

            result = market_open_bootstrap.run_bootstrap(
                synthesis=synthesis,  # type: ignore[arg-type]
                alpaca=FakeAlpaca(),  # type: ignore[arg-type]
                now=datetime(2026, 6, 3, 13, 15, tzinfo=UTC),
                agent_run_name="autonomous-trader-market-open-test",
                session_mode="market_open",
                goal_equity="500000",
                work_dir=root,
                report_path=report_path,
                analysis_dir=analysis_dir,
                analysis_context_path=analysis_context,
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["sessionId"], "session-market-open")
            self.assertEqual(result["accountGate"]["action"], "scan")
            self.assertEqual(len(result["analysisContextHash"]), 64)
            self.assertTrue(result["june3FailurePathReplayGate"]["ok"])
            self.assertTrue((root / "session.json").exists())
            self.assertIn("session-market-open", (root / "session.json").read_text(encoding="utf-8"))
            self.assertIn("status: running", report_path.read_text(encoding="utf-8"))

        paths = [path for path, _ in synthesis.posts]
        self.assertEqual(paths, ["/api/autotrader/sessions", "/api/autotrader/status", "/api/autotrader/events"])
        start_payload = synthesis.posts[0][1]
        status_payload = synthesis.posts[1][1]
        event_payload = synthesis.posts[2][1]
        self.assertEqual(start_payload["mode"], "market_open")
        self.assertEqual(start_payload["accountId"], "PA30HY0S5MZY")
        self.assertEqual(start_payload["analysisContextHash"], result["analysisContextHash"])
        self.assertEqual(status_payload["phase"], "scan")
        self.assertEqual(status_payload["payload"]["bootstrap"], "market_open_session")
        self.assertTrue(status_payload["payload"]["june3FailurePathReplayGate"]["ok"])
        self.assertEqual(event_payload["eventType"], "market_open_bootstrap_complete")

    def test_fails_closed_when_june3_replay_gate_fails(self) -> None:
        synthesis = FakeSynthesis()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            analysis_dir = root / "analysis"
            analysis_dir.mkdir()
            analysis_context = root / "analysis-context.json"
            analysis_context.write_text('{"ok":true}\n', encoding="utf-8")

            with patch.object(
                market_open_bootstrap.live_scan_cycle,
                "run_june3_failure_path_replay",
                return_value={
                    "ok": False,
                    "name": "june3_failure_path_replay",
                    "failures": [{"name": "avgo_cycle_147_post_amd_loss_b_grade_single_sample"}],
                },
            ):
                with self.assertRaisesRegex(RuntimeError, "market-open safety regression failed"):
                    market_open_bootstrap.run_bootstrap(
                        synthesis=synthesis,  # type: ignore[arg-type]
                        alpaca=FakeAlpaca(),  # type: ignore[arg-type]
                        now=datetime(2026, 6, 3, 13, 15, tzinfo=UTC),
                        agent_run_name="autonomous-trader-market-open-test",
                        session_mode="market_open",
                        goal_equity="500000",
                        work_dir=root,
                        report_path=root / "report.md",
                        analysis_dir=analysis_dir,
                        analysis_context_path=analysis_context,
                    )

        self.assertEqual(synthesis.posts, [])


if __name__ == "__main__":
    unittest.main()

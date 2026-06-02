#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import scorecard_readback


class FakeSynthesis:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def get(self, path: str, query: dict[str, str] | None = None) -> Any:
        if path == "/api/autotrader/scorecards":
            return {"scorecards": [{"key": "NVDA|vwap_reclaim"}], "setupExamples": [{"id": "example-1"}]}
        if path == "/api/autotrader/sessions":
            return {"sessions": []}
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        self.posts.append((path, payload))
        if path == "/api/autotrader/sessions":
            return {"session": {"id": "session-readback"}}
        if path in {"/api/autotrader/status", "/api/autotrader/events", "/api/autotrader/finalize"}:
            return {"ok": True}
        raise AssertionError(f"unexpected POST {path}")


class FakeAlpaca:
    def get(self, path: str) -> Any:
        if path == "/v2/account":
            return {
                "account_number": "PA30HY0S5MZY",
                "equity": "30000",
                "buying_power": "60000",
                "daytrading_buying_power": "0",
            }
        if path == "/v2/positions":
            return []
        if path == "/v2/orders?status=open&nested=true":
            return []
        raise AssertionError(f"unexpected Alpaca GET {path}")


class ScorecardReadbackTest(unittest.TestCase):
    def test_readback_finalizes_without_broker_mutations_or_analysis_bootstrap(self) -> None:
        synthesis = FakeSynthesis()
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.md"

            result = scorecard_readback.run_readback(
                synthesis=synthesis,  # type: ignore[arg-type]
                alpaca=FakeAlpaca(),  # type: ignore[arg-type]
                now=datetime(2026, 6, 2, 21, 0, tzinfo=UTC),
                agent_run_name="autonomous-trader-readback-test",
                session_mode="scorecard_readback",
                goal_equity="500000",
                scorecard_limit=20,
                finalize_stale_flat=True,
                current_agent_run_name="autonomous-trader-readback-test",
                report_path=report_path,
            )

            self.assertTrue(result["ok"])
            self.assertTrue(result["brokerFlat"])
            self.assertEqual(result["brokerOpenPositionCount"], 0)
            self.assertEqual(result["brokerOpenOrderCount"], 0)
            self.assertEqual(result["scorecardCount"], 1)
            self.assertEqual(result["setupExampleCount"], 1)
            self.assertEqual(result["reconciliation"]["candidateCount"], 0)
            self.assertIn("No Alpaca broker mutations", report_path.read_text(encoding="utf-8"))

        paths = [path for path, _ in synthesis.posts]
        self.assertEqual(
            paths,
            [
                "/api/autotrader/sessions",
                "/api/autotrader/status",
                "/api/autotrader/events",
                "/api/autotrader/finalize",
            ],
        )
        start_payload = synthesis.posts[0][1]
        status_payload = synthesis.posts[1][1]
        event_payload = synthesis.posts[2][1]
        finalize_payload = synthesis.posts[3][1]
        self.assertEqual(start_payload["mode"], "scorecard_readback")
        self.assertEqual(start_payload["accountId"], "PA30HY0S5MZY")
        self.assertEqual(status_payload["currentAction"], "scorecard_readback_complete_no_broker_mutations")
        self.assertEqual(event_payload["eventType"], "scorecard_readback_complete")
        self.assertEqual(finalize_payload["terminalReason"], "scorecard_readback_complete")
        self.assertTrue(finalize_payload["summary"]["noBrokerMutations"])
        self.assertTrue(finalize_payload["summary"]["scorecardRead"])


if __name__ == "__main__":
    unittest.main()

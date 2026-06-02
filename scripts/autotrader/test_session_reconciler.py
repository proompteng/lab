#!/usr/bin/env python3
from __future__ import annotations

import unittest
from datetime import UTC, datetime
from typing import Any

import session_reconciler


class FakeSynthesis:
    def __init__(self, sessions: list[dict[str, Any]], details: dict[str, dict[str, Any]]) -> None:
        self.sessions = sessions
        self.details = details
        self.finalized: list[dict[str, Any]] = []

    def get(self, path: str, query: dict[str, str] | None = None) -> Any:
        if path == "/api/autotrader/sessions":
            return {"sessions": self.sessions[: int((query or {}).get("limit", "50"))]}
        prefix = "/api/autotrader/sessions/"
        if path.startswith(prefix):
            return self.details[path[len(prefix) :]]
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        if path != "/api/autotrader/finalize":
            raise AssertionError(f"unexpected POST {path}")
        self.finalized.append(payload)
        return {"ok": True}


class FakeAlpaca:
    def __init__(
        self,
        *,
        account: dict[str, Any] | None = None,
        positions: list[dict[str, Any]] | None = None,
        orders: list[dict[str, Any]] | None = None,
    ) -> None:
        self.account = account or {"equity": "30001.25"}
        self.positions = positions or []
        self.orders = orders or []

    def get(self, path: str) -> Any:
        if path == "/v2/account":
            return self.account
        if path == "/v2/positions":
            return self.positions
        if path == "/v2/orders?status=open&nested=true":
            return self.orders
        raise AssertionError(f"unexpected Alpaca GET {path}")


def stale_session(**overrides: Any) -> dict[str, Any]:
    session = {
        "id": "session-1",
        "agentRunName": "autonomous-trader-market-open-abcde",
        "mode": "market_open",
        "tradingDate": "2026-06-02",
        "marketCloseAt": "2026-06-02T20:00:00.000Z",
        "finalizedAt": None,
        "realizedPnl": "-11.17",
    }
    session.update(overrides)
    return session


class SessionReconcilerTest(unittest.TestCase):
    def test_finalizes_stale_market_session_when_broker_is_flat(self) -> None:
        synthesis = FakeSynthesis(
            [stale_session()],
            {
                "session-1": {
                    "status": {"equity": "29990.03", "realizedPnl": "-11.17"},
                    "events": [{"seq": 1}],
                    "tradeTickets": [{"id": "ticket-1"}],
                    "riskChecks": [],
                    "orders": [{"clientOrderId": "order-1"}],
                    "fills": [{"brokerFillId": "fill-1"}],
                    "positionSnapshots": [],
                }
            },
        )

        result = session_reconciler.reconcile_sessions(
            synthesis=synthesis,  # type: ignore[arg-type]
            alpaca=FakeAlpaca(),  # type: ignore[arg-type]
            now=datetime(2026, 6, 2, 20, 10, tzinfo=UTC),
            limit=50,
            grace_minutes=5,
            finalize_stale_flat=True,
            current_agent_run="autonomous-trader-market-open-next",
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["candidateCount"], 1)
        self.assertEqual(result["reconciled"][0]["sessionId"], "session-1")
        self.assertEqual(len(synthesis.finalized), 1)
        payload = synthesis.finalized[0]
        self.assertEqual(payload["sessionId"], "session-1")
        self.assertEqual(payload["terminalReason"], "market_closed")
        self.assertEqual(payload["closingEquity"], "30001.25")
        self.assertEqual(payload["realizedPnl"], "-11.17")
        self.assertEqual(payload["summary"]["sourceCounts"]["events"], 1)
        self.assertTrue(payload["summary"]["brokerFlat"])

    def test_does_not_finalize_when_current_broker_state_is_open(self) -> None:
        synthesis = FakeSynthesis([stale_session()], {"session-1": {"status": {}, "events": []}})

        result = session_reconciler.reconcile_sessions(
            synthesis=synthesis,  # type: ignore[arg-type]
            alpaca=FakeAlpaca(positions=[{"symbol": "GOOGL", "qty": "5"}]),  # type: ignore[arg-type]
            now=datetime(2026, 6, 2, 20, 10, tzinfo=UTC),
            limit=50,
            grace_minutes=5,
            finalize_stale_flat=True,
            current_agent_run="",
        )

        self.assertEqual(synthesis.finalized, [])
        self.assertEqual(result["skipped"][0]["reason"], "broker_state_not_flat")
        self.assertEqual(result["skipped"][0]["brokerOpenPositionCount"], 1)

    def test_ignores_finalized_current_and_within_grace_sessions(self) -> None:
        sessions = [
            stale_session(id="finalized", finalizedAt="2026-06-02T20:01:00Z"),
            stale_session(id="current", agentRunName="autonomous-trader-market-open-current"),
            stale_session(id="within-grace", marketCloseAt="2026-06-02T20:04:00Z"),
        ]
        synthesis = FakeSynthesis(sessions, {})

        result = session_reconciler.reconcile_sessions(
            synthesis=synthesis,  # type: ignore[arg-type]
            alpaca=FakeAlpaca(),  # type: ignore[arg-type]
            now=datetime(2026, 6, 2, 20, 5, tzinfo=UTC),
            limit=50,
            grace_minutes=5,
            finalize_stale_flat=True,
            current_agent_run="autonomous-trader-market-open-current",
        )

        self.assertEqual(result["candidateCount"], 0)
        self.assertIsNone(result["brokerFlat"])
        self.assertEqual(synthesis.finalized, [])


if __name__ == "__main__":
    unittest.main()

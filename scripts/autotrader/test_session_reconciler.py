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


def completed_round_trip_detail() -> dict[str, Any]:
    return {
        "session": {
            "id": "session-1",
            "terminalReason": "market_closed",
            "openingEquity": "30000",
            "closingEquity": "30010",
            "realizedPnl": "10",
            "summary": {"brokerFlat": True, "originalFinalizedAt": "2026-06-02T20:01:00Z"},
        },
        "status": {"equity": "30010.00", "realizedPnl": "10"},
        "events": [],
        "tradeTickets": [
            {
                "id": "ticket-win",
                "symbol": "AMD",
                "setupType": "vwap_reclaim",
                "setupGrade": "A",
                "regime": "regular_session",
                "timeBucket": "mid_session",
                "riskDollars": "10",
            }
        ],
        "riskChecks": [],
        "orders": [
            {
                "ticketId": "ticket-win",
                "clientOrderId": "amd-entry",
                "symbol": "AMD",
                "side": "buy",
                "quantity": "10",
                "status": "filled",
            },
            {
                "ticketId": "ticket-win",
                "clientOrderId": "amd-exit",
                "symbol": "AMD",
                "side": "sell",
                "quantity": "10",
                "status": "filled",
            },
        ],
        "fills": [
            {
                "clientOrderId": "amd-entry",
                "brokerFillId": "fill-entry",
                "symbol": "AMD",
                "side": "buy",
                "quantity": "10",
                "price": "100",
                "filledAt": "2026-06-02T15:00:00Z",
            },
            {
                "clientOrderId": "amd-exit",
                "brokerFillId": "fill-exit",
                "symbol": "AMD",
                "side": "sell",
                "quantity": "10",
                "price": "101",
                "filledAt": "2026-06-02T15:05:00Z",
            },
        ],
        "positionSnapshots": [],
        "setupExamples": [],
    }


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
            backfill_finalized_flat=False,
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
        self.assertEqual(payload["scorecardObservations"], [])
        self.assertEqual(payload["summary"]["scorecardObservationSummary"]["generated"], 0)

    def test_scores_completed_round_trips_for_stale_session_finalization(self) -> None:
        synthesis = FakeSynthesis(
            [stale_session()],
            {
                "session-1": {
                    "status": {"equity": "30010.00", "realizedPnl": "10"},
                    "events": [],
                    "tradeTickets": [
                        {
                            "id": "ticket-win",
                            "symbol": "AMD",
                            "setupType": "vwap_reclaim",
                            "setupGrade": "A",
                            "regime": "regular_session",
                            "timeBucket": "mid_session",
                            "riskDollars": "10",
                        },
                        {
                            "id": "ticket-open",
                            "symbol": "GOOGL",
                            "setupType": "opening_range_breakout",
                            "setupGrade": "B",
                            "regime": "regular_session",
                            "timeBucket": "mid_session",
                            "riskDollars": "5",
                        },
                    ],
                    "riskChecks": [],
                    "orders": [
                        {
                            "ticketId": "ticket-win",
                            "clientOrderId": "amd-entry",
                            "symbol": "AMD",
                            "side": "buy",
                            "quantity": "10",
                            "status": "filled",
                        },
                        {
                            "ticketId": "ticket-win",
                            "clientOrderId": "amd-exit",
                            "symbol": "AMD",
                            "side": "sell",
                            "quantity": "10",
                            "status": "filled",
                        },
                        {
                            "ticketId": "ticket-open",
                            "clientOrderId": "googl-entry",
                            "symbol": "GOOGL",
                            "side": "buy",
                            "quantity": "5",
                            "status": "filled",
                        },
                    ],
                    "fills": [
                        {
                            "clientOrderId": "amd-entry",
                            "brokerFillId": "fill-entry",
                            "symbol": "AMD",
                            "side": "buy",
                            "quantity": "10",
                            "price": "100",
                            "filledAt": "2026-06-02T15:00:00Z",
                        },
                        {
                            "clientOrderId": "amd-exit",
                            "brokerFillId": "fill-exit",
                            "symbol": "AMD",
                            "side": "sell",
                            "quantity": "10",
                            "price": "101",
                            "filledAt": "2026-06-02T15:05:00Z",
                        },
                        {
                            "clientOrderId": "googl-entry",
                            "brokerFillId": "fill-open",
                            "symbol": "GOOGL",
                            "side": "buy",
                            "quantity": "5",
                            "price": "200",
                            "filledAt": "2026-06-02T16:00:00Z",
                        },
                    ],
                    "positionSnapshots": [],
                }
            },
        )

        session_reconciler.reconcile_sessions(
            synthesis=synthesis,  # type: ignore[arg-type]
            alpaca=FakeAlpaca(account={"equity": "30010.00"}),  # type: ignore[arg-type]
            now=datetime(2026, 6, 2, 20, 10, tzinfo=UTC),
            limit=50,
            grace_minutes=5,
            finalize_stale_flat=True,
            backfill_finalized_flat=False,
            current_agent_run="",
        )

        payload = synthesis.finalized[0]
        self.assertEqual(len(payload["scorecardObservations"]), 1)
        observation = payload["scorecardObservations"][0]
        self.assertEqual(observation["ticketId"], "ticket-win")
        self.assertEqual(observation["symbol"], "AMD")
        self.assertEqual(observation["outcome"], "win")
        self.assertEqual(observation["realizedR"], "1")
        self.assertEqual(observation["holdSeconds"], "300")
        self.assertEqual(observation["payload"]["pnlDollars"], "10")
        self.assertEqual(observation["payload"]["clientOrderIds"], ["amd-entry", "amd-exit"])
        summary = payload["summary"]["scorecardObservationSummary"]
        self.assertEqual(summary["generated"], 1)
        self.assertEqual(summary["skipped"]["missingRoundTripSides"], 1)

    def test_backfills_finalized_flat_market_session_without_examples(self) -> None:
        session = stale_session(
            finalizedAt="2026-06-02T20:01:00Z",
            fillCount=2,
            setupExampleCount=0,
            summary={"brokerFlat": True},
        )
        synthesis = FakeSynthesis([session], {"session-1": completed_round_trip_detail()})

        result = session_reconciler.reconcile_sessions(
            synthesis=synthesis,  # type: ignore[arg-type]
            alpaca=FakeAlpaca(account={"equity": "30020.00"}),  # type: ignore[arg-type]
            now=datetime(2026, 6, 2, 20, 10, tzinfo=UTC),
            limit=50,
            grace_minutes=5,
            finalize_stale_flat=True,
            backfill_finalized_flat=True,
            current_agent_run="",
        )

        self.assertEqual(result["staleCandidateCount"], 0)
        self.assertEqual(result["backfillCandidateCount"], 1)
        self.assertEqual(result["backfilled"][0]["sessionId"], "session-1")
        self.assertEqual(result["backfilled"][0]["scorecardObservationCount"], 1)
        payload = synthesis.finalized[0]
        self.assertEqual(payload["sessionId"], "session-1")
        self.assertEqual(payload["terminalReason"], "market_closed")
        self.assertEqual(payload["openingEquity"], "30000")
        self.assertEqual(payload["closingEquity"], "30010")
        self.assertEqual(payload["realizedPnl"], "10")
        self.assertEqual(payload["summary"]["reconcileReason"], "finalized_session_scorecard_backfill")
        self.assertEqual(payload["summary"]["originalFinalizedAt"], "2026-06-02T20:01:00Z")
        self.assertEqual(payload["summary"]["scorecardObservationSummary"]["generated"], 1)

    def test_does_not_finalize_when_current_broker_state_is_open(self) -> None:
        synthesis = FakeSynthesis([stale_session()], {"session-1": {"status": {}, "events": []}})

        result = session_reconciler.reconcile_sessions(
            synthesis=synthesis,  # type: ignore[arg-type]
            alpaca=FakeAlpaca(positions=[{"symbol": "GOOGL", "qty": "5"}]),  # type: ignore[arg-type]
            now=datetime(2026, 6, 2, 20, 10, tzinfo=UTC),
            limit=50,
            grace_minutes=5,
            finalize_stale_flat=True,
            backfill_finalized_flat=False,
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
            backfill_finalized_flat=True,
            current_agent_run="autonomous-trader-market-open-current",
        )

        self.assertEqual(result["staleCandidateCount"], 0)
        self.assertEqual(result["backfillCandidateCount"], 0)
        self.assertIsNone(result["brokerFlat"])
        self.assertEqual(synthesis.finalized, [])


if __name__ == "__main__":
    unittest.main()

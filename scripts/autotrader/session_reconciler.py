#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from protective_preflight import AlpacaClient
from synthesis_autotrader_client import SynthesisClient


MARKET_SESSION_MODES = {"market_open", "market_session"}
TERMINAL_REASONS = {
    "target_reached",
    "market_closed",
    "dry_run_complete",
    "scorecard_readback_waiting",
    "scorecard_readback_complete",
    "hard_stop",
}
OBSERVATION_SOURCE = "session_reconciler_recorded_round_trip"
SCRATCH_R_THRESHOLD = Decimal("0.10")
SCRATCH_PNL_THRESHOLD = Decimal("1.00")
BUY_SIDES = {"buy", "buy_to_cover", "buy_to_open", "buy_to_close"}
SELL_SIDES = {"sell", "sell_short", "sell_to_open", "sell_to_close"}


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def decimal_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        Decimal(text)
    except InvalidOperation:
        return None
    return text


def decimal_value(value: Any) -> Decimal | None:
    text = decimal_text(value)
    if text is None:
        return None
    return Decimal(text)


def text_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def int_value(value: Any) -> int | None:
    text = decimal_text(value)
    if text is None:
        return None
    try:
        return int(Decimal(text))
    except (InvalidOperation, ValueError):
        return None


def format_decimal(value: Decimal, *, places: str = "0.000001") -> str:
    rounded = value.quantize(Decimal(places)).normalize()
    text = format(rounded, "f")
    return "0" if text == "-0" else text


def as_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def fill_side(value: Any) -> str:
    return str(value or "").strip().lower()


def derived_round_trip_risk_dollars(ticket: dict[str, Any], ticket_fills: list[dict[str, Any]]) -> Decimal | None:
    entry_side = fill_side(ticket.get("side"))
    entry_is_buy = entry_side in BUY_SIDES
    entry_is_sell = entry_side in SELL_SIDES
    if not entry_is_buy and not entry_is_sell:
        return None
    stop_price = decimal_value(ticket.get("stopPrice") or ticket.get("stop_price"))
    if stop_price is None:
        return None
    entry_quantity = Decimal("0")
    entry_cost = Decimal("0")
    for fill in ticket_fills:
        side = fill_side(fill.get("side"))
        quantity = decimal_value(fill.get("quantity"))
        price = decimal_value(fill.get("price"))
        if quantity is None or price is None or quantity <= 0 or price <= 0:
            return None
        if entry_is_buy and side in BUY_SIDES:
            entry_quantity += quantity
            entry_cost += quantity * price
        elif entry_is_sell and side in SELL_SIDES:
            entry_quantity += quantity
            entry_cost += quantity * price
    if entry_quantity <= 0:
        return None
    per_share_risk = abs((entry_cost / entry_quantity) - stop_price)
    if per_share_risk <= 0:
        return None
    return per_share_risk * entry_quantity


def is_stale_market_session(
    session: dict[str, Any], *, now: datetime, grace: timedelta, current_agent_run: str
) -> bool:
    if session.get("finalizedAt"):
        return False
    if session.get("mode") not in MARKET_SESSION_MODES:
        return False
    if current_agent_run and session.get("agentRunName") == current_agent_run:
        return False
    market_close = parse_timestamp(session.get("marketCloseAt"))
    if market_close is None:
        return False
    return now >= market_close + grace


def generated_scorecard_observation_count(session: dict[str, Any]) -> int:
    summary = session.get("summary") if isinstance(session.get("summary"), dict) else {}
    scorecard_summary = summary.get("scorecardObservationSummary")
    if not isinstance(scorecard_summary, dict):
        scorecard_summary = {}
    return int_value(scorecard_summary.get("generated")) or 0


def session_reported_flat(session: dict[str, Any]) -> bool:
    summary = session.get("summary") if isinstance(session.get("summary"), dict) else {}
    if summary.get("brokerFlat") is True:
        return True
    if int_value(summary.get("finalPositions")) == 0 and int_value(summary.get("finalOpenOrders")) == 0:
        return True
    final_broker_state = summary.get("finalBrokerState") if isinstance(summary.get("finalBrokerState"), dict) else {}
    return (
        int_value(final_broker_state.get("positionsCount")) == 0
        and int_value(final_broker_state.get("openOrdersCount")) == 0
    )


def is_finalized_backfill_candidate(session: dict[str, Any], *, current_agent_run: str) -> bool:
    if not session.get("finalizedAt"):
        return False
    if session.get("mode") not in MARKET_SESSION_MODES:
        return False
    if current_agent_run and session.get("agentRunName") == current_agent_run:
        return False
    if generated_scorecard_observation_count(session) > 0:
        return False
    setup_example_count = int_value(session.get("setupExampleCount"))
    if setup_example_count is not None and setup_example_count > 0:
        return False
    fill_count = int_value(session.get("fillCount"))
    if fill_count is not None and fill_count <= 0:
        return False
    return session_reported_flat(session)


def broker_readback(alpaca: AlpacaClient) -> dict[str, Any]:
    account = alpaca.get("/v2/account")
    positions = as_list(alpaca.get("/v2/positions"))
    orders = as_list(alpaca.get("/v2/orders?status=open&nested=true"))
    return {
        "account": account if isinstance(account, dict) else {},
        "openPositions": positions,
        "openOrders": orders,
        "flat": len(positions) == 0 and len(orders) == 0,
    }


def session_counts(detail: dict[str, Any]) -> dict[str, int]:
    return {
        "events": len(as_list(detail.get("events"))),
        "tradeTickets": len(as_list(detail.get("tradeTickets"))),
        "riskChecks": len(as_list(detail.get("riskChecks"))),
        "orders": len(as_list(detail.get("orders"))),
        "fills": len(as_list(detail.get("fills"))),
        "positionSnapshots": len(as_list(detail.get("positionSnapshots"))),
    }


def scorecard_observations(detail: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tickets = {
        str(ticket["id"]): ticket for ticket in as_list(detail.get("tradeTickets")) if text_value(ticket.get("id"))
    }
    orders = as_list(detail.get("orders"))
    fills = as_list(detail.get("fills"))
    order_by_client_id = {
        str(order["clientOrderId"]): order for order in orders if text_value(order.get("clientOrderId"))
    }
    fills_by_ticket_id: dict[str, list[dict[str, Any]]] = {}
    skipped = {
        "unlinkedFills": 0,
        "unknownTicketFills": 0,
        "invalidFills": 0,
        "incompleteRoundTrips": 0,
        "missingTicketFields": 0,
        "missingRoundTripSides": 0,
    }

    for fill in fills:
        client_order_id = text_value(fill.get("clientOrderId"))
        order = order_by_client_id.get(client_order_id or "")
        ticket_id = text_value(fill.get("ticketId")) or text_value(order.get("ticketId") if order else None)
        if ticket_id is None:
            skipped["unlinkedFills"] += 1
            continue
        if ticket_id not in tickets:
            skipped["unknownTicketFills"] += 1
            continue
        fills_by_ticket_id.setdefault(ticket_id, []).append(fill)

    observations: list[dict[str, Any]] = []
    for ticket_id, ticket_fills in sorted(fills_by_ticket_id.items()):
        ticket = tickets[ticket_id]
        symbol = text_value(ticket.get("symbol"))
        setup_type = text_value(ticket.get("setupType"))
        setup_grade = text_value(ticket.get("setupGrade"))
        regime = text_value(ticket.get("regime"))
        time_bucket = text_value(ticket.get("timeBucket"))
        if not all([symbol, setup_type, setup_grade, regime, time_bucket]):
            skipped["missingTicketFields"] += 1
            continue

        net_quantity = Decimal("0")
        pnl = Decimal("0")
        saw_buy = False
        saw_sell = False
        invalid = False
        fill_times: list[datetime] = []
        client_order_ids: list[str] = []
        for fill in ticket_fills:
            side = fill_side(fill.get("side"))
            quantity = decimal_value(fill.get("quantity"))
            price = decimal_value(fill.get("price"))
            if quantity is None or price is None or quantity <= 0:
                invalid = True
                break
            if side in BUY_SIDES:
                saw_buy = True
                net_quantity += quantity
                pnl -= quantity * price
            elif side in SELL_SIDES:
                saw_sell = True
                net_quantity -= quantity
                pnl += quantity * price
            else:
                invalid = True
                break
            filled_at = parse_timestamp(fill.get("filledAt"))
            if filled_at is not None:
                fill_times.append(filled_at)
            client_order_id = text_value(fill.get("clientOrderId"))
            if client_order_id is not None:
                client_order_ids.append(client_order_id)

        if invalid:
            skipped["invalidFills"] += 1
            continue
        if not saw_buy or not saw_sell:
            skipped["missingRoundTripSides"] += 1
            continue
        if net_quantity != 0:
            skipped["incompleteRoundTrips"] += 1
            continue

        explicit_risk_dollars = decimal_value(ticket.get("riskDollars"))
        derived_risk_dollars = derived_round_trip_risk_dollars(ticket, ticket_fills)
        risk_dollars_source = None
        if explicit_risk_dollars is not None and explicit_risk_dollars > 0:
            risk_dollars = explicit_risk_dollars
            risk_dollars_source = "ticket_risk_dollars"
        elif derived_risk_dollars is not None and derived_risk_dollars > 0:
            risk_dollars = derived_risk_dollars
            risk_dollars_source = "entry_stop_fill_risk"
        else:
            risk_dollars = None
        realized_r = pnl / risk_dollars if risk_dollars and risk_dollars > 0 else None
        if realized_r is not None:
            if realized_r > SCRATCH_R_THRESHOLD:
                outcome = "win"
            elif realized_r < -SCRATCH_R_THRESHOLD:
                outcome = "loss"
            else:
                outcome = "scratch"
        elif pnl > SCRATCH_PNL_THRESHOLD:
            outcome = "win"
        elif pnl < -SCRATCH_PNL_THRESHOLD:
            outcome = "loss"
        else:
            outcome = "scratch"

        tags = ["stale_session_reconciled", "completed_round_trip"]
        if outcome == "win":
            tags.append("realized_win")
        elif outcome == "loss":
            tags.append("realized_loss")
        else:
            tags.append("scratch_trade")

        realized_r_text = format_decimal(realized_r) if realized_r is not None else "n/a"
        observation: dict[str, Any] = {
            "ticketId": ticket_id,
            "symbol": symbol,
            "setupType": setup_type,
            "setupGrade": setup_grade,
            "regime": regime,
            "timeBucket": time_bucket,
            "outcome": outcome,
            "mistakeTags": tags,
            "notes": (
                "Reconciler scored completed recorded round trip: "
                f"pnl={format_decimal(pnl)}, realizedR={realized_r_text}."
            ),
            "payload": {
                "source": OBSERVATION_SOURCE,
                "fillCount": len(ticket_fills),
                "pnlDollars": format_decimal(pnl),
                "netQuantity": format_decimal(net_quantity),
                "riskDollars": format_decimal(risk_dollars) if risk_dollars is not None else None,
                "riskDollarsSource": risk_dollars_source,
                "clientOrderIds": client_order_ids,
            },
        }
        if realized_r is not None:
            observation["realizedR"] = format_decimal(realized_r)
        if len(fill_times) >= 2:
            hold_seconds = max(fill_times) - min(fill_times)
            observation["holdSeconds"] = str(int(hold_seconds.total_seconds()))
        observations.append(observation)

    return observations, {"source": OBSERVATION_SOURCE, "generated": len(observations), "skipped": skipped}


def finalization_payload(session: dict[str, Any], detail: dict[str, Any], broker: dict[str, Any]) -> dict[str, Any]:
    status = detail.get("status") if isinstance(detail.get("status"), dict) else {}
    account = broker.get("account") if isinstance(broker.get("account"), dict) else {}
    closing_equity = decimal_text(account.get("equity")) or decimal_text(status.get("equity"))
    realized_pnl = decimal_text(status.get("realizedPnl")) or decimal_text(session.get("realizedPnl"))
    observations, observation_summary = scorecard_observations(detail)
    summary = {
        "reconciledBy": "autotrader-session-reconciler",
        "reconcileReason": "stale_post_close_flat_broker_state",
        "agentRunName": session.get("agentRunName"),
        "tradingDate": session.get("tradingDate"),
        "marketCloseAt": session.get("marketCloseAt"),
        "brokerFlat": broker.get("flat") is True,
        "brokerOpenPositionCount": len(as_list(broker.get("openPositions"))),
        "brokerOpenOrderCount": len(as_list(broker.get("openOrders"))),
        "sourceCounts": session_counts(detail),
        "scorecardObservationSummary": observation_summary,
        "lastRecordedStatus": status,
    }
    return {
        "sessionId": session["id"],
        "terminalReason": "market_closed",
        "summary": summary,
        "scorecardObservations": observations,
        **({"closingEquity": closing_equity} if closing_equity is not None else {}),
        **({"realizedPnl": realized_pnl} if realized_pnl is not None else {}),
    }


def backfill_payload(session: dict[str, Any], detail: dict[str, Any], broker: dict[str, Any]) -> dict[str, Any]:
    detail_session = detail.get("session") if isinstance(detail.get("session"), dict) else {}
    status = detail.get("status") if isinstance(detail.get("status"), dict) else {}
    existing_summary = (
        detail_session.get("summary")
        if isinstance(detail_session.get("summary"), dict)
        else session.get("summary")
        if isinstance(session.get("summary"), dict)
        else {}
    )
    observations, observation_summary = scorecard_observations(detail)
    terminal_reason = text_value(detail_session.get("terminalReason")) or text_value(session.get("terminalReason"))
    if terminal_reason not in TERMINAL_REASONS:
        terminal_reason = "market_closed"
    summary = {
        **existing_summary,
        "reconciledBy": "autotrader-session-reconciler",
        "reconcileReason": "finalized_session_scorecard_backfill",
        "agentRunName": session.get("agentRunName"),
        "tradingDate": session.get("tradingDate"),
        "brokerFlat": broker.get("flat") is True,
        "brokerOpenPositionCount": len(as_list(broker.get("openPositions"))),
        "brokerOpenOrderCount": len(as_list(broker.get("openOrders"))),
        "sourceCounts": session_counts(detail),
        "scorecardObservationSummary": observation_summary,
        "lastRecordedStatus": status,
    }
    opening_equity = decimal_text(detail_session.get("openingEquity")) or decimal_text(session.get("openingEquity"))
    closing_equity = decimal_text(detail_session.get("closingEquity")) or decimal_text(session.get("closingEquity"))
    realized_pnl = decimal_text(detail_session.get("realizedPnl")) or decimal_text(session.get("realizedPnl"))
    max_drawdown = decimal_text(detail_session.get("maxDrawdown")) or decimal_text(session.get("maxDrawdown"))
    return {
        "sessionId": session["id"],
        "terminalReason": terminal_reason,
        "summary": summary,
        "scorecardObservations": observations,
        **({"openingEquity": opening_equity} if opening_equity is not None else {}),
        **({"closingEquity": closing_equity} if closing_equity is not None else {}),
        **({"realizedPnl": realized_pnl} if realized_pnl is not None else {}),
        **({"maxDrawdown": max_drawdown} if max_drawdown is not None else {}),
    }


def reconcile_sessions(
    *,
    synthesis: SynthesisClient,
    alpaca: AlpacaClient,
    now: datetime,
    limit: int,
    grace_minutes: int,
    finalize_stale_flat: bool,
    backfill_finalized_flat: bool,
    current_agent_run: str,
) -> dict[str, Any]:
    sessions_payload = synthesis.get("/api/autotrader/sessions", {"limit": str(limit)})
    sessions = as_list(sessions_payload.get("sessions") if isinstance(sessions_payload, dict) else None)
    grace = timedelta(minutes=grace_minutes)
    candidates = [
        session
        for session in sessions
        if is_stale_market_session(session, now=now, grace=grace, current_agent_run=current_agent_run)
    ]
    backfill_candidates = [
        session
        for session in sessions
        if backfill_finalized_flat and is_finalized_backfill_candidate(session, current_agent_run=current_agent_run)
    ]
    broker = (
        broker_readback(alpaca)
        if candidates or backfill_candidates
        else {"flat": None, "openPositions": [], "openOrders": []}
    )
    reconciled: list[dict[str, Any]] = []
    backfilled: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for session in candidates:
        session_id = str(session.get("id") or "")
        if not session_id:
            skipped.append({"sessionId": None, "reason": "missing_session_id"})
            continue
        detail = synthesis.get(f"/api/autotrader/sessions/{session_id}")
        if not isinstance(detail, dict):
            skipped.append({"sessionId": session_id, "reason": "invalid_session_detail"})
            continue
        if broker.get("flat") is not True:
            skipped.append(
                {
                    "sessionId": session_id,
                    "agentRunName": session.get("agentRunName"),
                    "reason": "broker_state_not_flat",
                    "brokerOpenPositionCount": len(as_list(broker.get("openPositions"))),
                    "brokerOpenOrderCount": len(as_list(broker.get("openOrders"))),
                }
            )
            continue
        payload = finalization_payload(session, detail, broker)
        if finalize_stale_flat:
            synthesis.post("/api/autotrader/finalize", payload)
        reconciled.append(
            {
                "sessionId": session_id,
                "agentRunName": session.get("agentRunName"),
                "terminalReason": payload["terminalReason"],
                "finalized": finalize_stale_flat,
                "scorecardObservationCount": len(as_list(payload.get("scorecardObservations"))),
            }
        )

    for session in backfill_candidates:
        session_id = str(session.get("id") or "")
        if not session_id:
            skipped.append({"sessionId": None, "reason": "missing_backfill_session_id"})
            continue
        detail = synthesis.get(f"/api/autotrader/sessions/{session_id}")
        if not isinstance(detail, dict):
            skipped.append({"sessionId": session_id, "reason": "invalid_backfill_session_detail"})
            continue
        if broker.get("flat") is not True:
            skipped.append(
                {
                    "sessionId": session_id,
                    "agentRunName": session.get("agentRunName"),
                    "reason": "broker_state_not_flat_for_backfill",
                    "brokerOpenPositionCount": len(as_list(broker.get("openPositions"))),
                    "brokerOpenOrderCount": len(as_list(broker.get("openOrders"))),
                }
            )
            continue
        if as_list(detail.get("setupExamples")):
            skipped.append(
                {
                    "sessionId": session_id,
                    "agentRunName": session.get("agentRunName"),
                    "reason": "already_has_setup_examples",
                }
            )
            continue
        payload = backfill_payload(session, detail, broker)
        observation_count = len(as_list(payload.get("scorecardObservations")))
        if observation_count == 0:
            skipped.append(
                {
                    "sessionId": session_id,
                    "agentRunName": session.get("agentRunName"),
                    "reason": "no_completed_round_trips",
                }
            )
            continue
        if finalize_stale_flat:
            synthesis.post("/api/autotrader/finalize", payload)
        backfilled.append(
            {
                "sessionId": session_id,
                "agentRunName": session.get("agentRunName"),
                "terminalReason": payload["terminalReason"],
                "finalized": finalize_stale_flat,
                "scorecardObservationCount": observation_count,
            }
        )

    return {
        "ok": True,
        "checkedSessions": len(sessions),
        "candidateCount": len(candidates) + len(backfill_candidates),
        "staleCandidateCount": len(candidates),
        "backfillCandidateCount": len(backfill_candidates),
        "reconciled": reconciled,
        "backfilled": backfilled,
        "skipped": skipped,
        "brokerFlat": broker.get("flat"),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconcile stale Synthesis autotrader sessions.")
    parser.add_argument("--base-url")
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--grace-minutes", type=int, default=5)
    parser.add_argument("--finalize-stale-flat", action="store_true")
    parser.add_argument("--backfill-finalized-flat", action="store_true")
    parser.add_argument("--now")
    parser.add_argument("--current-agent-run-name", default=os.environ.get("AGENT_RUN_NAME", ""))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_timestamp(args.now) if args.now else datetime.now(UTC)
    if now is None:
        raise SystemExit("--now must be an ISO timestamp")
    result = reconcile_sessions(
        synthesis=SynthesisClient(base_url=args.base_url, timeout_seconds=args.timeout_seconds),
        alpaca=AlpacaClient(timeout_seconds=args.timeout_seconds),
        now=now,
        limit=args.limit,
        grace_minutes=args.grace_minutes,
        finalize_stale_flat=args.finalize_stale_flat,
        backfill_finalized_flat=args.backfill_finalized_flat,
        current_agent_run=args.current_agent_run_name.strip(),
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime, time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from protective_preflight import AlpacaClient
from synthesis_autotrader_client import SynthesisClient

import session_reconciler


MARKET_TIMEZONE = ZoneInfo("America/New_York")


def parse_bool(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "enabled", "allow", "allowed"}


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


def as_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def market_window(now: datetime) -> dict[str, str]:
    local_now = now.astimezone(MARKET_TIMEZONE)
    trading_date = local_now.date()
    market_open = datetime.combine(trading_date, time(9, 30), tzinfo=MARKET_TIMEZONE)
    market_close = datetime.combine(trading_date, time(16, 0), tzinfo=MARKET_TIMEZONE)
    return {
        "tradingDate": trading_date.isoformat(),
        "marketOpenAt": market_open.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "marketCloseAt": market_close.astimezone(UTC).isoformat().replace("+00:00", "Z"),
    }


def scorecard_counts(payload: Any) -> dict[str, int]:
    data = payload if isinstance(payload, dict) else {}
    return {
        "scorecards": len(as_list(data.get("scorecards"))),
        "setupExamples": len(as_list(data.get("setupExamples"))),
    }


def start_session_payload(
    *,
    agent_run_name: str,
    mode: str,
    account: dict[str, Any],
    goal_equity: str,
    now: datetime,
) -> dict[str, Any]:
    window = market_window(now)
    account_id = account.get("account_number") or account.get("id")
    return {
        "agentRunName": agent_run_name,
        "mode": mode,
        "tradingDate": window["tradingDate"],
        **({"accountId": str(account_id)} if account_id else {}),
        "goalEquity": goal_equity,
        **({"openingEquity": decimal_text(account.get("equity"))} if decimal_text(account.get("equity")) else {}),
        "marketOpenAt": window["marketOpenAt"],
        "marketCloseAt": window["marketCloseAt"],
    }


def session_id_from_start(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("Synthesis start-session response must be a JSON object")
    session = payload.get("session")
    if not isinstance(session, dict) or not isinstance(session.get("id"), str) or not session["id"].strip():
        raise RuntimeError("Synthesis start-session response did not include session.id")
    return session["id"]


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Autonomous Trader Report",
        "",
        "status: scorecard_readback_complete",
        f"session_id: {payload['sessionId']}",
        f"agent_run: {payload['agentRunName']}",
        "mode: scorecard-readback",
        "broker_mutations: disabled",
        f"broker_flat: {str(payload['brokerFlat']).lower()}",
        f"open_positions: {payload['brokerOpenPositionCount']}",
        f"open_orders: {payload['brokerOpenOrderCount']}",
        f"scorecards_read: {payload['scorecardCount']}",
        f"setup_examples_read: {payload['setupExampleCount']}",
        f"session_reconciliation: {json.dumps(payload['reconciliation'], sort_keys=True)}",
        "",
        "No Alpaca broker mutations were submitted by this readback run.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def run_readback(
    *,
    synthesis: SynthesisClient,
    alpaca: AlpacaClient,
    now: datetime,
    agent_run_name: str,
    session_mode: str,
    goal_equity: str,
    scorecard_limit: int,
    finalize_stale_flat: bool,
    current_agent_run_name: str,
    report_path: Path,
) -> dict[str, Any]:
    broker = session_reconciler.broker_readback(alpaca)
    account = broker.get("account") if isinstance(broker.get("account"), dict) else {}
    start_payload = start_session_payload(
        agent_run_name=agent_run_name,
        mode=session_mode,
        account=account,
        goal_equity=goal_equity,
        now=now,
    )
    session_id = session_id_from_start(synthesis.post("/api/autotrader/sessions", start_payload))
    scorecards = synthesis.get("/api/autotrader/scorecards", {"limit": str(scorecard_limit)})
    counts = scorecard_counts(scorecards)
    reconciliation = session_reconciler.reconcile_sessions(
        synthesis=synthesis,
        alpaca=alpaca,
        now=now,
        limit=50,
        grace_minutes=5,
        finalize_stale_flat=finalize_stale_flat,
        current_agent_run=current_agent_run_name,
    )
    open_positions = as_list(broker.get("openPositions"))
    open_orders = as_list(broker.get("openOrders"))
    summary = {
        "mode": "scorecard-readback",
        "scorecardRead": True,
        "scorecardCount": counts["scorecards"],
        "setupExampleCount": counts["setupExamples"],
        "brokerFlat": broker.get("flat") is True,
        "brokerOpenPositionCount": len(open_positions),
        "brokerOpenOrderCount": len(open_orders),
        "noBrokerMutations": True,
        "reconciliation": reconciliation,
    }
    synthesis.post(
        "/api/autotrader/status",
        {
            "sessionId": session_id,
            "cycle": 0,
            "phase": "idle",
            "equity": decimal_text(account.get("equity")),
            "buyingPower": decimal_text(account.get("buying_power")),
            "daytradeBuyingPower": decimal_text(
                account.get("daytrading_buying_power") or account.get("daytrade_buying_power")
            ),
            "currentAction": "scorecard_readback_complete_no_broker_mutations",
            "blocker": None,
            "payload": summary,
        },
    )
    synthesis.post(
        "/api/autotrader/events",
        {
            "sessionId": session_id,
            "seq": 0,
            "eventType": "scorecard_readback_complete",
            "severity": "info",
            "payload": summary,
        },
    )
    synthesis.post(
        "/api/autotrader/finalize",
        {
            "sessionId": session_id,
            "terminalReason": "scorecard_readback_complete",
            "openingEquity": decimal_text(account.get("equity")),
            "closingEquity": decimal_text(account.get("equity")),
            "realizedPnl": "0",
            "maxDrawdown": "0",
            "summary": summary,
            "scorecardObservations": [],
        },
    )
    result = {
        "ok": True,
        "sessionId": session_id,
        "agentRunName": agent_run_name,
        "brokerFlat": summary["brokerFlat"],
        "brokerOpenPositionCount": summary["brokerOpenPositionCount"],
        "brokerOpenOrderCount": summary["brokerOpenOrderCount"],
        "scorecardCount": summary["scorecardCount"],
        "setupExampleCount": summary["setupExampleCount"],
        "reconciliation": reconciliation,
    }
    write_report(report_path, result)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the autotrader scorecard-readback path without analysis bootstrap.")
    parser.add_argument("--base-url")
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--scorecard-limit", type=int, default=20)
    parser.add_argument("--goal-equity", default=os.environ.get("AUTONOMOUS_TRADER_TARGET_EQUITY_USD", "500000"))
    parser.add_argument("--agent-run-name", default=os.environ.get("AGENT_RUN_NAME", "autonomous-trader-readback"))
    parser.add_argument(
        "--session-mode",
        default=os.environ.get("AUTONOMOUS_TRADER_SYNTHESIS_SESSION_MODE", "scorecard_readback"),
    )
    parser.add_argument("--report-path", default="/workspace/.agentrun/autonomous-trader/report.md")
    parser.add_argument("--finalize-stale-flat", action="store_true")
    parser.add_argument("--now")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        print(json.dumps({"ok": True, "mode": "scorecard-readback", "analysisBootstrapRequired": False}, sort_keys=True))
        return 0
    now = session_reconciler.parse_timestamp(args.now) if args.now else datetime.now(UTC)
    if now is None:
        raise SystemExit("--now must be an ISO timestamp")
    result = run_readback(
        synthesis=SynthesisClient(base_url=args.base_url, timeout_seconds=args.timeout_seconds),
        alpaca=AlpacaClient(timeout_seconds=args.timeout_seconds),
        now=now,
        agent_run_name=args.agent_run_name.strip() or "autonomous-trader-readback",
        session_mode=args.session_mode.strip() or "scorecard_readback",
        goal_equity=args.goal_equity.strip() or "500000",
        scorecard_limit=args.scorecard_limit,
        finalize_stale_flat=args.finalize_stale_flat,
        current_agent_run_name=args.agent_run_name.strip(),
        report_path=Path(args.report_path),
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

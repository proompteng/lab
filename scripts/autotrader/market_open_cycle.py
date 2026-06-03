#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime, time
from pathlib import Path
from typing import Any

import live_scan_cycle
import strategy_order_guard
from synthesis_autotrader_client import SynthesisClient


def parse_datetime(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def session_id_from_file(path: Path) -> str:
    payload = load_json(path)
    session_id = payload.get("sessionId")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError(f"{path} does not contain a non-empty sessionId")
    return session_id.strip()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, separators=(',', ':'), sort_keys=True)}\n", encoding="utf-8")


def market_window(now: datetime) -> dict[str, Any]:
    local_now = now.astimezone(live_scan_cycle.MARKET_TIMEZONE)
    trading_date = local_now.date()
    market_open = datetime.combine(trading_date, time(9, 30), tzinfo=live_scan_cycle.MARKET_TIMEZONE)
    market_close = datetime.combine(trading_date, time(16, 0), tzinfo=live_scan_cycle.MARKET_TIMEZONE)
    window = {
        "tradingDate": trading_date.isoformat(),
        "now": now.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "localNow": local_now.isoformat(),
        "marketOpenAt": market_open.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "marketCloseAt": market_close.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "regularSession": local_now.weekday() < 5 and market_open <= local_now < market_close,
    }
    if local_now.weekday() >= 5:
        return {
            **window,
            "state": "market_closed",
            "action": "market_closed",
            "blocker": "market_closed_weekend",
        }
    if local_now < market_open:
        return {
            **window,
            "state": "pre_open",
            "action": "waiting_for_market_open",
            "blocker": "market_not_open",
            "secondsUntilOpen": int((market_open - local_now).total_seconds()),
        }
    if local_now >= market_close:
        return {
            **window,
            "state": "post_close",
            "action": "market_closed",
            "blocker": "market_closed",
        }
    return {
        **window,
        "state": "regular_session",
        "action": "scan",
        "blocker": None,
    }


def next_cycle(args: argparse.Namespace, work_dir: Path) -> int:
    return args.cycle if args.cycle is not None else live_scan_cycle.next_cycle_number(work_dir)


def market_window_skip_summary(*, args: argparse.Namespace, work_dir: Path, window: dict[str, Any]) -> dict[str, Any]:
    cycle = next_cycle(args, work_dir)
    cycle_dir = work_dir / f"cycle-{cycle}"
    cycle_dir.mkdir(parents=True, exist_ok=True)
    write_json(cycle_dir / "market-window.json", window)
    return {
        "ok": True,
        "mode": "cycle",
        "cycle": cycle,
        "cycleDir": str(cycle_dir),
        "skipFullScan": True,
        "action": window["action"],
        "blocker": window["blocker"],
        "resultCount": 0,
        "topResults": [],
        "recordedTickets": [],
        "marketWindow": window,
        "windowGate": True,
    }


def account_from_summary(summary: dict[str, Any]) -> dict[str, Any]:
    gate = summary.get("accountGate")
    if not isinstance(gate, dict):
        return {}
    account = gate.get("account")
    return account if isinstance(account, dict) else {}


def cycle_phase(summary: dict[str, Any]) -> str:
    if not summary.get("skipFullScan"):
        return "scan"
    action = summary.get("action")
    if action == "manage_existing_broker_state":
        return "manage"
    return "idle"


def cycle_action(summary: dict[str, Any]) -> str:
    if summary.get("skipFullScan"):
        action = summary.get("action") or "unknown"
        window = summary.get("marketWindow")
        if action == "waiting_for_market_open" and isinstance(window, dict):
            return f"market_open_cycle_waiting_for_open; marketOpenAt={window.get('marketOpenAt')}"
        if action == "market_closed" and isinstance(window, dict):
            return f"market_open_cycle_market_closed; marketCloseAt={window.get('marketCloseAt')}"
        gate = summary.get("accountGate")
        management = gate.get("positionManagement") if isinstance(gate, dict) else None
        if action == "manage_existing_broker_state" and isinstance(management, dict) and management.get("primaryAction"):
            return f"market_open_cycle_manage_existing; action={management.get('primaryAction')}; reason={management.get('primaryReason')}"
        return f"market_open_cycle_account_gated; action={action}"
    top_results = summary.get("topResults")
    decision = summary.get("decisionSummary")
    guard = summary.get("strategyGuard")
    if isinstance(guard, dict):
        candidate = guard.get("candidate")
        if not isinstance(candidate, dict):
            candidate = {}
        state = "allowed" if guard.get("allowed") is True else "blocked"
        return (
            f"market_open_cycle_guard_{state}; "
            f"ticketId={candidate.get('ticketId')}; "
            f"symbol={candidate.get('symbol')}; "
            f"reason={guard.get('reason')}"
        )
    if isinstance(decision, dict) and decision.get("action") == "no_actionable_candidate":
        return "market_open_cycle_complete; no_actionable_candidate"
    if isinstance(top_results, list) and top_results:
        first = top_results[0] if isinstance(top_results[0], dict) else {}
        symbol = first.get("symbol") or "unknown"
        grade = first.get("setup_grade") or first.get("setupGrade") or "unknown"
        setup = first.get("setup_type") or first.get("setupType") or "unknown"
        return f"market_open_cycle_complete; top={symbol} {grade} {setup}"
    return "market_open_cycle_complete; no_candidates"


def cycle_blocker(summary: dict[str, Any]) -> str | None:
    blocker = summary.get("blocker")
    if isinstance(blocker, str) and blocker.strip():
        return blocker.strip()
    guard = summary.get("strategyGuard")
    if isinstance(guard, dict) and guard.get("allowed") is not True:
        reason = live_scan_cycle.optional_text(guard.get("reason"), max_length=240)
        if reason:
            return reason
    gate = summary.get("accountGate")
    if isinstance(gate, dict):
        return live_scan_cycle.account_gate_blocker(gate)
    return None


def cycle_event_type(summary: dict[str, Any]) -> str:
    action = summary.get("action")
    if summary.get("windowGate") and action == "waiting_for_market_open":
        return "market_open_cycle_waiting_for_open"
    if summary.get("windowGate") and action == "market_closed":
        return "market_open_cycle_market_closed"
    return "market_open_cycle_complete"


def recorded_ticket_count(summary: dict[str, Any]) -> int:
    tickets = summary.get("recordedTickets")
    return len(tickets) if isinstance(tickets, list) else 0


def scorecard_count(summary: dict[str, Any]) -> int:
    readback = summary.get("scorecardReadback")
    if not isinstance(readback, dict):
        return 0
    return live_scan_cycle.int_text_value(readback.get("scorecardCount"))


def candidate_guard_inputs(candidate: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    values = {
        "symbol": live_scan_cycle.optional_text(candidate.get("symbol"), max_length=32),
        "side": live_scan_cycle.optional_text(candidate.get("side"), max_length=32),
        "entryLimitPrice": live_scan_cycle.numeric_text(candidate.get("entryLimitPrice")),
        "targetPrice": live_scan_cycle.numeric_text(candidate.get("targetPrice")),
        "stopPrice": live_scan_cycle.numeric_text(candidate.get("stopPrice")),
    }
    missing = [key for key, value in values.items() if not value]
    if values.get("side") not in {"buy", "sell"} and "side" not in missing:
        missing.append("side")
    return {key: value for key, value in values.items() if value is not None}, missing


def run_strategy_guard_for_summary(args: argparse.Namespace, summary: dict[str, Any]) -> dict[str, Any] | None:
    decision = summary.get("decisionSummary")
    if not isinstance(decision, dict) or decision.get("action") != "run_strategy_order_guard":
        return None
    candidate = decision.get("bestCandidate")
    if not isinstance(candidate, dict):
        return {
            "ran": False,
            "allowed": False,
            "reason": "strategy_guard_missing_candidate",
            "candidate": None,
        }
    values, missing = candidate_guard_inputs(candidate)
    compact_candidate = {
        "ticketId": candidate.get("ticketId"),
        "symbol": candidate.get("symbol"),
        "side": candidate.get("side"),
        "setupType": candidate.get("setupType"),
        "setupGrade": candidate.get("setupGrade"),
        "expectedR": candidate.get("expectedR"),
        "entryLimitPrice": candidate.get("entryLimitPrice"),
        "targetPrice": candidate.get("targetPrice"),
        "stopPrice": candidate.get("stopPrice"),
    }
    if missing:
        return {
            "ran": False,
            "allowed": False,
            "reason": "strategy_guard_missing_inputs",
            "missingFields": missing,
            "candidate": compact_candidate,
        }
    guard_args = strategy_order_guard.build_parser().parse_args(
        [
            "--symbol",
            values["symbol"],
            "--side",
            values["side"],
            "--entry-limit",
            values["entryLimitPrice"],
            "--take-profit-limit",
            values["targetPrice"],
            "--stop-loss-stop",
            values["stopPrice"],
            "--feed",
            args.feed,
            "--timeout-seconds",
            str(args.timeout_seconds),
        ]
    )
    try:
        result = strategy_order_guard.evaluate_order(guard_args)
    except Exception as error:
        return {
            "ran": False,
            "allowed": False,
            "reason": "strategy_guard_error",
            "error": str(error),
            "candidate": compact_candidate,
        }
    return {
        "ran": True,
        "allowed": bool(result.get("allowed")),
        "reason": result.get("reason"),
        "candidate": compact_candidate,
        "result": result,
    }


def record_cycle_complete(
    *,
    synthesis: SynthesisClient,
    session_id: str,
    summary: dict[str, Any],
) -> dict[str, Any]:
    cycle = live_scan_cycle.int_text_value(summary.get("cycle"))
    account = account_from_summary(summary)
    payload = {
        "runner": "market_open_cycle",
        "cycle": cycle,
        "cycleDir": summary.get("cycleDir"),
        "skipFullScan": bool(summary.get("skipFullScan")),
        "action": summary.get("action"),
        "resultCount": live_scan_cycle.int_text_value(summary.get("resultCount")),
        "recordedTicketCount": recorded_ticket_count(summary),
        "scorecardReadback": summary.get("scorecardReadback"),
        "recordedScorecardReadback": summary.get("recordedScorecardReadback"),
        "topResults": summary.get("topResults"),
        "decisionSummary": summary.get("decisionSummary"),
        "strategyGuard": summary.get("strategyGuard"),
        "accountGate": summary.get("accountGate"),
        "marketWindow": summary.get("marketWindow"),
        "windowGate": summary.get("windowGate"),
        "stageTimingsMs": summary.get("stageTimingsMs"),
    }
    status = synthesis.post(
        "/api/autotrader/status",
        {
            "sessionId": session_id,
            "cycle": cycle,
            "phase": cycle_phase(summary),
            "equity": live_scan_cycle.numeric_text(account.get("equity")),
            "buyingPower": live_scan_cycle.numeric_text(account.get("buying_power")),
            "daytradeBuyingPower": live_scan_cycle.numeric_text(account.get("daytrading_buying_power")),
            "currentAction": cycle_action(summary),
            "blocker": cycle_blocker(summary),
            "payload": payload,
        },
    )
    event = synthesis.post(
        "/api/autotrader/events",
        {
            "sessionId": session_id,
            "seq": cycle,
            "eventType": cycle_event_type(summary),
            "severity": "info",
            "payload": payload,
        },
    )
    return {
        "statusRecorded": isinstance(status, dict),
        "eventRecorded": isinstance(event, dict),
    }


def strategy_guard_report_value(summary: dict[str, Any]) -> str:
    guard = summary.get("strategyGuard")
    if not isinstance(guard, dict):
        return "not_run"
    if guard.get("allowed") is True:
        return f"allowed:{guard.get('reason')}"
    return f"blocked:{guard.get('reason')}"


def scan_args_for(args: argparse.Namespace, *, session_id: str, work_dir: Path) -> argparse.Namespace:
    argv = [
        "--work-dir",
        str(work_dir),
        "--session-id",
        session_id,
        "--record-tickets",
        "--respect-account-gate",
        "--feed",
        args.feed,
        "--scorecard-limit",
        str(args.scorecard_limit),
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--retain-cycles",
        str(args.retain_cycles),
        "--max-recorded-tickets",
        str(args.max_recorded_tickets),
    ]
    if args.synthesis_base_url:
        argv.extend(["--synthesis-base-url", args.synthesis_base_url])
    if args.analysis_context:
        argv.extend(["--analysis-context", args.analysis_context])
    else:
        argv.extend(["--analysis-context", str(work_dir / "analysis-context.json")])
    if args.stock_analysis_cli:
        argv.extend(["--stock-analysis-cli", args.stock_analysis_cli])
    if args.cycle is not None:
        argv.extend(["--cycle", str(args.cycle)])
    if args.start:
        argv.extend(["--start", args.start])
    if args.end:
        argv.extend(["--end", args.end])
    for symbol in args.watchlist:
        argv.extend(["--watchlist", symbol])
    return live_scan_cycle.build_parser().parse_args(argv)


def write_report(path: Path, result: dict[str, Any]) -> None:
    summary = result.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    path.parent.mkdir(parents=True, exist_ok=True)
    gate = summary.get("accountGate")
    management = gate.get("positionManagement") if isinstance(gate, dict) else None
    lines = [
        "# Autonomous Trader Report",
        "",
        "status: running",
        f"session_id: {result['sessionId']}",
        "mode: market-open",
        "cycle_runner: deterministic_market_open_cycle",
        f"cycle: {summary.get('cycle')}",
        f"phase: {cycle_phase(summary)}",
        f"action: {cycle_action(summary)}",
        f"skip_full_scan: {str(bool(summary.get('skipFullScan'))).lower()}",
        f"blocker: {cycle_blocker(summary) or 'none'}",
        f"result_count: {live_scan_cycle.int_text_value(summary.get('resultCount'))}",
        f"recorded_ticket_count: {recorded_ticket_count(summary)}",
        f"scorecard_count: {scorecard_count(summary)}",
        f"strategy_guard: {strategy_guard_report_value(summary)}",
    ]
    if isinstance(management, dict) and management.get("primaryAction"):
        lines.extend(
            [
                f"position_management: {management.get('primaryAction')}",
                f"position_management_reason: {management.get('primaryReason')}",
                f"position_management_action_required: {str(bool(management.get('actionRequired'))).lower()}",
            ]
        )
        positions = management.get("positions")
        first_position = positions[0] if isinstance(positions, list) and positions else None
        if isinstance(first_position, dict):
            lines.extend(
                [
                    f"managed_symbol: {first_position.get('symbol')}",
                    f"managed_open_r: {first_position.get('openR')}",
                    f"managed_stop_r: {first_position.get('stopR')}",
                    f"recommended_stop: {first_position.get('recommendedStopPrice')}",
                ]
            )
    lines.extend(
        [
            "",
            "Next: continue bounded market-open cycles until close, target, or hard stop.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def run_market_open_cycle(
    *,
    args: argparse.Namespace,
    synthesis: SynthesisClient,
) -> dict[str, Any]:
    work_dir = Path(args.work_dir)
    session_path = Path(args.session_path) if args.session_path else work_dir / "session.json"
    session_id = args.session_id.strip() if args.session_id else session_id_from_file(session_path)
    window = market_window(parse_datetime(args.now))
    if window["regularSession"]:
        scan_args = scan_args_for(args, session_id=session_id, work_dir=work_dir)
        summary = live_scan_cycle.run_cycle(scan_args)
        strategy_guard = run_strategy_guard_for_summary(args, summary)
        if strategy_guard is not None:
            summary["strategyGuard"] = strategy_guard
    else:
        summary = market_window_skip_summary(args=args, work_dir=work_dir, window=window)
    output = {
        "ok": True,
        "mode": "market-open-cycle",
        "sessionId": session_id,
        "summary": summary,
    }
    output["recordedCycleComplete"] = record_cycle_complete(synthesis=synthesis, session_id=session_id, summary=summary)
    write_json(work_dir / "last-cycle.json", output)
    write_report(Path(args.report_path), output)
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one deterministic market-open autotrader cycle.")
    parser.add_argument("--work-dir", default=os.environ.get("AUTONOMOUS_TRADER_WORK_DIR", "/tmp/autonomous-trader-work"))
    parser.add_argument("--session-path")
    parser.add_argument("--session-id")
    parser.add_argument("--cycle", type=int)
    parser.add_argument("--watchlist", action="append", default=[])
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--feed", default="iex")
    parser.add_argument("--scorecard-limit", type=int, default=20)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--synthesis-base-url")
    parser.add_argument("--analysis-context")
    parser.add_argument("--stock-analysis-cli")
    parser.add_argument("--retain-cycles", type=int, default=5)
    parser.add_argument("--max-recorded-tickets", type=int, default=10)
    parser.add_argument("--report-path", default="/workspace/.agentrun/autonomous-trader/report.md")
    parser.add_argument("--now")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "market-open-cycle",
                    "sessionSource": "session.json",
                    "recordTickets": True,
                    "respectAccountGate": True,
                    "marketWindowGate": True,
                },
                sort_keys=True,
                indent=2,
            )
        )
        return 0
    result = run_market_open_cycle(
        args=args,
        synthesis=SynthesisClient(base_url=args.synthesis_base_url, timeout_seconds=args.timeout_seconds),
    )
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

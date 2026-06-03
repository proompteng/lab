#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import live_scan_cycle
from synthesis_autotrader_client import SynthesisClient


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
        return f"market_open_cycle_account_gated; action={action}"
    top_results = summary.get("topResults")
    if isinstance(top_results, list) and top_results:
        first = top_results[0] if isinstance(top_results[0], dict) else {}
        symbol = first.get("symbol") or "unknown"
        grade = first.get("setup_grade") or first.get("setupGrade") or "unknown"
        setup = first.get("setup_type") or first.get("setupType") or "unknown"
        return f"market_open_cycle_complete; top={symbol} {grade} {setup}"
    return "market_open_cycle_complete; no_candidates"


def cycle_blocker(summary: dict[str, Any]) -> str | None:
    gate = summary.get("accountGate")
    if isinstance(gate, dict):
        return live_scan_cycle.account_gate_blocker(gate)
    return None


def recorded_ticket_count(summary: dict[str, Any]) -> int:
    tickets = summary.get("recordedTickets")
    return len(tickets) if isinstance(tickets, list) else 0


def scorecard_count(summary: dict[str, Any]) -> int:
    readback = summary.get("scorecardReadback")
    if not isinstance(readback, dict):
        return 0
    return live_scan_cycle.int_text_value(readback.get("scorecardCount"))


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
            "eventType": "market_open_cycle_complete",
            "severity": "info",
            "payload": payload,
        },
    )
    return {
        "statusRecorded": isinstance(status, dict),
        "eventRecorded": isinstance(event, dict),
    }


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
        f"result_count: {live_scan_cycle.int_text_value(summary.get('resultCount'))}",
        f"recorded_ticket_count: {recorded_ticket_count(summary)}",
        f"scorecard_count: {scorecard_count(summary)}",
        "",
        "Next: continue bounded market-open cycles until close, target, or hard stop.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def run_market_open_cycle(
    *,
    args: argparse.Namespace,
    synthesis: SynthesisClient,
) -> dict[str, Any]:
    work_dir = Path(args.work_dir)
    session_path = Path(args.session_path) if args.session_path else work_dir / "session.json"
    session_id = args.session_id.strip() if args.session_id else session_id_from_file(session_path)
    scan_args = scan_args_for(args, session_id=session_id, work_dir=work_dir)
    summary = live_scan_cycle.run_cycle(scan_args)
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

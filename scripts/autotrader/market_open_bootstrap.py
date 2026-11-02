#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import live_scan_cycle
from scorecard_readback import decimal_text, session_id_from_start, start_session_payload
from synthesis_autotrader_client import SynthesisClient


def parse_datetime(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def file_sha256(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_head(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    head = result.stdout.strip()
    return head or None


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, separators=(',', ':'), sort_keys=True)}\n", encoding="utf-8")


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Autonomous Trader Report",
        "",
        "status: running",
        f"session_id: {payload['sessionId']}",
        f"agent_run: {payload['agentRunName']}",
        "mode: market-open",
        "bootstrap: deterministic_session_started",
        f"account_gate_action: {payload['accountGate']['action']}",
        f"open_positions: {payload['accountGate']['openPositionCount']}",
        f"open_orders: {payload['accountGate']['openOrderCount']}",
        f"analysis_head: {payload.get('analysisHead') or 'unknown'}",
        f"analysis_context_hash: {payload.get('analysisContextHash') or 'unknown'}",
        "",
        "Next: run live scan cycles with the recorded session id and respect account-gate output.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def run_bootstrap(
    *,
    synthesis: SynthesisClient,
    alpaca: live_scan_cycle.AlpacaRestClient,
    now: datetime,
    agent_run_name: str,
    session_mode: str,
    goal_equity: str,
    work_dir: Path,
    report_path: Path,
    analysis_dir: Path,
    analysis_context_path: Path,
) -> dict[str, Any]:
    june3_replay_gate = live_scan_cycle.run_june3_failure_path_replay()
    if not june3_replay_gate.get("ok"):
        raise RuntimeError(
            "market-open safety regression failed: "
            + json.dumps(june3_replay_gate.get("failures", []), sort_keys=True)
        )
    broker_state = live_scan_cycle.fetch_broker_state(alpaca)
    account = broker_state.get("account")
    if not isinstance(account, dict):
        raise ValueError("broker account state must be an object")
    account_gate = live_scan_cycle.summarize_broker_state(broker_state)
    blocker = live_scan_cycle.account_gate_blocker(account_gate)
    analysis_head = git_head(analysis_dir)
    analysis_context_hash = file_sha256(analysis_context_path)
    start_payload = start_session_payload(
        agent_run_name=agent_run_name,
        mode=session_mode,
        account=account,
        goal_equity=goal_equity,
        now=now,
    )
    if analysis_head:
        start_payload["analysisHead"] = analysis_head
    if analysis_context_hash:
        start_payload["analysisContextHash"] = analysis_context_hash

    session_id = session_id_from_start(synthesis.post("/api/autotrader/sessions", start_payload))
    status_payload = {
        "sessionId": session_id,
        "cycle": 0,
        "phase": live_scan_cycle.account_gate_status_phase(account_gate),
        "equity": decimal_text(account.get("equity")),
        "buyingPower": decimal_text(account.get("buying_power")),
        "daytradeBuyingPower": decimal_text(account.get("daytrading_buying_power") or account.get("daytrade_buying_power")),
        "currentAction": "market_open_bootstrap_complete; " + live_scan_cycle.account_gate_current_action(account_gate),
        "blocker": blocker,
        "payload": {
            "bootstrap": "market_open_session",
            "accountGate": account_gate,
            "analysisHead": analysis_head,
            "analysisContextHash": analysis_context_hash,
            "june3FailurePathReplayGate": june3_replay_gate,
        },
    }
    synthesis.post("/api/autotrader/status", status_payload)
    synthesis.post(
        "/api/autotrader/events",
        {
            "sessionId": session_id,
            "seq": 0,
            "eventType": "market_open_bootstrap_complete",
            "severity": "info",
            "payload": status_payload["payload"],
        },
    )

    result = {
        "ok": True,
        "mode": "market-open-bootstrap",
        "sessionId": session_id,
        "agentRunName": agent_run_name,
        "sessionMode": session_mode,
        "accountGate": account_gate,
        "analysisHead": analysis_head,
        "analysisContextHash": analysis_context_hash,
        "june3FailurePathReplayGate": june3_replay_gate,
        "nextCommand": (
            "python3 /workspace/lab/scripts/autotrader/market_open_cycle.py"
        ),
    }
    write_json(work_dir / "session.json", result)
    write_report(report_path, result)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Start and checkpoint a market-open autotrader session.")
    parser.add_argument("--base-url")
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--agent-run-name", default=os.environ.get("AGENT_RUN_NAME", "autonomous-trader-market-open"))
    parser.add_argument("--session-mode", default=os.environ.get("AUTONOMOUS_TRADER_SYNTHESIS_SESSION_MODE", "market_open"))
    parser.add_argument("--goal-equity", default=os.environ.get("AUTONOMOUS_TRADER_TARGET_EQUITY_USD", "500000"))
    parser.add_argument("--work-dir", default=os.environ.get("AUTONOMOUS_TRADER_WORK_DIR", "/tmp/autonomous-trader-work"))
    parser.add_argument("--report-path", default="/workspace/.agentrun/autonomous-trader/report.md")
    parser.add_argument("--analysis-dir", default=os.environ.get("ANALYSIS_REPO_DIR", "/workspace/analysis"))
    parser.add_argument(
        "--analysis-context",
        default=os.path.join(os.environ.get("AUTONOMOUS_TRADER_WORK_DIR", "/tmp/autonomous-trader-work"), "analysis-context.json"),
    )
    parser.add_argument("--now")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        june3_replay_gate = live_scan_cycle.run_june3_failure_path_replay()
        if not june3_replay_gate.get("ok"):
            raise RuntimeError(
                "market-open safety regression failed: "
                + json.dumps(june3_replay_gate.get("failures", []), sort_keys=True)
            )
        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "market-open-bootstrap",
                    "sessionMode": args.session_mode,
                    "workDir": args.work_dir,
                    "analysisContext": args.analysis_context,
                    "june3FailurePathReplayGate": june3_replay_gate,
                },
                sort_keys=True,
                indent=2,
            )
        )
        return 0
    result = run_bootstrap(
        synthesis=SynthesisClient(base_url=args.base_url, timeout_seconds=args.timeout_seconds),
        alpaca=live_scan_cycle.AlpacaRestClient(timeout_seconds=args.timeout_seconds),
        now=parse_datetime(args.now),
        agent_run_name=args.agent_run_name.strip() or "autonomous-trader-market-open",
        session_mode=args.session_mode.strip() or "market_open",
        goal_equity=args.goal_equity,
        work_dir=Path(args.work_dir),
        report_path=Path(args.report_path),
        analysis_dir=Path(args.analysis_dir),
        analysis_context_path=Path(args.analysis_context),
    )
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

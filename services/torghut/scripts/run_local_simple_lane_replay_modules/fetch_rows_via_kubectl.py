# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python3
"""Replay one trading session through Torghut's simple execution lane locally."""
# ruff: noqa: E402,F811

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

# ruff: noqa: F401,F403,F405,F821,F821,F821

from .shared_context import (
    ALLOWED_REJECT_REASONS,
    Base,
    BucketReplayIngestor,
    ClickHouseSignalIngestor,
    DEFAULT_CLICKHOUSE_NAMESPACE,
    DEFAULT_CLICKHOUSE_POD,
    DEFAULT_CLICKHOUSE_URL,
    DEFAULT_END,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_START,
    DEFAULT_SYMBOLS,
    DecisionEngine,
    ESSENTIAL_SIGNAL_COLUMNS,
    Execution,
    LocalSimulationBroker,
    OrderExecutor,
    OrderFirewall,
    REPO_ROOT,
    Reconciler,
    ReplayArtifacts,
    RiskEngine,
    SCRIPT_DIR,
    SERVICE_ROOT,
    SignalBatch,
    SignalEnvelope,
    SimpleTradingPipeline,
    SimulationExecutionAdapter,
    Strategy,
    StrategyConfig,
    TradeDecision,
    TradingState,
    UniverseResolver,
    _compose_strategy_description,
    _configure_replay_settings,
    _fetch_signals_adaptive,
    _fetch_signals_window,
    _load_enabled_strategies,
    _parse_timestamp,
    _seed_strategies,
    config,
    logger,
    main,
    parse_args,
)


def _fetch_rows_via_kubectl(
    *,
    symbol: str,
    start: datetime,
    end: datetime,
    clickhouse_namespace: str,
    clickhouse_pod: str,
    kubectl_context: str,
    clickhouse_username: str,
    clickhouse_password: str,
    clickhouse_table: str,
) -> list[dict[str, Any]]:
    start_literal = _to_ch_datetime64(start)
    end_literal = _to_ch_datetime64(end)
    select_expr = ", ".join(ESSENTIAL_SIGNAL_COLUMNS)
    query = (
        f"SELECT {select_expr} "
        f"FROM {clickhouse_table} "
        f"WHERE symbol = '{symbol}' "
        f"AND event_ts >= {start_literal} "
        f"AND event_ts <= {end_literal} "
        "ORDER BY event_ts ASC, seq ASC "
        "FORMAT JSONEachRow"
    )
    kubectl_cmd = ["kubectl"]
    if kubectl_context.strip():
        kubectl_cmd.extend(["--context", kubectl_context.strip()])
    kubectl_cmd.extend(
        [
            "exec",
            "-n",
            clickhouse_namespace,
            clickhouse_pod,
            "--",
            "clickhouse-client",
            "--user",
            clickhouse_username,
            "--password",
            clickhouse_password,
            "--query",
            query,
        ]
    )
    result = subprocess.run(
        kubectl_cmd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(detail[:400])
    rows: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        normalized = line.strip()
        if not normalized:
            continue
        rows.append(json.loads(normalized))
    return rows


def _to_ch_datetime64(value: datetime) -> str:
    timestamp = value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    return f"toDateTime64('{timestamp}', 3, 'UTC')"


def _bucket_signals(
    signals: list[SignalEnvelope],
    *,
    bucket_seconds: int,
) -> list[list[SignalEnvelope]]:
    if not signals:
        return []
    buckets: list[list[SignalEnvelope]] = []
    current_bucket: list[SignalEnvelope] = []
    current_key: datetime | None = None
    for signal in signals:
        bucket_key = _bucket_start(signal.event_ts, bucket_seconds=bucket_seconds)
        if current_key is None or bucket_key != current_key:
            if current_bucket:
                buckets.append(current_bucket)
            current_bucket = [signal]
            current_key = bucket_key
            continue
        current_bucket.append(signal)
    if current_bucket:
        buckets.append(current_bucket)
    return buckets


def _bucket_start(timestamp: datetime, *, bucket_seconds: int) -> datetime:
    epoch_seconds = int(timestamp.timestamp())
    bucket_epoch = epoch_seconds - (epoch_seconds % max(bucket_seconds, 1))
    return datetime.fromtimestamp(bucket_epoch, tz=timezone.utc)


def _signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, int]:
    return (
        signal.event_ts,
        signal.symbol,
        int(signal.seq or 0),
    )


def _build_artifacts(
    *,
    session_local: sessionmaker[Session],
    pipeline: SimpleTradingPipeline,
    output_dir: Path,
    start: datetime,
    end: datetime,
    symbols: list[str],
    strategies: list[dict[str, Any]],
    signal_fetch_counts: dict[str, int],
    total_signals: int,
    replay_buckets: int,
    reconcile_updates: int,
) -> ReplayArtifacts:
    with session_local() as session:
        decisions = list(session.execute(select(TradeDecision)).scalars())
        executions = list(session.execute(select(Execution)).scalars())
    decision_status_totals = Counter(decision.status for decision in decisions)
    execution_status_totals = Counter(execution.status for execution in executions)
    reject_reasons = Counter()
    block_reasons = Counter()
    lane_values = Counter()
    submit_paths = Counter()
    for decision in decisions:
        payload = _mapping(decision.decision_json)
        params = _mapping(payload.get("params"))
        lane_values.update([str(params.get("execution_lane") or "")])
        submit_paths.update([str(params.get("submit_path") or "")])
        reject_reasons.update(_string_list(payload.get("risk_reasons")))
        if payload.get("submission_block_reason"):
            block_reasons.update([str(payload["submission_block_reason"])])
    proof_floor_blocker_evidence = _proof_floor_blocker_evidence(decisions)
    governance_blockers = sorted(
        reason for reason in block_reasons if _is_governance_block_reason(reason)
    )
    invalid_reject_reasons = sorted(
        reason for reason in reject_reasons if reason not in ALLOWED_REJECT_REASONS
    )
    runtime_verify = {
        "runtime_state": "ready",
        "pipeline_mode": config.settings.trading_pipeline_mode,
        "execution_lane": "simple",
        "submit_path": "direct_alpaca",
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "strategy_names": [str(item.get("name")) for item in strategies],
        "strategy_count": len(strategies),
        "symbols": symbols,
        "signal_fetch_counts": signal_fetch_counts,
        "signals_total": total_signals,
        "replay_bucket_count": replay_buckets,
        "output_dir": str(output_dir),
    }
    replay_report = {
        "pipeline_mode": config.settings.trading_pipeline_mode,
        "execution_lane": "simple",
        "signals_total": total_signals,
        "decision_total": len(decisions),
        "orders_submitted_total": decision_status_totals.get("submitted", 0),
        "rejected_total": decision_status_totals.get("rejected", 0),
        "blocked_total": decision_status_totals.get("blocked", 0),
        "executions_total": len(executions),
        "decision_status_totals": dict(decision_status_totals),
        "execution_status_totals": dict(execution_status_totals),
        "reject_reason_totals": dict(reject_reasons),
        "block_reason_totals": dict(block_reasons),
        "reconcile_updates": reconcile_updates,
        "metrics": {
            "orders_submitted_total": pipeline.state.metrics.orders_submitted_total,
            "orders_rejected_total": pipeline.state.metrics.orders_rejected_total,
            "decisions_total": pipeline.state.metrics.decisions_total,
            "reconcile_updates_total": pipeline.state.metrics.reconcile_updates_total,
        },
    }
    decision_activity = {
        "pipeline_mode": "simple",
        "trade_decisions": len(decisions),
        "decision_status_totals": dict(decision_status_totals),
        "reject_reason_totals": dict(reject_reasons),
        "block_reason_totals": dict(block_reasons),
        "execution_lane_totals": {
            key: value for key, value in lane_values.items() if key
        },
        "submit_path_totals": {
            key: value for key, value in submit_paths.items() if key
        },
    }
    if proof_floor_blocker_evidence:
        decision_activity["proof_floor_blocker_evidence"] = proof_floor_blocker_evidence
    execution_activity = {
        "pipeline_mode": "simple",
        "executions": len(executions),
        "execution_status_totals": dict(execution_status_totals),
        "reconcile_updates": reconcile_updates,
    }
    acceptance = {
        "executions_non_zero": len(executions) > 0,
        "capital_stage_shadow_blocks_zero": block_reasons.get("capital_stage_shadow", 0)
        == 0,
        "alpha_readiness_blocks_zero": not any(
            reason.startswith("alpha_readiness_") for reason in block_reasons
        ),
        "dependency_quorum_blocks_zero": not any(
            reason.startswith("dependency_quorum_") for reason in block_reasons
        ),
        "market_context_blocks_zero": not any(
            reason.startswith("market_context") for reason in block_reasons
        ),
        "llm_blocks_zero": not any(
            reason.startswith("llm_") for reason in block_reasons
        ),
        "reject_reasons_within_simple_allowlist": not invalid_reject_reasons,
        "reconciliation_updates_persisted": reconcile_updates >= 0,
        "governance_blockers": governance_blockers,
        "invalid_reject_reasons": invalid_reject_reasons,
    }
    acceptance["passed"] = all(
        bool(value)
        for key, value in acceptance.items()
        if key not in {"governance_blockers", "invalid_reject_reasons"}
    )
    run_summary = {
        "run_token": "local-simple-20260326",
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "pipeline_mode": "simple",
        "execution_lane": "simple",
        "signals_total": total_signals,
        "decision_total": len(decisions),
        "executions_total": len(executions),
        "acceptance": acceptance,
        "artifacts": {
            "runtime_verify_path": str(output_dir / "runtime-verify.json"),
            "replay_report_path": str(output_dir / "replay-report.json"),
            "decision_activity_path": str(output_dir / "decision-activity.json"),
            "execution_activity_path": str(output_dir / "execution-activity.json"),
            "run_summary_path": str(output_dir / "run-summary.json"),
        },
    }
    if proof_floor_blocker_evidence:
        run_summary["proof_floor_blocker_evidence"] = proof_floor_blocker_evidence
    return ReplayArtifacts(
        runtime_verify=runtime_verify,
        replay_report=replay_report,
        decision_activity=decision_activity,
        execution_activity=execution_activity,
        run_summary=run_summary,
    )


def _write_artifacts(*, output_dir: Path, artifacts: ReplayArtifacts) -> None:
    _write_json(output_dir / "runtime-verify.json", artifacts.runtime_verify)
    _write_json(output_dir / "replay-report.json", artifacts.replay_report)
    _write_json(output_dir / "decision-activity.json", artifacts.decision_activity)
    _write_json(output_dir / "execution-activity.json", artifacts.execution_activity)
    _write_json(output_dir / "run-summary.json", artifacts.run_summary)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def _counter_to_dict(counter: Counter[str]) -> dict[str, int]:
    return {key: int(value) for key, value in counter.items() if key}


def _proof_floor_blocker_evidence(decisions: list[TradeDecision]) -> dict[str, Any]:
    floor_count = 0
    blocking_reasons: Counter[str] = Counter()
    alpha_reason_totals: Counter[str] = Counter()
    dimension_totals: dict[str, Counter[str]] = {}
    repair_targets: dict[str, dict[str, Any]] = {}
    repair_ladder: dict[str, dict[str, Any]] = {}
    routeable_symbols: set[str] = set()
    missing_symbols: set[str] = set()
    blocked_symbols: set[str] = set()

    for decision in decisions:
        payload = _mapping(decision.decision_json)
        proof_floor = _mapping(payload.get("profitability_proof_floor"))
        if not proof_floor:
            continue
        floor_count += 1
        blocking_reasons.update(_string_list(proof_floor.get("blocking_reasons")))

        raw_dimensions = proof_floor.get("proof_dimensions")
        if isinstance(raw_dimensions, list):
            for raw_dimension in raw_dimensions:
                dimension = _mapping(raw_dimension)
                name = str(dimension.get("dimension") or "").strip()
                if not name:
                    continue
                state = str(dimension.get("state") or "").strip() or "unknown"
                reason = str(dimension.get("reason") or "").strip() or "unknown"
                dimension_totals.setdefault(name, Counter()).update(
                    [f"{state}:{reason}"]
                )
                source_ref = _mapping(dimension.get("source_ref"))
                if name == "alpha_readiness":
                    raw_reason_totals = _mapping(source_ref.get("reason_totals"))
                    for reason_code, count in raw_reason_totals.items():
                        alpha_reason_totals[str(reason_code)] += int(count or 0)
                    raw_targets = source_ref.get("repair_targets")
                    if isinstance(raw_targets, list):
                        for raw_target in raw_targets:
                            target = _mapping(raw_target)
                            hypothesis_id = str(
                                target.get("hypothesis_id") or ""
                            ).strip()
                            if hypothesis_id:
                                repair_targets[hypothesis_id] = target
                if name == "execution_tca":
                    symbol_routes = _mapping(source_ref.get("symbol_routes"))
                    for symbol in symbol_routes.get("routeable_symbols") or []:
                        item = _mapping(symbol)
                        raw_symbol = item.get("symbol") if item else symbol
                        if raw_symbol:
                            routeable_symbols.add(str(raw_symbol))
                    for symbol in symbol_routes.get("missing_symbols") or []:
                        if symbol:
                            missing_symbols.add(str(symbol))
                    for symbol in symbol_routes.get("blocked_symbols") or []:
                        item = _mapping(symbol)
                        raw_symbol = item.get("symbol") if item else symbol
                        if raw_symbol:
                            blocked_symbols.add(str(raw_symbol))

        raw_ladder = proof_floor.get("repair_ladder")
        if isinstance(raw_ladder, list):
            for raw_item in raw_ladder:
                item = _mapping(raw_item)
                code = str(item.get("code") or "").strip()
                if code and code not in repair_ladder:
                    repair_ladder[code] = item

    if floor_count == 0:
        return {}
    return {
        "proof_floor_count": floor_count,
        "blocking_reason_totals": _counter_to_dict(blocking_reasons),
        "dimension_state_reason_totals": {
            name: _counter_to_dict(counter)
            for name, counter in sorted(dimension_totals.items())
        },
        "alpha_reason_totals": _counter_to_dict(alpha_reason_totals),
        "alpha_repair_targets": [repair_targets[key] for key in sorted(repair_targets)],
        "execution_tca": {
            "routeable_symbols": sorted(routeable_symbols),
            "missing_symbols": sorted(missing_symbols),
            "blocked_symbols": sorted(blocked_symbols),
        },
        "repair_ladder": [
            repair_ladder[key]
            for key in sorted(
                repair_ladder,
                key=lambda code: int(repair_ladder[code].get("priority") or 0),
                reverse=True,
            )
        ],
    }


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _is_governance_block_reason(reason: str) -> bool:
    return (
        reason == "capital_stage_shadow"
        or reason.startswith("alpha_readiness_")
        or reason.startswith("dependency_quorum_")
        or reason.startswith("market_context")
        or reason.startswith("llm_")
    )


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [name for name in globals() if not name.startswith("__")]

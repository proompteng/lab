#!/usr/bin/env python3
"""Replay one trading session through Torghut's simple execution lane locally."""

from __future__ import annotations

import json
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeAlias

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

if TYPE_CHECKING:
    from app.models import TradeDecision as TradeDecisionT
    from app.trading.models import SignalEnvelope as SignalEnvelopeT
    from app.trading.scheduler.simple_pipeline import (
        SimpleTradingPipeline as SimpleTradingPipelineT,
    )
else:
    SignalEnvelopeT: TypeAlias = Any
    SimpleTradingPipelineT: TypeAlias = Any
    TradeDecisionT: TypeAlias = Any


from .shared_context import (
    ALLOWED_REJECT_REASONS,
    ESSENTIAL_SIGNAL_COLUMNS,
    Execution,
    ReplayArtifacts,
    TradeDecision,
    config,
    main,
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
    signals: list[SignalEnvelopeT],
    *,
    bucket_seconds: int,
) -> list[list[SignalEnvelopeT]]:
    if not signals:
        return []
    buckets: list[list[SignalEnvelopeT]] = []
    current_bucket: list[SignalEnvelopeT] = []
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


def _signal_sort_key(signal: SignalEnvelopeT) -> tuple[datetime, str, int]:
    return (
        signal.event_ts,
        signal.symbol,
        int(signal.seq or 0),
    )


def _build_artifacts(
    *,
    session_local: sessionmaker[Session],
    pipeline: SimpleTradingPipelineT,
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


@dataclass
class _ProofFloorEvidenceAccumulator:
    floor_count: int = 0
    blocking_reasons: Counter[str] = field(default_factory=Counter)
    alpha_reason_totals: Counter[str] = field(default_factory=Counter)
    dimension_totals: dict[str, Counter[str]] = field(default_factory=dict)
    repair_targets: dict[str, dict[str, Any]] = field(default_factory=dict)
    repair_ladder: dict[str, dict[str, Any]] = field(default_factory=dict)
    routeable_symbols: set[str] = field(default_factory=set)
    missing_symbols: set[str] = field(default_factory=set)
    blocked_symbols: set[str] = field(default_factory=set)

    def record_decision(self, decision: TradeDecisionT) -> None:
        payload = _mapping(decision.decision_json)
        proof_floor = _mapping(payload.get("profitability_proof_floor"))
        if not proof_floor:
            return
        self.floor_count += 1
        self.blocking_reasons.update(_string_list(proof_floor.get("blocking_reasons")))
        self._record_dimensions(proof_floor.get("proof_dimensions"))
        self._record_repair_ladder(proof_floor.get("repair_ladder"))

    def _record_dimensions(self, raw_dimensions: Any) -> None:
        if not isinstance(raw_dimensions, list):
            return
        for raw_dimension in raw_dimensions:
            self._record_dimension(_mapping(raw_dimension))

    def _record_dimension(self, dimension: dict[str, Any]) -> None:
        name = str(dimension.get("dimension") or "").strip()
        if not name:
            return
        state = str(dimension.get("state") or "").strip() or "unknown"
        reason = str(dimension.get("reason") or "").strip() or "unknown"
        self.dimension_totals.setdefault(name, Counter()).update([f"{state}:{reason}"])
        source_ref = _mapping(dimension.get("source_ref"))
        if name == "alpha_readiness":
            self._record_alpha_source(source_ref)
        if name == "execution_tca":
            self._record_execution_tca_source(source_ref)

    def _record_alpha_source(self, source_ref: dict[str, Any]) -> None:
        for reason_code, count in _mapping(source_ref.get("reason_totals")).items():
            self.alpha_reason_totals[str(reason_code)] += int(count or 0)
        raw_targets = source_ref.get("repair_targets")
        if not isinstance(raw_targets, list):
            return
        for raw_target in raw_targets:
            target = _mapping(raw_target)
            hypothesis_id = str(target.get("hypothesis_id") or "").strip()
            if hypothesis_id:
                self.repair_targets[hypothesis_id] = target

    def _record_execution_tca_source(self, source_ref: dict[str, Any]) -> None:
        symbol_routes = _mapping(source_ref.get("symbol_routes"))
        self._record_route_symbols(
            symbol_routes.get("routeable_symbols"),
            self.routeable_symbols,
            unwrap_mapping=True,
        )
        self._record_route_symbols(
            symbol_routes.get("missing_symbols"), self.missing_symbols
        )
        self._record_route_symbols(
            symbol_routes.get("blocked_symbols"),
            self.blocked_symbols,
            unwrap_mapping=True,
        )

    @staticmethod
    def _record_route_symbols(
        raw_symbols: Any,
        target_symbols: set[str],
        *,
        unwrap_mapping: bool = False,
    ) -> None:
        if not isinstance(raw_symbols, list):
            return
        for symbol in raw_symbols:
            item = _mapping(symbol) if unwrap_mapping else {}
            raw_symbol = item.get("symbol") if item else symbol
            if raw_symbol:
                target_symbols.add(str(raw_symbol))

    def _record_repair_ladder(self, raw_ladder: Any) -> None:
        if not isinstance(raw_ladder, list):
            return
        for raw_item in raw_ladder:
            item = _mapping(raw_item)
            code = str(item.get("code") or "").strip()
            if code and code not in self.repair_ladder:
                self.repair_ladder[code] = item

    def to_payload(self) -> dict[str, Any]:
        if self.floor_count == 0:
            return {}
        return {
            "proof_floor_count": self.floor_count,
            "blocking_reason_totals": _counter_to_dict(self.blocking_reasons),
            "dimension_state_reason_totals": {
                name: _counter_to_dict(counter)
                for name, counter in sorted(self.dimension_totals.items())
            },
            "alpha_reason_totals": _counter_to_dict(self.alpha_reason_totals),
            "alpha_repair_targets": [
                self.repair_targets[key] for key in sorted(self.repair_targets)
            ],
            "execution_tca": {
                "routeable_symbols": sorted(self.routeable_symbols),
                "missing_symbols": sorted(self.missing_symbols),
                "blocked_symbols": sorted(self.blocked_symbols),
            },
            "repair_ladder": [
                self.repair_ladder[key]
                for key in sorted(
                    self.repair_ladder,
                    key=lambda code: int(self.repair_ladder[code].get("priority") or 0),
                    reverse=True,
                )
            ],
        }


def _proof_floor_blocker_evidence(decisions: list[TradeDecisionT]) -> dict[str, Any]:
    accumulator = _ProofFloorEvidenceAccumulator()
    for decision in decisions:
        accumulator.record_decision(decision)
    return accumulator.to_payload()


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

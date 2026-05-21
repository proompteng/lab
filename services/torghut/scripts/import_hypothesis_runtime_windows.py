#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import psycopg

from app.db import SessionLocal
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
    RuntimeLedgerFill,
    build_runtime_ledger_buckets,
)
from app.trading.runtime_window_import import (
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
    resolve_hypothesis_manifest,
)

EXECUTION_ELIGIBLE_DECISION_STATUSES = (
    "submitted",
    "filled",
    "partially_filled",
)
POST_COST_BASIS_RUNTIME_LEDGER = POST_COST_PNL_BASIS
POST_COST_BASIS_SIMULATION_REPORT = "simulation_report_net_pnl"
POST_COST_BASIS_TCA_PROXY = "tca_shortfall_proxy"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import observed runtime windows into strategy hypothesis governance tables.",
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--candidate-id", default="")
    parser.add_argument("--hypothesis-id", required=True)
    parser.add_argument("--observed-stage", required=True, choices=("paper", "live"))
    parser.add_argument("--strategy-family", default="")
    parser.add_argument("--source-dsn", default="")
    parser.add_argument("--source-dsn-env", default="DB_DSN")
    parser.add_argument("--strategy-name", required=True)
    parser.add_argument("--account-label", required=True)
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--bucket-minutes", type=int, default=30)
    parser.add_argument("--sample-minutes", type=int, default=5)
    parser.add_argument("--source-manifest-ref", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--dataset-snapshot-ref", default="")
    parser.add_argument("--artifact-ref", action="append", default=[])
    parser.add_argument(
        "--target-metadata-json",
        default="",
        help=(
            "JSON object copied from the candidate-board runtime-window target. "
            "Used for evidence-collection-only paper probation handoffs."
        ),
    )
    parser.add_argument("--delay-adjusted-depth-stress-report-ref", default="")
    parser.add_argument("--dependency-quorum-decision", default="allow")
    parser.add_argument("--continuity-ok", default="true")
    parser.add_argument("--drift-ok", default="true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _flag(value: str) -> bool:
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


def _parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _as_mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _parse_target_metadata(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception as exc:
        raise RuntimeError("target_metadata_json_invalid") from exc
    if not isinstance(payload, Mapping):
        raise RuntimeError("target_metadata_json_not_mapping")
    return {str(key): value for key, value in payload.items()}


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _row_payloads(row: Mapping[str, object]) -> list[Mapping[str, object]]:
    payloads: list[Mapping[str, object]] = [row]
    for key in ("execution_audit_json", "raw_order"):
        payload = row.get(key)
        if isinstance(payload, Mapping):
            payloads.append({str(item_key): item for item_key, item in payload.items()})
    return payloads


def _first_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None:
                return parsed
    return None


def _first_text(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            text = str(payload.get(key) or "").strip()
            if text:
                return text
    return None


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def _strategy_name_candidates(*values: str | None) -> list[str]:
    candidates: list[str] = []
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        variants = [
            raw,
            raw.split("@", 1)[0],
            raw.replace("_", "-"),
            raw.split("@", 1)[0].replace("_", "-"),
        ]
        for variant in variants:
            normalized = variant.strip()
            if normalized and normalized not in candidates:
                candidates.append(normalized)
    return candidates


def _execution_signed_qty(*, side: Any, qty: Any) -> Decimal:
    normalized_side = str(side or "").strip().lower()
    quantity = _decimal_or_none(qty)
    if quantity is None or quantity <= 0:
        return Decimal("0")
    if normalized_side == "buy":
        return quantity
    if normalized_side == "sell":
        return -quantity
    return Decimal("0")


def _build_realized_strategy_pnl_rows(
    execution_rows: list[dict[str, object]],
) -> list[dict[str, object]]:
    ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    event_times: list[datetime] = []
    for row in execution_rows:
        computed_at = row.get("computed_at")
        price = _decimal_or_none(row.get("avg_fill_price"))
        signed_qty = _execution_signed_qty(
            side=row.get("side"), qty=row.get("filled_qty")
        )
        symbol = str(row.get("symbol") or "").strip().upper()
        if not symbol or not isinstance(computed_at, datetime):
            continue
        event_times.append(computed_at)
        decision_id = _first_text(
            row, "decision_id", "trade_decision_id", "decision_hash"
        )
        order_id = _first_text(
            row,
            "order_id",
            "alpaca_order_id",
            "client_order_id",
            "execution_correlation_id",
        )
        common_ledger_fields = {
            "executed_at": computed_at,
            "account_label": str(row.get("account_label") or "") or None,
            "strategy_id": str(row.get("strategy_id") or "") or None,
            "symbol": symbol,
            "decision_id": decision_id,
            "order_id": order_id,
            "execution_policy_hash": _first_text(
                row,
                "execution_policy_hash",
                "execution_policy_sha256",
                "policy_hash",
                "execution_idempotency_key",
            ),
            "cost_model_hash": _first_text(
                row, "cost_model_hash", "fee_model_hash", "cost_model_sha256"
            ),
            "lineage_hash": _first_text(
                row,
                "lineage_hash",
                "candidate_lineage_hash",
                "replay_lineage_hash",
                "candidate_evaluation_key",
            ),
            "replay_data_hash": _first_text(
                row,
                "replay_data_hash",
                "replay_tape_content_sha256",
                "dataset_snapshot_hash",
                "source_query_digest",
            ),
        }
        if decision_id is not None:
            ledger_rows.append({**common_ledger_fields, "event_type": "decision"})
        if order_id is not None:
            ledger_rows.append(
                {**common_ledger_fields, "event_type": "order_submitted"}
            )
        if price is None or price <= 0 or signed_qty == 0:
            continue
        cost_amount = _first_decimal(
            row,
            "cost_amount",
            "explicit_cost",
            "commission",
            "fees",
            "fee_amount",
            "broker_fee",
        )
        cost_basis = _first_text(
            row,
            "cost_basis",
            "cost_source",
            "fee_basis",
            "commission_basis",
            "broker_fee_basis",
        )
        ledger_rows.append(
            RuntimeLedgerFill(
                executed_at=computed_at,
                event_type="fill",
                decision_id=decision_id,
                order_id=order_id,
                execution_policy_hash=common_ledger_fields["execution_policy_hash"],
                cost_model_hash=common_ledger_fields["cost_model_hash"],
                lineage_hash=common_ledger_fields["lineage_hash"],
                replay_data_hash=common_ledger_fields["replay_data_hash"],
                side=str(row.get("side") or ""),
                filled_qty=abs(signed_qty),
                avg_fill_price=price,
                cost_amount=cost_amount,
                cost_basis=cost_basis,
                account_label=str(row.get("account_label") or "") or None,
                strategy_id=str(row.get("strategy_id") or "") or None,
                symbol=symbol,
            )
        )
    if not event_times:
        return []
    unique_times = sorted(set(event_times))
    bucket_ranges = [(unique_times[0], unique_times[-1] + timedelta(microseconds=1))]
    realized_rows: list[dict[str, object]] = []
    for bucket in build_runtime_ledger_buckets(
        ledger_rows,
        bucket_ranges=bucket_ranges,
        require_order_lifecycle=True,
    ):
        if bucket.closed_trade_count <= 0 and not bucket.blockers:
            continue
        promotion_eligible = (
            bucket.post_cost_expectancy_bps is not None and not bucket.blockers
        )
        realized_rows.append(
            {
                "computed_at": unique_times[-1],
                "abs_slippage_bps": (
                    (bucket.cost_amount / bucket.filled_notional) * Decimal("10000")
                    if bucket.filled_notional > 0
                    else None
                ),
                "post_cost_expectancy_bps": bucket.post_cost_expectancy_bps,
                "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                "post_cost_promotion_eligible": promotion_eligible,
                "realized_gross_pnl": bucket.gross_strategy_pnl,
                "realized_net_pnl": bucket.net_strategy_pnl_after_costs,
                "turnover_notional": bucket.filled_notional,
                "runtime_ledger_blockers": bucket.blockers,
                "runtime_ledger_cost_basis_counts": bucket.cost_basis_counts,
                "runtime_ledger_pnl_basis": bucket.pnl_basis,
                "runtime_ledger_bucket": {
                    "bucket_started_at": bucket.bucket_started_at.isoformat(),
                    "bucket_ended_at": bucket.bucket_ended_at.isoformat(),
                    "account_label": bucket.account_label,
                    "strategy_id": bucket.strategy_id,
                    "symbol": bucket.symbol,
                    "fill_count": bucket.fill_count,
                    "decision_count": bucket.decision_count,
                    "submitted_order_count": bucket.submitted_order_count,
                    "cancelled_order_count": bucket.cancelled_order_count,
                    "rejected_order_count": bucket.rejected_order_count,
                    "unfilled_order_count": bucket.unfilled_order_count,
                    "closed_trade_count": bucket.closed_trade_count,
                    "open_position_count": bucket.open_position_count,
                    "filled_notional": str(bucket.filled_notional),
                    "gross_strategy_pnl": str(bucket.gross_strategy_pnl),
                    "cost_amount": str(bucket.cost_amount),
                    "net_strategy_pnl_after_costs": str(
                        bucket.net_strategy_pnl_after_costs
                    ),
                    "post_cost_expectancy_bps": (
                        str(bucket.post_cost_expectancy_bps)
                        if bucket.post_cost_expectancy_bps is not None
                        else None
                    ),
                    "cost_basis_counts": bucket.cost_basis_counts,
                    "execution_policy_hash_counts": bucket.execution_policy_hash_counts,
                    "cost_model_hash_counts": bucket.cost_model_hash_counts,
                    "lineage_hash_counts": bucket.lineage_hash_counts,
                    "blockers": bucket.blockers,
                    "ledger_schema_version": bucket.ledger_schema_version,
                    "pnl_basis": bucket.pnl_basis,
                },
            }
        )
    return realized_rows


def _load_report_post_cost_expectancy_bps(artifact_refs: list[str]) -> Decimal | None:
    for ref in artifact_refs:
        path = Path(ref)
        if (
            path.name not in {"simulation-report.json", "evaluation-report.json"}
            or not path.exists()
        ):
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        pnl_payload = _as_mapping(payload.get("pnl"))
        metrics_payload = _as_mapping(payload.get("metrics"))
        net_pnl = _decimal_or_none(
            pnl_payload.get("net_pnl_estimated") or metrics_payload.get("net_pnl")
        )
        execution_notional = _decimal_or_none(
            pnl_payload.get("execution_notional_total")
            or metrics_payload.get("turnover_notional")
        )
        if net_pnl is None or execution_notional is None or execution_notional <= 0:
            continue
        return (net_pnl / execution_notional) * Decimal("10000")
    return None


def _load_json_artifact(ref: str) -> dict[str, Any]:
    text = ref.strip()
    if not text:
        return {}
    path = Path(text)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _as_mapping(payload)


def _query_timestamps(
    *,
    dsn: str,
    strategy_names: list[str],
    account_label: str,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[datetime], list[datetime], list[dict[str, object]]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    execution_rows: list[dict[str, object]] = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select d.created_at
                from trade_decisions d
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.status = any(%s)
                  and d.created_at >= %s
                  and d.created_at < %s
                order by d.created_at
                """,
                (
                    strategy_names,
                    account_label,
                    list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                    window_start,
                    window_end,
                ),
            )
            decisions = [row[0] for row in cur.fetchall() if row[0] is not None]
            cur.execute(
                """
                select
                    d.created_at,
                    e.created_at,
                    e.symbol,
                    e.side,
                    e.filled_qty,
                    e.avg_fill_price,
                    t.shortfall_notional,
                    e.execution_audit_json,
                    e.raw_order,
                    e.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    e.alpaca_order_id,
                    e.client_order_id,
                    e.status
                from executions e
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                left join execution_tca_metrics t on t.execution_id = e.id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.created_at >= %s
                  and d.created_at < %s
                order by d.created_at
                """,
                (strategy_names, account_label, window_start, window_end),
            )
            execution_rows = [
                {
                    "computed_at": row[0],
                    "execution_created_at": row[1],
                    "symbol": row[2],
                    "side": row[3],
                    "filled_qty": row[4],
                    "avg_fill_price": row[5],
                    "shortfall_notional": row[6],
                    "execution_audit_json": row[7],
                    "raw_order": row[8],
                    "account_label": row[9],
                    "strategy_id": row[10],
                    "decision_hash": row[11],
                    "alpaca_order_id": row[12],
                    "client_order_id": row[13],
                    "order_status": row[14],
                }
                for row in cur.fetchall()
                if row[0] is not None
            ]
            executions = []
            for row in execution_rows:
                computed_at = row.get("computed_at")
                if isinstance(computed_at, datetime):
                    executions.append(computed_at)
            cur.execute(
                """
                select
                    d.created_at,
                    abs(coalesce(t.realized_shortfall_bps, t.slippage_bps)) as abs_slippage_bps,
                    (-coalesce(t.realized_shortfall_bps, t.slippage_bps)) as post_cost_expectancy_bps
                from execution_tca_metrics t
                join executions e on e.id = t.execution_id
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.created_at >= %s
                  and d.created_at < %s
                order by d.created_at
                """,
                (strategy_names, account_label, window_start, window_end),
            )
            tca_rows = [
                {
                    "computed_at": row[0],
                    "abs_slippage_bps": row[1] or Decimal("0"),
                    "post_cost_expectancy_bps": row[2] or Decimal("0"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_TCA_PROXY,
                    "post_cost_promotion_eligible": False,
                }
                for row in cur.fetchall()
                if row[0] is not None
            ]
    tca_rows.extend(_build_realized_strategy_pnl_rows(execution_rows))
    return decisions, executions, tca_rows


def _source_activity_missing_summary(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: list[str],
    account_label: str,
    window_start: datetime,
    window_end: datetime,
    source_manifest_ref: str,
    source_kind: str,
    dataset_snapshot_ref: str | None,
    target_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = _as_mapping(target_metadata)
    blocker = {
        "blocker": "runtime_window_source_activity_missing",
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_name": strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": account_label,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "remediation": (
            "Run live-paper replay or route/TCA repair until the source database contains "
            "execution-eligible trade_decisions, executions, or TCA rows for this target "
            "before importing promotion evidence."
        ),
    }
    return {
        "status": "skipped",
        "proof_status": "blocked",
        "proof_blockers": [blocker],
        "run_id": run_id,
        "candidate_id": candidate_id or None,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "window_count": 0,
        "market_session_samples": 0,
        "decision_count": 0,
        "trade_count": 0,
        "order_count": 0,
        "avg_abs_slippage_bps": "0",
        "avg_post_cost_expectancy_bps": "0",
        "promotion_allowed": False,
        "promotion_blocking_reasons": ["runtime_window_source_activity_missing"],
        "runtime_observation": {
            "authoritative": False,
            "observed_stage": observed_stage,
            "evidence_provenance": (
                "paper_runtime_observed"
                if observed_stage == "paper"
                else "live_runtime_observed"
            ),
            "source_kind": source_kind
            or (
                "simulation_paper_runtime"
                if observed_stage == "paper"
                else "live_runtime"
            ),
            "source_manifest_ref": source_manifest_ref or None,
            "strategy_name": strategy_name,
            "strategy_name_candidates": strategy_names,
            "account_label": account_label,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "target_metadata": metadata,
            "skip_reason": "runtime_window_source_activity_missing",
        },
    }


def main() -> int:
    args = _parse_args()
    source_dsn = args.source_dsn.strip() or os.getenv(args.source_dsn_env, "").strip()
    if not source_dsn:
        raise RuntimeError("source_dsn_not_configured")
    window_start = _parse_dt(args.window_start)
    window_end = _parse_dt(args.window_end)
    _, manifest = resolve_hypothesis_manifest(
        hypothesis_id=args.hypothesis_id,
        strategy_family=args.strategy_family.strip() or None,
    )
    strategy_names = _strategy_name_candidates(
        args.strategy_name,
        getattr(manifest, "strategy_id", None),
    )
    decisions, executions, tca_rows = _query_timestamps(
        dsn=source_dsn,
        strategy_names=strategy_names,
        account_label=args.account_label,
        window_start=window_start,
        window_end=window_end,
    )
    dataset_snapshot_ref = (
        str(getattr(args, "dataset_snapshot_ref", "") or "").strip() or None
    )
    target_metadata = _parse_target_metadata(
        str(getattr(args, "target_metadata_json", "") or "")
    )
    if not decisions and not executions and not tca_rows:
        summary = _source_activity_missing_summary(
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip(),
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_name=args.strategy_name,
            strategy_names=strategy_names,
            account_label=args.account_label,
            window_start=window_start,
            window_end=window_end,
            source_manifest_ref=args.source_manifest_ref.strip(),
            source_kind=args.source_kind.strip(),
            dataset_snapshot_ref=dataset_snapshot_ref,
            target_metadata=target_metadata,
        )
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(summary)
        return 0
    artifact_refs = [
        str(item).strip() for item in args.artifact_ref if str(item).strip()
    ]
    delay_depth_report_ref = str(
        getattr(args, "delay_adjusted_depth_stress_report_ref", "") or ""
    ).strip()
    delay_depth_report = _load_json_artifact(delay_depth_report_ref)
    if delay_depth_report_ref:
        artifact_refs.append(delay_depth_report_ref)
    report_post_cost_expectancy_bps = _load_report_post_cost_expectancy_bps(
        artifact_refs
    )
    if (
        report_post_cost_expectancy_bps is not None
        and args.source_kind.strip().startswith("simulation_")
    ):
        tca_rows.append(
            {
                "computed_at": executions[-1] if executions else window_end,
                "post_cost_expectancy_bps": report_post_cost_expectancy_bps,
                "post_cost_expectancy_basis": POST_COST_BASIS_SIMULATION_REPORT,
                "post_cost_promotion_eligible": False,
                "promotion_blocker": "simulation_report_not_runtime_ledger_proof",
            }
        )
    bucket_ranges = build_regular_session_buckets(
        window_start=window_start,
        window_end=window_end,
        bucket_minutes=args.bucket_minutes,
        sample_minutes=args.sample_minutes,
    )
    buckets = build_observed_runtime_buckets(
        bucket_ranges=bucket_ranges,
        decision_times=decisions,
        execution_times=executions,
        tca_rows=tca_rows,
        continuity_ok=_flag(args.continuity_ok),
        drift_ok=_flag(args.drift_ok),
        dependency_quorum_decision=args.dependency_quorum_decision.strip() or "allow",
    )
    evidence_provenance = (
        "paper_runtime_observed"
        if args.observed_stage == "paper"
        else "live_runtime_observed"
    )
    source_kind = args.source_kind.strip() or (
        "simulation_paper_runtime" if args.observed_stage == "paper" else "live_runtime"
    )
    runtime_observation_payload = {
        "authoritative": True,
        "observed_stage": args.observed_stage,
        "evidence_provenance": evidence_provenance,
        "source_kind": source_kind,
        "source_manifest_ref": args.source_manifest_ref.strip() or None,
        "strategy_name": args.strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": args.account_label,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "artifact_refs": artifact_refs,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "target_metadata": target_metadata,
        "report_post_cost_expectancy_bps": (
            str(report_post_cost_expectancy_bps)
            if report_post_cost_expectancy_bps is not None
            else None
        ),
        "report_post_cost_expectancy_basis": (
            POST_COST_BASIS_SIMULATION_REPORT
            if report_post_cost_expectancy_bps is not None
            and source_kind.startswith("simulation_")
            else None
        ),
    }
    if delay_depth_report_ref:
        runtime_observation_payload.update(
            {
                "delay_adjusted_depth_stress_artifact_ref": delay_depth_report_ref,
                "delay_adjusted_depth_stress_report": delay_depth_report,
                "delay_adjusted_depth_stress_checks_total": max(
                    _nonnegative_int(delay_depth_report.get("stress_case_count")),
                    _nonnegative_int(delay_depth_report.get("case_count")),
                    _nonnegative_int(delay_depth_report.get("trading_day_count")),
                )
                if delay_depth_report
                else 0,
                "delay_adjusted_depth_stress_passed": delay_depth_report.get("passed")
                if delay_depth_report
                else False,
                "delay_adjusted_depth_stress_checked_at": (
                    delay_depth_report.get("generated_at")
                    or delay_depth_report.get("checked_at")
                )
                if delay_depth_report
                else None,
            }
        )
    with SessionLocal() as session:
        summary = persist_observed_runtime_windows(
            session=session,
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_family=args.strategy_family.strip() or manifest.strategy_family,
            source_manifest_ref=args.source_manifest_ref.strip() or None,
            buckets=buckets,
            slippage_budget_bps=manifest.max_allowed_slippage_bps,
            runtime_observation_payload=runtime_observation_payload,
        )
        session.commit()
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

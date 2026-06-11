"""Runtime-ledger materialization checks for proofs."""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import StrategyRuntimeLedgerBucket
from .schemas import RuntimeLedgerPayload
from .targets import ProofTarget, isoformat


def load_runtime_ledger(
    session: Session,
    target: ProofTarget,
) -> RuntimeLedgerPayload:
    stmt = (
        select(StrategyRuntimeLedgerBucket)
        .where(StrategyRuntimeLedgerBucket.bucket_started_at >= target.window_start)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at <= target.window_end)
        .order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.desc())
        .limit(50)
    )
    if target.account_label:
        stmt = stmt.where(
            StrategyRuntimeLedgerBucket.account_label == target.account_label
        )
    if target.hypothesis_id:
        stmt = stmt.where(
            StrategyRuntimeLedgerBucket.hypothesis_id == target.hypothesis_id
        )
    if target.candidate_id:
        stmt = stmt.where(
            StrategyRuntimeLedgerBucket.candidate_id == target.candidate_id
        )
    rows = list(session.execute(stmt).scalars().all())
    decision_count = sum(int(row.decision_count or 0) for row in rows)
    submitted_order_count = sum(int(row.submitted_order_count or 0) for row in rows)
    fill_count = sum(int(row.fill_count or 0) for row in rows)
    closed_trade_count = sum(int(row.closed_trade_count or 0) for row in rows)
    open_position_count = sum(int(row.open_position_count or 0) for row in rows)
    filled_notional = sum((row.filled_notional for row in rows), Decimal("0"))
    cost_amount = sum((row.cost_amount for row in rows), Decimal("0"))
    net_pnl = sum((row.net_strategy_pnl_after_costs for row in rows), Decimal("0"))
    pnl_basis = next((row.pnl_basis for row in rows if row.pnl_basis), None)
    blockers: list[str] = []
    if not rows:
        blockers.append("runtime_ledger_materialization_missing")
    if open_position_count > 0:
        blockers.append("runtime_ledger_open_positions")
    return {
        "materialized": bool(rows),
        "bucket_count": len(rows),
        "refs": [
            {
                "id": str(row.id),
                "run_id": row.run_id,
                "hypothesis_id": row.hypothesis_id,
                "candidate_id": row.candidate_id,
                "account_label": row.account_label,
                "bucket_started_at": isoformat(row.bucket_started_at),
                "bucket_ended_at": isoformat(row.bucket_ended_at),
            }
            for row in rows[:10]
        ],
        "decision_count": decision_count,
        "submitted_order_count": submitted_order_count,
        "fill_count": fill_count,
        "closed_trade_count": closed_trade_count,
        "open_position_count": open_position_count,
        "filled_notional": _decimal_text(filled_notional) if rows else None,
        "cost_amount": _decimal_text(cost_amount) if rows else None,
        "net_strategy_pnl_after_costs": _decimal_text(net_pnl) if rows else None,
        "pnl_basis": pnl_basis,
        "blockers": blockers,
    }


def _decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")

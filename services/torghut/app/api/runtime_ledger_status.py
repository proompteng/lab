"""Compact, bounded runtime-ledger status for the current trading day."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
)

logger = logging.getLogger(__name__)


def _bucket_blockers(row: StrategyRuntimeLedgerBucket) -> list[str]:
    raw_blockers = cast(Sequence[object], row.blockers_json or [])
    return [str(item).strip() for item in raw_blockers if str(item).strip()]


def _bucket_payload(row: StrategyRuntimeLedgerBucket) -> dict[str, object]:
    raw_payload = cast(object, row.payload_json)
    if not isinstance(raw_payload, Mapping):
        return {}
    return {
        str(key): value
        for key, value in cast(Mapping[object, object], raw_payload).items()
    }


def runtime_ledger_bucket_reconciled(row: StrategyRuntimeLedgerBucket) -> bool:
    """Return whether a bucket has complete execution and cost lineage."""

    return (
        row.pnl_basis == "realized_strategy_pnl_after_explicit_costs"
        and int(row.fill_count or 0) > 0
        and int(row.submitted_order_count or 0) > 0
        and int(row.closed_trade_count or 0) > 0
        and int(row.open_position_count or 0) == 0
        and row.filled_notional > 0
        and bool(row.execution_policy_hash_counts)
        and bool(row.cost_model_hash_counts)
        and bool(row.lineage_hash_counts)
        and not cost_basis_counts_have_non_promotion_grade_costs(
            _bucket_payload(row).get("cost_basis_counts")
        )
        and not _bucket_blockers(row)
    )


def _set_statement_timeout(session: Session, milliseconds: int) -> None:
    bind = session.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") == "postgresql":
        from sqlalchemy import text

        session.execute(text(f"SET LOCAL statement_timeout = {max(1, milliseconds)}"))


def _query_failure_reason(exc: SQLAlchemyError) -> str:
    message = str(exc).lower()
    if (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    ):
        return "runtime_ledger_query_timeout"
    return "runtime_ledger_query_failed"


def _unavailable_summary(
    *,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
    reason: str,
) -> dict[str, object]:
    return {
        "status": "unavailable",
        "account_label": account_label,
        "stage": stage_scope,
        "observed_at": observed_at.isoformat(),
        "bucket_count": 0,
        "reconciled_bucket_count": 0,
        "net_pnl_after_costs": "0",
        "filled_notional": "0",
        "closed_trade_count": 0,
        "open_position_count": 0,
        "reason_codes": [reason],
    }


def daily_runtime_ledger_portfolio_summary(
    *,
    session: Session,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
) -> dict[str, object]:
    """Return bounded execution and P&L reconciliation for the current UTC day."""

    observed = (
        observed_at.astimezone(timezone.utc)
        if observed_at.tzinfo
        else observed_at.replace(tzinfo=timezone.utc)
    )
    day_start = observed.replace(hour=0, minute=0, second=0, microsecond=0)
    account = account_label.strip()
    stage = stage_scope.strip()
    statement = (
        select(StrategyRuntimeLedgerBucket)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at >= day_start)
        .where(StrategyRuntimeLedgerBucket.bucket_ended_at <= observed)
        .where(StrategyRuntimeLedgerBucket.account_label == account)
        .where(
            StrategyRuntimeLedgerBucket.observed_stage
            == (stage if stage in {"paper", "live"} else "__missing__")
        )
        .order_by(
            StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
            StrategyRuntimeLedgerBucket.created_at.desc(),
        )
        .limit(200)
    )
    try:
        _set_statement_timeout(session, 500)
        rows = list(session.execute(statement).scalars())
    except SQLAlchemyError as exc:
        logger.warning("Runtime-ledger status query failed: %s", exc)
        session.rollback()
        return _unavailable_summary(
            account_label=account,
            stage_scope=stage,
            observed_at=observed,
            reason=_query_failure_reason(exc),
        )

    reconciled = [row for row in rows if runtime_ledger_bucket_reconciled(row)]
    net_pnl = sum(
        (row.net_strategy_pnl_after_costs for row in reconciled),
        Decimal("0"),
    )
    filled_notional = sum(
        (row.filled_notional for row in reconciled),
        Decimal("0"),
    )
    reason_codes: list[str] = []
    if not rows:
        reason_codes.append("runtime_ledger_missing")
    elif not reconciled:
        reason_codes.append("runtime_ledger_unreconciled")
    return {
        "status": "current" if reconciled else "degraded",
        "account_label": account,
        "stage": stage,
        "day_start": day_start.isoformat(),
        "observed_at": observed.isoformat(),
        "bucket_count": len(rows),
        "reconciled_bucket_count": len(reconciled),
        "net_pnl_after_costs": str(net_pnl),
        "filled_notional": str(filled_notional),
        "closed_trade_count": sum(
            max(0, int(row.closed_trade_count or 0)) for row in reconciled
        ),
        "open_position_count": sum(
            max(0, int(row.open_position_count or 0)) for row in reconciled
        ),
        "candidate_ids": sorted(
            {
                str(row.candidate_id).strip()
                for row in reconciled
                if str(row.candidate_id or "").strip()
            }
        ),
        "row_ids": [str(row.id) for row in reconciled],
        "reason_codes": reason_codes,
    }


__all__ = (
    "daily_runtime_ledger_portfolio_summary",
    "runtime_ledger_bucket_reconciled",
)

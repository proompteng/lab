# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F403,F405,F811,F821
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

# ruff: noqa: F401,F403,F405,F821,F821,F821

from .part_01_statements_10 import *
from .part_02_trading_autonomy import *


@router.get("/trading/executions")
def trading_executions(
    symbol: str | None = None,
    since: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    """Return recent trade executions."""

    stmt = select(Execution).order_by(Execution.created_at.desc())
    if symbol:
        stmt = stmt.where(Execution.symbol == symbol)
    if since:
        stmt = stmt.where(Execution.created_at >= since)
    stmt = stmt.limit(limit)
    executions = session.execute(stmt).scalars().all()
    execution_ids = [execution.id for execution in executions]
    tca_by_execution: dict[str, ExecutionTCAMetric] = {}
    if execution_ids:
        tca_stmt = select(ExecutionTCAMetric).where(
            ExecutionTCAMetric.execution_id.in_(execution_ids)
        )
        tca_rows = session.execute(tca_stmt).scalars().all()
        tca_by_execution = {str(row.execution_id): row for row in tca_rows}
    payload = [
        {
            "id": str(execution.id),
            "trade_decision_id": str(execution.trade_decision_id)
            if execution.trade_decision_id
            else None,
            "symbol": execution.symbol,
            "side": execution.side,
            "order_type": execution.order_type,
            "time_in_force": execution.time_in_force,
            "submitted_qty": execution.submitted_qty,
            "filled_qty": execution.filled_qty,
            "avg_fill_price": execution.avg_fill_price,
            "execution_expected_adapter": execution.execution_expected_adapter,
            "execution_actual_adapter": execution.execution_actual_adapter,
            "execution_fallback_reason": execution.execution_fallback_reason,
            "execution_fallback_count": execution.execution_fallback_count,
            "execution_correlation_id": execution.execution_correlation_id,
            "execution_idempotency_key": execution.execution_idempotency_key,
            "status": execution.status,
            "created_at": execution.created_at,
            "last_update_at": execution.last_update_at,
            "alpaca_order_id": execution.alpaca_order_id,
            "tca": _tca_row_payload(tca_by_execution.get(str(execution.id))),
        }
        for execution in executions
    ]
    return jsonable_encoder(payload)


__all__ = [
    "_consumer_evidence_dependency_quorum",
    "_build_consumer_evidence_receipt_projection",
    "_consumer_evidence_summary_view",
    "_revenue_repair_topline_fields",
    "_build_trading_consumer_evidence_payload",
    "trading_consumer_evidence",
    "trading_metrics",
    "trading_simulation_progress",
    "submit_lean_backtest",
    "get_lean_backtest",
    "get_lean_shadow_parity",
    "trading_autonomy",
    "_runtime_ledger_bucket_evidence_grade",
    "_daily_runtime_ledger_portfolio_summary",
    "_build_current_evidence_epoch",
    "trading_evidence_epoch_latest",
    "trading_evidence_epoch_detail",
    "trading_empirical_jobs",
    "trading_completion_doc29",
    "trading_completion_doc29_gate",
    "trading_autonomy_evidence_continuity",
    "trading_llm_evaluation",
    "prometheus_metrics",
    "trading_decisions",
    "trading_executions",
]

capture_module_exports(globals(), __all__)


__all__ = [name for name in globals() if not name.startswith("__")]

"""Widen runtime market symbol columns for OCC option contracts.

Revision ID: 0035_widen_market_symbol_columns
Revises: 0034_strategy_runtime_ledger_buckets
Create Date: 2026-05-27 13:20:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.engine.reflection import Inspector


revision = "0035_widen_market_symbol_columns"
down_revision = "0034_strategy_runtime_ledger_buckets"
branch_labels = None
depends_on = None


MARKET_SYMBOL_COLUMNS = (
    ("trade_decisions", "symbol", False),
    ("executions", "symbol", False),
    ("execution_order_events", "symbol", True),
    ("rejected_signal_outcome_events", "symbol", False),
    ("execution_tca_metrics", "symbol", False),
)

TCA_STRATEGY_VIEW_SQL = """
CREATE OR REPLACE VIEW public.execution_tca_strategy_agg_v1 AS
SELECT
    strategy_id,
    COALESCE(alpaca_account_label, 'unknown') AS alpaca_account_label,
    COUNT(*)::BIGINT AS order_count,
    COUNT(DISTINCT symbol)::BIGINT AS symbol_count,
    AVG(slippage_bps) AS avg_slippage_bps,
    AVG(shortfall_notional) AS avg_shortfall_notional,
    AVG(churn_ratio) AS avg_churn_ratio,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY slippage_bps)
        FILTER (WHERE slippage_bps IS NOT NULL) AS p95_slippage_bps,
    MAX(computed_at) AS last_computed_at
FROM public.execution_tca_metrics
GROUP BY strategy_id, COALESCE(alpaca_account_label, 'unknown');
"""

TCA_SYMBOL_VIEW_SQL = """
CREATE OR REPLACE VIEW public.execution_tca_symbol_agg_v1 AS
SELECT
    strategy_id,
    COALESCE(alpaca_account_label, 'unknown') AS alpaca_account_label,
    symbol,
    COUNT(*)::BIGINT AS order_count,
    AVG(slippage_bps) AS avg_slippage_bps,
    AVG(shortfall_notional) AS avg_shortfall_notional,
    AVG(churn_ratio) AS avg_churn_ratio,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY slippage_bps)
        FILTER (WHERE slippage_bps IS NOT NULL) AS p95_slippage_bps,
    MAX(computed_at) AS last_computed_at
FROM public.execution_tca_metrics
GROUP BY strategy_id, COALESCE(alpaca_account_label, 'unknown'), symbol;
"""


def _drop_execution_tca_views() -> None:
    op.execute("DROP VIEW IF EXISTS public.execution_tca_symbol_agg_v1;")
    op.execute("DROP VIEW IF EXISTS public.execution_tca_strategy_agg_v1;")


def _create_execution_tca_views() -> None:
    op.execute(TCA_STRATEGY_VIEW_SQL)
    op.execute(TCA_SYMBOL_VIEW_SQL)
    op.execute(
        "GRANT SELECT ON TABLE public.execution_tca_strategy_agg_v1 TO torghut_app;"
    )
    op.execute(
        "GRANT SELECT ON TABLE public.execution_tca_symbol_agg_v1 TO torghut_app;"
    )


def _column_type_length(
    inspector: Inspector, table_name: str, column_name: str
) -> tuple[bool, int | None]:
    for column in inspector.get_columns(table_name):
        if column["name"] != column_name:
            continue
        column_type = column.get("type")
        length = getattr(column_type, "length", None)
        return True, int(length) if isinstance(length, int) else None
    return False, None


def _alter_symbols(target_length: int, existing_length: int, *, widen: bool) -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    should_recreate_tca_views = inspector.has_table("execution_tca_metrics")
    if should_recreate_tca_views:
        _drop_execution_tca_views()

    for table_name, column_name, nullable in MARKET_SYMBOL_COLUMNS:
        if not inspector.has_table(table_name):
            continue
        has_column, current_length = _column_type_length(
            inspector, table_name, column_name
        )
        if not has_column:
            continue
        if current_length is not None:
            if widen and current_length >= target_length:
                continue
            if not widen and current_length <= target_length:
                continue
        op.alter_column(
            table_name,
            column_name,
            existing_type=sa.String(length=existing_length),
            type_=sa.String(length=target_length),
            existing_nullable=nullable,
        )

    if should_recreate_tca_views:
        _create_execution_tca_views()


def upgrade() -> None:
    _alter_symbols(target_length=64, existing_length=16, widen=True)


def downgrade() -> None:
    _alter_symbols(target_length=16, existing_length=64, widen=False)

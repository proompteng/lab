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


def upgrade() -> None:
    _alter_symbols(target_length=64, existing_length=16, widen=True)


def downgrade() -> None:
    _alter_symbols(target_length=16, existing_length=64, widen=False)

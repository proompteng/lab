"""Preserve Alpaca crypto quantities at the broker's nine-decimal precision.

Revision ID: 0074_crypto_qty_precision
Revises: 0073_live_paper_bounds
Create Date: 2026-07-15 22:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0074_crypto_qty_precision"
down_revision = "0073_live_paper_bounds"
branch_labels = None
depends_on = None


_TABLE = "execution_order_events"
_QUANTITY_COLUMNS = (
    "qty",
    "filled_qty",
    "filled_qty_delta",
    "position_qty",
)
_OLD_TYPE = sa.Numeric(20, 8)
_NEW_TYPE = sa.Numeric(21, 9)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    if not inspector.has_table(_TABLE):
        return
    columns = {column["name"]: column for column in inspector.get_columns(_TABLE)}
    op.execute(sa.text(f"LOCK TABLE {_TABLE} IN ACCESS EXCLUSIVE MODE NOWAIT"))
    for column_name in _QUANTITY_COLUMNS:
        column = columns.get(column_name)
        if column is None or _is_quantity_type(column["type"], precision=21, scale=9):
            continue
        op.alter_column(
            _TABLE,
            column_name,
            existing_type=column["type"],
            type_=_NEW_TYPE,
            existing_nullable=True,
            postgresql_using=f"{column_name}::numeric(21, 9)",
        )


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    if not inspector.has_table(_TABLE):
        return
    columns = {column["name"]: column for column in inspector.get_columns(_TABLE)}
    op.execute(sa.text(f"LOCK TABLE {_TABLE} IN ACCESS EXCLUSIVE MODE NOWAIT"))
    for column_name in _QUANTITY_COLUMNS:
        column = columns.get(column_name)
        if column is None or _is_quantity_type(column["type"], precision=20, scale=8):
            continue
        loses_precision = bind.execute(
            sa.text(
                f"SELECT EXISTS (SELECT 1 FROM {_TABLE} "
                f"WHERE {column_name} IS NOT NULL "
                f"AND {column_name} <> round({column_name}, 8))"
            )
        ).scalar_one()
        if loses_precision:
            raise RuntimeError(
                f"cannot narrow {_TABLE}.{column_name}: nine-decimal values exist"
            )
        op.alter_column(
            _TABLE,
            column_name,
            existing_type=column["type"],
            type_=_OLD_TYPE,
            existing_nullable=True,
            postgresql_using=f"{column_name}::numeric(20, 8)",
        )


def _is_quantity_type(
    column_type: object,
    *,
    precision: int,
    scale: int,
) -> bool:
    return (
        isinstance(column_type, sa.Numeric)
        and column_type.precision == precision
        and column_type.scale == scale
    )

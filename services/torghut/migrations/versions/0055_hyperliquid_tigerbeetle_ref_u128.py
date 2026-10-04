"""Repair Hyperliquid TigerBeetle u128 ref columns.

Revision ID: 0055_hyperliquid_tigerbeetle_ref_u128
Revises: 0054_hyperliquid_runtime
Create Date: 2026-06-18 06:58:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0055_hyperliquid_tigerbeetle_ref_u128"
down_revision = "0054_hyperliquid_runtime"
branch_labels = None
depends_on = None

TABLE_NAME = "hyperliquid_runtime_tigerbeetle_refs"
NUMERIC_39_COLUMNS = (
    "transfer_id",
    "debit_account_id",
    "credit_account_id",
    "amount",
)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return

    columns = {column["name"]: column for column in inspector.get_columns(TABLE_NAME)}
    for column_name in NUMERIC_39_COLUMNS:
        column = columns.get(column_name)
        if column is None or _is_numeric_39(column["type"]):
            continue
        op.alter_column(
            TABLE_NAME,
            column_name,
            existing_type=column["type"],
            type_=sa.Numeric(39, 0),
            existing_nullable=False,
            postgresql_using=f"{column_name}::numeric(39, 0)",
        )


def downgrade() -> None:
    """Do not narrow u128 refs back to integer storage."""


def _is_numeric_39(column_type: object) -> bool:
    return (
        isinstance(column_type, sa.Numeric)
        and column_type.precision == 39
        and column_type.scale == 0
    )

"""Add measured Hyperliquid execution order read indexes.

Revision ID: 0083_hyperliquid_order_reads
Revises: 0082_order_lineage_runs
Create Date: 2026-07-18 06:40:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0083_hyperliquid_order_reads"
down_revision = "0082_order_lineage_runs"
branch_labels = None
depends_on = None


TABLE_NAME = "hyperliquid_execution_orders"
INDEXES: tuple[tuple[str, str], ...] = (
    (
        "ix_hyperliquid_execution_orders_network_created",
        """
CREATE INDEX CONCURRENTLY
  ix_hyperliquid_execution_orders_network_created
ON hyperliquid_execution_orders (execution_network, created_at DESC)
""",
    ),
    (
        "ix_hyperliquid_execution_orders_network_exchange_created",
        """
CREATE INDEX CONCURRENTLY
  ix_hyperliquid_execution_orders_network_exchange_created
ON hyperliquid_execution_orders (
  execution_network,
  exchange_order_id,
  created_at DESC
)
WHERE exchange_order_id IS NOT NULL
""",
    ),
)


def _index_is_valid(index_name: str) -> bool | None:
    value = (
        op.get_bind()
        .execute(
            sa.text(
                """
                SELECT COALESCE(indisvalid AND indisready, false)
                FROM pg_index
                WHERE indexrelid = to_regclass(:index_name)
                """
            ),
            {"index_name": index_name},
        )
        .scalar_one_or_none()
    )
    if value is None:
        return None
    return bool(value)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    if not inspect(bind).has_table(TABLE_NAME):
        return
    with op.get_context().autocommit_block():
        op.execute(sa.text("SET lock_timeout = '5s'"))
        op.execute(sa.text("SET statement_timeout = '30min'"))
        try:
            for index_name, create_sql in INDEXES:
                # A cancelled concurrent build leaves a named but invalid index.
                # Rebuild unconditionally so an invalid or mismatched definition
                # cannot make IF NOT EXISTS silently stamp this migration.
                op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {index_name}"))
                op.execute(sa.text(create_sql))
                if _index_is_valid(index_name) is not True:
                    raise RuntimeError(f"{index_name} was not created as a valid index")
        finally:
            op.execute(sa.text("RESET statement_timeout"))
            op.execute(sa.text("RESET lock_timeout"))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    if not inspect(bind).has_table(TABLE_NAME):
        return
    with op.get_context().autocommit_block():
        for index_name, _create_sql in reversed(INDEXES):
            op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {index_name}"))

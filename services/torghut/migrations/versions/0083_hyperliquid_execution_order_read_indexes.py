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
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  ix_hyperliquid_execution_orders_network_created
ON hyperliquid_execution_orders (execution_network, created_at DESC)
""",
    ),
    (
        "ix_hyperliquid_execution_orders_network_exchange_created",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS
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


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    if not inspect(bind).has_table(TABLE_NAME):
        return
    with op.get_context().autocommit_block():
        for _index_name, create_sql in INDEXES:
            op.execute(sa.text(create_sql))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    if not inspect(bind).has_table(TABLE_NAME):
        return
    with op.get_context().autocommit_block():
        for index_name, _create_sql in reversed(INDEXES):
            op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {index_name}"))

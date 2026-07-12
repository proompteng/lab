"""Add bounded trading loop status read indexes.

Revision ID: 0062_loop_status_read_indexes
Revises: 0061_linked_submission_terminal
Create Date: 2026-07-12 04:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0062_loop_status_read_indexes"
down_revision = "0061_linked_submission_terminal"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, str], ...] = (
    (
        "ix_hyperliquid_execution_signals_generated_at_desc",
        "hyperliquid_execution_signals",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  ix_hyperliquid_execution_signals_generated_at_desc
ON hyperliquid_execution_signals (generated_at DESC)
""",
    ),
    (
        "ix_hyperliquid_execution_orders_network_created_desc",
        "hyperliquid_execution_orders",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  ix_hyperliquid_execution_orders_network_created_desc
ON hyperliquid_execution_orders (execution_network, created_at DESC)
""",
    ),
    (
        "ix_hyperliquid_execution_fills_network_event_desc",
        "hyperliquid_execution_fills",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  ix_hyperliquid_execution_fills_network_event_desc
ON hyperliquid_execution_fills (execution_network, event_ts DESC)
""",
    ),
    (
        "ix_executions_created_at_desc",
        "executions",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_executions_created_at_desc
ON executions (created_at DESC)
INCLUDE (alpaca_account_label)
""",
    ),
    (
        "ix_execution_order_events_activity_at_desc",
        "execution_order_events",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  ix_execution_order_events_activity_at_desc
ON execution_order_events ((COALESCE(event_ts, created_at)) DESC)
INCLUDE (alpaca_account_label)
""",
    ),
)

_INDEX_VALIDITY_SQL = sa.text(
    """
    SELECT indisvalid
      FROM pg_index
     WHERE indexrelid = to_regclass(:index_name)
    """
)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    with op.get_context().autocommit_block():
        for index_name, table_name, create_sql in _INDEXES:
            if not inspector.has_table(table_name):
                continue
            validity = bind.execute(
                _INDEX_VALIDITY_SQL,
                {"index_name": index_name},
            ).scalar_one_or_none()
            if validity is True:
                continue
            if validity is False:
                op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {index_name}"))
            op.execute(sa.text(create_sql))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    with op.get_context().autocommit_block():
        for index_name, table_name, _create_sql in reversed(_INDEXES):
            if inspector.has_table(table_name):
                op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {index_name}"))

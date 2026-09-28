"""Add paper route proof read indexes.

Revision ID: 0053_paper_route_proof_read_indexes
Revises: 0052_proof_read_timeout_indexes
Create Date: 2026-06-05 18:05:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0053_paper_route_proof_read_indexes"
down_revision = "0052_proof_read_timeout_indexes"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, str], ...] = (
    (
        "ix_position_snapshots_account_as_of_desc",
        "position_snapshots",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_position_snapshots_account_as_of_desc
ON position_snapshots (
  alpaca_account_label,
  as_of DESC
)
""",
    ),
    (
        "ix_execution_order_events_account_symbol_activity_desc",
        "execution_order_events",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_execution_order_events_account_symbol_activity_desc
ON execution_order_events (
  alpaca_account_label,
  symbol,
  (COALESCE(event_ts, created_at)) DESC,
  trade_decision_id
)
WHERE symbol IS NOT NULL
""",
    ),
    (
        "ix_executions_account_symbol_activity_desc",
        "executions",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_executions_account_symbol_activity_desc
ON executions (
  alpaca_account_label,
  symbol,
  (COALESCE(order_feed_last_event_ts, last_update_at, updated_at, created_at)) DESC,
  trade_decision_id
)
""",
    ),
    (
        "ix_execution_tca_account_symbol_computed_desc",
        "execution_tca_metrics",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_execution_tca_account_symbol_computed_desc
ON execution_tca_metrics (
  alpaca_account_label,
  symbol,
  computed_at DESC,
  trade_decision_id
)
WHERE alpaca_account_label IS NOT NULL
""",
    ),
)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    with op.get_context().autocommit_block():
        for _index_name, table_name, create_sql in _INDEXES:
            if not inspector.has_table(table_name):
                continue
            op.execute(sa.text(create_sql))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    with op.get_context().autocommit_block():
        for index_name, table_name, _create_sql in reversed(_INDEXES):
            if not inspector.has_table(table_name):
                continue
            op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {index_name}"))

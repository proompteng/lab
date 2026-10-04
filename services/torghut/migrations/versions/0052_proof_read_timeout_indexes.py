"""Add proof read timeout indexes.

Revision ID: 0052_proof_read_timeout_indexes
Revises: 0051_paper_route_source_activity_latest_index
Create Date: 2026-06-05 01:35:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0052_proof_read_timeout_indexes"
down_revision = "0051_paper_route_source_activity_latest_index"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, str], ...] = (
    (
        "ix_runtime_ledger_bucket_audit_lookup",
        "strategy_runtime_ledger_buckets",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_runtime_ledger_bucket_audit_lookup
ON strategy_runtime_ledger_buckets (
  hypothesis_id,
  candidate_id,
  observed_stage,
  account_label,
  strategy_family,
  bucket_ended_at DESC,
  created_at DESC
)
""",
    ),
    (
        "ix_rejected_signal_events_account_event_created",
        "rejected_signal_outcome_events",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_rejected_signal_events_account_event_created
ON rejected_signal_outcome_events (
  account_label,
  event_ts DESC,
  created_at DESC
)
""",
    ),
    (
        "ix_trade_decisions_created_id",
        "trade_decisions",
        """
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_trade_decisions_created_id
ON trade_decisions (
  created_at DESC,
  id
)
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

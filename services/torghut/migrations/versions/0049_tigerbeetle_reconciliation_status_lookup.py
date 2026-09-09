"""Add TigerBeetle reconciliation status lookup index.

Revision ID: 0049_tigerbeetle_reconciliation_status_lookup
Revises: 0048_status_read_timeout_indexes
Create Date: 2026-06-03 09:05:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0049_tigerbeetle_reconciliation_status_lookup"
down_revision = "0048_status_read_timeout_indexes"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_tb_reconciliation_runs_cluster_started_desc"
TABLE_NAME = "tigerbeetle_reconciliation_runs"
CREATE_SQL = f"""
CREATE INDEX IF NOT EXISTS {INDEX_NAME}
ON {TABLE_NAME} (
  cluster_id,
  started_at DESC
)
"""


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return
    op.execute(sa.text(CREATE_SQL))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return
    op.execute(sa.text(f"DROP INDEX IF EXISTS {INDEX_NAME}"))

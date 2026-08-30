"""Add first-class source-window classification counts.

Revision ID: 0047_order_feed_source_window_classification_counts
Revises: 0046_autoresearch_portfolio_latest_index
Create Date: 2026-06-02 12:05:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


revision = "0047_order_feed_source_window_classification_counts"
down_revision = "0046_autoresearch_portfolio_latest_index"
branch_labels = None
depends_on = None

_TABLE_NAME = "order_feed_source_windows"
_COLUMN_NAME = "classification_counts"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(_TABLE_NAME):
        return
    existing_columns = {column["name"] for column in inspector.get_columns(_TABLE_NAME)}
    if _COLUMN_NAME not in existing_columns:
        op.add_column(
            _TABLE_NAME,
            sa.Column(_COLUMN_NAME, postgresql.JSONB(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(_TABLE_NAME):
        return
    existing_columns = {column["name"] for column in inspector.get_columns(_TABLE_NAME)}
    if _COLUMN_NAME in existing_columns:
        op.drop_column(_TABLE_NAME, _COLUMN_NAME)

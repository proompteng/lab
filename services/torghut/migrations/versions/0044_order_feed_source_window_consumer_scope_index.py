"""Add consumer-scope order-feed source-window lookup index.

Revision ID: 0044_order_feed_source_window_consumer_scope_index
Revises: 0043_status_readiness_bounded_read_indexes
Create Date: 2026-06-01 11:15:00.000000
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect


revision = "0044_order_feed_source_window_consumer_scope_index"
down_revision = "0043_status_readiness_bounded_read_indexes"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_order_feed_source_windows_consumer_scope_revision_offsets"
_TABLE_NAME = "order_feed_source_windows"
_COLUMNS = [
    "consumer_group",
    "source_topic",
    "source_partition",
    "alpaca_account_label",
    "assignment_mode",
    "collector_identity",
    "source_revision",
    "start_offset",
    "end_offset",
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(_TABLE_NAME):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(_TABLE_NAME)}
    if _INDEX_NAME not in existing_indexes:
        op.create_index(_INDEX_NAME, _TABLE_NAME, _COLUMNS)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(_TABLE_NAME):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(_TABLE_NAME)}
    if _INDEX_NAME in existing_indexes:
        op.drop_index(_INDEX_NAME, table_name=_TABLE_NAME)

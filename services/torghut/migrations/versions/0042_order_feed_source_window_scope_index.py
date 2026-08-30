"""Add source-window scope/revision offset index."""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision = "0042_order_feed_source_window_scope_index"
down_revision = "0041_runtime_ledger_status_index"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_order_feed_source_windows_scope_revision_offsets"
_TABLE_NAME = "order_feed_source_windows"
_COLUMNS = [
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

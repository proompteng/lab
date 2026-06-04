"""Add latest paper-route source activity index.

Revision ID: 0051_paper_route_source_activity_latest_index
Revises: 0050_tigerbeetle_reconciliation_compact_status
Create Date: 2026-06-04 13:55:00.000000
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect


revision = "0051_paper_route_source_activity_latest_index"
down_revision = "0050_tigerbeetle_reconciliation_compact_status"
branch_labels = None
depends_on = None


INDEX_NAME = "ix_trade_decisions_account_strategy_symbol_created"
TABLE_NAME = "trade_decisions"
INDEX_COLUMNS = (
    "alpaca_account_label",
    "strategy_id",
    "symbol",
    "created_at",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
    if INDEX_NAME in existing_indexes:
        return
    op.create_index(INDEX_NAME, TABLE_NAME, list(INDEX_COLUMNS))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
    if INDEX_NAME not in existing_indexes:
        return
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)

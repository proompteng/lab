"""Add latest-row index for autoresearch portfolio status reads.

Revision ID: 0046_autoresearch_portfolio_latest_index
Revises: 0045_paper_route_audit_bounded_read_indexes
Create Date: 2026-06-02 00:35:00.000000
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect


revision = "0046_autoresearch_portfolio_latest_index"
down_revision = "0045_paper_route_audit_bounded_read_indexes"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_autoresearch_portfolio_candidates_created"
TABLE_NAME = "autoresearch_portfolio_candidates"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
    if INDEX_NAME in existing_indexes:
        return
    op.create_index(INDEX_NAME, TABLE_NAME, ["created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(TABLE_NAME)}
    if INDEX_NAME not in existing_indexes:
        return
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)

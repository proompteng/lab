"""Add bounded status/readiness lookup indexes.

Revision ID: 0043_status_readiness_bounded_read_indexes
Revises: 0042_order_feed_source_window_scope_index
Create Date: 2026-06-01 10:05:00.000000
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect


revision = "0043_status_readiness_bounded_read_indexes"
down_revision = "0042_order_feed_source_window_scope_index"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "ix_strategy_hypothesis_metric_windows_hypothesis_ended_created",
        "strategy_hypothesis_metric_windows",
        ("hypothesis_id", "window_ended_at", "created_at"),
    ),
    (
        "ix_strategy_promotion_decisions_hypothesis_created",
        "strategy_promotion_decisions",
        ("hypothesis_id", "created_at"),
    ),
    (
        "ix_autoresearch_portfolio_candidates_status_created",
        "autoresearch_portfolio_candidates",
        ("status", "created_at"),
    ),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for index_name, table_name, columns in _INDEXES:
        if not inspector.has_table(table_name):
            continue
        existing_indexes = {
            index["name"] for index in inspector.get_indexes(table_name)
        }
        if index_name in existing_indexes:
            continue
        op.create_index(index_name, table_name, list(columns))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for index_name, table_name, _columns in reversed(_INDEXES):
        if not inspector.has_table(table_name):
            continue
        existing_indexes = {
            index["name"] for index in inspector.get_indexes(table_name)
        }
        if index_name not in existing_indexes:
            continue
        op.drop_index(index_name, table_name=table_name)

"""Trading core pipeline columns

Revision ID: 0002_trading_core
Revises: 0001_initial
Create Date: 2026-01-01 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0002_trading_core"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    trade_decision_columns = {column["name"] for column in inspector.get_columns("trade_decisions")}
    if "decision_hash" not in trade_decision_columns:
        op.add_column("trade_decisions", sa.Column("decision_hash", sa.String(length=64), nullable=True))
    if "executed_at" not in trade_decision_columns:
        op.add_column("trade_decisions", sa.Column("executed_at", sa.DateTime(timezone=True), nullable=True))

    trade_decision_indexes = {index["name"] for index in inspector.get_indexes("trade_decisions")}
    if "ix_trade_decisions_decision_hash" not in trade_decision_indexes:
        op.create_index(
            "ix_trade_decisions_decision_hash",
            "trade_decisions",
            ["decision_hash"],
            unique=True,
        )

    execution_columns = {column["name"] for column in inspector.get_columns("executions")}
    if "last_update_at" not in execution_columns:
        op.add_column("executions", sa.Column("last_update_at", sa.DateTime(timezone=True), nullable=True))

    if not inspector.has_table("trade_cursor"):
        op.create_table(
            "trade_cursor",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("source", sa.String(length=64), nullable=False, unique=True),
            sa.Column("cursor_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
        )


def downgrade() -> None:
    op.drop_table("trade_cursor")

    op.drop_column("executions", "last_update_at")

    op.drop_index("ix_trade_decisions_decision_hash", table_name="trade_decisions")
    op.drop_column("trade_decisions", "executed_at")
    op.drop_column("trade_decisions", "decision_hash")

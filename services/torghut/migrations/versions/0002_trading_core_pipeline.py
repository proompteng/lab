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
    op.add_column("trade_decisions", sa.Column("decision_hash", sa.String(length=64), nullable=True))
    op.add_column("trade_decisions", sa.Column("executed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "ix_trade_decisions_decision_hash",
        "trade_decisions",
        ["decision_hash"],
        unique=True,
    )

    op.add_column("executions", sa.Column("last_update_at", sa.DateTime(timezone=True), nullable=True))

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

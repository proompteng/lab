"""Add cursor_seq to trade_cursor

Revision ID: 0004_trade_cursor_seq
Revises: 0003_llm_decision_reviews
Create Date: 2026-01-02 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision = "0004_trade_cursor_seq"
down_revision = "0003_llm_decision_reviews"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("trade_cursor", sa.Column("cursor_seq", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("trade_cursor", "cursor_seq")

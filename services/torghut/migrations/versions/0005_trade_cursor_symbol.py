"""Add cursor_symbol to trade_cursor

Revision ID: 0005_trade_cursor_symbol
Revises: 0004_trade_cursor_seq
Create Date: 2026-01-03 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision = "0005_trade_cursor_symbol"
down_revision = "0004_trade_cursor_seq"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("trade_cursor", sa.Column("cursor_symbol", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("trade_cursor", "cursor_symbol")

"""Merge the released strategy-capital revision with the linearized chain.

Revision ID: 0065_strategy_capital_compat
Revises: 0064_strategy_capital_authority, 0063_strategy_capital_authority
Create Date: 2026-07-14 06:41:00.000000
"""

from __future__ import annotations


revision = "0065_strategy_capital_compat"
down_revision = (
    "0064_strategy_capital_authority",
    "0063_strategy_capital_authority",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

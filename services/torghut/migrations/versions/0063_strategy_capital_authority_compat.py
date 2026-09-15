"""Preserve the previously shipped strategy-capital revision identifier.

Revision ID: 0063_strategy_capital_authority
Revises: 0062_options_archive_members
Create Date: 2026-07-14 06:40:00.000000

This revision was released before the strategy-capital migration was moved to
0064 to linearize the options archive index. Databases stamped at the old ID
already contain the strategy-capital schema, so this node must remain a no-op.
The idempotent 0064 migration repairs or completes that schema on the path to
the merge revision.
"""

from __future__ import annotations


revision = "0063_strategy_capital_authority"
down_revision = "0062_options_archive_members"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

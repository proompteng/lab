"""Widen LEAN shadow parity status columns.

Revision ID: 0025_widen_lean_shadow_parity_status
Revises: 0024_simulation_runtime_context
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025_widen_lean_shadow_parity_status"
down_revision = "0024_simulation_runtime_context"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "lean_execution_shadow_events",
        "parity_status",
        existing_type=sa.String(length=32),
        type_=sa.String(length=64),
        existing_nullable=False,
        existing_server_default=sa.text("'unknown'"),
    )
    op.alter_column(
        "lean_strategy_shadow_evaluations",
        "parity_status",
        existing_type=sa.String(length=32),
        type_=sa.String(length=64),
        existing_nullable=False,
        existing_server_default=sa.text("'unknown'"),
    )


def downgrade() -> None:
    op.alter_column(
        "lean_strategy_shadow_evaluations",
        "parity_status",
        existing_type=sa.String(length=64),
        type_=sa.String(length=32),
        existing_nullable=False,
        existing_server_default=sa.text("'unknown'"),
    )
    op.alter_column(
        "lean_execution_shadow_events",
        "parity_status",
        existing_type=sa.String(length=64),
        type_=sa.String(length=32),
        existing_nullable=False,
        existing_server_default=sa.text("'unknown'"),
    )

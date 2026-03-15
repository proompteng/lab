"""Add explicit simulation runtime context table.

Revision ID: 0024_simulation_runtime_context
Revises: 0023_simulation_run_progress
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0024_simulation_runtime_context"
down_revision = "0023_simulation_run_progress"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "simulation_runtime_context",
        sa.Column("lane", sa.String(length=32), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("dataset_id", sa.String(length=128), nullable=True),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cache_key", sa.String(length=128), nullable=True),
        sa.Column("cache_artifact_path", sa.String(length=512), nullable=True),
        sa.Column("cache_manifest_path", sa.String(length=512), nullable=True),
        sa.Column(
            "warm_lane_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "metadata_json",
            _json_type(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("lane", "account_label", name="pk_simulation_runtime_context"),
    )
    op.create_index(
        "ix_simulation_runtime_context_run",
        "simulation_runtime_context",
        ["run_id"],
    )
    op.create_index(
        "ix_simulation_runtime_context_updated_at",
        "simulation_runtime_context",
        ["updated_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_simulation_runtime_context_updated_at", table_name="simulation_runtime_context")
    op.drop_index("ix_simulation_runtime_context_run", table_name="simulation_runtime_context")
    op.drop_table("simulation_runtime_context")

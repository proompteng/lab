"""Add durable simulation run progress ledger."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0023_simulation_run_progress"
down_revision = "0022_options_lane_control_plane"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "simulation_run_progress",
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("component", sa.String(length=32), nullable=False),
        sa.Column("dataset_id", sa.String(length=128), nullable=True),
        sa.Column(
            "lane",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'equity'"),
        ),
        sa.Column("workflow_name", sa.String(length=128), nullable=True),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("last_source_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_signal_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_price_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cursor_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "records_dumped",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "records_replayed",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "trade_decisions",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "executions",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "execution_tca_metrics",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "execution_order_events",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("strategy_type", sa.String(length=128), nullable=True),
        sa.Column(
            "legacy_path_count",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "fallback_count",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("terminal_state", sa.String(length=64), nullable=True),
        sa.Column("last_error_code", sa.String(length=128), nullable=True),
        sa.Column("last_error_message", sa.Text(), nullable=True),
        sa.Column(
            "payload_json",
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
        sa.PrimaryKeyConstraint(
            "run_id",
            "component",
            name="pk_simulation_run_progress",
        ),
    )
    op.create_index(
        "ix_simulation_run_progress_status",
        "simulation_run_progress",
        ["status"],
    )
    op.create_index(
        "ix_simulation_run_progress_updated_at",
        "simulation_run_progress",
        ["updated_at"],
    )
    op.create_index(
        "ix_simulation_run_progress_dataset",
        "simulation_run_progress",
        ["dataset_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_simulation_run_progress_dataset", table_name="simulation_run_progress")
    op.drop_index("ix_simulation_run_progress_updated_at", table_name="simulation_run_progress")
    op.drop_index("ix_simulation_run_progress_status", table_name="simulation_run_progress")
    op.drop_table("simulation_run_progress")

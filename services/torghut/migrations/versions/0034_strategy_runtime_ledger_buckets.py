"""Add durable strategy runtime ledger buckets.

Revision ID: 0034_strategy_runtime_ledger_buckets
Revises: 0033_rejected_signal_outcome_events
Create Date: 2026-05-21 12:35:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0034_strategy_runtime_ledger_buckets"
down_revision = "0033_rejected_signal_outcome_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "strategy_runtime_ledger_buckets",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
        sa.Column("observed_stage", sa.String(length=32), nullable=False),
        sa.Column("bucket_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bucket_ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=True),
        sa.Column("runtime_strategy_name", sa.String(length=255), nullable=True),
        sa.Column("strategy_family", sa.String(length=128), nullable=True),
        sa.Column(
            "fill_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "decision_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "submitted_order_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "cancelled_order_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "rejected_order_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "unfilled_order_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "closed_trade_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "open_position_count",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "filled_notional",
            sa.Numeric(20, 8),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "gross_strategy_pnl",
            sa.Numeric(20, 8),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "cost_amount",
            sa.Numeric(20, 8),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "net_strategy_pnl_after_costs",
            sa.Numeric(20, 8),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("post_cost_expectancy_bps", sa.Numeric(20, 8), nullable=True),
        sa.Column("ledger_schema_version", sa.String(length=64), nullable=False),
        sa.Column("pnl_basis", sa.String(length=64), nullable=False),
        sa.Column("execution_policy_hash_counts", sa.JSON(), nullable=True),
        sa.Column("cost_model_hash_counts", sa.JSON(), nullable=True),
        sa.Column("lineage_hash_counts", sa.JSON(), nullable=True),
        sa.Column("blockers_json", sa.JSON(), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_strategy_runtime_ledger_buckets"),
    )
    op.create_index(
        "ix_strategy_runtime_ledger_buckets_run_id",
        "strategy_runtime_ledger_buckets",
        ["run_id"],
    )
    op.create_index(
        "ix_strategy_runtime_ledger_buckets_hypothesis_id",
        "strategy_runtime_ledger_buckets",
        ["hypothesis_id"],
    )
    op.create_index(
        "ix_strategy_runtime_ledger_buckets_candidate_id",
        "strategy_runtime_ledger_buckets",
        ["candidate_id"],
    )
    op.create_index(
        "ix_strategy_runtime_ledger_buckets_stage_started",
        "strategy_runtime_ledger_buckets",
        ["observed_stage", "bucket_started_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_strategy_runtime_ledger_buckets_stage_started",
        table_name="strategy_runtime_ledger_buckets",
    )
    op.drop_index(
        "ix_strategy_runtime_ledger_buckets_candidate_id",
        table_name="strategy_runtime_ledger_buckets",
    )
    op.drop_index(
        "ix_strategy_runtime_ledger_buckets_hypothesis_id",
        table_name="strategy_runtime_ledger_buckets",
    )
    op.drop_index(
        "ix_strategy_runtime_ledger_buckets_run_id",
        table_name="strategy_runtime_ledger_buckets",
    )
    op.drop_table("strategy_runtime_ledger_buckets")

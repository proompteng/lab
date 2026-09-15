"""Generic multifactor machine proof tables.

Revision ID: 0057_generic_multifactor_machine
Revises: 0056_hyperliquid_execution_v2_hard_reset
Create Date: 2026-06-25 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0057_generic_multifactor_machine"
down_revision = "0056_hyperliquid_execution_v2_hard_reset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "multifactor_runs",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("lane", sa.String(length=64), nullable=False),
        sa.Column("model_version", sa.String(length=128), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column(
            "blockers",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "selected_assets",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "raw_payload",
            postgresql.JSONB(astext_type=sa.Text()),
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
        sa.PrimaryKeyConstraint("id", name="pk_multifactor_runs"),
    )
    op.create_index("ix_multifactor_runs_finished", "multifactor_runs", ["finished_at"])

    op.create_table(
        "multifactor_factor_snapshots",
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("asset_key", sa.String(length=256), nullable=False),
        sa.Column("venue", sa.String(length=64), nullable=False),
        sa.Column("symbol", sa.String(length=64), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("source_event_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "raw_factors", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "normalized_factors",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("source_lag_seconds", sa.Integer(), nullable=False),
        sa.Column("quote_lag_seconds", sa.Integer(), nullable=True),
        sa.Column("freshness_blocker", sa.String(length=128), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["multifactor_runs.id"], name="fk_multifactor_factors_run"
        ),
        sa.PrimaryKeyConstraint(
            "run_id", "asset_key", name="pk_multifactor_factor_snapshots"
        ),
    )

    op.create_table(
        "multifactor_forecasts",
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("asset_key", sa.String(length=256), nullable=False),
        sa.Column("model_id", sa.String(length=128), nullable=False),
        sa.Column("signal_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("horizon_seconds", sa.Integer(), nullable=False),
        sa.Column("score", sa.Numeric(18, 8), nullable=False),
        sa.Column("residual_volatility_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("information_coefficient", sa.Numeric(18, 8), nullable=False),
        sa.Column("expected_return_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("direction", sa.String(length=16), nullable=False),
        sa.Column("blocker", sa.String(length=128), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["multifactor_runs.id"], name="fk_multifactor_forecasts_run"
        ),
        sa.PrimaryKeyConstraint("run_id", "asset_key", name="pk_multifactor_forecasts"),
    )

    op.create_table(
        "multifactor_risk_forecasts",
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("asset_key", sa.String(length=256), nullable=False),
        sa.Column("active_risk_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("gross_exposure_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("symbol_exposure_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("liquidity_capacity_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("concentration_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("blocker", sa.String(length=128), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["multifactor_runs.id"], name="fk_multifactor_risk_run"
        ),
        sa.PrimaryKeyConstraint(
            "run_id", "asset_key", name="pk_multifactor_risk_forecasts"
        ),
    )

    op.create_table(
        "multifactor_portfolio_targets",
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("asset_key", sa.String(length=256), nullable=False),
        sa.Column("direction", sa.String(length=16), nullable=False),
        sa.Column("current_notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("target_notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("delta_notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("expected_return_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("expected_cost_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("active_risk_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("risk_buffer_bps", sa.Numeric(18, 8), nullable=False),
        sa.Column("clip_reason", sa.String(length=128), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["multifactor_runs.id"], name="fk_multifactor_targets_run"
        ),
        sa.PrimaryKeyConstraint(
            "run_id", "asset_key", name="pk_multifactor_portfolio_targets"
        ),
    )

    op.create_table(
        "multifactor_execution_intents",
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("asset_key", sa.String(length=256), nullable=False),
        sa.Column("venue", sa.String(length=64), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("blocker", sa.Text(), nullable=True),
        sa.Column("venue_order_id", sa.String(length=128), nullable=True),
        sa.Column(
            "raw_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["multifactor_runs.id"], name="fk_multifactor_intents_run"
        ),
        sa.PrimaryKeyConstraint(
            "run_id", "asset_key", name="pk_multifactor_execution_intents"
        ),
    )

    op.create_table(
        "multifactor_attribution_snapshots",
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fill_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "realized_pnl_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "turnover_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "realized_cost_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column("information_coefficient", sa.Numeric(18, 8), nullable=True),
        sa.Column("information_ratio", sa.Numeric(18, 8), nullable=True),
        sa.Column("hit_rate", sa.Numeric(18, 8), nullable=True),
        sa.Column(
            "raw_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["multifactor_runs.id"], name="fk_multifactor_attribution_run"
        ),
        sa.PrimaryKeyConstraint("run_id", name="pk_multifactor_attribution_snapshots"),
    )


def downgrade() -> None:
    for table_name in (
        "multifactor_attribution_snapshots",
        "multifactor_execution_intents",
        "multifactor_portfolio_targets",
        "multifactor_risk_forecasts",
        "multifactor_forecasts",
        "multifactor_factor_snapshots",
        "multifactor_runs",
    ):
        op.drop_table(table_name)

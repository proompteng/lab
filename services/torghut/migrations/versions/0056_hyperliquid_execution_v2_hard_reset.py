"""Hard reset Hyperliquid execution v2 tables.

Revision ID: 0056_hyperliquid_execution_v2_hard_reset
Revises: 0055_hyperliquid_tigerbeetle_ref_u128
Create Date: 2026-06-19 22:15:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0056_hyperliquid_execution_v2_hard_reset"
down_revision = "0055_hyperliquid_tigerbeetle_ref_u128"
branch_labels = None
depends_on = None


V1_TABLES = (
    "hyperliquid_runtime_tigerbeetle_refs",
    "hyperliquid_runtime_kill_switch_events",
    "hyperliquid_runtime_optimizer_runs",
    "hyperliquid_runtime_performance_snapshots",
    "hyperliquid_runtime_positions",
    "hyperliquid_runtime_account_snapshots",
    "hyperliquid_runtime_fills",
    "hyperliquid_runtime_orders",
    "hyperliquid_runtime_decisions",
    "hyperliquid_runtime_signals",
    "hyperliquid_runtime_markets",
)

V2_TABLES = (
    "hyperliquid_execution_performance_snapshots",
    "hyperliquid_execution_positions",
    "hyperliquid_execution_account_snapshots",
    "hyperliquid_execution_fills",
    "hyperliquid_execution_orders",
    "hyperliquid_execution_signals",
    "hyperliquid_execution_symbol_state",
    "hyperliquid_execution_cycles",
)


def upgrade() -> None:
    for table_name in V1_TABLES:
        op.execute(sa.text(f"DROP TABLE IF EXISTS {table_name} CASCADE"))

    op.create_table(
        "hyperliquid_execution_cycles",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("trading_enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "selected_coins",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("signals_written", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("orders_submitted", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("orders_cancelled", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "dependency_statuses",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "universe_details",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_execution_cycles"),
    )
    op.create_index(
        "ix_hyperliquid_execution_cycles_finished",
        "hyperliquid_execution_cycles",
        ["finished_at"],
    )

    op.create_table(
        "hyperliquid_execution_symbol_state",
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=True),
        sa.Column("dex", sa.String(length=64), nullable=True),
        sa.Column(
            "active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column("cooldown_reason", sa.String(length=128), nullable=True),
        sa.Column("cooldown_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_metadata",
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
        sa.PrimaryKeyConstraint("coin", name="pk_hyperliquid_execution_symbol_state"),
    )
    op.create_index(
        "ix_hyperliquid_execution_symbol_state_cooldown",
        "hyperliquid_execution_symbol_state",
        ["cooldown_until"],
    )

    op.create_table(
        "hyperliquid_execution_signals",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("cycle_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("market_data_network", sa.String(length=16), nullable=False),
        sa.Column("execution_network", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("edge_bps", sa.Numeric(18, 8), nullable=False, server_default="0"),
        sa.Column("reason", sa.String(length=128), nullable=False),
        sa.Column("feature_event_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("features", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["cycle_id"],
            ["hyperliquid_execution_cycles.id"],
            name="fk_hyperliquid_execution_signals_cycle",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_execution_signals"),
    )
    op.create_index(
        "ix_hyperliquid_execution_signals_coin_generated",
        "hyperliquid_execution_signals",
        ["coin", "generated_at"],
    )

    op.create_table(
        "hyperliquid_execution_orders",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("signal_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("execution_network", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("cloid", sa.String(length=66), nullable=False),
        sa.Column("exchange_order_id", sa.String(length=128), nullable=True),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("size", sa.Numeric(28, 12), nullable=False),
        sa.Column("limit_price", sa.Numeric(28, 10), nullable=False),
        sa.Column("notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column(
            "reduce_only", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("tif", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "raw_response", postgresql.JSONB(astext_type=sa.Text()), nullable=False
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
        sa.ForeignKeyConstraint(
            ["signal_id"],
            ["hyperliquid_execution_signals.id"],
            name="fk_hyperliquid_execution_orders_signal",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_execution_orders"),
        sa.UniqueConstraint(
            "execution_network",
            "cloid",
            name="uq_hyperliquid_execution_orders_cloid",
        ),
    )
    op.create_index(
        "ix_hyperliquid_execution_orders_status_coin",
        "hyperliquid_execution_orders",
        ["status", "coin"],
    )
    op.create_index(
        "ix_hyperliquid_execution_orders_expires",
        "hyperliquid_execution_orders",
        ["expires_at"],
    )

    op.create_table(
        "hyperliquid_execution_fills",
        sa.Column("execution_network", sa.String(length=16), nullable=False),
        sa.Column("fill_hash", sa.String(length=128), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("price", sa.Numeric(28, 10), nullable=False),
        sa.Column("size", sa.Numeric(28, 12), nullable=False),
        sa.Column("notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("fee_usd", sa.Numeric(28, 8), nullable=False, server_default="0"),
        sa.Column(
            "closed_pnl_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column("exchange_order_id", sa.String(length=128), nullable=True),
        sa.Column("event_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "raw_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["hyperliquid_execution_orders.id"],
            name="fk_hyperliquid_execution_fills_order",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint(
            "execution_network",
            "fill_hash",
            name="pk_hyperliquid_execution_fills",
        ),
    )
    op.create_index(
        "ix_hyperliquid_execution_fills_coin_event",
        "hyperliquid_execution_fills",
        ["coin", "event_ts"],
    )

    op.create_table(
        "hyperliquid_execution_positions",
        sa.Column("execution_network", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("size", sa.Numeric(28, 12), nullable=False),
        sa.Column("entry_price", sa.Numeric(28, 10), nullable=True),
        sa.Column("notional_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column(
            "unrealized_pnl_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "raw_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.PrimaryKeyConstraint(
            "execution_network",
            "coin",
            name="pk_hyperliquid_execution_positions",
        ),
    )

    op.create_table(
        "hyperliquid_execution_account_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("execution_network", sa.String(length=16), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "account_value_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "withdrawable_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "gross_exposure_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "raw_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.PrimaryKeyConstraint(
            "id", name="pk_hyperliquid_execution_account_snapshots"
        ),
    )
    op.create_index(
        "ix_hyperliquid_execution_account_observed",
        "hyperliquid_execution_account_snapshots",
        ["observed_at"],
    )

    op.create_table(
        "hyperliquid_execution_performance_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("execution_network", sa.String(length=16), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fill_count_24h", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "notional_usd_24h", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "fees_usd_24h", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "net_pnl_after_fees_usd_24h",
            sa.Numeric(28, 8),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "max_drawdown_usd_24h",
            sa.Numeric(28, 8),
            nullable=False,
            server_default="0",
        ),
        sa.Column("fill_count_7d", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "notional_usd_7d", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column("fees_usd_7d", sa.Numeric(28, 8), nullable=False, server_default="0"),
        sa.Column(
            "net_pnl_after_fees_usd_7d",
            sa.Numeric(28, 8),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "max_drawdown_usd_7d", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "maker_fill_rate_24h", sa.Numeric(18, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "cancel_rate_24h", sa.Numeric(18, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "reject_rate_24h", sa.Numeric(18, 8), nullable=False, server_default="0"
        ),
        sa.Column(
            "sample_ready",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "symbol_pnl",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.PrimaryKeyConstraint(
            "id", name="pk_hyperliquid_execution_performance_snapshots"
        ),
    )
    op.create_index(
        "ix_hyperliquid_execution_performance_observed",
        "hyperliquid_execution_performance_snapshots",
        ["observed_at"],
    )


def downgrade() -> None:
    for table_name in V2_TABLES:
        op.execute(sa.text(f"DROP TABLE IF EXISTS {table_name} CASCADE"))

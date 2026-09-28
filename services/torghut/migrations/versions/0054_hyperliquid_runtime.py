"""Add isolated Hyperliquid runtime tables.

Revision ID: 0054_hyperliquid_runtime
Revises: 0053_paper_route_proof_read_indexes
Create Date: 2026-06-18 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0054_hyperliquid_runtime"
down_revision = "0053_paper_route_proof_read_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "hyperliquid_runtime_markets",
        sa.Column("network", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("dex", sa.String(length=64), nullable=False),
        sa.Column("asset_class", sa.String(length=32), nullable=False),
        sa.Column(
            "day_notional_volume_usd",
            sa.Numeric(28, 8),
            nullable=False,
            server_default="0",
        ),
        sa.Column("mark_price", sa.Numeric(28, 10), nullable=True),
        sa.Column("mid_price", sa.Numeric(28, 10), nullable=True),
        sa.Column(
            "open_interest_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column("max_leverage", sa.Integer(), nullable=True),
        sa.Column(
            "payload",
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
        sa.PrimaryKeyConstraint(
            "network", "market_id", name="pk_hyperliquid_runtime_markets"
        ),
    )
    op.create_index(
        "ix_hyperliquid_runtime_markets_asset_volume",
        "hyperliquid_runtime_markets",
        ["asset_class", "day_notional_volume_usd"],
    )

    op.create_table(
        "hyperliquid_runtime_signals",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("network", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("strength", sa.Numeric(18, 8), nullable=False),
        sa.Column("reason", sa.String(length=128), nullable=False),
        sa.Column("parameter_version", sa.String(length=128), nullable=False),
        sa.Column("feature_event_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("features", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_runtime_signals"),
    )
    op.create_index(
        "ix_hyperliquid_runtime_signals_market_generated",
        "hyperliquid_runtime_signals",
        ["market_id", "generated_at"],
    )

    op.create_table(
        "hyperliquid_runtime_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("signal_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("network", sa.String(length=16), nullable=False),
        sa.Column("market_id", sa.String(length=128), nullable=False),
        sa.Column("coin", sa.String(length=64), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=160), nullable=False),
        sa.Column(
            "order_notional_usd", sa.Numeric(28, 8), nullable=False, server_default="0"
        ),
        sa.Column("decision_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["signal_id"],
            ["hyperliquid_runtime_signals.id"],
            name="fk_hyperliquid_runtime_decisions_signal",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_runtime_decisions"),
        sa.UniqueConstraint(
            "network", "decision_hash", name="uq_hyperliquid_runtime_decisions_hash"
        ),
    )
    op.create_index(
        "ix_hyperliquid_runtime_decisions_market_decided",
        "hyperliquid_runtime_decisions",
        ["market_id", "decided_at"],
    )

    op.create_table(
        "hyperliquid_runtime_orders",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("decision_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("network", sa.String(length=16), nullable=False),
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
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
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
            ["decision_id"],
            ["hyperliquid_runtime_decisions.id"],
            name="fk_hyperliquid_runtime_orders_decision",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_runtime_orders"),
        sa.UniqueConstraint(
            "network", "cloid", name="uq_hyperliquid_runtime_orders_cloid"
        ),
    )
    op.create_index(
        "ix_hyperliquid_runtime_orders_status_market",
        "hyperliquid_runtime_orders",
        ["status", "market_id"],
    )

    op.create_table(
        "hyperliquid_runtime_fills",
        sa.Column("network", sa.String(length=16), nullable=False),
        sa.Column("fill_hash", sa.String(length=128), nullable=False),
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
        sa.PrimaryKeyConstraint(
            "network", "fill_hash", name="pk_hyperliquid_runtime_fills"
        ),
    )
    op.create_index(
        "ix_hyperliquid_runtime_fills_market_event",
        "hyperliquid_runtime_fills",
        ["market_id", "event_ts"],
    )

    op.create_table(
        "hyperliquid_runtime_positions",
        sa.Column("network", sa.String(length=16), nullable=False),
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
            "network", "market_id", name="pk_hyperliquid_runtime_positions"
        ),
    )

    op.create_table(
        "hyperliquid_runtime_account_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("network", sa.String(length=16), nullable=False),
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
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_runtime_account_snapshots"),
    )
    op.create_index(
        "ix_hyperliquid_runtime_account_snapshots_observed",
        "hyperliquid_runtime_account_snapshots",
        ["observed_at"],
    )

    op.create_table(
        "hyperliquid_runtime_performance_snapshots",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("network", sa.String(length=16), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gross_exposure_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("realized_pnl_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("unrealized_pnl_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("fees_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("trade_count", sa.Integer(), nullable=False),
        sa.Column("reconciliation_status", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint(
            "id", name="pk_hyperliquid_runtime_performance_snapshots"
        ),
    )
    op.create_index(
        "ix_hyperliquid_runtime_performance_observed",
        "hyperliquid_runtime_performance_snapshots",
        ["observed_at"],
    )

    op.create_table(
        "hyperliquid_runtime_optimizer_runs",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("parameter_version", sa.String(length=128), nullable=False),
        sa.Column("trade_count", sa.Integer(), nullable=False),
        sa.Column("net_pnl_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("max_drawdown_usd", sa.Numeric(28, 8), nullable=False),
        sa.Column("reconciliation_gap_count", sa.Integer(), nullable=False),
        sa.Column("stale_period_count", sa.Integer(), nullable=False),
        sa.Column("promoted", sa.Boolean(), nullable=False),
        sa.Column(
            "rejection_reasons", postgresql.ARRAY(sa.String(length=128)), nullable=False
        ),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_runtime_optimizer_runs"),
    )

    op.create_table(
        "hyperliquid_runtime_kill_switch_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("network", sa.String(length=16), nullable=False),
        sa.Column(
            "event_ts",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("reason", sa.String(length=160), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_hyperliquid_runtime_kill_switch_events"),
    )

    op.create_table(
        "hyperliquid_runtime_tigerbeetle_refs",
        sa.Column("transfer_id", sa.Numeric(39, 0), nullable=False),
        sa.Column("source_id", sa.String(length=160), nullable=False),
        sa.Column("transfer_kind", sa.String(length=64), nullable=False),
        sa.Column("debit_account_id", sa.Numeric(39, 0), nullable=False),
        sa.Column("credit_account_id", sa.Numeric(39, 0), nullable=False),
        sa.Column("amount", sa.Numeric(39, 0), nullable=False),
        sa.Column("ledger", sa.Integer(), nullable=False),
        sa.Column("code", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint(
            "transfer_id", name="pk_hyperliquid_runtime_tigerbeetle_refs"
        ),
    )
    op.create_index(
        "ix_hyperliquid_runtime_tigerbeetle_refs_source",
        "hyperliquid_runtime_tigerbeetle_refs",
        ["source_id", "transfer_kind"],
    )


def downgrade() -> None:
    for table_name in (
        "hyperliquid_runtime_tigerbeetle_refs",
        "hyperliquid_runtime_kill_switch_events",
        "hyperliquid_runtime_optimizer_runs",
        "hyperliquid_runtime_performance_snapshots",
        "hyperliquid_runtime_account_snapshots",
        "hyperliquid_runtime_positions",
        "hyperliquid_runtime_fills",
        "hyperliquid_runtime_orders",
        "hyperliquid_runtime_decisions",
        "hyperliquid_runtime_signals",
        "hyperliquid_runtime_markets",
    ):
        op.drop_table(table_name)

"""Initial torghut schema

Revision ID: 0001_initial
Revises: 
Create Date: 2025-12-03 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "strategies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("base_timeframe", sa.String(length=16), nullable=False),
        sa.Column("universe_type", sa.String(length=64), nullable=False),
        sa.Column("universe_symbols", postgresql.JSONB(), nullable=True),
        sa.Column("max_position_pct_equity", sa.Numeric(20, 8), nullable=True),
        sa.Column("max_notional_per_trade", sa.Numeric(20, 8), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_strategies_enabled", "strategies", ["enabled"], unique=False)
    op.create_index("ix_strategies_name", "strategies", ["name"], unique=False)

    op.create_table(
        "trade_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("strategy_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("alpaca_account_label", sa.String(length=64), nullable=False),
        sa.Column("symbol", sa.String(length=16), nullable=False),
        sa.Column("timeframe", sa.String(length=16), nullable=False),
        sa.Column("decision_json", postgresql.JSONB(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default=sa.text("'planned'")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_trade_decisions_strategy", "trade_decisions", ["strategy_id"], unique=False)
    op.create_index("ix_trade_decisions_status", "trade_decisions", ["status"], unique=False)

    op.create_table(
        "executions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("trade_decision_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("trade_decisions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("alpaca_order_id", sa.String(length=128), nullable=False, unique=True),
        sa.Column("client_order_id", sa.String(length=128), nullable=True, unique=True),
        sa.Column("symbol", sa.String(length=16), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("order_type", sa.String(length=32), nullable=False),
        sa.Column("time_in_force", sa.String(length=16), nullable=False),
        sa.Column("submitted_qty", sa.Numeric(20, 8), nullable=False),
        sa.Column("filled_qty", sa.Numeric(20, 8), nullable=False, server_default=sa.text("0")),
        sa.Column("avg_fill_price", sa.Numeric(20, 8), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("raw_order", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_executions_alpaca_order_id", "executions", ["alpaca_order_id"], unique=False)
    op.create_index("ix_executions_symbol_status", "executions", ["symbol", "status"], unique=False)

    op.create_table(
        "position_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("alpaca_account_label", sa.String(length=64), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("equity", sa.Numeric(20, 8), nullable=False),
        sa.Column("cash", sa.Numeric(20, 8), nullable=False),
        sa.Column("buying_power", sa.Numeric(20, 8), nullable=False),
        sa.Column("positions", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_position_snapshots_as_of", "position_snapshots", ["as_of"], unique=False)
    op.create_index(
        "ix_position_snapshots_account_label",
        "position_snapshots",
        ["alpaca_account_label"],
        unique=False,
    )

    op.create_table(
        "tool_run_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("codex_session_id", sa.String(length=128), nullable=False),
        sa.Column("tool_name", sa.String(length=128), nullable=False),
        sa.Column("request_payload", postgresql.JSONB(), nullable=False),
        sa.Column("response_payload", postgresql.JSONB(), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_tool_run_logs_codex_session", "tool_run_logs", ["codex_session_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_tool_run_logs_codex_session", table_name="tool_run_logs")
    op.drop_table("tool_run_logs")

    op.drop_index("ix_position_snapshots_account_label", table_name="position_snapshots")
    op.drop_index("ix_position_snapshots_as_of", table_name="position_snapshots")
    op.drop_table("position_snapshots")

    op.drop_index("ix_executions_symbol_status", table_name="executions")
    op.drop_index("ix_executions_alpaca_order_id", table_name="executions")
    op.drop_table("executions")

    op.drop_index("ix_trade_decisions_status", table_name="trade_decisions")
    op.drop_index("ix_trade_decisions_strategy", table_name="trade_decisions")
    op.drop_table("trade_decisions")

    op.drop_index("ix_strategies_name", table_name="strategies")
    op.drop_index("ix_strategies_enabled", table_name="strategies")
    op.drop_table("strategies")

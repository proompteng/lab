"""Add durable rejected-signal outcome event ledger.

Revision ID: 0033_rejected_signal_outcome_events
Revises: 0032_options_catalog_active_underlying_index
Create Date: 2026-05-18 11:30:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0033_rejected_signal_outcome_events"
down_revision = "0032_options_catalog_active_underlying_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rejected_signal_outcome_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.String(length=64), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("paper_source", sa.String(length=128), nullable=False),
        sa.Column("paper_claim_id", sa.String(length=128), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("symbol", sa.String(length=16), nullable=False),
        sa.Column("event_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("timeframe", sa.String(length=16), nullable=False),
        sa.Column("seq", sa.String(length=64), nullable=True),
        sa.Column("reject_reason", sa.String(length=128), nullable=False),
        sa.Column("spread_bps", sa.Numeric(20, 8), nullable=True),
        sa.Column("jump_bps", sa.Numeric(20, 8), nullable=True),
        sa.Column(
            "outcome_label_status",
            sa.String(length=32),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column(
            "counterfactual_required",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column("required_outcome_fields_json", sa.JSON(), nullable=False),
        sa.Column("event_payload_json", sa.JSON(), nullable=False),
        sa.Column("outcome_payload_json", sa.JSON(), nullable=True),
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
        sa.PrimaryKeyConstraint("id", name="pk_rejected_signal_outcome_events"),
    )
    op.create_index(
        "uq_rejected_signal_outcome_events_event_id",
        "rejected_signal_outcome_events",
        ["event_id"],
        unique=True,
    )
    op.create_index(
        "ix_rejected_signal_outcome_events_status_ts",
        "rejected_signal_outcome_events",
        ["outcome_label_status", "event_ts"],
    )
    op.create_index(
        "ix_rejected_signal_outcome_events_account_symbol_ts",
        "rejected_signal_outcome_events",
        ["account_label", "symbol", "event_ts"],
    )
    op.create_index(
        "ix_rejected_signal_outcome_events_reason",
        "rejected_signal_outcome_events",
        ["reject_reason"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_rejected_signal_outcome_events_reason",
        table_name="rejected_signal_outcome_events",
    )
    op.drop_index(
        "ix_rejected_signal_outcome_events_account_symbol_ts",
        table_name="rejected_signal_outcome_events",
    )
    op.drop_index(
        "ix_rejected_signal_outcome_events_status_ts",
        table_name="rejected_signal_outcome_events",
    )
    op.drop_index(
        "uq_rejected_signal_outcome_events_event_id",
        table_name="rejected_signal_outcome_events",
    )
    op.drop_table("rejected_signal_outcome_events")

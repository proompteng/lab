"""Add LLM decision reviews table

Revision ID: 0003_llm_decision_reviews
Revises: 0002_trading_core
Create Date: 2026-01-02 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0003_llm_decision_reviews"
down_revision = "0002_trading_core"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_decision_reviews",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "trade_decision_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("trade_decisions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("prompt_version", sa.String(length=32), nullable=False),
        sa.Column("input_json", postgresql.JSONB(), nullable=False),
        sa.Column("response_json", postgresql.JSONB(), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),
        sa.Column("confidence", sa.Numeric(6, 4), nullable=True),
        sa.Column("adjusted_qty", sa.Numeric(20, 8), nullable=True),
        sa.Column("adjusted_order_type", sa.String(length=32), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("risk_flags", postgresql.JSONB(), nullable=True),
        sa.Column("tokens_prompt", sa.Integer(), nullable=True),
        sa.Column("tokens_completion", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_index(
        "ix_llm_decision_reviews_trade_decision_id",
        "llm_decision_reviews",
        ["trade_decision_id"],
    )
    op.create_index(
        "ix_llm_decision_reviews_verdict",
        "llm_decision_reviews",
        ["verdict"],
    )
    op.create_index(
        "ix_llm_decision_reviews_created_at",
        "llm_decision_reviews",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_llm_decision_reviews_created_at", table_name="llm_decision_reviews")
    op.drop_index("ix_llm_decision_reviews_verdict", table_name="llm_decision_reviews")
    op.drop_index("ix_llm_decision_reviews_trade_decision_id", table_name="llm_decision_reviews")
    op.drop_table("llm_decision_reviews")

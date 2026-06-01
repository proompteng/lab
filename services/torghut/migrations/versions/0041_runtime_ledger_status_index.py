"""Add runtime-ledger status lookup index."""

from __future__ import annotations

from alembic import op


revision = "0041_runtime_ledger_status_index"
down_revision = "0040_order_feed_fill_delta_basis"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_strategy_runtime_ledger_buckets_hypothesis_ended_created"


def upgrade() -> None:
    op.execute(
        f"""
CREATE INDEX IF NOT EXISTS {INDEX_NAME}
ON strategy_runtime_ledger_buckets (
    hypothesis_id,
    bucket_ended_at DESC,
    created_at DESC
)
"""
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {INDEX_NAME}")

"""Add a narrow durable status overlay for archive reconciliation.

Revision ID: 0067_options_archive_status
Revises: 0066_broker_submit_coordinator
Create Date: 2026-07-14 22:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0067_options_archive_status"
down_revision = "0066_broker_submit_coordinator"
branch_labels = None
depends_on = None


_TABLE = "torghut_options_contract_archive_status"
_VIEW = "torghut_options_active_contract_catalog"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("contract_symbol", sa.Text(), nullable=False),
        sa.Column("effective_status", sa.Text(), nullable=False),
        sa.Column("query_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("shard_key", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint(
            "contract_symbol",
            name="pk_torghut_options_contract_archive_status",
        ),
        sa.CheckConstraint(
            "effective_status IN ('inactive', 'expired')",
            name="ck_torghut_options_contract_archive_status_value",
        ),
        sa.CheckConstraint(
            "query_fingerprint ~ '^[0-9a-f]{64}$'",
            name="ck_torghut_options_contract_archive_status_fingerprint",
        ),
    )
    op.execute(
        f"""
        CREATE VIEW {_VIEW} AS
        SELECT catalog.*
        FROM torghut_options_contract_catalog AS catalog
        WHERE catalog.status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM {_TABLE} AS archive_status
            WHERE archive_status.contract_symbol = catalog.contract_symbol
          )
        """
    )


def downgrade() -> None:
    op.execute(f"DROP VIEW IF EXISTS {_VIEW}")
    op.drop_table(_TABLE)

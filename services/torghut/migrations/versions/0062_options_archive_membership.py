"""Add crash-resumable options archive membership staging.

Revision ID: 0062_options_archive_members
Revises: 0061_linked_submission_terminal
Create Date: 2026-07-14 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0062_options_archive_members"
down_revision = "0061_linked_submission_terminal"
branch_labels = None
depends_on = None


_TABLE = "torghut_options_archive_membership"


def upgrade() -> None:
    # UNLOGGED preserves ordinary pod restarts without adding archive-page WAL.
    # PostgreSQL may truncate it after a database crash; the worker detects that
    # by comparing its row count with the durable shard watermark.
    op.create_table(
        _TABLE,
        sa.Column("component", sa.Text(), nullable=False),
        sa.Column("query_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("shard_key", sa.Text(), nullable=False),
        sa.Column("contract_symbol", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint(
            "component",
            "query_fingerprint",
            "shard_key",
            "contract_symbol",
            name="pk_torghut_options_archive_membership",
        ),
        sa.CheckConstraint(
            "query_fingerprint ~ '^[0-9a-f]{64}$'",
            name="ck_torghut_options_archive_fingerprint",
        ),
        prefixes=["UNLOGGED"],
    )


def downgrade() -> None:
    op.drop_table(_TABLE)

"""Add compact TigerBeetle reconciliation status columns.

Revision ID: 0050_tigerbeetle_reconciliation_compact_status
Revises: 0049_tigerbeetle_reconciliation_status_lookup
Create Date: 2026-06-03 16:40:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0050_tigerbeetle_reconciliation_compact_status"
down_revision = "0049_tigerbeetle_reconciliation_status_lookup"
branch_labels = None
depends_on = None

TABLE_NAME = "tigerbeetle_reconciliation_runs"
COMPACT_COUNT_COLUMNS = (
    "account_ref_count",
    "transfer_ref_count",
    "runtime_ledger_ref_count",
    "runtime_ledger_signed_ref_count",
    "runtime_ledger_missing_signed_ref_count",
    "runtime_ledger_missing_account_ref_count",
    "stable_ref_count",
    "stable_ref_missing_count",
    "stable_ref_mismatch_count",
)
COMPACT_JSON_COLUMNS = (
    "blockers_json",
    "ref_counts_json",
)


def _column_names() -> set[str]:
    inspector = inspect(op.get_bind())
    if not inspector.has_table(TABLE_NAME):
        return set()
    return {column["name"] for column in inspector.get_columns(TABLE_NAME)}


def upgrade() -> None:
    columns = _column_names()
    if not columns:
        return
    for column_name in COMPACT_COUNT_COLUMNS:
        if column_name in columns:
            continue
        op.add_column(
            TABLE_NAME,
            sa.Column(
                column_name,
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
        )
    for column_name in COMPACT_JSON_COLUMNS:
        if column_name in columns:
            continue
        op.add_column(TABLE_NAME, sa.Column(column_name, sa.JSON(), nullable=True))


def downgrade() -> None:
    columns = _column_names()
    if not columns:
        return
    for column_name in reversed((*COMPACT_JSON_COLUMNS, *COMPACT_COUNT_COLUMNS)):
        if column_name in columns:
            op.drop_column(TABLE_NAME, column_name)

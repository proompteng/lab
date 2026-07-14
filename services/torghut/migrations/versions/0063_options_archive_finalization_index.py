"""Add the bounded options archive finalization index.

Revision ID: 0063_options_archive_final_idx
Revises: 0062_options_archive_members
Create Date: 2026-07-14 01:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0063_options_archive_final_idx"
down_revision = "0062_options_archive_members"
branch_labels = None
depends_on = None


INDEX_NAME = "ix_options_catalog_active_expiration_symbol"
TABLE_NAME = "torghut_options_contract_catalog"


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return

    index_valid = bind.execute(
        sa.text(
            """
            SELECT index_entry.indisvalid AND index_entry.indisready
            FROM pg_index AS index_entry
            WHERE index_entry.indexrelid = to_regclass(:index_name)
            """
        ),
        {"index_name": f"public.{INDEX_NAME}"},
    ).scalar_one_or_none()
    with op.get_context().autocommit_block():
        if index_valid is False:
            op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME}"))
        if index_valid is not True:
            op.execute(
                sa.text(
                    f"""
                    CREATE INDEX CONCURRENTLY {INDEX_NAME}
                    ON {TABLE_NAME} (expiration_date, contract_symbol)
                    WHERE status = 'active'
                    """
                )
            )


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME}"))

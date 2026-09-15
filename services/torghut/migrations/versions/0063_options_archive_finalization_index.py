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


def _index_is_current() -> bool | None:
    value = (
        op.get_bind()
        .execute(
            sa.text(
                """
                SELECT COALESCE((
                    indisvalid
                    AND indisready
                    AND NOT indisunique
                    AND indnkeyatts = 2
                    AND pg_get_indexdef(indexrelid, 1, true) = 'expiration_date'
                    AND pg_get_indexdef(indexrelid, 2, true) = 'contract_symbol'
                    AND pg_get_expr(indpred, indrelid) =
                        '(status = ''active''::text)'
                ), false) AS is_current
                FROM pg_index
                WHERE indexrelid = to_regclass(:index_name)
                """
            ),
            {"index_name": INDEX_NAME},
        )
        .scalar_one_or_none()
    )
    if value is None:
        return None
    return bool(value)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return

    with op.get_context().autocommit_block():
        op.execute(sa.text("SET lock_timeout = '5s'"))
        op.execute(sa.text("SET statement_timeout = '45min'"))
        try:
            state = _index_is_current()
            if state is True:
                return
            if state is False:
                op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME}"))
            op.execute(
                sa.text(
                    f"""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS {INDEX_NAME}
                    ON {TABLE_NAME} (expiration_date, contract_symbol)
                    WHERE status = 'active'
                    """
                )
            )
            if _index_is_current() is not True:
                raise RuntimeError(f"{INDEX_NAME} was not created as a valid index")
        finally:
            op.execute(sa.text("RESET statement_timeout"))
            op.execute(sa.text("RESET lock_timeout"))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME}"))

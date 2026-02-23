"""Remove legacy trade_cursor source-only uniqueness left by older revisions."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = '0014_trade_cursor_legacy_source_uniqueness_cleanup'
down_revision = '0013_multi_account_execution_isolation'
branch_labels = None
depends_on = None


def _index_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {index['name'] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    # Legacy environments can keep either of these names for source-only uniqueness.
    op.execute('ALTER TABLE trade_cursor DROP CONSTRAINT IF EXISTS trade_cursor_source_key')
    op.execute('ALTER TABLE trade_cursor DROP CONSTRAINT IF EXISTS uq_trade_cursor_source')
    op.execute('DROP INDEX IF EXISTS uq_trade_cursor_source')

    inspector = inspect(op.get_bind())
    trade_cursor_indexes = _index_names(inspector, 'trade_cursor')
    if 'uq_trade_cursor_source_account' not in trade_cursor_indexes:
        op.create_index(
            'uq_trade_cursor_source_account',
            'trade_cursor',
            ['source', 'account_label'],
            unique=True,
        )


def downgrade() -> None:
    inspector = inspect(op.get_bind())
    trade_cursor_indexes = _index_names(inspector, 'trade_cursor')
    if 'uq_trade_cursor_source_account' in trade_cursor_indexes:
        op.drop_index('uq_trade_cursor_source_account', table_name='trade_cursor')
    op.execute('ALTER TABLE trade_cursor ADD CONSTRAINT trade_cursor_source_key UNIQUE (source)')

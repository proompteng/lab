"""Add account-scoped execution isolation and trade-updates v2 persistence fields."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = '0013_multi_account_execution_isolation'
down_revision = '0012_lean_multilane_foundation'
branch_labels = None
depends_on = None


def _index_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {index['name'] for index in inspector.get_indexes(table)}


def _column_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {column['name'] for column in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    execution_columns = _column_names(inspector, 'executions')
    if 'alpaca_account_label' not in execution_columns:
        op.add_column(
            'executions',
            sa.Column(
                'alpaca_account_label',
                sa.String(length=64),
                nullable=False,
                server_default=sa.text("'paper'"),
            ),
        )

    op.execute(
        """
        UPDATE executions AS e
        SET alpaca_account_label = td.alpaca_account_label
        FROM trade_decisions AS td
        WHERE e.trade_decision_id = td.id
          AND (e.alpaca_account_label IS NULL OR e.alpaca_account_label = 'paper')
        """
    )

    execution_indexes = _index_names(inspector, 'executions')
    if 'uq_executions_account_alpaca_order_id' not in execution_indexes:
        op.create_index(
            'uq_executions_account_alpaca_order_id',
            'executions',
            ['alpaca_account_label', 'alpaca_order_id'],
            unique=True,
        )
    if 'uq_executions_account_client_order_id' not in execution_indexes:
        op.create_index(
            'uq_executions_account_client_order_id',
            'executions',
            ['alpaca_account_label', 'client_order_id'],
            unique=True,
        )
    if 'ix_executions_account_label' not in execution_indexes:
        op.create_index('ix_executions_account_label', 'executions', ['alpaca_account_label'])

    if 'ix_executions_alpaca_order_id' in execution_indexes:
        op.drop_index('ix_executions_alpaca_order_id', table_name='executions')
    op.execute('ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_alpaca_order_id_key')
    op.execute('ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_client_order_id_key')

    trade_decision_indexes = _index_names(inspector, 'trade_decisions')
    if 'ix_trade_decisions_decision_hash' in trade_decision_indexes:
        op.drop_index('ix_trade_decisions_decision_hash', table_name='trade_decisions')
    op.execute('ALTER TABLE trade_decisions DROP CONSTRAINT IF EXISTS trade_decisions_decision_hash_key')
    if 'uq_trade_decisions_account_decision_hash' not in trade_decision_indexes:
        op.create_index(
            'uq_trade_decisions_account_decision_hash',
            'trade_decisions',
            ['alpaca_account_label', 'decision_hash'],
            unique=True,
        )
    if 'ix_trade_decisions_decision_hash' not in trade_decision_indexes:
        op.create_index('ix_trade_decisions_decision_hash', 'trade_decisions', ['decision_hash'])

    trade_cursor_columns = _column_names(inspector, 'trade_cursor')
    if 'account_label' not in trade_cursor_columns:
        op.add_column(
            'trade_cursor',
            sa.Column(
                'account_label',
                sa.String(length=64),
                nullable=False,
                server_default=sa.text("'paper'"),
            ),
        )
    op.execute("UPDATE trade_cursor SET account_label = COALESCE(NULLIF(account_label, ''), 'paper')")
    op.execute('ALTER TABLE trade_cursor DROP CONSTRAINT IF EXISTS trade_cursor_source_key')

    trade_cursor_indexes = _index_names(inspector, 'trade_cursor')
    if 'uq_trade_cursor_source_account' not in trade_cursor_indexes:
        op.create_index(
            'uq_trade_cursor_source_account',
            'trade_cursor',
            ['source', 'account_label'],
            unique=True,
        )

    order_event_columns = _column_names(inspector, 'execution_order_events')
    if 'alpaca_account_label' not in order_event_columns:
        op.add_column(
            'execution_order_events',
            sa.Column(
                'alpaca_account_label',
                sa.String(length=64),
                nullable=False,
                server_default=sa.text("'paper'"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    order_event_columns = _column_names(inspector, 'execution_order_events')
    if 'alpaca_account_label' in order_event_columns:
        op.drop_column('execution_order_events', 'alpaca_account_label')

    trade_cursor_indexes = _index_names(inspector, 'trade_cursor')
    if 'uq_trade_cursor_source_account' in trade_cursor_indexes:
        op.drop_index('uq_trade_cursor_source_account', table_name='trade_cursor')
    op.execute('ALTER TABLE trade_cursor ADD CONSTRAINT trade_cursor_source_key UNIQUE (source)')

    trade_cursor_columns = _column_names(inspector, 'trade_cursor')
    if 'account_label' in trade_cursor_columns:
        op.drop_column('trade_cursor', 'account_label')

    trade_decision_indexes = _index_names(inspector, 'trade_decisions')
    if 'uq_trade_decisions_account_decision_hash' in trade_decision_indexes:
        op.drop_index('uq_trade_decisions_account_decision_hash', table_name='trade_decisions')
    op.execute(
        'ALTER TABLE trade_decisions ADD CONSTRAINT trade_decisions_decision_hash_key UNIQUE (decision_hash)'
    )

    execution_indexes = _index_names(inspector, 'executions')
    if 'uq_executions_account_alpaca_order_id' in execution_indexes:
        op.drop_index('uq_executions_account_alpaca_order_id', table_name='executions')
    if 'uq_executions_account_client_order_id' in execution_indexes:
        op.drop_index('uq_executions_account_client_order_id', table_name='executions')
    if 'ix_executions_account_label' in execution_indexes:
        op.drop_index('ix_executions_account_label', table_name='executions')
    op.execute(
        'ALTER TABLE executions ADD CONSTRAINT executions_alpaca_order_id_key UNIQUE (alpaca_order_id)'
    )
    op.execute(
        'ALTER TABLE executions ADD CONSTRAINT executions_client_order_id_key UNIQUE (client_order_id)'
    )

    execution_columns = _column_names(inspector, 'executions')
    if 'alpaca_account_label' in execution_columns:
        op.drop_column('executions', 'alpaca_account_label')

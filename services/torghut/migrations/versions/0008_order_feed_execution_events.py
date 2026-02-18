"""Add order-feed timeline persistence for execution reconciliation."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = '0008_order_feed_execution_events'
down_revision = '0007_autonomy_permissions_backfill_routes'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    execution_columns = {column['name'] for column in inspector.get_columns('executions')}
    if 'order_feed_last_event_ts' not in execution_columns:
        op.add_column('executions', sa.Column('order_feed_last_event_ts', sa.DateTime(timezone=True), nullable=True))
    if 'order_feed_last_seq' not in execution_columns:
        op.add_column('executions', sa.Column('order_feed_last_seq', sa.BigInteger(), nullable=True))

    execution_indexes = {index['name'] for index in inspector.get_indexes('executions')}
    if 'ix_executions_order_feed_last_event_ts' not in execution_indexes:
        op.create_index('ix_executions_order_feed_last_event_ts', 'executions', ['order_feed_last_event_ts'])

    if not inspector.has_table('execution_order_events'):
        op.create_table(
            'execution_order_events',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column('event_fingerprint', sa.String(length=64), nullable=False, unique=True),
            sa.Column('source_topic', sa.String(length=128), nullable=False),
            sa.Column('source_partition', sa.Integer(), nullable=True),
            sa.Column('source_offset', sa.BigInteger(), nullable=True),
            sa.Column('feed_seq', sa.BigInteger(), nullable=True),
            sa.Column('event_ts', sa.DateTime(timezone=True), nullable=True),
            sa.Column('symbol', sa.String(length=16), nullable=True),
            sa.Column('alpaca_order_id', sa.String(length=128), nullable=True),
            sa.Column('client_order_id', sa.String(length=128), nullable=True),
            sa.Column('event_type', sa.String(length=64), nullable=True),
            sa.Column('status', sa.String(length=32), nullable=True),
            sa.Column('qty', sa.Numeric(20, 8), nullable=True),
            sa.Column('filled_qty', sa.Numeric(20, 8), nullable=True),
            sa.Column('avg_fill_price', sa.Numeric(20, 8), nullable=True),
            sa.Column('raw_event', postgresql.JSONB(), nullable=False),
            sa.Column(
                'execution_id',
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey('executions.id', ondelete='SET NULL'),
                nullable=True,
            ),
            sa.Column(
                'trade_decision_id',
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey('trade_decisions.id', ondelete='SET NULL'),
                nullable=True,
            ),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        )
        op.create_index('ix_execution_order_events_event_ts', 'execution_order_events', ['event_ts'])
        op.create_index('ix_execution_order_events_execution_id', 'execution_order_events', ['execution_id'])
        op.create_index(
            'ix_execution_order_events_trade_decision_id',
            'execution_order_events',
            ['trade_decision_id'],
        )
        op.create_index('ix_execution_order_events_order_id', 'execution_order_events', ['alpaca_order_id'])
        op.create_index('ix_execution_order_events_client_order_id', 'execution_order_events', ['client_order_id'])
        op.create_index(
            'uq_execution_order_events_source_offset',
            'execution_order_events',
            ['source_topic', 'source_partition', 'source_offset'],
            unique=True,
        )

    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_order_events TO torghut_app;')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if inspector.has_table('execution_order_events'):
        op.execute('REVOKE ALL PRIVILEGES ON TABLE public.execution_order_events FROM torghut_app;')
        op.drop_index('uq_execution_order_events_source_offset', table_name='execution_order_events')
        op.drop_index('ix_execution_order_events_client_order_id', table_name='execution_order_events')
        op.drop_index('ix_execution_order_events_order_id', table_name='execution_order_events')
        op.drop_index('ix_execution_order_events_trade_decision_id', table_name='execution_order_events')
        op.drop_index('ix_execution_order_events_execution_id', table_name='execution_order_events')
        op.drop_index('ix_execution_order_events_event_ts', table_name='execution_order_events')
        op.drop_table('execution_order_events')

    execution_indexes = {index['name'] for index in inspector.get_indexes('executions')}
    if 'ix_executions_order_feed_last_event_ts' in execution_indexes:
        op.drop_index('ix_executions_order_feed_last_event_ts', table_name='executions')

    execution_columns = {column['name'] for column in inspector.get_columns('executions')}
    if 'order_feed_last_seq' in execution_columns:
        op.drop_column('executions', 'order_feed_last_seq')
    if 'order_feed_last_event_ts' in execution_columns:
        op.drop_column('executions', 'order_feed_last_event_ts')

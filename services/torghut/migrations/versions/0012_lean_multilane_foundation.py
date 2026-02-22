"""Add LEAN multi-lane persistence and execution audit columns."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = '0012_lean_multilane_foundation'
down_revision = (
    '0011_autonomy_lifecycle_and_promotion_audit',
    '0011_execution_tca_simulator_divergence',
)
branch_labels = None
depends_on = None


def _table_exists(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    execution_columns = {column['name'] for column in inspector.get_columns('executions')}
    if 'execution_correlation_id' not in execution_columns:
        op.add_column('executions', sa.Column('execution_correlation_id', sa.String(length=64), nullable=True))
    if 'execution_idempotency_key' not in execution_columns:
        op.add_column('executions', sa.Column('execution_idempotency_key', sa.String(length=96), nullable=True))
    if 'execution_audit_json' not in execution_columns:
        op.add_column('executions', sa.Column('execution_audit_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True))

    execution_indexes = {index['name'] for index in inspector.get_indexes('executions')}
    if 'ix_executions_execution_correlation_id' not in execution_indexes:
        op.create_index('ix_executions_execution_correlation_id', 'executions', ['execution_correlation_id'])

    if not _table_exists(inspector, 'lean_backtest_runs'):
        op.create_table(
            'lean_backtest_runs',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column('backtest_id', sa.String(length=64), nullable=False, unique=True),
            sa.Column('status', sa.String(length=32), nullable=False, server_default=sa.text("'queued'")),
            sa.Column('requested_by', sa.String(length=128), nullable=True),
            sa.Column('lane', sa.String(length=32), nullable=False, server_default=sa.text("'research'")),
            sa.Column('config_json', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
            sa.Column('result_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('artifacts_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('reproducibility_hash', sa.String(length=128), nullable=True),
            sa.Column('replay_hash', sa.String(length=128), nullable=True),
            sa.Column('deterministic_replay_passed', sa.Boolean(), nullable=True),
            sa.Column('failure_taxonomy', sa.String(length=128), nullable=True),
            sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index('ix_lean_backtest_runs_status', 'lean_backtest_runs', ['status'])
        op.create_index('ix_lean_backtest_runs_lane', 'lean_backtest_runs', ['lane'])
        op.create_index('ix_lean_backtest_runs_created_at', 'lean_backtest_runs', ['created_at'])

    if not _table_exists(inspector, 'lean_execution_shadow_events'):
        op.create_table(
            'lean_execution_shadow_events',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column('correlation_id', sa.String(length=64), nullable=True),
            sa.Column('trade_decision_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('trade_decisions.id', ondelete='SET NULL'), nullable=True),
            sa.Column('execution_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('executions.id', ondelete='SET NULL'), nullable=True),
            sa.Column('symbol', sa.String(length=32), nullable=False),
            sa.Column('side', sa.String(length=8), nullable=False),
            sa.Column('qty', sa.Numeric(20, 8), nullable=False),
            sa.Column('intent_notional', sa.Numeric(20, 8), nullable=True),
            sa.Column('simulated_fill_price', sa.Numeric(20, 8), nullable=True),
            sa.Column('simulated_slippage_bps', sa.Numeric(20, 8), nullable=True),
            sa.Column('parity_delta_bps', sa.Numeric(20, 8), nullable=True),
            sa.Column('parity_status', sa.String(length=32), nullable=False, server_default=sa.text("'unknown'")),
            sa.Column('failure_taxonomy', sa.String(length=128), nullable=True),
            sa.Column('simulation_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index('ix_lean_execution_shadow_events_created_at', 'lean_execution_shadow_events', ['created_at'])
        op.create_index('ix_lean_execution_shadow_events_symbol', 'lean_execution_shadow_events', ['symbol'])
        op.create_index('ix_lean_execution_shadow_events_status', 'lean_execution_shadow_events', ['parity_status'])
        op.create_index(
            'ix_lean_execution_shadow_events_trade_decision',
            'lean_execution_shadow_events',
            ['trade_decision_id'],
        )

    if not _table_exists(inspector, 'lean_canary_incidents'):
        op.create_table(
            'lean_canary_incidents',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column('incident_key', sa.String(length=96), nullable=False, unique=True),
            sa.Column('breach_type', sa.String(length=64), nullable=False),
            sa.Column('severity', sa.String(length=16), nullable=False, server_default=sa.text("'warning'")),
            sa.Column('rollback_triggered', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('symbols', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('evidence_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index('ix_lean_canary_incidents_breach_type', 'lean_canary_incidents', ['breach_type'])
        op.create_index('ix_lean_canary_incidents_created_at', 'lean_canary_incidents', ['created_at'])

    if not _table_exists(inspector, 'lean_strategy_shadow_evaluations'):
        op.create_table(
            'lean_strategy_shadow_evaluations',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column('run_id', sa.String(length=64), nullable=False, unique=True),
            sa.Column('strategy_id', sa.String(length=128), nullable=False),
            sa.Column('symbol', sa.String(length=32), nullable=False),
            sa.Column('intent_json', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
            sa.Column('shadow_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('parity_status', sa.String(length=32), nullable=False, server_default=sa.text("'unknown'")),
            sa.Column('governance_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column('disable_switch_active', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index('ix_lean_strategy_shadow_evaluations_strategy', 'lean_strategy_shadow_evaluations', ['strategy_id'])
        op.create_index('ix_lean_strategy_shadow_evaluations_symbol', 'lean_strategy_shadow_evaluations', ['symbol'])
        op.create_index('ix_lean_strategy_shadow_evaluations_status', 'lean_strategy_shadow_evaluations', ['parity_status'])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if _table_exists(inspector, 'lean_strategy_shadow_evaluations'):
        op.drop_table('lean_strategy_shadow_evaluations')

    if _table_exists(inspector, 'lean_canary_incidents'):
        op.drop_table('lean_canary_incidents')

    if _table_exists(inspector, 'lean_execution_shadow_events'):
        op.drop_table('lean_execution_shadow_events')

    if _table_exists(inspector, 'lean_backtest_runs'):
        op.drop_table('lean_backtest_runs')

    execution_columns = {column['name'] for column in inspector.get_columns('executions')}
    if 'execution_audit_json' in execution_columns:
        op.drop_column('executions', 'execution_audit_json')
    if 'execution_idempotency_key' in execution_columns:
        op.drop_column('executions', 'execution_idempotency_key')
    if 'execution_correlation_id' in execution_columns:
        op.drop_column('executions', 'execution_correlation_id')

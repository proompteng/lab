"""Persist execution-route metadata and autonomous research ledger tables."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0006_autonomy_ledger_and_execution_route"
down_revision = "0005_trade_cursor_symbol"
branch_labels = None
depends_on = None


def _index_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {index['name'] for index in inspector.get_indexes(table)}


def _column_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {column['name'] for column in inspector.get_columns(table)}


def _ensure_execution_columns(inspector: sa.Inspector) -> None:
    execution_columns = _column_names(inspector, 'executions')
    column_specs: tuple[tuple[str, sa.Column[Any]], ...] = (
        (
            'execution_expected_adapter',
            sa.Column('execution_expected_adapter', sa.String(length=32), nullable=True),
        ),
        (
            'execution_actual_adapter',
            sa.Column('execution_actual_adapter', sa.String(length=32), nullable=True),
        ),
        (
            'execution_fallback_reason',
            sa.Column('execution_fallback_reason', sa.String(length=128), nullable=True),
        ),
        (
            'execution_fallback_count',
            sa.Column('execution_fallback_count', sa.BigInteger(), nullable=False, server_default='0'),
        ),
    )
    for name, column in column_specs:
        if name not in execution_columns:
            op.add_column('executions', column)


def _ensure_execution_indexes(inspector: sa.Inspector) -> None:
    execution_indexes = _index_names(inspector, 'executions')
    for name, columns in (
        ('ix_executions_expected_adapter', ['execution_expected_adapter']),
        ('ix_executions_actual_adapter', ['execution_actual_adapter']),
    ):
        if name not in execution_indexes:
            op.create_index(name, 'executions', columns)


def _create_research_runs_table() -> None:
    op.create_table(
        'research_runs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('run_id', sa.String(length=64), nullable=False, unique=True),
        sa.Column(
            'status',
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'running'"),
        ),
        sa.Column('strategy_id', sa.String(length=64), nullable=True),
        sa.Column('strategy_name', sa.String(length=255), nullable=True),
        sa.Column('strategy_type', sa.String(length=128), nullable=True),
        sa.Column('strategy_version', sa.String(length=64), nullable=True),
        sa.Column('code_commit', sa.String(length=128), nullable=True),
        sa.Column('feature_version', sa.String(length=64), nullable=True),
        sa.Column('feature_schema_version', sa.String(length=64), nullable=True),
        sa.Column('feature_spec_hash', sa.String(length=128), nullable=True),
        sa.Column('signal_source', sa.String(length=128), nullable=True),
        sa.Column('dataset_version', sa.String(length=64), nullable=True),
        sa.Column('dataset_from', sa.DateTime(timezone=True), nullable=True),
        sa.Column('dataset_to', sa.DateTime(timezone=True), nullable=True),
        sa.Column('dataset_snapshot_ref', sa.String(length=255), nullable=True),
        sa.Column('runner_version', sa.String(length=64), nullable=True),
        sa.Column('runner_binary_hash', sa.String(length=128), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_research_runs_status', 'research_runs', ['status'])
    op.create_index('ix_research_runs_created_at', 'research_runs', ['created_at'])


def _create_research_candidates_table() -> None:
    op.create_table(
        'research_candidates',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('run_id', sa.String(length=64), nullable=False),
        sa.Column('candidate_id', sa.String(length=64), nullable=False, unique=True),
        sa.Column('candidate_hash', sa.String(length=128), nullable=True),
        sa.Column('parameter_set', postgresql.JSONB(), nullable=True),
        sa.Column('decision_count', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('trade_count', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('symbols_covered', postgresql.JSONB(), nullable=True),
        sa.Column('universe_definition', postgresql.JSONB(), nullable=True),
        sa.Column('promotion_target', sa.String(length=16), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_research_candidates_run_id', 'research_candidates', ['run_id'])
    op.create_index('ix_research_candidates_candidate_id', 'research_candidates', ['candidate_id'])


def _create_research_fold_metrics_table() -> None:
    op.create_table(
        'research_fold_metrics',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('candidate_id', sa.String(length=64), nullable=False),
        sa.Column('fold_name', sa.String(length=128), nullable=False),
        sa.Column('fold_order', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('train_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('train_end', sa.DateTime(timezone=True), nullable=False),
        sa.Column('test_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('test_end', sa.DateTime(timezone=True), nullable=False),
        sa.Column('decision_count', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('trade_count', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('gross_pnl', sa.Numeric(20, 8), nullable=True),
        sa.Column('net_pnl', sa.Numeric(20, 8), nullable=True),
        sa.Column('max_drawdown', sa.Numeric(20, 8), nullable=True),
        sa.Column('turnover_ratio', sa.Numeric(20, 8), nullable=True),
        sa.Column('cost_bps', sa.Numeric(20, 8), nullable=True),
        sa.Column('cost_assumptions', postgresql.JSONB(), nullable=True),
        sa.Column('regime_label', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_research_fold_metrics_candidate', 'research_fold_metrics', ['candidate_id'])
    op.create_index('ix_research_fold_metrics_fold_order', 'research_fold_metrics', ['fold_order'])


def _create_research_stress_metrics_table() -> None:
    op.create_table(
        'research_stress_metrics',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('candidate_id', sa.String(length=64), nullable=False),
        sa.Column('stress_case', sa.String(length=64), nullable=False),
        sa.Column('metric_bundle', postgresql.JSONB(), nullable=True),
        sa.Column('pessimistic_pnl_delta', sa.Numeric(20, 8), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_research_stress_metrics_candidate', 'research_stress_metrics', ['candidate_id'])
    op.create_index('ix_research_stress_metrics_case', 'research_stress_metrics', ['stress_case'])


def _create_research_promotions_table() -> None:
    op.create_table(
        'research_promotions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('candidate_id', sa.String(length=64), nullable=False),
        sa.Column('requested_mode', sa.String(length=16), nullable=True),
        sa.Column('approved_mode', sa.String(length=16), nullable=True),
        sa.Column('approver', sa.String(length=128), nullable=True),
        sa.Column('approver_role', sa.String(length=64), nullable=True),
        sa.Column('approve_reason', sa.Text(), nullable=True),
        sa.Column('deny_reason', sa.Text(), nullable=True),
        sa.Column('paper_candidate_patch_ref', sa.String(length=255), nullable=True),
        sa.Column('effective_time', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_research_promotions_candidate', 'research_promotions', ['candidate_id'])
    op.create_index('ix_research_promotions_requested_mode', 'research_promotions', ['requested_mode'])
    op.create_index('ix_research_promotions_approved_mode', 'research_promotions', ['approved_mode'])


def _ensure_research_tables(inspector: sa.Inspector) -> None:
    table_creators: tuple[tuple[str, Any], ...] = (
        ('research_runs', _create_research_runs_table),
        ('research_candidates', _create_research_candidates_table),
        ('research_fold_metrics', _create_research_fold_metrics_table),
        ('research_stress_metrics', _create_research_stress_metrics_table),
        ('research_promotions', _create_research_promotions_table),
    )
    for table_name, create_table in table_creators:
        if not inspector.has_table(table_name):
            create_table()


def _drop_table_with_indexes(inspector: sa.Inspector, table: str, indexes: tuple[str, ...]) -> None:
    if not inspector.has_table(table):
        return
    for index_name in indexes:
        op.drop_index(index_name, table_name=table)
    op.drop_table(table)


def _drop_execution_indexes(inspector: sa.Inspector) -> None:
    execution_indexes = _index_names(inspector, 'executions')
    for index_name in ('ix_executions_expected_adapter', 'ix_executions_actual_adapter'):
        if index_name in execution_indexes:
            op.drop_index(index_name, table_name='executions')


def _drop_execution_columns(inspector: sa.Inspector) -> None:
    execution_columns = _column_names(inspector, 'executions')
    for column_name in (
        'execution_fallback_count',
        'execution_fallback_reason',
        'execution_actual_adapter',
        'execution_expected_adapter',
    ):
        if column_name in execution_columns:
            op.drop_column('executions', column_name)


def upgrade() -> None:
    # Alembic defaults `alembic_version.version_num` to VARCHAR(32). This repo uses
    # descriptive revision IDs which can exceed 32 chars (e.g. this revision),
    # so widen the column before Alembic updates it at the end of the migration.
    op.alter_column(
        'alembic_version',
        'version_num',
        type_=sa.String(length=128),
        existing_type=sa.String(length=32),
        existing_nullable=False,
    )

    inspector = inspect(op.get_bind())
    _ensure_execution_columns(inspector)
    _ensure_execution_indexes(inspector)
    _ensure_research_tables(inspector)


def downgrade() -> None:
    inspector = inspect(op.get_bind())
    _drop_table_with_indexes(
        inspector,
        'research_promotions',
        (
            'ix_research_promotions_candidate',
            'ix_research_promotions_requested_mode',
            'ix_research_promotions_approved_mode',
        ),
    )
    _drop_table_with_indexes(
        inspector,
        'research_stress_metrics',
        ('ix_research_stress_metrics_candidate', 'ix_research_stress_metrics_case'),
    )
    _drop_table_with_indexes(
        inspector,
        'research_fold_metrics',
        ('ix_research_fold_metrics_candidate', 'ix_research_fold_metrics_fold_order'),
    )
    _drop_table_with_indexes(
        inspector,
        'research_candidates',
        ('ix_research_candidates_run_id', 'ix_research_candidates_candidate_id'),
    )
    _drop_table_with_indexes(
        inspector,
        'research_runs',
        ('ix_research_runs_status', 'ix_research_runs_created_at'),
    )
    _drop_execution_indexes(inspector)
    _drop_execution_columns(inspector)

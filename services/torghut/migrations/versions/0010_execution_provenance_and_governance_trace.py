"""Enforce execution provenance and persist governance trace identifiers."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision = '0010_execution_provenance_and_governance_trace'
down_revision = '0009_execution_tca_metrics'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE public.executions
        SET execution_expected_adapter = 'unknown'
        WHERE execution_expected_adapter IS NULL OR BTRIM(execution_expected_adapter) = '';
        """
    )
    op.execute(
        """
        UPDATE public.executions
        SET execution_actual_adapter = COALESCE(NULLIF(BTRIM(execution_expected_adapter), ''), 'unknown')
        WHERE execution_actual_adapter IS NULL OR BTRIM(execution_actual_adapter) = '';
        """
    )
    op.execute(
        """
        UPDATE public.executions
        SET
          execution_fallback_count = CASE
            WHEN execution_fallback_count IS NULL THEN 0
            WHEN execution_fallback_count < 0 THEN 0
            ELSE execution_fallback_count
          END;
        """
    )
    op.execute(
        """
        UPDATE public.executions
        SET execution_fallback_reason = CONCAT(
          'fallback_from_',
          execution_expected_adapter,
          '_to_',
          execution_actual_adapter
        )
        WHERE execution_expected_adapter <> execution_actual_adapter
          AND execution_fallback_count > 0
          AND (execution_fallback_reason IS NULL OR BTRIM(execution_fallback_reason) = '');
        """
    )
    op.execute(
        """
        UPDATE public.executions
        SET execution_fallback_reason = NULL
        WHERE execution_fallback_count = 0;
        """
    )

    op.alter_column(
        'executions',
        'execution_expected_adapter',
        existing_type=sa.String(length=32),
        nullable=False,
        server_default='unknown',
    )
    op.alter_column(
        'executions',
        'execution_actual_adapter',
        existing_type=sa.String(length=32),
        nullable=False,
        server_default='unknown',
    )
    op.alter_column(
        'executions',
        'execution_fallback_count',
        existing_type=sa.BigInteger(),
        nullable=False,
        server_default='0',
    )
    op.create_check_constraint(
        'ck_executions_fallback_reason_required',
        'executions',
        '(execution_fallback_count = 0) OR (execution_fallback_reason IS NOT NULL AND BTRIM(execution_fallback_reason) <> \'\')',
    )

    op.add_column(
        'research_runs',
        sa.Column('gate_report_trace_id', sa.String(length=64), nullable=True),
    )
    op.add_column(
        'research_runs',
        sa.Column('recommendation_trace_id', sa.String(length=64), nullable=True),
    )
    op.create_index('ix_research_runs_gate_trace', 'research_runs', ['gate_report_trace_id'])
    op.create_index('ix_research_runs_recommendation_trace', 'research_runs', ['recommendation_trace_id'])


def downgrade() -> None:
    op.drop_index('ix_research_runs_recommendation_trace', table_name='research_runs')
    op.drop_index('ix_research_runs_gate_trace', table_name='research_runs')
    op.drop_column('research_runs', 'recommendation_trace_id')
    op.drop_column('research_runs', 'gate_report_trace_id')

    op.drop_constraint('ck_executions_fallback_reason_required', 'executions', type_='check')
    op.alter_column(
        'executions',
        'execution_actual_adapter',
        existing_type=sa.String(length=32),
        nullable=True,
        server_default=None,
    )
    op.alter_column(
        'executions',
        'execution_expected_adapter',
        existing_type=sa.String(length=32),
        nullable=True,
        server_default=None,
    )

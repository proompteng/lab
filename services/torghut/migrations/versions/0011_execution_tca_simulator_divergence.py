"""Add simulator divergence and provenance fields to execution_tca_metrics."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0011_execution_tca_simulator_divergence'
down_revision = '0010_execution_provenance_and_governance_trace'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('execution_tca_metrics', sa.Column('expected_shortfall_bps_p50', sa.Numeric(20, 8), nullable=True))
    op.add_column('execution_tca_metrics', sa.Column('expected_shortfall_bps_p95', sa.Numeric(20, 8), nullable=True))
    op.add_column('execution_tca_metrics', sa.Column('realized_shortfall_bps', sa.Numeric(20, 8), nullable=True))
    op.add_column('execution_tca_metrics', sa.Column('divergence_bps', sa.Numeric(20, 8), nullable=True))
    op.add_column('execution_tca_metrics', sa.Column('simulator_version', sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column('execution_tca_metrics', 'simulator_version')
    op.drop_column('execution_tca_metrics', 'divergence_bps')
    op.drop_column('execution_tca_metrics', 'realized_shortfall_bps')
    op.drop_column('execution_tca_metrics', 'expected_shortfall_bps_p95')
    op.drop_column('execution_tca_metrics', 'expected_shortfall_bps_p50')

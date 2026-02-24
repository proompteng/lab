"""Add autonomy lifecycle metadata and promotion audit fields."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0011_autonomy_lifecycle_and_promotion_audit"
down_revision = "0010_execution_provenance_and_governance_trace"
branch_labels = None
depends_on = None


def _column_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {column['name'] for column in inspector.get_columns(table)}


def _index_names(inspector: sa.Inspector, table: str) -> set[str]:
    return {index['name'] for index in inspector.get_indexes(table)}


def _add_columns_if_missing(
    inspector: sa.Inspector,
    table: str,
    columns: tuple[tuple[str, sa.Column[Any]], ...],
) -> None:
    existing_columns = _column_names(inspector, table)
    for column_name, column in columns:
        if column_name not in existing_columns:
            op.add_column(table, column)


def _add_indexes_if_missing(
    inspector: sa.Inspector,
    table: str,
    indexes: tuple[tuple[str, list[str]], ...],
) -> None:
    existing_indexes = _index_names(inspector, table)
    for index_name, columns in indexes:
        if index_name not in existing_indexes:
            op.create_index(index_name, table, columns)


def _drop_indexes_if_present(
    inspector: sa.Inspector,
    table: str,
    indexes: tuple[str, ...],
) -> None:
    existing_indexes = _index_names(inspector, table)
    for index_name in indexes:
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name=table)


def _drop_columns_if_present(
    inspector: sa.Inspector,
    table: str,
    columns: tuple[str, ...],
) -> None:
    existing_columns = _column_names(inspector, table)
    for column_name in columns:
        if column_name in existing_columns:
            op.drop_column(table, column_name)


def upgrade() -> None:
    inspector = inspect(op.get_bind())

    _add_columns_if_missing(
        inspector,
        'research_candidates',
        (
            (
                'lifecycle_role',
                sa.Column(
                    'lifecycle_role',
                    sa.String(length=32),
                    nullable=False,
                    server_default=sa.text("'challenger'"),
                ),
            ),
            (
                'lifecycle_status',
                sa.Column(
                    'lifecycle_status',
                    sa.String(length=32),
                    nullable=False,
                    server_default=sa.text("'evaluated'"),
                ),
            ),
            (
                'metadata_bundle',
                sa.Column(
                    'metadata_bundle',
                    postgresql.JSONB(astext_type=sa.Text()),
                    nullable=True,
                ),
            ),
            (
                'recommendation_bundle',
                sa.Column(
                    'recommendation_bundle',
                    postgresql.JSONB(astext_type=sa.Text()),
                    nullable=True,
                ),
            ),
        ),
    )
    _add_indexes_if_missing(
        inspector,
        'research_candidates',
        (
            ('ix_research_candidates_lifecycle_role', ['lifecycle_role']),
            ('ix_research_candidates_lifecycle_status', ['lifecycle_status']),
        ),
    )

    _add_columns_if_missing(
        inspector,
        'research_promotions',
        (
            (
                'decision_action',
                sa.Column(
                    'decision_action',
                    sa.String(length=32),
                    nullable=False,
                    server_default=sa.text("'hold'"),
                ),
            ),
            ('decision_rationale', sa.Column('decision_rationale', sa.Text(), nullable=True)),
            (
                'evidence_bundle',
                sa.Column(
                    'evidence_bundle',
                    postgresql.JSONB(astext_type=sa.Text()),
                    nullable=True,
                ),
            ),
            (
                'recommendation_trace_id',
                sa.Column('recommendation_trace_id', sa.String(length=64), nullable=True),
            ),
            (
                'successor_candidate_id',
                sa.Column('successor_candidate_id', sa.String(length=64), nullable=True),
            ),
            (
                'rollback_candidate_id',
                sa.Column('rollback_candidate_id', sa.String(length=64), nullable=True),
            ),
        ),
    )
    _add_indexes_if_missing(
        inspector,
        'research_promotions',
        (
            ('ix_research_promotions_action', ['decision_action']),
            ('ix_research_promotions_recommendation_trace', ['recommendation_trace_id']),
        ),
    )


def downgrade() -> None:
    inspector = inspect(op.get_bind())

    _drop_indexes_if_present(
        inspector,
        'research_promotions',
        ('ix_research_promotions_recommendation_trace', 'ix_research_promotions_action'),
    )
    _drop_columns_if_present(
        inspector,
        'research_promotions',
        (
            'rollback_candidate_id',
            'successor_candidate_id',
            'recommendation_trace_id',
            'evidence_bundle',
            'decision_rationale',
            'decision_action',
        ),
    )
    _drop_indexes_if_present(
        inspector,
        'research_candidates',
        ('ix_research_candidates_lifecycle_status', 'ix_research_candidates_lifecycle_role'),
    )
    _drop_columns_if_present(
        inspector,
        'research_candidates',
        ('recommendation_bundle', 'metadata_bundle', 'lifecycle_status', 'lifecycle_role'),
    )

"""Add autonomy lifecycle metadata and promotion audit fields."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0011_autonomy_lifecycle_and_promotion_audit"
down_revision = "0010_execution_provenance_and_governance_trace"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    candidate_columns = {
        column["name"] for column in inspector.get_columns("research_candidates")
    }
    if "lifecycle_role" not in candidate_columns:
        op.add_column(
            "research_candidates",
            sa.Column(
                "lifecycle_role",
                sa.String(length=32),
                nullable=False,
                server_default=sa.text("'challenger'"),
            ),
        )
    if "lifecycle_status" not in candidate_columns:
        op.add_column(
            "research_candidates",
            sa.Column(
                "lifecycle_status",
                sa.String(length=32),
                nullable=False,
                server_default=sa.text("'evaluated'"),
            ),
        )
    if "metadata_bundle" not in candidate_columns:
        op.add_column(
            "research_candidates",
            sa.Column(
                "metadata_bundle",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
        )
    if "recommendation_bundle" not in candidate_columns:
        op.add_column(
            "research_candidates",
            sa.Column(
                "recommendation_bundle",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
        )

    candidate_indexes = {
        index["name"] for index in inspector.get_indexes("research_candidates")
    }
    if "ix_research_candidates_lifecycle_role" not in candidate_indexes:
        op.create_index(
            "ix_research_candidates_lifecycle_role",
            "research_candidates",
            ["lifecycle_role"],
        )
    if "ix_research_candidates_lifecycle_status" not in candidate_indexes:
        op.create_index(
            "ix_research_candidates_lifecycle_status",
            "research_candidates",
            ["lifecycle_status"],
        )

    promotion_columns = {
        column["name"] for column in inspector.get_columns("research_promotions")
    }
    if "decision_action" not in promotion_columns:
        op.add_column(
            "research_promotions",
            sa.Column(
                "decision_action",
                sa.String(length=32),
                nullable=False,
                server_default=sa.text("'hold'"),
            ),
        )
    if "decision_rationale" not in promotion_columns:
        op.add_column(
            "research_promotions",
            sa.Column("decision_rationale", sa.Text(), nullable=True),
        )
    if "evidence_bundle" not in promotion_columns:
        op.add_column(
            "research_promotions",
            sa.Column(
                "evidence_bundle",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
        )
    if "recommendation_trace_id" not in promotion_columns:
        op.add_column(
            "research_promotions",
            sa.Column("recommendation_trace_id", sa.String(length=64), nullable=True),
        )
    if "successor_candidate_id" not in promotion_columns:
        op.add_column(
            "research_promotions",
            sa.Column("successor_candidate_id", sa.String(length=64), nullable=True),
        )
    if "rollback_candidate_id" not in promotion_columns:
        op.add_column(
            "research_promotions",
            sa.Column("rollback_candidate_id", sa.String(length=64), nullable=True),
        )

    promotion_indexes = {
        index["name"] for index in inspector.get_indexes("research_promotions")
    }
    if "ix_research_promotions_action" not in promotion_indexes:
        op.create_index(
            "ix_research_promotions_action",
            "research_promotions",
            ["decision_action"],
        )
    if "ix_research_promotions_recommendation_trace" not in promotion_indexes:
        op.create_index(
            "ix_research_promotions_recommendation_trace",
            "research_promotions",
            ["recommendation_trace_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    promotion_indexes = {
        index["name"] for index in inspector.get_indexes("research_promotions")
    }
    if "ix_research_promotions_recommendation_trace" in promotion_indexes:
        op.drop_index(
            "ix_research_promotions_recommendation_trace",
            table_name="research_promotions",
        )
    if "ix_research_promotions_action" in promotion_indexes:
        op.drop_index("ix_research_promotions_action", table_name="research_promotions")

    promotion_columns = {
        column["name"] for column in inspector.get_columns("research_promotions")
    }
    if "rollback_candidate_id" in promotion_columns:
        op.drop_column("research_promotions", "rollback_candidate_id")
    if "successor_candidate_id" in promotion_columns:
        op.drop_column("research_promotions", "successor_candidate_id")
    if "recommendation_trace_id" in promotion_columns:
        op.drop_column("research_promotions", "recommendation_trace_id")
    if "evidence_bundle" in promotion_columns:
        op.drop_column("research_promotions", "evidence_bundle")
    if "decision_rationale" in promotion_columns:
        op.drop_column("research_promotions", "decision_rationale")
    if "decision_action" in promotion_columns:
        op.drop_column("research_promotions", "decision_action")

    candidate_indexes = {
        index["name"] for index in inspector.get_indexes("research_candidates")
    }
    if "ix_research_candidates_lifecycle_status" in candidate_indexes:
        op.drop_index(
            "ix_research_candidates_lifecycle_status",
            table_name="research_candidates",
        )
    if "ix_research_candidates_lifecycle_role" in candidate_indexes:
        op.drop_index(
            "ix_research_candidates_lifecycle_role",
            table_name="research_candidates",
        )

    candidate_columns = {
        column["name"] for column in inspector.get_columns("research_candidates")
    }
    if "recommendation_bundle" in candidate_columns:
        op.drop_column("research_candidates", "recommendation_bundle")
    if "metadata_bundle" in candidate_columns:
        op.drop_column("research_candidates", "metadata_bundle")
    if "lifecycle_status" in candidate_columns:
        op.drop_column("research_candidates", "lifecycle_status")
    if "lifecycle_role" in candidate_columns:
        op.drop_column("research_candidates", "lifecycle_role")

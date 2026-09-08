"""Add normalized empirical job records for parity and Janus workflow freshness."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0019_vnext_empirical_job_runs"
down_revision = "0018_vnext_persistence_objects"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "vnext_empirical_job_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("job_name", sa.String(length=128), nullable=False),
        sa.Column("job_type", sa.String(length=64), nullable=False),
        sa.Column("job_run_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("authority", sa.String(length=32), nullable=False),
        sa.Column(
            "promotion_authority_eligible",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("dataset_snapshot_ref", sa.String(length=255), nullable=True),
        sa.Column("artifact_refs", _json_type(), nullable=True),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_empirical_job_runs"),
    )
    op.create_index(
        "ix_vnext_empirical_job_runs_run_id",
        "vnext_empirical_job_runs",
        ["run_id"],
    )
    op.create_index(
        "ix_vnext_empirical_job_runs_candidate_id",
        "vnext_empirical_job_runs",
        ["candidate_id"],
    )
    op.create_index(
        "ix_vnext_empirical_job_runs_job_type",
        "vnext_empirical_job_runs",
        ["job_type"],
    )
    op.create_index(
        "uq_vnext_empirical_job_runs_job_run_id",
        "vnext_empirical_job_runs",
        ["job_run_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_vnext_empirical_job_runs_job_run_id",
        table_name="vnext_empirical_job_runs",
    )
    op.drop_index(
        "ix_vnext_empirical_job_runs_job_type",
        table_name="vnext_empirical_job_runs",
    )
    op.drop_index(
        "ix_vnext_empirical_job_runs_candidate_id",
        table_name="vnext_empirical_job_runs",
    )
    op.drop_index(
        "ix_vnext_empirical_job_runs_run_id",
        table_name="vnext_empirical_job_runs",
    )
    op.drop_table("vnext_empirical_job_runs")

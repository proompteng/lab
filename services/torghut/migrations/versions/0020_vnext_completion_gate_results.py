"""Add doc-scoped completion gate results for vNext traceability."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0020_vnext_completion_gate_results"
down_revision = "0019_vnext_empirical_job_runs"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "vnext_completion_gate_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("dataset_snapshot_ref", sa.String(length=255), nullable=True),
        sa.Column("git_revision", sa.String(length=128), nullable=True),
        sa.Column("image_digest", sa.String(length=255), nullable=True),
        sa.Column("workflow_name", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("artifact_ref", sa.String(length=1024), nullable=True),
        sa.Column("blocked_reason", sa.String(length=255), nullable=True),
        sa.Column("details_json", _json_type(), nullable=True),
        sa.Column("measured_at", sa.DateTime(timezone=True), nullable=False),
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
        sa.PrimaryKeyConstraint("id", name="pk_vnext_completion_gate_results"),
    )
    op.create_index(
        "ix_vnext_completion_gate_results_gate_id",
        "vnext_completion_gate_results",
        ["gate_id"],
    )
    op.create_index(
        "ix_vnext_completion_gate_results_run_id",
        "vnext_completion_gate_results",
        ["run_id"],
    )
    op.create_index(
        "ix_vnext_completion_gate_results_candidate_id",
        "vnext_completion_gate_results",
        ["candidate_id"],
    )
    op.create_index(
        "ix_vnext_completion_gate_results_status",
        "vnext_completion_gate_results",
        ["status"],
    )
    op.create_index(
        "uq_vnext_completion_gate_results_gate_run",
        "vnext_completion_gate_results",
        ["gate_id", "run_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_vnext_completion_gate_results_gate_run",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_status",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_candidate_id",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_run_id",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_gate_id",
        table_name="vnext_completion_gate_results",
    )
    op.drop_table("vnext_completion_gate_results")

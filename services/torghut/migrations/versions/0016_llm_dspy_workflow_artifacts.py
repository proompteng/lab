"""Add DSPy compile/eval/promotion artifact audit table."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016_llm_dspy_workflow_artifacts"
down_revision = "0015_whitepaper_workflow_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_dspy_workflow_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_key", sa.String(length=128), nullable=False),
        sa.Column("lane", sa.String(length=32), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'queued'"),
        ),
        sa.Column("implementation_spec_ref", sa.String(length=128), nullable=False),
        sa.Column("program_name", sa.String(length=128), nullable=True),
        sa.Column("signature_version", sa.String(length=64), nullable=True),
        sa.Column("optimizer", sa.String(length=64), nullable=True),
        sa.Column("artifact_uri", sa.String(length=1024), nullable=True),
        sa.Column("artifact_hash", sa.String(length=64), nullable=True),
        sa.Column("dataset_hash", sa.String(length=64), nullable=True),
        sa.Column("compiled_prompt_hash", sa.String(length=64), nullable=True),
        sa.Column("reproducibility_hash", sa.String(length=64), nullable=True),
        sa.Column("metric_bundle", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("gate_compatibility", sa.String(length=16), nullable=True),
        sa.Column("promotion_recommendation", sa.String(length=32), nullable=True),
        sa.Column("promotion_target", sa.String(length=32), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("agentrun_name", sa.String(length=128), nullable=True),
        sa.Column("agentrun_namespace", sa.String(length=64), nullable=True),
        sa.Column("agentrun_uid", sa.String(length=128), nullable=True),
        sa.Column("request_payload_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("response_payload_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_llm_dspy_workflow_artifacts"),
        sa.UniqueConstraint("run_key", name="uq_llm_dspy_workflow_artifacts_run_key"),
    )
    op.create_index(
        "ix_llm_dspy_workflow_artifacts_lane",
        "llm_dspy_workflow_artifacts",
        ["lane"],
    )
    op.create_index(
        "ix_llm_dspy_workflow_artifacts_status",
        "llm_dspy_workflow_artifacts",
        ["status"],
    )
    op.create_index(
        "ix_llm_dspy_workflow_artifacts_program_name",
        "llm_dspy_workflow_artifacts",
        ["program_name"],
    )
    op.create_index(
        "ix_llm_dspy_workflow_artifacts_artifact_hash",
        "llm_dspy_workflow_artifacts",
        ["artifact_hash"],
    )
    op.create_index(
        "ix_llm_dspy_workflow_artifacts_created_at",
        "llm_dspy_workflow_artifacts",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_llm_dspy_workflow_artifacts_created_at", table_name="llm_dspy_workflow_artifacts")
    op.drop_index("ix_llm_dspy_workflow_artifacts_artifact_hash", table_name="llm_dspy_workflow_artifacts")
    op.drop_index("ix_llm_dspy_workflow_artifacts_program_name", table_name="llm_dspy_workflow_artifacts")
    op.drop_index("ix_llm_dspy_workflow_artifacts_status", table_name="llm_dspy_workflow_artifacts")
    op.drop_index("ix_llm_dspy_workflow_artifacts_lane", table_name="llm_dspy_workflow_artifacts")
    op.drop_table("llm_dspy_workflow_artifacts")

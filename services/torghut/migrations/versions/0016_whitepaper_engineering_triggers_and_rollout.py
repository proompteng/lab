"""Add whitepaper engineering trigger and rollout transition audit tables."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016_whitepaper_engineering_triggers_and_rollout"
down_revision = "0015_whitepaper_workflow_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "whitepaper_engineering_triggers",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("trigger_id", sa.String(length=64), nullable=False),
        sa.Column("whitepaper_run_id", sa.String(length=64), nullable=False),
        sa.Column("analysis_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("verdict_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("hypothesis_id", sa.String(length=128), nullable=True),
        sa.Column("implementation_grade", sa.String(length=32), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("reason_codes_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("approval_token", sa.String(length=128), nullable=True),
        sa.Column("dispatched_agentrun_name", sa.String(length=128), nullable=True),
        sa.Column("rollout_profile", sa.String(length=32), nullable=False, server_default=sa.text("'manual'")),
        sa.Column("approval_source", sa.String(length=32), nullable=True),
        sa.Column("approved_by", sa.String(length=128), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approval_reason", sa.Text(), nullable=True),
        sa.Column("policy_ref", sa.String(length=255), nullable=True),
        sa.Column("gate_snapshot_hash", sa.String(length=64), nullable=True),
        sa.Column("gate_snapshot_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["analysis_run_id"],
            ["whitepaper_analysis_runs.id"],
            name="fk_wp_eng_triggers_analysis_run_id_wp_analysis_runs",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["verdict_id"],
            ["whitepaper_viability_verdicts.id"],
            name="fk_wp_eng_triggers_verdict_id_wp_viability_verdicts",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_engineering_triggers"),
        sa.UniqueConstraint("trigger_id", name="uq_whitepaper_engineering_triggers_trigger_id"),
        sa.UniqueConstraint("whitepaper_run_id", name="uq_whitepaper_engineering_triggers_whitepaper_run_id"),
        sa.UniqueConstraint("analysis_run_id", name="uq_whitepaper_engineering_triggers_analysis_run_id"),
    )
    op.create_index(
        "ix_whitepaper_engineering_triggers_run_id",
        "whitepaper_engineering_triggers",
        ["whitepaper_run_id"],
    )
    op.create_index(
        "ix_whitepaper_engineering_triggers_grade",
        "whitepaper_engineering_triggers",
        ["implementation_grade"],
    )
    op.create_index(
        "ix_whitepaper_engineering_triggers_decision",
        "whitepaper_engineering_triggers",
        ["decision"],
    )
    op.create_index(
        "ix_whitepaper_engineering_triggers_rollout_profile",
        "whitepaper_engineering_triggers",
        ["rollout_profile"],
    )
    op.create_index(
        "ix_whitepaper_engineering_triggers_approval_source",
        "whitepaper_engineering_triggers",
        ["approval_source"],
    )

    op.create_table(
        "whitepaper_rollout_transitions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("transition_id", sa.String(length=64), nullable=False),
        sa.Column("trigger_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("whitepaper_run_id", sa.String(length=64), nullable=False),
        sa.Column("from_stage", sa.String(length=32), nullable=True),
        sa.Column("to_stage", sa.String(length=32), nullable=True),
        sa.Column("transition_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("gate_results_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("reason_codes_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("blocking_gate", sa.String(length=64), nullable=True),
        sa.Column("evidence_hash", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["trigger_id"],
            ["whitepaper_engineering_triggers.id"],
            name="fk_wp_rollout_transitions_trigger_id_wp_engineering_triggers",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_rollout_transitions"),
        sa.UniqueConstraint("transition_id", name="uq_whitepaper_rollout_transitions_transition_id"),
    )
    op.create_index(
        "ix_whitepaper_rollout_transitions_trigger_id",
        "whitepaper_rollout_transitions",
        ["trigger_id"],
    )
    op.create_index(
        "ix_whitepaper_rollout_transitions_run_id",
        "whitepaper_rollout_transitions",
        ["whitepaper_run_id"],
    )
    op.create_index(
        "ix_whitepaper_rollout_transitions_status",
        "whitepaper_rollout_transitions",
        ["status"],
    )
    op.create_index(
        "ix_whitepaper_rollout_transitions_created_at",
        "whitepaper_rollout_transitions",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_whitepaper_rollout_transitions_created_at",
        table_name="whitepaper_rollout_transitions",
    )
    op.drop_index(
        "ix_whitepaper_rollout_transitions_status",
        table_name="whitepaper_rollout_transitions",
    )
    op.drop_index(
        "ix_whitepaper_rollout_transitions_run_id",
        table_name="whitepaper_rollout_transitions",
    )
    op.drop_index(
        "ix_whitepaper_rollout_transitions_trigger_id",
        table_name="whitepaper_rollout_transitions",
    )
    op.drop_table("whitepaper_rollout_transitions")

    op.drop_index(
        "ix_whitepaper_engineering_triggers_approval_source",
        table_name="whitepaper_engineering_triggers",
    )
    op.drop_index(
        "ix_whitepaper_engineering_triggers_rollout_profile",
        table_name="whitepaper_engineering_triggers",
    )
    op.drop_index(
        "ix_whitepaper_engineering_triggers_decision",
        table_name="whitepaper_engineering_triggers",
    )
    op.drop_index(
        "ix_whitepaper_engineering_triggers_grade",
        table_name="whitepaper_engineering_triggers",
    )
    op.drop_index(
        "ix_whitepaper_engineering_triggers_run_id",
        table_name="whitepaper_engineering_triggers",
    )
    op.drop_table("whitepaper_engineering_triggers")

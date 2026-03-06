"""Add normalized vNext persistence objects for promotion-safe research state."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0018_vnext_persistence_objects"
down_revision = (
    "0016_llm_dspy_workflow_artifacts",
    "0017_whitepaper_semantic_indexing",
)
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "vnext_dataset_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("dataset_id", sa.String(length=128), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("dataset_version", sa.String(length=128), nullable=True),
        sa.Column("dataset_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dataset_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column("artifact_ref", sa.String(length=255), nullable=True),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_dataset_snapshots"),
    )
    op.create_index("ix_vnext_dataset_snapshots_run_id", "vnext_dataset_snapshots", ["run_id"])
    op.create_index(
        "ix_vnext_dataset_snapshots_candidate_id", "vnext_dataset_snapshots", ["candidate_id"]
    )
    op.create_index("ix_vnext_dataset_snapshots_dataset_id", "vnext_dataset_snapshots", ["dataset_id"])
    op.create_index(
        "uq_vnext_dataset_snapshots_run_dataset_id",
        "vnext_dataset_snapshots",
        ["run_id", "dataset_id"],
        unique=True,
    )

    op.create_table(
        "vnext_feature_view_specs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("strategy_id", sa.String(length=128), nullable=False),
        sa.Column("feature_view_spec_ref", sa.String(length=255), nullable=False),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_feature_view_specs"),
    )
    op.create_index("ix_vnext_feature_view_specs_run_id", "vnext_feature_view_specs", ["run_id"])
    op.create_index(
        "ix_vnext_feature_view_specs_candidate_id", "vnext_feature_view_specs", ["candidate_id"]
    )
    op.create_index(
        "ix_vnext_feature_view_specs_strategy_id", "vnext_feature_view_specs", ["strategy_id"]
    )
    op.create_index(
        "uq_vnext_feature_view_specs_candidate_strategy",
        "vnext_feature_view_specs",
        ["candidate_id", "strategy_id"],
        unique=True,
    )

    op.create_table(
        "vnext_model_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("strategy_id", sa.String(length=128), nullable=False),
        sa.Column("artifact_ref", sa.String(length=255), nullable=False),
        sa.Column("artifact_kind", sa.String(length=64), nullable=False),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_model_artifacts"),
    )
    op.create_index("ix_vnext_model_artifacts_run_id", "vnext_model_artifacts", ["run_id"])
    op.create_index(
        "ix_vnext_model_artifacts_candidate_id", "vnext_model_artifacts", ["candidate_id"]
    )
    op.create_index(
        "ix_vnext_model_artifacts_strategy_id", "vnext_model_artifacts", ["strategy_id"]
    )
    op.create_index(
        "uq_vnext_model_artifacts_candidate_strategy_ref",
        "vnext_model_artifacts",
        ["candidate_id", "strategy_id", "artifact_ref"],
        unique=True,
    )

    op.create_table(
        "vnext_experiment_specs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("experiment_id", sa.String(length=128), nullable=False),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_experiment_specs"),
    )
    op.create_index("ix_vnext_experiment_specs_run_id", "vnext_experiment_specs", ["run_id"])
    op.create_index(
        "ix_vnext_experiment_specs_candidate_id", "vnext_experiment_specs", ["candidate_id"]
    )
    op.create_index(
        "ix_vnext_experiment_specs_experiment_id", "vnext_experiment_specs", ["experiment_id"]
    )
    op.create_index(
        "uq_vnext_experiment_specs_candidate_experiment",
        "vnext_experiment_specs",
        ["candidate_id", "experiment_id"],
        unique=True,
    )

    op.create_table(
        "vnext_experiment_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("experiment_id", sa.String(length=128), nullable=True),
        sa.Column("stage_lineage_root", sa.String(length=128), nullable=True),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_experiment_runs"),
    )
    op.create_index("ix_vnext_experiment_runs_run_id", "vnext_experiment_runs", ["run_id"])
    op.create_index(
        "ix_vnext_experiment_runs_candidate_id", "vnext_experiment_runs", ["candidate_id"]
    )
    op.create_index(
        "ix_vnext_experiment_runs_experiment_id", "vnext_experiment_runs", ["experiment_id"]
    )
    op.create_index(
        "uq_vnext_experiment_runs_candidate_run",
        "vnext_experiment_runs",
        ["candidate_id", "run_id"],
        unique=True,
    )

    op.create_table(
        "vnext_simulation_calibrations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("artifact_ref", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=True),
        sa.Column("order_count", sa.BigInteger(), nullable=True),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_simulation_calibrations"),
    )
    op.create_index(
        "ix_vnext_simulation_calibrations_run_id", "vnext_simulation_calibrations", ["run_id"]
    )
    op.create_index(
        "ix_vnext_simulation_calibrations_candidate_id",
        "vnext_simulation_calibrations",
        ["candidate_id"],
    )
    op.create_index(
        "uq_vnext_simulation_calibrations_candidate_artifact",
        "vnext_simulation_calibrations",
        ["candidate_id", "artifact_ref"],
        unique=True,
    )

    op.create_table(
        "vnext_shadow_live_deviations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=True),
        sa.Column("artifact_ref", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=True),
        sa.Column("order_count", sa.BigInteger(), nullable=True),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_shadow_live_deviations"),
    )
    op.create_index(
        "ix_vnext_shadow_live_deviations_run_id", "vnext_shadow_live_deviations", ["run_id"]
    )
    op.create_index(
        "ix_vnext_shadow_live_deviations_candidate_id",
        "vnext_shadow_live_deviations",
        ["candidate_id"],
    )
    op.create_index(
        "uq_vnext_shadow_live_deviations_candidate_artifact",
        "vnext_shadow_live_deviations",
        ["candidate_id", "artifact_ref"],
        unique=True,
    )

    op.create_table(
        "vnext_promotion_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("candidate_id", sa.String(length=64), nullable=False),
        sa.Column("promotion_target", sa.String(length=16), nullable=False),
        sa.Column("recommended_mode", sa.String(length=16), nullable=True),
        sa.Column("decision_action", sa.String(length=32), nullable=True),
        sa.Column("allowed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("gate_report_trace_id", sa.String(length=64), nullable=True),
        sa.Column("recommendation_trace_id", sa.String(length=64), nullable=True),
        sa.Column("payload_json", _json_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_vnext_promotion_decisions"),
    )
    op.create_index("ix_vnext_promotion_decisions_run_id", "vnext_promotion_decisions", ["run_id"])
    op.create_index(
        "ix_vnext_promotion_decisions_candidate_id", "vnext_promotion_decisions", ["candidate_id"]
    )
    op.create_index(
        "ix_vnext_promotion_decisions_target", "vnext_promotion_decisions", ["promotion_target"]
    )
    op.create_index(
        "uq_vnext_promotion_decisions_candidate_target",
        "vnext_promotion_decisions",
        ["candidate_id", "promotion_target"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_vnext_promotion_decisions_candidate_target", table_name="vnext_promotion_decisions")
    op.drop_index("ix_vnext_promotion_decisions_target", table_name="vnext_promotion_decisions")
    op.drop_index("ix_vnext_promotion_decisions_candidate_id", table_name="vnext_promotion_decisions")
    op.drop_index("ix_vnext_promotion_decisions_run_id", table_name="vnext_promotion_decisions")
    op.drop_table("vnext_promotion_decisions")

    op.drop_index(
        "uq_vnext_shadow_live_deviations_candidate_artifact",
        table_name="vnext_shadow_live_deviations",
    )
    op.drop_index(
        "ix_vnext_shadow_live_deviations_candidate_id",
        table_name="vnext_shadow_live_deviations",
    )
    op.drop_index("ix_vnext_shadow_live_deviations_run_id", table_name="vnext_shadow_live_deviations")
    op.drop_table("vnext_shadow_live_deviations")

    op.drop_index(
        "uq_vnext_simulation_calibrations_candidate_artifact",
        table_name="vnext_simulation_calibrations",
    )
    op.drop_index(
        "ix_vnext_simulation_calibrations_candidate_id",
        table_name="vnext_simulation_calibrations",
    )
    op.drop_index("ix_vnext_simulation_calibrations_run_id", table_name="vnext_simulation_calibrations")
    op.drop_table("vnext_simulation_calibrations")

    op.drop_index("uq_vnext_experiment_runs_candidate_run", table_name="vnext_experiment_runs")
    op.drop_index("ix_vnext_experiment_runs_experiment_id", table_name="vnext_experiment_runs")
    op.drop_index("ix_vnext_experiment_runs_candidate_id", table_name="vnext_experiment_runs")
    op.drop_index("ix_vnext_experiment_runs_run_id", table_name="vnext_experiment_runs")
    op.drop_table("vnext_experiment_runs")

    op.drop_index(
        "uq_vnext_experiment_specs_candidate_experiment",
        table_name="vnext_experiment_specs",
    )
    op.drop_index("ix_vnext_experiment_specs_experiment_id", table_name="vnext_experiment_specs")
    op.drop_index("ix_vnext_experiment_specs_candidate_id", table_name="vnext_experiment_specs")
    op.drop_index("ix_vnext_experiment_specs_run_id", table_name="vnext_experiment_specs")
    op.drop_table("vnext_experiment_specs")

    op.drop_index(
        "uq_vnext_model_artifacts_candidate_strategy_ref",
        table_name="vnext_model_artifacts",
    )
    op.drop_index("ix_vnext_model_artifacts_strategy_id", table_name="vnext_model_artifacts")
    op.drop_index("ix_vnext_model_artifacts_candidate_id", table_name="vnext_model_artifacts")
    op.drop_index("ix_vnext_model_artifacts_run_id", table_name="vnext_model_artifacts")
    op.drop_table("vnext_model_artifacts")

    op.drop_index(
        "uq_vnext_feature_view_specs_candidate_strategy",
        table_name="vnext_feature_view_specs",
    )
    op.drop_index("ix_vnext_feature_view_specs_strategy_id", table_name="vnext_feature_view_specs")
    op.drop_index("ix_vnext_feature_view_specs_candidate_id", table_name="vnext_feature_view_specs")
    op.drop_index("ix_vnext_feature_view_specs_run_id", table_name="vnext_feature_view_specs")
    op.drop_table("vnext_feature_view_specs")

    op.drop_index("uq_vnext_dataset_snapshots_run_dataset_id", table_name="vnext_dataset_snapshots")
    op.drop_index("ix_vnext_dataset_snapshots_dataset_id", table_name="vnext_dataset_snapshots")
    op.drop_index("ix_vnext_dataset_snapshots_candidate_id", table_name="vnext_dataset_snapshots")
    op.drop_index("ix_vnext_dataset_snapshots_run_id", table_name="vnext_dataset_snapshots")
    op.drop_table("vnext_dataset_snapshots")

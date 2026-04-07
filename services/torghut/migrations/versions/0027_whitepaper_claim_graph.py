"""Add whitepaper claim graph persistence objects.

Revision ID: 0027_whitepaper_claim_graph
Revises: 0026_strategy_factory_research_objects
Create Date: 2026-04-07 09:15:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0027_whitepaper_claim_graph"
down_revision = "0026_strategy_factory_research_objects"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "whitepaper_claims",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("analysis_run_id", sa.UUID(), nullable=False),
        sa.Column("claim_id", sa.String(length=128), nullable=False),
        sa.Column("claim_type", sa.String(length=64), nullable=False),
        sa.Column("claim_text", sa.Text(), nullable=False),
        sa.Column("asset_scope", sa.String(length=128), nullable=True),
        sa.Column("horizon_scope", sa.String(length=128), nullable=True),
        sa.Column("data_requirements_json", sa.JSON(), nullable=True),
        sa.Column("expected_direction", sa.String(length=64), nullable=True),
        sa.Column("required_activity_conditions_json", sa.JSON(), nullable=True),
        sa.Column("liquidity_constraints_json", sa.JSON(), nullable=True),
        sa.Column("validation_notes", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Numeric(6, 4), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["analysis_run_id"], ["whitepaper_analysis_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_claims"),
    )
    op.create_index("ix_whitepaper_claims_run_id", "whitepaper_claims", ["analysis_run_id"])
    op.create_index("ix_whitepaper_claims_type", "whitepaper_claims", ["claim_type"])
    op.create_index("ix_whitepaper_claims_asset_scope", "whitepaper_claims", ["asset_scope"])
    op.create_index(
        "uq_whitepaper_claims_run_claim_id",
        "whitepaper_claims",
        ["analysis_run_id", "claim_id"],
        unique=True,
    )

    op.create_table(
        "whitepaper_claim_relations",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("analysis_run_id", sa.UUID(), nullable=False),
        sa.Column("relation_id", sa.String(length=128), nullable=False),
        sa.Column("relation_type", sa.String(length=64), nullable=False),
        sa.Column("source_claim_id", sa.String(length=128), nullable=False),
        sa.Column("target_claim_id", sa.String(length=128), nullable=False),
        sa.Column("target_run_id", sa.String(length=64), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Numeric(6, 4), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["analysis_run_id"], ["whitepaper_analysis_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_claim_relations"),
    )
    op.create_index("ix_whitepaper_claim_relations_run_id", "whitepaper_claim_relations", ["analysis_run_id"])
    op.create_index("ix_whitepaper_claim_relations_type", "whitepaper_claim_relations", ["relation_type"])
    op.create_index("ix_whitepaper_claim_relations_source", "whitepaper_claim_relations", ["source_claim_id"])
    op.create_index("ix_whitepaper_claim_relations_target", "whitepaper_claim_relations", ["target_claim_id"])
    op.create_index(
        "uq_whitepaper_claim_relations_run_relation_id",
        "whitepaper_claim_relations",
        ["analysis_run_id", "relation_id"],
        unique=True,
    )

    op.create_table(
        "whitepaper_strategy_templates",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("analysis_run_id", sa.UUID(), nullable=False),
        sa.Column("template_id", sa.String(length=128), nullable=False),
        sa.Column("family_template_id", sa.String(length=128), nullable=False),
        sa.Column("economic_mechanism", sa.Text(), nullable=False),
        sa.Column("hypothesis", sa.Text(), nullable=True),
        sa.Column("supported_markets_json", sa.JSON(), nullable=True),
        sa.Column("required_features_json", sa.JSON(), nullable=True),
        sa.Column("allowed_normalizations_json", sa.JSON(), nullable=True),
        sa.Column("entry_motifs_json", sa.JSON(), nullable=True),
        sa.Column("exit_motifs_json", sa.JSON(), nullable=True),
        sa.Column("risk_controls_json", sa.JSON(), nullable=True),
        sa.Column("activity_model_json", sa.JSON(), nullable=True),
        sa.Column("liquidity_assumptions_json", sa.JSON(), nullable=True),
        sa.Column("regime_activation_rules_json", sa.JSON(), nullable=True),
        sa.Column("day_veto_rules_json", sa.JSON(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["analysis_run_id"], ["whitepaper_analysis_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_strategy_templates"),
    )
    op.create_index("ix_whitepaper_strategy_templates_run_id", "whitepaper_strategy_templates", ["analysis_run_id"])
    op.create_index("ix_whitepaper_strategy_templates_family_id", "whitepaper_strategy_templates", ["family_template_id"])
    op.create_index(
        "uq_whitepaper_strategy_templates_run_template_id",
        "whitepaper_strategy_templates",
        ["analysis_run_id", "template_id"],
        unique=True,
    )

    op.create_table(
        "whitepaper_experiment_specs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("analysis_run_id", sa.UUID(), nullable=False),
        sa.Column("experiment_id", sa.String(length=128), nullable=False),
        sa.Column("family_template_id", sa.String(length=128), nullable=False),
        sa.Column("template_id", sa.String(length=128), nullable=True),
        sa.Column("hypothesis", sa.Text(), nullable=True),
        sa.Column("paper_claim_links_json", sa.JSON(), nullable=True),
        sa.Column("dataset_snapshot_policy_json", sa.JSON(), nullable=True),
        sa.Column("template_overrides_json", sa.JSON(), nullable=True),
        sa.Column("feature_variants_json", sa.JSON(), nullable=True),
        sa.Column("veto_controller_variants_json", sa.JSON(), nullable=True),
        sa.Column("selection_objectives_json", sa.JSON(), nullable=True),
        sa.Column("hard_vetoes_json", sa.JSON(), nullable=True),
        sa.Column("expected_failure_modes_json", sa.JSON(), nullable=True),
        sa.Column("promotion_contract_json", sa.JSON(), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["analysis_run_id"], ["whitepaper_analysis_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_experiment_specs"),
    )
    op.create_index("ix_whitepaper_experiment_specs_run_id", "whitepaper_experiment_specs", ["analysis_run_id"])
    op.create_index("ix_whitepaper_experiment_specs_family_id", "whitepaper_experiment_specs", ["family_template_id"])
    op.create_index(
        "uq_whitepaper_experiment_specs_run_experiment_id",
        "whitepaper_experiment_specs",
        ["analysis_run_id", "experiment_id"],
        unique=True,
    )

    op.create_table(
        "whitepaper_contradiction_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("analysis_run_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.String(length=128), nullable=False),
        sa.Column("source_claim_id", sa.String(length=128), nullable=False),
        sa.Column("target_claim_id", sa.String(length=128), nullable=True),
        sa.Column("target_run_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default=sa.text("'open'")),
        sa.Column("required_action", sa.String(length=64), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.ForeignKeyConstraint(["analysis_run_id"], ["whitepaper_analysis_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_contradiction_events"),
    )
    op.create_index("ix_whitepaper_contradiction_events_run_id", "whitepaper_contradiction_events", ["analysis_run_id"])
    op.create_index("ix_whitepaper_contradiction_events_status", "whitepaper_contradiction_events", ["status"])
    op.create_index("ix_whitepaper_contradiction_events_source_claim_id", "whitepaper_contradiction_events", ["source_claim_id"])
    op.create_index(
        "uq_whitepaper_contradiction_events_run_event_id",
        "whitepaper_contradiction_events",
        ["analysis_run_id", "event_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_whitepaper_contradiction_events_run_event_id", table_name="whitepaper_contradiction_events")
    op.drop_index("ix_whitepaper_contradiction_events_source_claim_id", table_name="whitepaper_contradiction_events")
    op.drop_index("ix_whitepaper_contradiction_events_status", table_name="whitepaper_contradiction_events")
    op.drop_index("ix_whitepaper_contradiction_events_run_id", table_name="whitepaper_contradiction_events")
    op.drop_table("whitepaper_contradiction_events")

    op.drop_index("uq_whitepaper_experiment_specs_run_experiment_id", table_name="whitepaper_experiment_specs")
    op.drop_index("ix_whitepaper_experiment_specs_family_id", table_name="whitepaper_experiment_specs")
    op.drop_index("ix_whitepaper_experiment_specs_run_id", table_name="whitepaper_experiment_specs")
    op.drop_table("whitepaper_experiment_specs")

    op.drop_index("uq_whitepaper_strategy_templates_run_template_id", table_name="whitepaper_strategy_templates")
    op.drop_index("ix_whitepaper_strategy_templates_family_id", table_name="whitepaper_strategy_templates")
    op.drop_index("ix_whitepaper_strategy_templates_run_id", table_name="whitepaper_strategy_templates")
    op.drop_table("whitepaper_strategy_templates")

    op.drop_index("uq_whitepaper_claim_relations_run_relation_id", table_name="whitepaper_claim_relations")
    op.drop_index("ix_whitepaper_claim_relations_target", table_name="whitepaper_claim_relations")
    op.drop_index("ix_whitepaper_claim_relations_source", table_name="whitepaper_claim_relations")
    op.drop_index("ix_whitepaper_claim_relations_type", table_name="whitepaper_claim_relations")
    op.drop_index("ix_whitepaper_claim_relations_run_id", table_name="whitepaper_claim_relations")
    op.drop_table("whitepaper_claim_relations")

    op.drop_index("uq_whitepaper_claims_run_claim_id", table_name="whitepaper_claims")
    op.drop_index("ix_whitepaper_claims_asset_scope", table_name="whitepaper_claims")
    op.drop_index("ix_whitepaper_claims_type", table_name="whitepaper_claims")
    op.drop_index("ix_whitepaper_claims_run_id", table_name="whitepaper_claims")
    op.drop_table("whitepaper_claims")

"""Add autoresearch epoch ledger tables.

Revision ID: 0028_autoresearch_epoch_ledgers
Revises: 0027_whitepaper_claim_graph
Create Date: 2026-04-21 04:30:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0028_autoresearch_epoch_ledgers"
down_revision = "0027_whitepaper_claim_graph"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "autoresearch_epochs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("epoch_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("target_net_pnl_per_day", sa.Numeric(20, 8), nullable=False),
        sa.Column("paper_run_ids_json", sa.JSON(), nullable=True),
        sa.Column("snapshot_manifest_json", sa.JSON(), nullable=True),
        sa.Column("runner_config_json", sa.JSON(), nullable=True),
        sa.Column("summary_json", sa.JSON(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_autoresearch_epochs"),
    )
    op.create_index(
        "uq_autoresearch_epochs_epoch_id",
        "autoresearch_epochs",
        ["epoch_id"],
        unique=True,
    )
    op.create_index("ix_autoresearch_epochs_status", "autoresearch_epochs", ["status"])
    op.create_index(
        "ix_autoresearch_epochs_completed_at", "autoresearch_epochs", ["completed_at"]
    )

    op.create_table(
        "autoresearch_candidate_specs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("candidate_spec_id", sa.String(length=128), nullable=False),
        sa.Column("epoch_id", sa.String(length=128), nullable=False),
        sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
        sa.Column("candidate_kind", sa.String(length=32), nullable=False),
        sa.Column("family_template_id", sa.String(length=128), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("blockers_json", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_autoresearch_candidate_specs"),
    )
    op.create_index(
        "uq_autoresearch_candidate_specs_candidate_spec_id",
        "autoresearch_candidate_specs",
        ["candidate_spec_id"],
        unique=True,
    )
    op.create_index(
        "ix_autoresearch_candidate_specs_epoch_id",
        "autoresearch_candidate_specs",
        ["epoch_id"],
    )
    op.create_index(
        "ix_autoresearch_candidate_specs_hypothesis_id",
        "autoresearch_candidate_specs",
        ["hypothesis_id"],
    )
    op.create_index(
        "ix_autoresearch_candidate_specs_family",
        "autoresearch_candidate_specs",
        ["family_template_id"],
    )
    op.create_index(
        "ix_autoresearch_candidate_specs_status",
        "autoresearch_candidate_specs",
        ["status"],
    )

    op.create_table(
        "autoresearch_proposal_scores",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("epoch_id", sa.String(length=128), nullable=False),
        sa.Column("candidate_spec_id", sa.String(length=128), nullable=False),
        sa.Column("model_id", sa.String(length=128), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("proposal_score", sa.Numeric(20, 8), nullable=False),
        sa.Column("rank", sa.BigInteger(), nullable=False),
        sa.Column("selection_reason", sa.String(length=64), nullable=False),
        sa.Column("feature_hash", sa.String(length=64), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_autoresearch_proposal_scores"),
    )
    op.create_index(
        "ix_autoresearch_proposal_scores_epoch_id",
        "autoresearch_proposal_scores",
        ["epoch_id"],
    )
    op.create_index(
        "ix_autoresearch_proposal_scores_candidate_spec",
        "autoresearch_proposal_scores",
        ["candidate_spec_id"],
    )
    op.create_index(
        "ix_autoresearch_proposal_scores_rank",
        "autoresearch_proposal_scores",
        ["epoch_id", "rank"],
    )
    op.create_index(
        "uq_autoresearch_proposal_scores_epoch_candidate_model",
        "autoresearch_proposal_scores",
        ["epoch_id", "candidate_spec_id", "model_id"],
        unique=True,
    )

    op.create_table(
        "autoresearch_portfolio_candidates",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("portfolio_candidate_id", sa.String(length=128), nullable=False),
        sa.Column("epoch_id", sa.String(length=128), nullable=False),
        sa.Column("source_candidate_ids_json", sa.JSON(), nullable=False),
        sa.Column("target_net_pnl_per_day", sa.Numeric(20, 8), nullable=False),
        sa.Column("objective_scorecard_json", sa.JSON(), nullable=False),
        sa.Column("optimizer_report_json", sa.JSON(), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_autoresearch_portfolio_candidates"),
    )
    op.create_index(
        "uq_autoresearch_portfolio_candidates_portfolio_candidate_id",
        "autoresearch_portfolio_candidates",
        ["portfolio_candidate_id"],
        unique=True,
    )
    op.create_index(
        "ix_autoresearch_portfolio_candidates_epoch_id",
        "autoresearch_portfolio_candidates",
        ["epoch_id"],
    )
    op.create_index(
        "ix_autoresearch_portfolio_candidates_status",
        "autoresearch_portfolio_candidates",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_autoresearch_portfolio_candidates_status",
        table_name="autoresearch_portfolio_candidates",
    )
    op.drop_index(
        "ix_autoresearch_portfolio_candidates_epoch_id",
        table_name="autoresearch_portfolio_candidates",
    )
    op.drop_index(
        "uq_autoresearch_portfolio_candidates_portfolio_candidate_id",
        table_name="autoresearch_portfolio_candidates",
    )
    op.drop_table("autoresearch_portfolio_candidates")

    op.drop_index(
        "uq_autoresearch_proposal_scores_epoch_candidate_model",
        table_name="autoresearch_proposal_scores",
    )
    op.drop_index(
        "ix_autoresearch_proposal_scores_rank",
        table_name="autoresearch_proposal_scores",
    )
    op.drop_index(
        "ix_autoresearch_proposal_scores_candidate_spec",
        table_name="autoresearch_proposal_scores",
    )
    op.drop_index(
        "ix_autoresearch_proposal_scores_epoch_id",
        table_name="autoresearch_proposal_scores",
    )
    op.drop_table("autoresearch_proposal_scores")

    op.drop_index(
        "ix_autoresearch_candidate_specs_status",
        table_name="autoresearch_candidate_specs",
    )
    op.drop_index(
        "ix_autoresearch_candidate_specs_family",
        table_name="autoresearch_candidate_specs",
    )
    op.drop_index(
        "ix_autoresearch_candidate_specs_hypothesis_id",
        table_name="autoresearch_candidate_specs",
    )
    op.drop_index(
        "ix_autoresearch_candidate_specs_epoch_id",
        table_name="autoresearch_candidate_specs",
    )
    op.drop_index(
        "uq_autoresearch_candidate_specs_candidate_spec_id",
        table_name="autoresearch_candidate_specs",
    )
    op.drop_table("autoresearch_candidate_specs")

    op.drop_index(
        "ix_autoresearch_epochs_completed_at", table_name="autoresearch_epochs"
    )
    op.drop_index("ix_autoresearch_epochs_status", table_name="autoresearch_epochs")
    op.drop_index("uq_autoresearch_epochs_epoch_id", table_name="autoresearch_epochs")
    op.drop_table("autoresearch_epochs")

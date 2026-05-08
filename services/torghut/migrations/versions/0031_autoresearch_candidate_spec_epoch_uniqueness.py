"""Scope autoresearch candidate spec uniqueness to each epoch.

Revision ID: 0031_autoresearch_candidate_spec_epoch_uniqueness
Revises: 0030_evidence_epochs
Create Date: 2026-05-08 18:45:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "0031_autoresearch_candidate_spec_epoch_uniqueness"
down_revision = "0030_evidence_epochs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index(
        "uq_autoresearch_candidate_specs_candidate_spec_id",
        table_name="autoresearch_candidate_specs",
    )
    op.create_index(
        "uq_autoresearch_candidate_specs_epoch_candidate_spec",
        "autoresearch_candidate_specs",
        ["epoch_id", "candidate_spec_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_autoresearch_candidate_specs_epoch_candidate_spec",
        table_name="autoresearch_candidate_specs",
    )
    op.create_index(
        "uq_autoresearch_candidate_specs_candidate_spec_id",
        "autoresearch_candidate_specs",
        ["candidate_spec_id"],
        unique=True,
    )

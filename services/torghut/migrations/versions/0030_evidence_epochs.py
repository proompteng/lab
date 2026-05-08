"""Add cross-plane evidence epoch receipt tables.

Revision ID: 0030_evidence_epochs
Revises: 0029_whitepaper_embedding_dimension_4096
Create Date: 2026-05-05 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0030_evidence_epochs"
down_revision = "0029_whitepaper_embedding_dimension_4096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "evidence_receipts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("receipt_id", sa.String(length=64), nullable=False),
        sa.Column("evidence_epoch_id", sa.String(length=64), nullable=True),
        sa.Column("receipt_type", sa.String(length=64), nullable=False),
        sa.Column("producer", sa.String(length=128), nullable=False),
        sa.Column("subject_ref", sa.String(length=255), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("decision", sa.String(length=64), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fresh_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason_codes_json", sa.JSON(), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_evidence_receipts"),
    )
    op.create_index(
        "uq_evidence_receipts_receipt_id",
        "evidence_receipts",
        ["receipt_id"],
        unique=True,
    )
    op.create_index(
        "ix_evidence_receipts_epoch_id",
        "evidence_receipts",
        ["evidence_epoch_id"],
    )
    op.create_index(
        "ix_evidence_receipts_type_state",
        "evidence_receipts",
        ["receipt_type", "state"],
    )
    op.create_index(
        "ix_evidence_receipts_fresh_until",
        "evidence_receipts",
        ["fresh_until"],
    )

    op.create_table(
        "evidence_epochs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("evidence_epoch_id", sa.String(length=64), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("stage_scope", sa.String(length=32), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("fresh_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason_codes_json", sa.JSON(), nullable=True),
        sa.Column("receipt_ids_json", sa.JSON(), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_evidence_epochs"),
    )
    op.create_index(
        "uq_evidence_epochs_epoch_id",
        "evidence_epochs",
        ["evidence_epoch_id"],
        unique=True,
    )
    op.create_index(
        "ix_evidence_epochs_account_stage",
        "evidence_epochs",
        ["account_label", "stage_scope"],
    )
    op.create_index(
        "ix_evidence_epochs_decision",
        "evidence_epochs",
        ["decision"],
    )
    op.create_index(
        "ix_evidence_epochs_fresh_until",
        "evidence_epochs",
        ["fresh_until"],
    )


def downgrade() -> None:
    op.drop_index("ix_evidence_epochs_fresh_until", table_name="evidence_epochs")
    op.drop_index("ix_evidence_epochs_decision", table_name="evidence_epochs")
    op.drop_index("ix_evidence_epochs_account_stage", table_name="evidence_epochs")
    op.drop_index("uq_evidence_epochs_epoch_id", table_name="evidence_epochs")
    op.drop_table("evidence_epochs")

    op.drop_index("ix_evidence_receipts_fresh_until", table_name="evidence_receipts")
    op.drop_index("ix_evidence_receipts_type_state", table_name="evidence_receipts")
    op.drop_index("ix_evidence_receipts_epoch_id", table_name="evidence_receipts")
    op.drop_index("uq_evidence_receipts_receipt_id", table_name="evidence_receipts")
    op.drop_table("evidence_receipts")

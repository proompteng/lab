"""Add active-underlying index for options catalog freshness checks.

Revision ID: 0032_options_catalog_active_underlying_index
Revises: 0031_autoresearch_candidate_spec_epoch_uniqueness
Create Date: 2026-05-18 10:45:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0032_options_catalog_active_underlying_index"
down_revision = "0031_autoresearch_candidate_spec_epoch_uniqueness"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_torghut_options_contract_catalog_active_underlying_freshness"
TABLE_NAME = "torghut_options_contract_catalog"


def upgrade() -> None:
    op.create_index(
        INDEX_NAME,
        TABLE_NAME,
        ["underlying_symbol"],
        unique=False,
        postgresql_where=sa.text("status = 'active'"),
        postgresql_include=[
            "last_seen_ts",
            "provider_updated_ts",
            "close_price",
            "open_interest",
        ],
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)

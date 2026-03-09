"""Add Torghut-owned options lane control-plane tables."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0022_options_lane_control_plane"
down_revision = "0021_strategy_hypothesis_governance"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "torghut_options_contract_catalog",
        sa.Column("contract_symbol", sa.Text(), nullable=False),
        sa.Column("contract_id", sa.Text(), nullable=False),
        sa.Column("root_symbol", sa.Text(), nullable=False),
        sa.Column("underlying_symbol", sa.Text(), nullable=False),
        sa.Column("expiration_date", sa.Date(), nullable=False),
        sa.Column("strike_price", sa.Numeric(18, 6), nullable=False),
        sa.Column("option_type", sa.Text(), nullable=False),
        sa.Column("style", sa.Text(), nullable=False),
        sa.Column(
            "contract_size",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("100"),
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "tradable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("open_interest", sa.BigInteger(), nullable=True),
        sa.Column("open_interest_date", sa.Date(), nullable=True),
        sa.Column("close_price", sa.Numeric(18, 6), nullable=True),
        sa.Column("close_price_date", sa.Date(), nullable=True),
        sa.Column("provider_updated_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("first_seen_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "metadata",
            _json_type(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.PrimaryKeyConstraint("contract_symbol", name="pk_torghut_options_contract_catalog"),
        sa.UniqueConstraint("contract_id", name="uq_torghut_options_contract_catalog_contract_id"),
        sa.CheckConstraint(
            "option_type IN ('call', 'put')",
            name="ck_torghut_options_contract_catalog_option_type",
        ),
        sa.CheckConstraint(
            "style IN ('american', 'european', 'unknown')",
            name="ck_torghut_options_contract_catalog_style",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'inactive', 'expired', 'unknown')",
            name="ck_torghut_options_contract_catalog_status",
        ),
        sa.CheckConstraint(
            "contract_size > 0",
            name="ck_torghut_options_contract_catalog_contract_size",
        ),
    )
    op.create_index(
        "ix_torghut_options_contract_catalog_underlying",
        "torghut_options_contract_catalog",
        ["underlying_symbol", "expiration_date", "strike_price"],
    )
    op.create_index(
        "ix_torghut_options_contract_catalog_status",
        "torghut_options_contract_catalog",
        ["status", "expiration_date"],
    )

    op.create_table(
        "torghut_options_subscription_state",
        sa.Column("contract_symbol", sa.Text(), nullable=False),
        sa.Column(
            "ranking_score",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "ranking_inputs",
            _json_type(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column(
            "desired_channels",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("ARRAY['trades','quotes']::text[]"),
        ),
        sa.Column(
            "subscribed_channels",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("ARRAY[]::text[]"),
        ),
        sa.Column(
            "provider_cap_generation",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_ranked_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_subscribe_attempt_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_subscribe_success_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("suppress_until_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("suppress_reason", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("contract_symbol", name="pk_torghut_options_subscription_state"),
        sa.ForeignKeyConstraint(
            ["contract_symbol"],
            ["torghut_options_contract_catalog.contract_symbol"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "tier IN ('hot', 'warm', 'cold', 'off')",
            name="ck_torghut_options_subscription_state_tier",
        ),
    )
    op.create_index(
        "ix_torghut_options_subscription_state_tier",
        "torghut_options_subscription_state",
        ["tier", "ranking_score"],
    )

    op.create_table(
        "torghut_options_watermarks",
        sa.Column("component", sa.Text(), nullable=False),
        sa.Column("scope_type", sa.Text(), nullable=False),
        sa.Column("scope_key", sa.Text(), nullable=False),
        sa.Column("cursor", sa.Text(), nullable=True),
        sa.Column("last_event_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_eligible_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "retry_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "metadata",
            _json_type(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.PrimaryKeyConstraint(
            "component",
            "scope_type",
            "scope_key",
            name="pk_torghut_options_watermarks",
        ),
    )

    op.create_table(
        "torghut_options_rate_limit_state",
        sa.Column("bucket_name", sa.Text(), nullable=False),
        sa.Column("observed_limit_per_minute", sa.Integer(), nullable=True),
        sa.Column("refill_per_second", sa.Float(), nullable=False),
        sa.Column("burst_capacity", sa.Integer(), nullable=False),
        sa.Column("tokens_available", sa.Float(), nullable=False),
        sa.Column("last_refill_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_429_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "metadata",
            _json_type(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.PrimaryKeyConstraint("bucket_name", name="pk_torghut_options_rate_limit_state"),
    )


def downgrade() -> None:
    op.drop_table("torghut_options_rate_limit_state")
    op.drop_table("torghut_options_watermarks")
    op.drop_index(
        "ix_torghut_options_subscription_state_tier",
        table_name="torghut_options_subscription_state",
    )
    op.drop_table("torghut_options_subscription_state")
    op.drop_index(
        "ix_torghut_options_contract_catalog_status",
        table_name="torghut_options_contract_catalog",
    )
    op.drop_index(
        "ix_torghut_options_contract_catalog_underlying",
        table_name="torghut_options_contract_catalog",
    )
    op.drop_table("torghut_options_contract_catalog")

"""Add immutable strategy-scoped capital authorities.

Revision ID: 0063_strategy_capital_authority
Revises: 0062_options_archive_members
Create Date: 2026-07-13 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0063_strategy_capital_authority"
down_revision = "0062_options_archive_members"
branch_labels = None
depends_on = None


_TABLE = "strategy_capital_authorities"
_IMMUTABILITY_FUNCTION = "torghut_reject_strategy_capital_authority_mutation"
_EVIDENCE_TABLE = "evidence_epochs"
_EVIDENCE_IMMUTABILITY_FUNCTION = "torghut_reject_evidence_epoch_mutation"


def _create_authority_table() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("authority_id", sa.String(length=128), nullable=False),
        sa.Column("strategy_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("schema_version", sa.String(length=64), nullable=False),
        sa.Column("stage", sa.String(length=32), nullable=False),
        sa.Column("authority_digest", sa.String(length=71), nullable=False),
        sa.Column(
            "payload_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "schema_version = 'torghut.strategy-capital-authority.v1'",
            name="ck_strategy_capital_authorities_schema",
        ),
        sa.CheckConstraint(
            "stage IN ('disabled', 'quarantined', 'research_only', "
            "'replay_verified', 'shadow_allowed', 'paper_probation', "
            "'paper_verified', 'micro_live_allowed', 'capital_allowed', 'scaled')",
            name="ck_strategy_capital_authorities_stage",
        ),
        sa.CheckConstraint(
            "authority_digest ~ '^sha256:[0-9a-f]{64}$'",
            name="ck_strategy_capital_authorities_digest",
        ),
        sa.CheckConstraint(
            "length(authority_id) BETWEEN 1 AND 128",
            name="ck_strategy_capital_authorities_id",
        ),
        sa.CheckConstraint(
            "expires_at IS NULL OR issued_at IS NOT NULL",
            name="ck_strategy_capital_authorities_expiry_issuance",
        ),
        sa.CheckConstraint(
            "expires_at IS NULL OR expires_at > issued_at",
            name="ck_strategy_capital_authorities_expiry_order",
        ),
        sa.ForeignKeyConstraint(
            ["strategy_id"],
            ["strategies.id"],
            name="fk_strategy_capital_authorities_strategy",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_strategy_capital_authorities"),
        sa.UniqueConstraint(
            "authority_id",
            name="uq_strategy_capital_authorities_authority_id",
        ),
        sa.UniqueConstraint(
            "authority_digest",
            name="uq_strategy_capital_authorities_digest",
        ),
        sa.UniqueConstraint(
            "id",
            "strategy_id",
            name="uq_strategy_capital_authorities_record_strategy",
        ),
        sa.UniqueConstraint(
            "authority_id",
            "authority_digest",
            "strategy_id",
            name="uq_strategy_capital_authorities_identity",
        ),
    )
    op.create_index(
        "ix_strategy_capital_authorities_strategy_created",
        _TABLE,
        ["strategy_id", "created_at"],
        unique=False,
    )


def _create_immutability_guard(
    *,
    table: str,
    function: str,
    message: str,
) -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {function}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION '{message}'
                    USING ERRCODE = '23514';
            END;
            $$
            """
        )
    )
    for operation in ("UPDATE", "DELETE"):
        op.execute(
            sa.text(
                f"CREATE TRIGGER trg_{table}_no_{operation.lower()} "
                f"BEFORE {operation} ON {table} FOR EACH ROW "
                f"EXECUTE FUNCTION {function}()"
            )
        )


def _link_active_authority() -> None:
    op.add_column(
        "strategies",
        sa.Column(
            "active_capital_authority_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_strategies_active_capital_authority_identity",
        "strategies",
        _TABLE,
        ["active_capital_authority_id", "id"],
        ["id", "strategy_id"],
        ondelete="RESTRICT",
        onupdate="RESTRICT",
    )
    op.create_index(
        "ix_strategies_active_capital_authority",
        "strategies",
        ["active_capital_authority_id"],
        unique=False,
    )


def _add_decision_authority_reservation() -> None:
    op.add_column(
        "trade_decisions",
        sa.Column(
            "strategy_capital_authority_id",
            sa.String(length=128),
            nullable=True,
        ),
    )
    op.add_column(
        "trade_decisions",
        sa.Column(
            "strategy_capital_authority_digest",
            sa.String(length=71),
            nullable=True,
        ),
    )
    op.add_column(
        "trade_decisions",
        sa.Column(
            "strategy_capital_authority_evaluated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "trade_decisions",
        sa.Column(
            "strategy_capital_authority_allowed",
            sa.Boolean(),
            nullable=True,
        ),
    )
    op.create_check_constraint(
        "ck_trade_decisions_capital_authority_evaluated",
        "trade_decisions",
        "strategy_capital_authority_allowed IS NULL OR "
        "strategy_capital_authority_evaluated_at IS NOT NULL",
    )
    op.create_check_constraint(
        "ck_trade_decisions_capital_authority_allowed_identity",
        "trade_decisions",
        "strategy_capital_authority_allowed IS NOT TRUE OR "
        "(strategy_capital_authority_id IS NOT NULL AND "
        "strategy_capital_authority_digest IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_trade_decisions_capital_authority_identity_pair",
        "trade_decisions",
        "(strategy_capital_authority_id IS NULL) = "
        "(strategy_capital_authority_digest IS NULL)",
    )
    op.create_check_constraint(
        "ck_trade_decisions_capital_authority_digest",
        "trade_decisions",
        "strategy_capital_authority_digest IS NULL OR "
        "strategy_capital_authority_digest ~ '^sha256:[0-9a-f]{64}$'",
    )
    op.create_foreign_key(
        "fk_trade_decisions_strategy_capital_authority_identity",
        "trade_decisions",
        _TABLE,
        [
            "strategy_capital_authority_id",
            "strategy_capital_authority_digest",
            "strategy_id",
        ],
        ["authority_id", "authority_digest", "strategy_id"],
        ondelete="RESTRICT",
        onupdate="RESTRICT",
    )
    op.create_index(
        "ix_trade_decisions_capital_authority_usage",
        "trade_decisions",
        [
            "strategy_id",
            "alpaca_account_label",
            "strategy_capital_authority_evaluated_at",
        ],
        unique=False,
    )


def upgrade() -> None:
    _create_authority_table()
    _create_immutability_guard(
        table=_TABLE,
        function=_IMMUTABILITY_FUNCTION,
        message="strategy capital authority records are immutable",
    )
    _create_immutability_guard(
        table=_EVIDENCE_TABLE,
        function=_EVIDENCE_IMMUTABILITY_FUNCTION,
        message="evidence epoch records are immutable",
    )
    _link_active_authority()
    _add_decision_authority_reservation()


def downgrade() -> None:
    op.execute(
        sa.text(
            f"LOCK TABLE strategies, {_TABLE}, trade_decisions, {_EVIDENCE_TABLE} "
            "IN ACCESS EXCLUSIVE MODE NOWAIT"
        )
    )
    op.execute(
        sa.text(
            f"""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM {_TABLE}) THEN
                    RAISE EXCEPTION
                        'refusing to downgrade nonempty strategy capital authorities'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )
    op.drop_index("ix_strategies_active_capital_authority", table_name="strategies")
    op.drop_constraint(
        "fk_strategies_active_capital_authority_identity",
        "strategies",
        type_="foreignkey",
    )
    op.drop_column("strategies", "active_capital_authority_id")
    op.drop_index(
        "ix_trade_decisions_capital_authority_usage",
        table_name="trade_decisions",
    )
    op.drop_constraint(
        "fk_trade_decisions_strategy_capital_authority_identity",
        "trade_decisions",
        type_="foreignkey",
    )
    for constraint in (
        "ck_trade_decisions_capital_authority_digest",
        "ck_trade_decisions_capital_authority_identity_pair",
        "ck_trade_decisions_capital_authority_allowed_identity",
        "ck_trade_decisions_capital_authority_evaluated",
    ):
        op.drop_constraint(constraint, "trade_decisions", type_="check")
    for column in (
        "strategy_capital_authority_allowed",
        "strategy_capital_authority_evaluated_at",
        "strategy_capital_authority_digest",
        "strategy_capital_authority_id",
    ):
        op.drop_column("trade_decisions", column)
    for operation in ("update", "delete"):
        op.execute(
            sa.text(
                f"DROP TRIGGER trg_{_EVIDENCE_TABLE}_no_{operation} ON {_EVIDENCE_TABLE}"
            )
        )
    op.execute(sa.text(f"DROP FUNCTION {_EVIDENCE_IMMUTABILITY_FUNCTION}()"))
    for operation in ("update", "delete"):
        op.execute(sa.text(f"DROP TRIGGER trg_{_TABLE}_no_{operation} ON {_TABLE}"))
    op.execute(sa.text(f"DROP FUNCTION {_IMMUTABILITY_FUNCTION}()"))
    op.drop_index(
        "ix_strategy_capital_authorities_strategy_created",
        table_name=_TABLE,
    )
    op.drop_table(_TABLE)

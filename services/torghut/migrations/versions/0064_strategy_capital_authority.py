"""Add immutable strategy-scoped capital authorities.

Revision ID: 0064_strategy_capital_authority
Revises: 0063_options_archive_final_idx
Create Date: 2026-07-14 02:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import conv


revision = "0064_strategy_capital_authority"
down_revision = "0063_options_archive_final_idx"
branch_labels = None
depends_on = None


_TABLE = "strategy_capital_authorities"
_IMMUTABILITY_FUNCTION = "torghut_reject_strategy_capital_authority_mutation"
_EVIDENCE_TABLE = "evidence_epochs"
_EVIDENCE_IMMUTABILITY_FUNCTION = "torghut_reject_evidence_epoch_mutation"
_STRATEGY_AUTHORITY_FK = "fk_strategies_active_capital_authority_identity"
_USAGE_INDEX = "ix_trade_decisions_capital_authority_usage"
_DECISION_AUTHORITY_FK = "fk_trade_decisions_strategy_capital_authority_identity"
_DECISION_CHECKS: tuple[tuple[str, str], ...] = (
    (
        "ck_trade_decisions_capital_authority_evaluated",
        "strategy_capital_authority_allowed IS NULL OR "
        "strategy_capital_authority_evaluated_at IS NOT NULL",
    ),
    (
        "ck_trade_decisions_capital_authority_allowed_identity",
        "strategy_capital_authority_allowed IS NOT TRUE OR "
        "(strategy_capital_authority_id IS NOT NULL AND "
        "strategy_capital_authority_digest IS NOT NULL)",
    ),
    (
        "ck_trade_decisions_capital_authority_identity_pair",
        "(strategy_capital_authority_id IS NULL) = "
        "(strategy_capital_authority_digest IS NULL)",
    ),
    (
        "ck_trade_decisions_capital_authority_digest",
        "strategy_capital_authority_digest IS NULL OR "
        "strategy_capital_authority_digest ~ '^sha256:[0-9a-f]{64}$'",
    ),
)
_DECISION_CONSTRAINTS = tuple(name for name, _condition in _DECISION_CHECKS) + (
    _DECISION_AUTHORITY_FK,
)


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
            name=conv("ck_strategy_capital_authorities_schema"),
        ),
        sa.CheckConstraint(
            "stage IN ('disabled', 'quarantined', 'research_only', "
            "'replay_verified', 'shadow_allowed', 'paper_probation', "
            "'paper_verified', 'micro_live_allowed', 'capital_allowed', 'scaled')",
            name=conv("ck_strategy_capital_authorities_stage"),
        ),
        sa.CheckConstraint(
            "authority_digest ~ '^sha256:[0-9a-f]{64}$'",
            name=conv("ck_strategy_capital_authorities_digest"),
        ),
        sa.CheckConstraint(
            "length(authority_id) BETWEEN 1 AND 128",
            name=conv("ck_strategy_capital_authorities_id"),
        ),
        sa.CheckConstraint(
            "expires_at IS NULL OR issued_at IS NOT NULL",
            name=conv("ck_strategy_capital_authorities_expiry_issuance"),
        ),
        sa.CheckConstraint(
            "expires_at IS NULL OR expires_at > issued_at",
            name=conv("ck_strategy_capital_authorities_expiry_order"),
        ),
        sa.ForeignKeyConstraint(
            ["strategy_id"],
            ["strategies.id"],
            name=conv("fk_strategy_capital_authorities_strategy"),
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_strategy_capital_authorities")),
        sa.UniqueConstraint(
            "authority_id",
            name=conv("uq_strategy_capital_authorities_authority_id"),
        ),
        sa.UniqueConstraint(
            "authority_digest",
            name=conv("uq_strategy_capital_authorities_digest"),
        ),
        sa.UniqueConstraint(
            "id",
            "strategy_id",
            name=conv("uq_strategy_capital_authorities_record_strategy"),
        ),
        sa.UniqueConstraint(
            "authority_id",
            "authority_digest",
            "strategy_id",
            name=conv("uq_strategy_capital_authorities_identity"),
        ),
        if_not_exists=True,
    )
    op.create_index(
        "ix_strategy_capital_authorities_strategy_created",
        _TABLE,
        ["strategy_id", "created_at"],
        unique=False,
        if_not_exists=True,
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
            CREATE OR REPLACE FUNCTION {function}()
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
        trigger = f"trg_{table}_no_{operation.lower()}"
        op.execute(
            sa.text(
                f"""
                DO $torghut$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1
                        FROM pg_trigger
                        WHERE tgrelid = '{table}'::regclass
                          AND tgname = '{trigger}'
                          AND NOT tgisinternal
                    ) THEN
                        CREATE TRIGGER {trigger}
                        BEFORE {operation} ON {table} FOR EACH ROW
                        EXECUTE FUNCTION {function}();
                    END IF;
                END
                $torghut$;
                """
            )
        )


def _existing_column_names(table: str) -> set[str]:
    rows = op.get_bind().execute(
        sa.text(
            """
            SELECT attname
            FROM pg_attribute
            WHERE attrelid = to_regclass(:table_name)
              AND attnum > 0
              AND NOT attisdropped
            """
        ),
        {"table_name": table},
    )
    return {str(value) for value in rows.scalars()}


def _existing_constraint_names(table: str) -> set[str]:
    rows = op.get_bind().execute(
        sa.text(
            """
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = to_regclass(:table_name)
            """
        ),
        {"table_name": table},
    )
    return {str(value) for value in rows.scalars()}


def _unvalidated_constraint_names(table: str) -> set[str]:
    rows = op.get_bind().execute(
        sa.text(
            """
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = to_regclass(:table_name)
              AND NOT convalidated
            """
        ),
        {"table_name": table},
    )
    return {str(value) for value in rows.scalars()}


def _execute_alter_actions(table: str, actions: list[str]) -> None:
    if not actions:
        return
    op.execute(sa.text(f"ALTER TABLE {table}\n" + ",\n".join(actions)))


def _link_active_authority() -> None:
    columns = _existing_column_names("strategies")
    constraints = _existing_constraint_names("strategies")
    actions: list[str] = []
    if "active_capital_authority_id" not in columns:
        actions.append("ADD COLUMN active_capital_authority_id UUID")
    if _STRATEGY_AUTHORITY_FK not in constraints:
        actions.append(
            f"ADD CONSTRAINT {_STRATEGY_AUTHORITY_FK} "
            f"FOREIGN KEY (active_capital_authority_id, id) "
            f"REFERENCES {_TABLE} (id, strategy_id) "
            "ON DELETE RESTRICT ON UPDATE RESTRICT"
        )
    _execute_alter_actions("strategies", actions)
    op.create_index(
        "ix_strategies_active_capital_authority",
        "strategies",
        ["active_capital_authority_id"],
        unique=False,
        if_not_exists=True,
    )


def _add_decision_authority_reservation() -> None:
    columns = _existing_column_names("trade_decisions")
    constraints = _existing_constraint_names("trade_decisions")
    actions: list[str] = []
    for name, sql_type in (
        ("strategy_capital_authority_id", "VARCHAR(128)"),
        ("strategy_capital_authority_digest", "VARCHAR(71)"),
        ("strategy_capital_authority_evaluated_at", "TIMESTAMPTZ"),
        ("strategy_capital_authority_allowed", "BOOLEAN"),
    ):
        if name not in columns:
            actions.append(f"ADD COLUMN {name} {sql_type}")
    for name, condition in _DECISION_CHECKS:
        if name not in constraints:
            actions.append(f"ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID")
    if _DECISION_AUTHORITY_FK not in constraints:
        actions.append(
            f"ADD CONSTRAINT {_DECISION_AUTHORITY_FK} "
            "FOREIGN KEY (strategy_capital_authority_id, "
            "strategy_capital_authority_digest, strategy_id) "
            f"REFERENCES {_TABLE} (authority_id, authority_digest, strategy_id) "
            "ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID"
        )
    _execute_alter_actions("trade_decisions", actions)

    unvalidated = _unvalidated_constraint_names("trade_decisions")
    validation_actions = [
        f"VALIDATE CONSTRAINT {name}"
        for name in _DECISION_CONSTRAINTS
        if name in unvalidated
    ]
    _execute_alter_actions("trade_decisions", validation_actions)


def _usage_index_is_current() -> bool | None:
    value = (
        op.get_bind()
        .execute(
            sa.text(
                """
                SELECT COALESCE((
                    indisvalid
                    AND indisready
                    AND NOT indisunique
                    AND indnkeyatts = 3
                    AND pg_get_indexdef(indexrelid, 1, true) = 'strategy_id'
                    AND pg_get_indexdef(indexrelid, 2, true) = 'alpaca_account_label'
                    AND pg_get_indexdef(indexrelid, 3, true) =
                        'strategy_capital_authority_evaluated_at'
                    AND pg_get_expr(indpred, indrelid) =
                        '(strategy_capital_authority_allowed IS TRUE)'
                ), false) AS is_current
                FROM pg_index
                WHERE indexrelid = to_regclass(:index_name)
                """
            ),
            {"index_name": _USAGE_INDEX},
        )
        .scalar_one_or_none()
    )
    if value is None:
        return None
    return bool(value)


def _create_usage_index() -> None:
    state = _usage_index_is_current()
    if state is True:
        return
    if state is False:
        op.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {_USAGE_INDEX}"))
    op.execute(
        sa.text(
            f"""
            CREATE INDEX CONCURRENTLY IF NOT EXISTS {_USAGE_INDEX}
            ON trade_decisions (
                strategy_id,
                alpaca_account_label,
                strategy_capital_authority_evaluated_at
            )
            WHERE strategy_capital_authority_allowed IS TRUE
            """
        )
    )
    if _usage_index_is_current() is not True:
        raise RuntimeError(f"{_USAGE_INDEX} was not created as a valid index")


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(sa.text("SET lock_timeout = '5s'"))
        op.execute(sa.text("SET statement_timeout = '30min'"))
        try:
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
            _create_usage_index()
        finally:
            op.execute(sa.text("RESET statement_timeout"))
            op.execute(sa.text("RESET lock_timeout"))


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
        conv(_STRATEGY_AUTHORITY_FK),
        "strategies",
        type_="foreignkey",
    )
    op.drop_column("strategies", "active_capital_authority_id")
    op.drop_index(
        _USAGE_INDEX,
        table_name="trade_decisions",
    )
    op.drop_constraint(
        conv(_DECISION_AUTHORITY_FK),
        "trade_decisions",
        type_="foreignkey",
    )
    for constraint, _condition in reversed(_DECISION_CHECKS):
        op.drop_constraint(conv(constraint), "trade_decisions", type_="check")
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

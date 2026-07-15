"""Align the paper lifecycle bound with Alpaca's enforced cost-basis floor.

Revision ID: 0073_live_paper_bounds
Revises: 0072_validation_lifecycle
Create Date: 2026-07-15 20:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.schema import conv


revision = "0073_live_paper_bounds"
down_revision = "0072_validation_lifecycle"
branch_labels = None
depends_on = None


_CONSTRAINT = "ck_bm_receipt_validation_authority"
_OLD_CAP = 5
_NEW_CAP = 30
_LIFECYCLE_SCHEMA = "torghut.infrastructure-validation-lifecycle-plan.v1"


def _cap_fragment(field: str, cap: int) -> str:
    return (
        "((canonical_intent_json::jsonb #>> "
        f"'{{request,infrastructure_validation,permit,{field}}}'::text[])::numeric) "
        f"<= {cap}::numeric"
    )


def _replace_lifecycle_cap(definition: str, *, old_cap: int, new_cap: int) -> str:
    prefix = "CHECK ("
    if not definition.startswith(prefix) or not definition.endswith(")"):
        raise RuntimeError("validation_authority_constraint_shape_invalid")
    condition = definition[len(prefix) : -1]
    if condition.count(_LIFECYCLE_SCHEMA) != 1:
        raise RuntimeError("validation_authority_lifecycle_schema_invalid")
    for field in ("max_notional_usd", "max_loss_usd"):
        old_fragment = _cap_fragment(field, old_cap)
        if condition.count(old_fragment) != 1:
            raise RuntimeError(f"validation_authority_{field}_cap_invalid")
        condition = condition.replace(
            old_fragment,
            _cap_fragment(field, new_cap),
            1,
        )
    return condition


def _current_constraint_definition() -> str:
    definition = (
        op.get_bind()
        .execute(
            sa.text(
                """
            SELECT pg_get_constraintdef(oid, true)
              FROM pg_constraint
             WHERE conrelid = 'broker_mutation_receipts'::regclass
               AND conname = :constraint_name
            """
            ),
            {"constraint_name": _CONSTRAINT},
        )
        .scalar_one_or_none()
    )
    if not isinstance(definition, str):
        raise RuntimeError("validation_authority_constraint_missing")
    return definition


def _install_constraint(condition: str) -> None:
    op.drop_constraint(conv(_CONSTRAINT), "broker_mutation_receipts", type_="check")
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              ADD CONSTRAINT {_CONSTRAINT} CHECK ({condition}) NOT VALID
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              VALIDATE CONSTRAINT {_CONSTRAINT}
            """
        )
    )


def upgrade() -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    condition = _replace_lifecycle_cap(
        _current_constraint_definition(),
        old_cap=_OLD_CAP,
        new_cap=_NEW_CAP,
    )
    _install_constraint(condition)


def downgrade() -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    op.execute(
        sa.text(
            f"""
            DO $torghut$
            BEGIN
                IF EXISTS (
                    SELECT 1
                      FROM broker_mutation_receipts
                     WHERE purpose = 'control_plane_validation'
                       AND canonical_intent_json::jsonb #>>
                           '{{request,infrastructure_validation,test_plan,schema_version}}' =
                           '{_LIFECYCLE_SCHEMA}'
                       AND (
                           (canonical_intent_json::jsonb #>>
                            '{{request,infrastructure_validation,permit,max_notional_usd}}')::numeric
                           > {_OLD_CAP}
                           OR
                           (canonical_intent_json::jsonb #>>
                            '{{request,infrastructure_validation,permit,max_loss_usd}}')::numeric
                           > {_OLD_CAP}
                       )
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with lifecycle receipts above the old cap';
                END IF;
            END
            $torghut$;
            """
        )
    )
    condition = _replace_lifecycle_cap(
        _current_constraint_definition(),
        old_cap=_NEW_CAP,
        new_cap=_OLD_CAP,
    )
    _install_constraint(condition)

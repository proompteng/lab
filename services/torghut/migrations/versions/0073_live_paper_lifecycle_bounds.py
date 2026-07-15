"""Align the paper lifecycle bound with Alpaca's enforced cost-basis floor.

Revision ID: 0073_live_paper_bounds
Revises: 0072_validation_lifecycle
Create Date: 2026-07-15 20:00:00.000000
"""

from __future__ import annotations

import re

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
_MIN_LEG_NOTIONAL = 12
_LEGACY_LIFECYCLE_SCHEMA = "torghut.infrastructure-validation-lifecycle-plan.v1"
_LIFECYCLE_SCHEMA = "torghut.infrastructure-validation-lifecycle-plan.v2"
_LINEAGE_FUNCTION = "torghut_guard_bm_validation_lineage_0072"
_LINEAGE_SCHEMA_GUARD_COUNT = 3
_LEGACY_ROOT_FUNCTION = "torghut_reject_bm_validation_lifecycle_v1_0073"
_LEGACY_ROOT_TRIGGER = "trg_reject_bm_validation_lifecycle_v1_0073"
_LEGACY_ROOT_RETIREMENT_ERROR = (
    "infrastructure validation lifecycle v1 receipts are read-only"
)


def _numeric_plan_field(field: str) -> str:
    return (
        "((canonical_intent_json::jsonb #>> "
        f"'{{request,infrastructure_validation,test_plan,{field}}}'::text[])::numeric)"
    )


def _numeric_permit_field(field: str) -> str:
    return (
        "((canonical_intent_json::jsonb #>> "
        f"'{{request,infrastructure_validation,permit,{field}}}'::text[])::numeric)"
    )


def _plan_schema_value() -> str:
    return (
        "canonical_intent_json::jsonb #>> "
        "'{request,infrastructure_validation,test_plan,schema_version}'::text[]"
    )


def _plan_schema_field() -> str:
    return f"({_plan_schema_value()})"


def _cap_fragment(field: str, cap: int) -> str:
    return f"{_numeric_permit_field(field)} <= {cap}::numeric"


def _versioned_cap_fragment(field: str) -> str:
    return (
        f"{_numeric_permit_field(field)} <=\n"
        f"CASE {_plan_schema_value()}\n"
        f"    WHEN '{_LEGACY_LIFECYCLE_SCHEMA}'::text THEN {_OLD_CAP}::numeric\n"
        f"    WHEN '{_LIFECYCLE_SCHEMA}'::text THEN {_NEW_CAP}::numeric\n"
        "    ELSE NULL::numeric\n"
        "END"
    )


def _partial_close_bound_fragment() -> str:
    return f"{_numeric_plan_field('partial_close_qty')} < {_numeric_plan_field('qty')}"


def _resting_close_bound_fragment() -> str:
    return (
        f"{_numeric_plan_field('resting_close_limit_price')} > "
        f"{_numeric_plan_field('limit_price')}"
    )


def _leg_floor_fragments() -> tuple[str, str]:
    limit_price = _numeric_plan_field("limit_price")
    partial_close = _numeric_plan_field("partial_close_qty")
    residual_close = (
        f"({_numeric_plan_field('qty')} - {_numeric_plan_field('partial_close_qty')})"
    )
    return (
        f"({partial_close} * {limit_price}) >= {_MIN_LEG_NOTIONAL}::numeric",
        f"({residual_close} * {limit_price}) >= {_MIN_LEG_NOTIONAL}::numeric",
    )


def _schema_predicate(schema: str) -> str:
    return f"{_plan_schema_field()} = '{schema}'::text"


def _schema_pair_predicate() -> str:
    return (
        f"{_plan_schema_field()} = ANY (ARRAY["
        f"'{_LEGACY_LIFECYCLE_SCHEMA}'::text, '{_LIFECYCLE_SCHEMA}'::text])"
    )


def _floor_guard_fragment() -> str:
    return (
        f"{_plan_schema_field()} <> '{_LIFECYCLE_SCHEMA}'::text OR ("
        f"{' AND '.join(_leg_floor_fragments())})"
    )


def _rewrite_lifecycle_authority(
    definition: str,
    *,
    upgrade: bool,
) -> str:
    prefix = "CHECK ("
    if not definition.startswith(prefix) or not definition.endswith(")"):
        raise RuntimeError("validation_authority_constraint_shape_invalid")
    condition = definition[len(prefix) : -1]
    partial_bound = _partial_close_bound_fragment()
    bounded_floor_clause = f"{partial_bound} AND ({_floor_guard_fragment()})"
    if upgrade:
        legacy_schema = _schema_predicate(_LEGACY_LIFECYCLE_SCHEMA)
        if condition.count(legacy_schema) != 1 or _LIFECYCLE_SCHEMA in condition:
            raise RuntimeError("validation_authority_lifecycle_schema_invalid")
        condition = condition.replace(legacy_schema, _schema_pair_predicate(), 1)
        for field in ("max_notional_usd", "max_loss_usd"):
            legacy_cap = _cap_fragment(field, _OLD_CAP)
            if condition.count(legacy_cap) != 1:
                raise RuntimeError(f"validation_authority_{field}_cap_invalid")
            condition = condition.replace(
                legacy_cap,
                _versioned_cap_fragment(field),
                1,
            )
        if condition.count(partial_bound) != 1 or any(
            fragment in condition for fragment in _leg_floor_fragments()
        ):
            raise RuntimeError("validation_authority_leg_floor_shape_invalid")
        condition = condition.replace(
            partial_bound,
            bounded_floor_clause,
            1,
        )
    else:
        if condition.count(_schema_pair_predicate()) != 1:
            raise RuntimeError("validation_authority_lifecycle_schema_invalid")
        condition = condition.replace(
            _schema_pair_predicate(),
            _schema_predicate(_LEGACY_LIFECYCLE_SCHEMA),
            1,
        )
        for field in ("max_notional_usd", "max_loss_usd"):
            versioned_cap = _versioned_cap_fragment(field)
            if condition.count(versioned_cap) != 1:
                raise RuntimeError(f"validation_authority_{field}_cap_invalid")
            condition = condition.replace(
                versioned_cap,
                _cap_fragment(field, _OLD_CAP),
                1,
            )
        floor_guard_start = (
            f" AND ({_plan_schema_field()} <> '{_LIFECYCLE_SCHEMA}'::text OR "
        )
        floor_guard_end = f" AND {_resting_close_bound_fragment()}"
        if condition.count(floor_guard_start) != 1:
            raise RuntimeError("validation_authority_leg_floor_shape_invalid")
        start = condition.index(floor_guard_start)
        end = condition.find(floor_guard_end, start)
        if end < 0:
            raise RuntimeError("validation_authority_leg_floor_shape_invalid")
        floor_guard = condition[start:end]
        if (
            floor_guard.count(f">= {_MIN_LEG_NOTIONAL}::numeric") != 2
            or "partial_close_qty" not in floor_guard
            or "limit_price" not in floor_guard
        ):
            raise RuntimeError("validation_authority_leg_floor_shape_invalid")
        condition = f"{condition[:start]}{condition[end:]}"
    return condition


def _rewrite_lineage_function(definition: str, *, upgrade: bool) -> str:
    legacy_guard = (
        r"root_plan_schema\s+IS\s+DISTINCT\s+FROM\s+"
        f"'{re.escape(_LEGACY_LIFECYCLE_SCHEMA)}'"
    )
    versioned_guard = (
        r"\(\s*root_plan_schema\s+IS\s+DISTINCT\s+FROM\s+"
        rf"'{re.escape(_LEGACY_LIFECYCLE_SCHEMA)}'\s+AND\s+"
        r"root_plan_schema\s+IS\s+DISTINCT\s+FROM\s+"
        rf"'{re.escape(_LIFECYCLE_SCHEMA)}'\s*\)"
    )
    old_guard, new_guard = (
        (
            legacy_guard,
            "(root_plan_schema IS DISTINCT FROM "
            f"'{_LEGACY_LIFECYCLE_SCHEMA}' AND "
            "root_plan_schema IS DISTINCT FROM "
            f"'{_LIFECYCLE_SCHEMA}')",
        )
        if upgrade
        else (
            versioned_guard,
            f"root_plan_schema IS DISTINCT FROM '{_LEGACY_LIFECYCLE_SCHEMA}'",
        )
    )
    rewritten, count = re.subn(old_guard, new_guard, definition)
    if count != _LINEAGE_SCHEMA_GUARD_COUNT:
        raise RuntimeError("validation_lineage_function_schema_invalid")
    return rewritten


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


def _current_lineage_function_definition() -> str:
    definition = (
        op.get_bind()
        .execute(
            sa.text("SELECT pg_get_functiondef(to_regprocedure(:signature))"),
            {"signature": f"{_LINEAGE_FUNCTION}()"},
        )
        .scalar_one_or_none()
    )
    if not isinstance(definition, str):
        raise RuntimeError("validation_lineage_function_missing")
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


def _install_lineage_function(definition: str) -> None:
    op.execute(sa.text(definition))


def _install_legacy_root_retirement_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_LEGACY_ROOT_FUNCTION}() RETURNS trigger AS $torghut$
            BEGIN
                RAISE EXCEPTION '{_LEGACY_ROOT_RETIREMENT_ERROR}'
                    USING ERRCODE = '23514';
            END;
            $torghut$ LANGUAGE plpgsql
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {_LEGACY_ROOT_TRIGGER}
            BEFORE INSERT ON broker_mutation_receipts
            FOR EACH ROW
            WHEN ((NEW.canonical_intent_json::jsonb #>>
                '{{request,infrastructure_validation,test_plan,schema_version}}') =
                '{_LEGACY_LIFECYCLE_SCHEMA}')
            EXECUTE FUNCTION {_LEGACY_ROOT_FUNCTION}()
            """
        )
    )


def _remove_legacy_root_retirement_guard() -> None:
    op.execute(
        sa.text(f"DROP TRIGGER {_LEGACY_ROOT_TRIGGER} ON broker_mutation_receipts")
    )
    op.execute(sa.text(f"DROP FUNCTION {_LEGACY_ROOT_FUNCTION}()"))


def upgrade() -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    condition = _rewrite_lifecycle_authority(
        _current_constraint_definition(), upgrade=True
    )
    lineage_function = _rewrite_lineage_function(
        _current_lineage_function_definition(), upgrade=True
    )
    _install_constraint(condition)
    _install_lineage_function(lineage_function)
    _install_legacy_root_retirement_guard()


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
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with lifecycle v2 receipts';
                END IF;
            END
            $torghut$;
            """
        )
    )
    condition = _rewrite_lifecycle_authority(
        _current_constraint_definition(), upgrade=False
    )
    lineage_function = _rewrite_lineage_function(
        _current_lineage_function_definition(), upgrade=False
    )
    _remove_legacy_root_retirement_guard()
    _install_constraint(condition)
    _install_lineage_function(lineage_function)

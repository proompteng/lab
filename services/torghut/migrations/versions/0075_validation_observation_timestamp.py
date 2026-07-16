"""Reject lifecycle reductions without an observation timestamp.

Revision ID: 0075_validation_observed_at
Revises: 0074_crypto_qty_precision
Create Date: 2026-07-16 00:30:00.000000
"""

from __future__ import annotations

import re

import sqlalchemy as sa
from alembic import op


revision = "0075_validation_observed_at"
down_revision = "0074_crypto_qty_precision"
branch_labels = None
depends_on = None


_LINEAGE_FUNCTION = "torghut_guard_bm_validation_lineage_0072"
_POSITION_GUARD = r"observed_position_qty\s+IS\s+DISTINCT\s+FROM\s+latest_position_qty"
_NULL_POSITION_GUARD = r"observed_at\s+IS\s+NULL\s+OR\s+" + _POSITION_GUARD


def _rewrite_lineage_function(definition: str, *, upgrade: bool) -> str:
    old_guard, new_guard = (
        (
            rf"IF\s+{_POSITION_GUARD}",
            "IF observed_at IS NULL\n"
            "                   OR observed_position_qty IS DISTINCT FROM "
            "latest_position_qty",
        )
        if upgrade
        else (
            rf"IF\s+{_NULL_POSITION_GUARD}",
            "IF observed_position_qty IS DISTINCT FROM latest_position_qty",
        )
    )
    rewritten, count = re.subn(old_guard, new_guard, definition, count=1)
    if count != 1:
        raise RuntimeError("validation_observation_timestamp_guard_shape_invalid")
    return rewritten


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


def _install_lineage_function(definition: str) -> None:
    op.execute(sa.text(definition))


def _rewrite_live_function(*, upgrade: bool) -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    _install_lineage_function(
        _rewrite_lineage_function(
            _current_lineage_function_definition(),
            upgrade=upgrade,
        )
    )


def upgrade() -> None:
    _rewrite_live_function(upgrade=True)


def downgrade() -> None:
    _rewrite_live_function(upgrade=False)

"""Add order-feed fill delta basis fields."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0040_order_feed_fill_delta_basis"
down_revision = "0039_tigerbeetle_real_flow_refs"
branch_labels = None
depends_on = None


def _column_names(table_name: str) -> set[str]:
    inspector = inspect(op.get_bind())
    if not inspector.has_table(table_name):
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    columns = _column_names("execution_order_events")
    if not columns:
        return

    if "filled_qty_delta" not in columns:
        op.add_column(
            "execution_order_events",
            sa.Column("filled_qty_delta", sa.Numeric(20, 8), nullable=True),
        )
    if "filled_notional_delta" not in columns:
        op.add_column(
            "execution_order_events",
            sa.Column("filled_notional_delta", sa.Numeric(20, 8), nullable=True),
        )
    if "fill_quantity_basis" not in columns:
        op.add_column(
            "execution_order_events",
            sa.Column("fill_quantity_basis", sa.String(length=32), nullable=True),
        )

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_order_events TO torghut_app;"
    )


def downgrade() -> None:
    columns = _column_names("execution_order_events")
    if not columns:
        return

    for column_name in (
        "fill_quantity_basis",
        "filled_notional_delta",
        "filled_qty_delta",
    ):
        if column_name in columns:
            op.drop_column("execution_order_events", column_name)

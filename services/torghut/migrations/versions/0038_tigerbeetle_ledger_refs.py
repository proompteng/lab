"""Add TigerBeetle ledger reference tables."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


revision = "0038_tigerbeetle_ledger_refs"
down_revision = "0037_order_feed_source_windows"
branch_labels = None
depends_on = None


def _index_names(table_name: str) -> set[str]:
    inspector = inspect(op.get_bind())
    return {index["name"] for index in inspector.get_indexes(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if not inspector.has_table("tigerbeetle_account_refs"):
        op.create_table(
            "tigerbeetle_account_refs",
            sa.Column(
                "id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False
            ),
            sa.Column("cluster_id", sa.BigInteger(), nullable=False),
            sa.Column("account_id", sa.String(length=39), nullable=False),
            sa.Column("account_key", sa.String(length=255), nullable=False),
            sa.Column("ledger", sa.BigInteger(), nullable=False),
            sa.Column("code", sa.BigInteger(), nullable=False),
            sa.Column("account_label", sa.String(length=64), nullable=True),
            sa.Column("symbol", sa.String(length=64), nullable=True),
            sa.Column("strategy_id", sa.String(length=128), nullable=True),
            sa.Column("payload_json", postgresql.JSONB(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.UniqueConstraint(
                "cluster_id",
                "account_id",
                name="uq_tigerbeetle_account_refs_cluster_account_id",
            ),
            sa.UniqueConstraint(
                "cluster_id",
                "account_key",
                name="uq_tigerbeetle_account_refs_cluster_account_key",
            ),
        )
        op.create_index(
            "ix_tigerbeetle_account_refs_account_label",
            "tigerbeetle_account_refs",
            ["account_label"],
        )
        op.create_index(
            "ix_tigerbeetle_account_refs_symbol",
            "tigerbeetle_account_refs",
            ["symbol"],
        )

    if not inspector.has_table("tigerbeetle_transfer_refs"):
        op.create_table(
            "tigerbeetle_transfer_refs",
            sa.Column(
                "id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False
            ),
            sa.Column("cluster_id", sa.BigInteger(), nullable=False),
            sa.Column("transfer_id", sa.String(length=39), nullable=False),
            sa.Column("transfer_kind", sa.String(length=64), nullable=False),
            sa.Column("ledger", sa.BigInteger(), nullable=False),
            sa.Column("code", sa.BigInteger(), nullable=False),
            sa.Column("amount", sa.Numeric(39, 0), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("result_code", sa.String(length=64), nullable=True),
            sa.Column(
                "trade_decision_id", postgresql.UUID(as_uuid=True), nullable=True
            ),
            sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column(
                "execution_order_event_id",
                postgresql.UUID(as_uuid=True),
                nullable=True,
            ),
            sa.Column("event_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("payload_json", postgresql.JSONB(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["trade_decision_id"], ["trade_decisions.id"], ondelete="SET NULL"
            ),
            sa.ForeignKeyConstraint(
                ["execution_id"], ["executions.id"], ondelete="SET NULL"
            ),
            sa.ForeignKeyConstraint(
                ["execution_order_event_id"],
                ["execution_order_events.id"],
                ondelete="SET NULL",
            ),
            sa.UniqueConstraint(
                "cluster_id",
                "transfer_id",
                name="uq_tigerbeetle_transfer_refs_cluster_transfer_id",
            ),
            sa.UniqueConstraint(
                "cluster_id",
                "event_fingerprint",
                "transfer_kind",
                name="uq_tigerbeetle_transfer_refs_cluster_event_kind",
            ),
        )
        for index_name, columns in (
            ("ix_tigerbeetle_transfer_refs_status", ["status"]),
            (
                "ix_tigerbeetle_transfer_refs_trade_decision_id",
                ["trade_decision_id"],
            ),
            ("ix_tigerbeetle_transfer_refs_execution_id", ["execution_id"]),
            (
                "ix_tigerbeetle_transfer_refs_execution_order_event_id",
                ["execution_order_event_id"],
            ),
        ):
            op.create_index(index_name, "tigerbeetle_transfer_refs", columns)

    if not inspector.has_table("tigerbeetle_reconciliation_runs"):
        op.create_table(
            "tigerbeetle_reconciliation_runs",
            sa.Column(
                "id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False
            ),
            sa.Column("cluster_id", sa.BigInteger(), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column(
                "checked_transfer_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "missing_transfer_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "mismatched_transfer_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column("payload_json", postgresql.JSONB(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
        )
        for index_name, columns in (
            ("ix_tigerbeetle_reconciliation_runs_cluster_id", ["cluster_id"]),
            ("ix_tigerbeetle_reconciliation_runs_status", ["status"]),
            ("ix_tigerbeetle_reconciliation_runs_started_at", ["started_at"]),
        ):
            op.create_index(index_name, "tigerbeetle_reconciliation_runs", columns)

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tigerbeetle_account_refs TO torghut_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tigerbeetle_transfer_refs TO torghut_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tigerbeetle_reconciliation_runs TO torghut_app;"
    )


def downgrade() -> None:
    inspector = inspect(op.get_bind())

    if inspector.has_table("tigerbeetle_reconciliation_runs"):
        for index_name in _index_names("tigerbeetle_reconciliation_runs"):
            if index_name.startswith("ix_tigerbeetle_reconciliation_runs_"):
                op.drop_index(index_name, table_name="tigerbeetle_reconciliation_runs")
        op.drop_table("tigerbeetle_reconciliation_runs")

    if inspector.has_table("tigerbeetle_transfer_refs"):
        for index_name in _index_names("tigerbeetle_transfer_refs"):
            if index_name.startswith("ix_tigerbeetle_transfer_refs_"):
                op.drop_index(index_name, table_name="tigerbeetle_transfer_refs")
        op.drop_table("tigerbeetle_transfer_refs")

    if inspector.has_table("tigerbeetle_account_refs"):
        for index_name in _index_names("tigerbeetle_account_refs"):
            if index_name.startswith("ix_tigerbeetle_account_refs_"):
                op.drop_index(index_name, table_name="tigerbeetle_account_refs")
        op.drop_table("tigerbeetle_account_refs")

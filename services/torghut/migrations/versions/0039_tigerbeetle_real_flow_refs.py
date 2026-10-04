"""Add source-backed TigerBeetle ledger ref columns."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


revision = "0039_tigerbeetle_real_flow_refs"
down_revision = "0038_tigerbeetle_ledger_refs"
branch_labels = None
depends_on = None


def _column_names(table_name: str) -> set[str]:
    inspector = inspect(op.get_bind())
    if not inspector.has_table(table_name):
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def _index_names(table_name: str) -> set[str]:
    inspector = inspect(op.get_bind())
    if not inspector.has_table(table_name):
        return set()
    return {index["name"] for index in inspector.get_indexes(table_name)}


def _unique_constraint_names(table_name: str) -> set[str]:
    inspector = inspect(op.get_bind())
    if not inspector.has_table(table_name):
        return set()
    return {
        constraint["name"]
        for constraint in inspector.get_unique_constraints(table_name)
    }


def _foreign_key_names(table_name: str) -> set[str]:
    inspector = inspect(op.get_bind())
    if not inspector.has_table(table_name):
        return set()
    return {constraint["name"] for constraint in inspector.get_foreign_keys(table_name)}


def upgrade() -> None:
    inspector = inspect(op.get_bind())
    if not inspector.has_table("tigerbeetle_transfer_refs"):
        return

    columns = _column_names("tigerbeetle_transfer_refs")
    if "execution_tca_metric_id" not in columns:
        op.add_column(
            "tigerbeetle_transfer_refs",
            sa.Column(
                "execution_tca_metric_id", postgresql.UUID(as_uuid=True), nullable=True
            ),
        )
    if "runtime_ledger_bucket_id" not in columns:
        op.add_column(
            "tigerbeetle_transfer_refs",
            sa.Column(
                "runtime_ledger_bucket_id", postgresql.UUID(as_uuid=True), nullable=True
            ),
        )
    if "source_type" not in columns:
        op.add_column(
            "tigerbeetle_transfer_refs",
            sa.Column("source_type", sa.String(length=64), nullable=True),
        )
    if "source_id" not in columns:
        op.add_column(
            "tigerbeetle_transfer_refs",
            sa.Column("source_id", sa.String(length=128), nullable=True),
        )

    foreign_keys = _foreign_key_names("tigerbeetle_transfer_refs")
    if "fk_tigerbeetle_transfer_refs_execution_tca_metric_id" not in foreign_keys:
        op.create_foreign_key(
            "fk_tigerbeetle_transfer_refs_execution_tca_metric_id",
            "tigerbeetle_transfer_refs",
            "execution_tca_metrics",
            ["execution_tca_metric_id"],
            ["id"],
            ondelete="SET NULL",
        )
    if "fk_tigerbeetle_transfer_refs_runtime_ledger_bucket_id" not in foreign_keys:
        op.create_foreign_key(
            "fk_tigerbeetle_transfer_refs_runtime_ledger_bucket_id",
            "tigerbeetle_transfer_refs",
            "strategy_runtime_ledger_buckets",
            ["runtime_ledger_bucket_id"],
            ["id"],
            ondelete="SET NULL",
        )

    unique_constraints = _unique_constraint_names("tigerbeetle_transfer_refs")
    if "uq_tigerbeetle_transfer_refs_cluster_source_kind" not in unique_constraints:
        op.create_unique_constraint(
            "uq_tigerbeetle_transfer_refs_cluster_source_kind",
            "tigerbeetle_transfer_refs",
            ["cluster_id", "source_type", "source_id", "transfer_kind"],
        )

    indexes = _index_names("tigerbeetle_transfer_refs")
    for index_name, columns_ in (
        (
            "ix_tigerbeetle_transfer_refs_source",
            ["cluster_id", "source_type", "source_id"],
        ),
        (
            "ix_tigerbeetle_transfer_refs_execution_tca_metric_id",
            ["execution_tca_metric_id"],
        ),
        (
            "ix_tigerbeetle_transfer_refs_runtime_ledger_bucket_id",
            ["runtime_ledger_bucket_id"],
        ),
    ):
        if index_name not in indexes:
            op.create_index(index_name, "tigerbeetle_transfer_refs", columns_)

    if inspector.has_table("tigerbeetle_reconciliation_runs"):
        reconciliation_columns = _column_names("tigerbeetle_reconciliation_runs")
        if "source_missing_count" not in reconciliation_columns:
            op.add_column(
                "tigerbeetle_reconciliation_runs",
                sa.Column(
                    "source_missing_count",
                    sa.BigInteger(),
                    server_default=sa.text("0"),
                    nullable=False,
                ),
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
        columns = _column_names("tigerbeetle_reconciliation_runs")
        if "source_missing_count" in columns:
            op.drop_column("tigerbeetle_reconciliation_runs", "source_missing_count")

    if not inspector.has_table("tigerbeetle_transfer_refs"):
        return

    indexes = _index_names("tigerbeetle_transfer_refs")
    for index_name in (
        "ix_tigerbeetle_transfer_refs_runtime_ledger_bucket_id",
        "ix_tigerbeetle_transfer_refs_execution_tca_metric_id",
        "ix_tigerbeetle_transfer_refs_source",
    ):
        if index_name in indexes:
            op.drop_index(index_name, table_name="tigerbeetle_transfer_refs")

    unique_constraints = _unique_constraint_names("tigerbeetle_transfer_refs")
    if "uq_tigerbeetle_transfer_refs_cluster_source_kind" in unique_constraints:
        op.drop_constraint(
            "uq_tigerbeetle_transfer_refs_cluster_source_kind",
            "tigerbeetle_transfer_refs",
            type_="unique",
        )

    foreign_keys = _foreign_key_names("tigerbeetle_transfer_refs")
    for constraint_name in (
        "fk_tigerbeetle_transfer_refs_runtime_ledger_bucket_id",
        "fk_tigerbeetle_transfer_refs_execution_tca_metric_id",
    ):
        if constraint_name in foreign_keys:
            op.drop_constraint(
                constraint_name,
                "tigerbeetle_transfer_refs",
                type_="foreignkey",
            )

    columns = _column_names("tigerbeetle_transfer_refs")
    for column_name in (
        "source_id",
        "source_type",
        "runtime_ledger_bucket_id",
        "execution_tca_metric_id",
    ):
        if column_name in columns:
            op.drop_column("tigerbeetle_transfer_refs", column_name)

"""Add persistent hypothesis governance tables for doc29 live evidence gates."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = "0021_strategy_hypothesis_governance"
down_revision = "0020_vnext_completion_gate_results"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def _inspector() -> sa.Inspector[sa.engine.Connection]:
    return inspect(op.get_bind())


def _table_exists(inspector: sa.Inspector[sa.engine.Connection], table_name: str) -> bool:
    return inspector.has_table(table_name)


def _index_names(inspector: sa.Inspector[sa.engine.Connection], table_name: str) -> set[str]:
    if not _table_exists(inspector, table_name):
        return set()
    return {
        str(index.get("name"))
        for index in inspector.get_indexes(table_name)
        if index.get("name")
    }


def _create_index_if_missing(
    inspector: sa.Inspector[sa.engine.Connection],
    name: str,
    table_name: str,
    columns: list[str],
    *,
    unique: bool = False,
) -> None:
    if name in _index_names(inspector, table_name):
        return
    op.create_index(name, table_name, columns, unique=unique)


def _drop_index_if_present(
    inspector: sa.Inspector[sa.engine.Connection],
    name: str,
    *,
    table_name: str,
) -> None:
    if name not in _index_names(inspector, table_name):
        return
    op.drop_index(name, table_name=table_name)


def _drop_table_if_present(
    inspector: sa.Inspector[sa.engine.Connection],
    table_name: str,
) -> None:
    if not _table_exists(inspector, table_name):
        return
    op.drop_table(table_name)


def upgrade() -> None:
    inspector = _inspector()

    if not _table_exists(inspector, "strategy_hypotheses"):
        op.create_table(
            "strategy_hypotheses",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
            sa.Column("lane_id", sa.String(length=128), nullable=False),
            sa.Column("strategy_family", sa.String(length=128), nullable=False),
            sa.Column("source_manifest_ref", sa.String(length=255), nullable=True),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("payload_json", _json_type(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id", name="pk_strategy_hypotheses"),
            sa.UniqueConstraint("hypothesis_id", name="uq_strategy_hypotheses_hypothesis_id"),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypotheses_hypothesis_id",
        "strategy_hypotheses",
        ["hypothesis_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypotheses_strategy_family",
        "strategy_hypotheses",
        ["strategy_family"],
    )

    if not _table_exists(inspector, "strategy_hypothesis_versions"):
        op.create_table(
            "strategy_hypothesis_versions",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
            sa.Column("version_key", sa.String(length=128), nullable=False),
            sa.Column("source_manifest_ref", sa.String(length=255), nullable=True),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("payload_json", _json_type(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id", name="pk_strategy_hypothesis_versions"),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypothesis_versions_hypothesis_id",
        "strategy_hypothesis_versions",
        ["hypothesis_id"],
    )
    _create_index_if_missing(
        inspector,
        "uq_strategy_hypothesis_versions_hypothesis_version",
        "strategy_hypothesis_versions",
        ["hypothesis_id", "version_key"],
        unique=True,
    )

    if not _table_exists(inspector, "strategy_hypothesis_metric_windows"):
        op.create_table(
            "strategy_hypothesis_metric_windows",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=True),
            sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
            sa.Column("observed_stage", sa.String(length=32), nullable=False),
            sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("window_ended_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("market_session_count", sa.BigInteger(), nullable=False, server_default=sa.text("1")),
            sa.Column("decision_count", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("trade_count", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("order_count", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("evidence_provenance", sa.String(length=64), nullable=True),
            sa.Column("evidence_maturity", sa.String(length=64), nullable=True),
            sa.Column("decision_alignment_ratio", sa.String(length=64), nullable=True),
            sa.Column("avg_abs_slippage_bps", sa.String(length=64), nullable=True),
            sa.Column("slippage_budget_bps", sa.String(length=64), nullable=True),
            sa.Column("post_cost_expectancy_bps", sa.String(length=64), nullable=True),
            sa.Column("continuity_ok", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("drift_ok", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("dependency_quorum_decision", sa.String(length=32), nullable=True),
            sa.Column("capital_stage", sa.String(length=32), nullable=True),
            sa.Column("payload_json", _json_type(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id", name="pk_strategy_hypothesis_metric_windows"),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypothesis_metric_windows_run_id",
        "strategy_hypothesis_metric_windows",
        ["run_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypothesis_metric_windows_candidate_id",
        "strategy_hypothesis_metric_windows",
        ["candidate_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypothesis_metric_windows_hypothesis_id",
        "strategy_hypothesis_metric_windows",
        ["hypothesis_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_hypothesis_metric_windows_observed_stage",
        "strategy_hypothesis_metric_windows",
        ["observed_stage"],
    )

    if not _table_exists(inspector, "strategy_capital_allocations"):
        op.create_table(
            "strategy_capital_allocations",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=True),
            sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
            sa.Column("prior_stage", sa.String(length=32), nullable=True),
            sa.Column("stage", sa.String(length=32), nullable=False),
            sa.Column("capital_multiplier", sa.String(length=64), nullable=True),
            sa.Column("rollback_target_stage", sa.String(length=32), nullable=True),
            sa.Column("payload_json", _json_type(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id", name="pk_strategy_capital_allocations"),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_strategy_capital_allocations_run_id",
        "strategy_capital_allocations",
        ["run_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_capital_allocations_candidate_id",
        "strategy_capital_allocations",
        ["candidate_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_capital_allocations_hypothesis_id",
        "strategy_capital_allocations",
        ["hypothesis_id"],
    )

    if not _table_exists(inspector, "strategy_promotion_decisions"):
        op.create_table(
            "strategy_promotion_decisions",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=True),
            sa.Column("hypothesis_id", sa.String(length=128), nullable=False),
            sa.Column("promotion_target", sa.String(length=16), nullable=False),
            sa.Column("state", sa.String(length=32), nullable=True),
            sa.Column("allowed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("reason_summary", sa.String(length=255), nullable=True),
            sa.Column("payload_json", _json_type(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id", name="pk_strategy_promotion_decisions"),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_strategy_promotion_decisions_run_id",
        "strategy_promotion_decisions",
        ["run_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_promotion_decisions_candidate_id",
        "strategy_promotion_decisions",
        ["candidate_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_strategy_promotion_decisions_hypothesis_id",
        "strategy_promotion_decisions",
        ["hypothesis_id"],
    )
    _create_index_if_missing(
        inspector,
        "uq_strategy_promotion_decisions_run_hypothesis_target",
        "strategy_promotion_decisions",
        ["run_id", "hypothesis_id", "promotion_target"],
        unique=True,
    )


def downgrade() -> None:
    inspector = _inspector()

    _drop_index_if_present(
        inspector,
        "uq_strategy_promotion_decisions_run_hypothesis_target",
        table_name="strategy_promotion_decisions",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_promotion_decisions_hypothesis_id",
        table_name="strategy_promotion_decisions",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_promotion_decisions_candidate_id",
        table_name="strategy_promotion_decisions",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_promotion_decisions_run_id",
        table_name="strategy_promotion_decisions",
    )
    _drop_table_if_present(inspector, "strategy_promotion_decisions")

    _drop_index_if_present(
        inspector,
        "ix_strategy_capital_allocations_hypothesis_id",
        table_name="strategy_capital_allocations",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_capital_allocations_candidate_id",
        table_name="strategy_capital_allocations",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_capital_allocations_run_id",
        table_name="strategy_capital_allocations",
    )
    _drop_table_if_present(inspector, "strategy_capital_allocations")

    _drop_index_if_present(
        inspector,
        "ix_strategy_hypothesis_metric_windows_observed_stage",
        table_name="strategy_hypothesis_metric_windows",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_hypothesis_metric_windows_hypothesis_id",
        table_name="strategy_hypothesis_metric_windows",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_hypothesis_metric_windows_candidate_id",
        table_name="strategy_hypothesis_metric_windows",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_hypothesis_metric_windows_run_id",
        table_name="strategy_hypothesis_metric_windows",
    )
    _drop_table_if_present(inspector, "strategy_hypothesis_metric_windows")

    _drop_index_if_present(
        inspector,
        "uq_strategy_hypothesis_versions_hypothesis_version",
        table_name="strategy_hypothesis_versions",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_hypothesis_versions_hypothesis_id",
        table_name="strategy_hypothesis_versions",
    )
    _drop_table_if_present(inspector, "strategy_hypothesis_versions")

    _drop_index_if_present(
        inspector,
        "ix_strategy_hypotheses_strategy_family",
        table_name="strategy_hypotheses",
    )
    _drop_index_if_present(
        inspector,
        "ix_strategy_hypotheses_hypothesis_id",
        table_name="strategy_hypotheses",
    )
    _drop_table_if_present(inspector, "strategy_hypotheses")

"""Add persistent hypothesis governance tables for doc29 live evidence gates."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0021_strategy_hypothesis_governance"
down_revision = "0020_vnext_completion_gate_results"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
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
    op.create_index("ix_strategy_hypotheses_hypothesis_id", "strategy_hypotheses", ["hypothesis_id"])
    op.create_index("ix_strategy_hypotheses_strategy_family", "strategy_hypotheses", ["strategy_family"])

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
    op.create_index(
        "ix_strategy_hypothesis_versions_hypothesis_id",
        "strategy_hypothesis_versions",
        ["hypothesis_id"],
    )
    op.create_index(
        "uq_strategy_hypothesis_versions_hypothesis_version",
        "strategy_hypothesis_versions",
        ["hypothesis_id", "version_key"],
        unique=True,
    )

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
    op.create_index(
        "ix_strategy_hypothesis_metric_windows_run_id",
        "strategy_hypothesis_metric_windows",
        ["run_id"],
    )
    op.create_index(
        "ix_strategy_hypothesis_metric_windows_candidate_id",
        "strategy_hypothesis_metric_windows",
        ["candidate_id"],
    )
    op.create_index(
        "ix_strategy_hypothesis_metric_windows_hypothesis_id",
        "strategy_hypothesis_metric_windows",
        ["hypothesis_id"],
    )
    op.create_index(
        "ix_strategy_hypothesis_metric_windows_observed_stage",
        "strategy_hypothesis_metric_windows",
        ["observed_stage"],
    )

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
    op.create_index("ix_strategy_capital_allocations_run_id", "strategy_capital_allocations", ["run_id"])
    op.create_index(
        "ix_strategy_capital_allocations_candidate_id",
        "strategy_capital_allocations",
        ["candidate_id"],
    )
    op.create_index(
        "ix_strategy_capital_allocations_hypothesis_id",
        "strategy_capital_allocations",
        ["hypothesis_id"],
    )

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
    op.create_index("ix_strategy_promotion_decisions_run_id", "strategy_promotion_decisions", ["run_id"])
    op.create_index(
        "ix_strategy_promotion_decisions_candidate_id",
        "strategy_promotion_decisions",
        ["candidate_id"],
    )
    op.create_index(
        "ix_strategy_promotion_decisions_hypothesis_id",
        "strategy_promotion_decisions",
        ["hypothesis_id"],
    )
    op.create_index(
        "uq_strategy_promotion_decisions_run_hypothesis_target",
        "strategy_promotion_decisions",
        ["run_id", "hypothesis_id", "promotion_target"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_strategy_promotion_decisions_run_hypothesis_target",
        table_name="strategy_promotion_decisions",
    )
    op.drop_index("ix_strategy_promotion_decisions_hypothesis_id", table_name="strategy_promotion_decisions")
    op.drop_index("ix_strategy_promotion_decisions_candidate_id", table_name="strategy_promotion_decisions")
    op.drop_index("ix_strategy_promotion_decisions_run_id", table_name="strategy_promotion_decisions")
    op.drop_table("strategy_promotion_decisions")

    op.drop_index("ix_strategy_capital_allocations_hypothesis_id", table_name="strategy_capital_allocations")
    op.drop_index("ix_strategy_capital_allocations_candidate_id", table_name="strategy_capital_allocations")
    op.drop_index("ix_strategy_capital_allocations_run_id", table_name="strategy_capital_allocations")
    op.drop_table("strategy_capital_allocations")

    op.drop_index(
        "ix_strategy_hypothesis_metric_windows_observed_stage",
        table_name="strategy_hypothesis_metric_windows",
    )
    op.drop_index(
        "ix_strategy_hypothesis_metric_windows_hypothesis_id",
        table_name="strategy_hypothesis_metric_windows",
    )
    op.drop_index(
        "ix_strategy_hypothesis_metric_windows_candidate_id",
        table_name="strategy_hypothesis_metric_windows",
    )
    op.drop_index(
        "ix_strategy_hypothesis_metric_windows_run_id",
        table_name="strategy_hypothesis_metric_windows",
    )
    op.drop_table("strategy_hypothesis_metric_windows")

    op.drop_index(
        "uq_strategy_hypothesis_versions_hypothesis_version",
        table_name="strategy_hypothesis_versions",
    )
    op.drop_index(
        "ix_strategy_hypothesis_versions_hypothesis_id",
        table_name="strategy_hypothesis_versions",
    )
    op.drop_table("strategy_hypothesis_versions")

    op.drop_index("ix_strategy_hypotheses_strategy_family", table_name="strategy_hypotheses")
    op.drop_index("ix_strategy_hypotheses_hypothesis_id", table_name="strategy_hypotheses")
    op.drop_table("strategy_hypotheses")

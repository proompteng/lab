"""Persist execution-route metadata and autonomous research ledger tables."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0006_autonomy_ledger_and_execution_route"
down_revision = "0005_trade_cursor_symbol"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    execution_columns = {column["name"] for column in inspector.get_columns("executions")}
    if "execution_expected_adapter" not in execution_columns:
        op.add_column(
            "executions",
            sa.Column("execution_expected_adapter", sa.String(length=32), nullable=True),
        )
    if "execution_actual_adapter" not in execution_columns:
        op.add_column(
            "executions",
            sa.Column("execution_actual_adapter", sa.String(length=32), nullable=True),
        )
    if "execution_fallback_reason" not in execution_columns:
        op.add_column(
            "executions",
            sa.Column("execution_fallback_reason", sa.String(length=128), nullable=True),
        )
    if "execution_fallback_count" not in execution_columns:
        op.add_column(
            "executions",
            sa.Column(
                "execution_fallback_count",
                sa.BigInteger(),
                nullable=False,
                server_default="0",
            ),
        )

    execution_indexes = {index["name"] for index in inspector.get_indexes("executions")}
    if "ix_executions_expected_adapter" not in execution_indexes:
        op.create_index("ix_executions_expected_adapter", "executions", ["execution_expected_adapter"])
    if "ix_executions_actual_adapter" not in execution_indexes:
        op.create_index("ix_executions_actual_adapter", "executions", ["execution_actual_adapter"])

    if not inspector.has_table("research_runs"):
        op.create_table(
            "research_runs",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("run_id", sa.String(length=64), nullable=False, unique=True),
            sa.Column(
                "status",
                sa.String(length=32),
                nullable=False,
                server_default=sa.text("'running'"),
            ),
            sa.Column("strategy_id", sa.String(length=64), nullable=True),
            sa.Column("strategy_name", sa.String(length=255), nullable=True),
            sa.Column("strategy_type", sa.String(length=128), nullable=True),
            sa.Column("strategy_version", sa.String(length=64), nullable=True),
            sa.Column("code_commit", sa.String(length=128), nullable=True),
            sa.Column("feature_version", sa.String(length=64), nullable=True),
            sa.Column("feature_schema_version", sa.String(length=64), nullable=True),
            sa.Column("feature_spec_hash", sa.String(length=128), nullable=True),
            sa.Column("signal_source", sa.String(length=128), nullable=True),
            sa.Column("dataset_version", sa.String(length=64), nullable=True),
            sa.Column("dataset_from", sa.DateTime(timezone=True), nullable=True),
            sa.Column("dataset_to", sa.DateTime(timezone=True), nullable=True),
            sa.Column("dataset_snapshot_ref", sa.String(length=255), nullable=True),
            sa.Column("runner_version", sa.String(length=64), nullable=True),
            sa.Column("runner_binary_hash", sa.String(length=128), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
        )
        op.create_index("ix_research_runs_status", "research_runs", ["status"])
        op.create_index("ix_research_runs_created_at", "research_runs", ["created_at"])

    if not inspector.has_table("research_candidates"):
        op.create_table(
            "research_candidates",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=False, unique=True),
            sa.Column("candidate_hash", sa.String(length=128), nullable=True),
            sa.Column("parameter_set", postgresql.JSONB(), nullable=True),
            sa.Column("decision_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("trade_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("symbols_covered", postgresql.JSONB(), nullable=True),
            sa.Column("universe_definition", postgresql.JSONB(), nullable=True),
            sa.Column("promotion_target", sa.String(length=16), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
        op.create_index("ix_research_candidates_run_id", "research_candidates", ["run_id"])
        op.create_index(
            "ix_research_candidates_candidate_id",
            "research_candidates",
            ["candidate_id"],
        )

    if not inspector.has_table("research_fold_metrics"):
        op.create_table(
            "research_fold_metrics",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=False),
            sa.Column("fold_name", sa.String(length=128), nullable=False),
            sa.Column("fold_order", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("train_start", sa.DateTime(timezone=True), nullable=False),
            sa.Column("train_end", sa.DateTime(timezone=True), nullable=False),
            sa.Column("test_start", sa.DateTime(timezone=True), nullable=False),
            sa.Column("test_end", sa.DateTime(timezone=True), nullable=False),
            sa.Column("decision_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("trade_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("gross_pnl", sa.Numeric(20, 8), nullable=True),
            sa.Column("net_pnl", sa.Numeric(20, 8), nullable=True),
            sa.Column("max_drawdown", sa.Numeric(20, 8), nullable=True),
            sa.Column("turnover_ratio", sa.Numeric(20, 8), nullable=True),
            sa.Column("cost_bps", sa.Numeric(20, 8), nullable=True),
            sa.Column("cost_assumptions", postgresql.JSONB(), nullable=True),
            sa.Column("regime_label", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
        op.create_index("ix_research_fold_metrics_candidate", "research_fold_metrics", ["candidate_id"])
        op.create_index("ix_research_fold_metrics_fold_order", "research_fold_metrics", ["fold_order"])

    if not inspector.has_table("research_stress_metrics"):
        op.create_table(
            "research_stress_metrics",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=False),
            sa.Column("stress_case", sa.String(length=64), nullable=False),
            sa.Column("metric_bundle", postgresql.JSONB(), nullable=True),
            sa.Column("pessimistic_pnl_delta", sa.Numeric(20, 8), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
        op.create_index("ix_research_stress_metrics_candidate", "research_stress_metrics", ["candidate_id"])
        op.create_index("ix_research_stress_metrics_case", "research_stress_metrics", ["stress_case"])

    if not inspector.has_table("research_promotions"):
        op.create_table(
            "research_promotions",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=False),
            sa.Column("requested_mode", sa.String(length=16), nullable=True),
            sa.Column("approved_mode", sa.String(length=16), nullable=True),
            sa.Column("approver", sa.String(length=128), nullable=True),
            sa.Column("approver_role", sa.String(length=64), nullable=True),
            sa.Column("approve_reason", sa.Text(), nullable=True),
            sa.Column("deny_reason", sa.Text(), nullable=True),
            sa.Column("paper_candidate_patch_ref", sa.String(length=255), nullable=True),
            sa.Column("effective_time", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
        op.create_index("ix_research_promotions_candidate", "research_promotions", ["candidate_id"])
        op.create_index("ix_research_promotions_requested_mode", "research_promotions", ["requested_mode"])
        op.create_index("ix_research_promotions_approved_mode", "research_promotions", ["approved_mode"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if inspector.has_table("research_promotions"):
        op.drop_index("ix_research_promotions_candidate", table_name="research_promotions")
        op.drop_index("ix_research_promotions_requested_mode", table_name="research_promotions")
        op.drop_index("ix_research_promotions_approved_mode", table_name="research_promotions")
        op.drop_table("research_promotions")
    if inspector.has_table("research_stress_metrics"):
        op.drop_index("ix_research_stress_metrics_candidate", table_name="research_stress_metrics")
        op.drop_index("ix_research_stress_metrics_case", table_name="research_stress_metrics")
        op.drop_table("research_stress_metrics")
    if inspector.has_table("research_fold_metrics"):
        op.drop_index("ix_research_fold_metrics_candidate", table_name="research_fold_metrics")
        op.drop_index("ix_research_fold_metrics_fold_order", table_name="research_fold_metrics")
        op.drop_table("research_fold_metrics")
    if inspector.has_table("research_candidates"):
        op.drop_index("ix_research_candidates_run_id", table_name="research_candidates")
        op.drop_index("ix_research_candidates_candidate_id", table_name="research_candidates")
        op.drop_table("research_candidates")
    if inspector.has_table("research_runs"):
        op.drop_index("ix_research_runs_status", table_name="research_runs")
        op.drop_index("ix_research_runs_created_at", table_name="research_runs")
        op.drop_table("research_runs")

    execution_indexes = {index["name"] for index in inspector.get_indexes("executions")}
    if "ix_executions_expected_adapter" in execution_indexes:
        op.drop_index("ix_executions_expected_adapter", table_name="executions")
    if "ix_executions_actual_adapter" in execution_indexes:
        op.drop_index("ix_executions_actual_adapter", table_name="executions")

    execution_columns = {column["name"] for column in inspector.get_columns("executions")}
    if "execution_fallback_count" in execution_columns:
        op.drop_column("executions", "execution_fallback_count")
    if "execution_fallback_reason" in execution_columns:
        op.drop_column("executions", "execution_fallback_reason")
    if "execution_actual_adapter" in execution_columns:
        op.drop_column("executions", "execution_actual_adapter")
    if "execution_expected_adapter" in execution_columns:
        op.drop_column("executions", "execution_expected_adapter")


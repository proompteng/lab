"""Add paper-route audit bounded-read indexes.

Revision ID: 0045_paper_route_audit_bounded_read_indexes
Revises: 0044_order_feed_source_window_consumer_scope_index
Create Date: 2026-06-01 12:05:00.000000
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import inspect


revision = "0045_paper_route_audit_bounded_read_indexes"
down_revision = "0044_order_feed_source_window_consumer_scope_index"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "ix_trade_decisions_account_created_strategy_symbol",
        "trade_decisions",
        ("alpaca_account_label", "created_at", "strategy_id", "symbol"),
    ),
    (
        "ix_executions_trade_decision_id",
        "executions",
        ("trade_decision_id",),
    ),
    (
        "ix_execution_order_events_account_event_symbol_decision",
        "execution_order_events",
        ("alpaca_account_label", "event_ts", "symbol", "trade_decision_id"),
    ),
    (
        "ix_strategy_hyp_metric_windows_hyp_cand_window",
        "strategy_hypothesis_metric_windows",
        (
            "hypothesis_id",
            "candidate_id",
            "window_started_at",
            "window_ended_at",
            "created_at",
        ),
    ),
    (
        "ix_strategy_runtime_ledger_buckets_hyp_run_cand_stage_ended",
        "strategy_runtime_ledger_buckets",
        (
            "hypothesis_id",
            "run_id",
            "candidate_id",
            "observed_stage",
            "bucket_ended_at",
            "created_at",
        ),
    ),
    (
        "ix_strategy_runtime_ledger_buckets_account_stage_ended",
        "strategy_runtime_ledger_buckets",
        ("account_label", "observed_stage", "bucket_ended_at", "created_at"),
    ),
    (
        "ix_position_snapshots_account_as_of",
        "position_snapshots",
        ("alpaca_account_label", "as_of"),
    ),
    (
        "ix_execution_tca_metrics_trade_decision_id",
        "execution_tca_metrics",
        ("trade_decision_id",),
    ),
    (
        "ix_execution_tca_metrics_account_computed_symbol",
        "execution_tca_metrics",
        ("alpaca_account_label", "computed_at", "symbol"),
    ),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for index_name, table_name, columns in _INDEXES:
        if not inspector.has_table(table_name):
            continue
        existing_indexes = {
            index["name"] for index in inspector.get_indexes(table_name)
        }
        if index_name in existing_indexes:
            continue
        op.create_index(index_name, table_name, list(columns))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for index_name, table_name, _columns in reversed(_INDEXES):
        if not inspector.has_table(table_name):
            continue
        existing_indexes = {
            index["name"] for index in inspector.get_indexes(table_name)
        }
        if index_name not in existing_indexes:
            continue
        op.drop_index(index_name, table_name=table_name)

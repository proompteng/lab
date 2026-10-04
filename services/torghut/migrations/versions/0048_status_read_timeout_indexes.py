"""Add status read timeout indexes.

Revision ID: 0048_status_read_timeout_indexes
Revises: 0047_order_feed_source_window_classification_counts
Create Date: 2026-06-02 12:45:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision = "0048_status_read_timeout_indexes"
down_revision = "0047_order_feed_source_window_classification_counts"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, str], ...] = (
    (
        "ix_strategy_hyp_windows_hyp_ended_desc",
        "strategy_hypothesis_metric_windows",
        """
CREATE INDEX IF NOT EXISTS ix_strategy_hyp_windows_hyp_ended_desc
ON strategy_hypothesis_metric_windows (
  hypothesis_id,
  window_ended_at DESC NULLS LAST,
  created_at DESC
)
""",
    ),
    (
        "ix_strategy_promotion_decisions_status_lookup",
        "strategy_promotion_decisions",
        """
CREATE INDEX IF NOT EXISTS ix_strategy_promotion_decisions_status_lookup
ON strategy_promotion_decisions (
  hypothesis_id,
  run_id,
  candidate_id,
  promotion_target,
  created_at DESC
)
""",
    ),
    (
        "ix_executions_account_symbol_filled_created",
        "executions",
        """
CREATE INDEX IF NOT EXISTS ix_executions_account_symbol_filled_created
ON executions (
  alpaca_account_label,
  symbol,
  created_at DESC
)
WHERE avg_fill_price IS NOT NULL
  AND filled_qty > 0
""",
    ),
    (
        "ix_execution_tca_metrics_account_symbol_computed",
        "execution_tca_metrics",
        """
CREATE INDEX IF NOT EXISTS ix_execution_tca_metrics_account_symbol_computed
ON execution_tca_metrics (
  alpaca_account_label,
  symbol,
  computed_at DESC
)
""",
    ),
    (
        "ix_options_catalog_active_last_seen_desc",
        "torghut_options_contract_catalog",
        """
CREATE INDEX IF NOT EXISTS ix_options_catalog_active_last_seen_desc
ON torghut_options_contract_catalog (
  last_seen_ts DESC NULLS LAST
)
INCLUDE (
  underlying_symbol,
  provider_updated_ts,
  close_price,
  open_interest
)
WHERE status = 'active'
""",
    ),
)


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    for _index_name, table_name, create_sql in _INDEXES:
        if not inspector.has_table(table_name):
            continue
        op.execute(sa.text(create_sql))


def downgrade() -> None:
    bind = op.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", "") != "postgresql":
        return
    inspector = inspect(bind)
    for index_name, table_name, _create_sql in reversed(_INDEXES):
        if not inspector.has_table(table_name):
            continue
        op.execute(sa.text(f"DROP INDEX IF EXISTS {index_name}"))

"""Add execution-level TCA metrics and aggregate strategy/symbol views."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0009_execution_tca_metrics"
down_revision = "0008_order_feed_execution_events"
branch_labels = None
depends_on = None


_STRATEGY_VIEW_NAME = "execution_tca_strategy_agg_v1"
_SYMBOL_VIEW_NAME = "execution_tca_symbol_agg_v1"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if not inspector.has_table("execution_tca_metrics"):
        op.create_table(
            "execution_tca_metrics",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column(
                "execution_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("executions.id", ondelete="CASCADE"),
                nullable=False,
                unique=True,
            ),
            sa.Column(
                "trade_decision_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("trade_decisions.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "strategy_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("strategies.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("alpaca_account_label", sa.String(length=64), nullable=True),
            sa.Column("symbol", sa.String(length=16), nullable=False),
            sa.Column("side", sa.String(length=8), nullable=False),
            sa.Column("arrival_price", sa.Numeric(20, 8), nullable=True),
            sa.Column("avg_fill_price", sa.Numeric(20, 8), nullable=True),
            sa.Column("filled_qty", sa.Numeric(20, 8), nullable=False, server_default="0"),
            sa.Column("signed_qty", sa.Numeric(20, 8), nullable=False, server_default="0"),
            sa.Column("slippage_bps", sa.Numeric(20, 8), nullable=True),
            sa.Column("shortfall_notional", sa.Numeric(20, 8), nullable=True),
            sa.Column("churn_qty", sa.Numeric(20, 8), nullable=False, server_default="0"),
            sa.Column("churn_ratio", sa.Numeric(20, 8), nullable=True),
            sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
        op.create_index(
            "ix_execution_tca_metrics_strategy_symbol",
            "execution_tca_metrics",
            ["strategy_id", "symbol"],
        )
        op.create_index("ix_execution_tca_metrics_symbol", "execution_tca_metrics", ["symbol"])
        op.create_index("ix_execution_tca_metrics_computed_at", "execution_tca_metrics", ["computed_at"])

    op.execute(
        f"""
        CREATE OR REPLACE VIEW public.{_STRATEGY_VIEW_NAME} AS
        SELECT
            strategy_id,
            COALESCE(alpaca_account_label, 'unknown') AS alpaca_account_label,
            COUNT(*)::BIGINT AS order_count,
            COUNT(DISTINCT symbol)::BIGINT AS symbol_count,
            AVG(slippage_bps) AS avg_slippage_bps,
            AVG(shortfall_notional) AS avg_shortfall_notional,
            AVG(churn_ratio) AS avg_churn_ratio,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY slippage_bps)
                FILTER (WHERE slippage_bps IS NOT NULL) AS p95_slippage_bps,
            MAX(computed_at) AS last_computed_at
        FROM public.execution_tca_metrics
        GROUP BY strategy_id, COALESCE(alpaca_account_label, 'unknown');
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE VIEW public.{_SYMBOL_VIEW_NAME} AS
        SELECT
            strategy_id,
            COALESCE(alpaca_account_label, 'unknown') AS alpaca_account_label,
            symbol,
            COUNT(*)::BIGINT AS order_count,
            AVG(slippage_bps) AS avg_slippage_bps,
            AVG(shortfall_notional) AS avg_shortfall_notional,
            AVG(churn_ratio) AS avg_churn_ratio,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY slippage_bps)
                FILTER (WHERE slippage_bps IS NOT NULL) AS p95_slippage_bps,
            MAX(computed_at) AS last_computed_at
        FROM public.execution_tca_metrics
        GROUP BY strategy_id, COALESCE(alpaca_account_label, 'unknown'), symbol;
        """
    )

    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_tca_metrics TO torghut_app;")
    op.execute(f"GRANT SELECT ON TABLE public.{_STRATEGY_VIEW_NAME} TO torghut_app;")
    op.execute(f"GRANT SELECT ON TABLE public.{_SYMBOL_VIEW_NAME} TO torghut_app;")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    op.execute(f"REVOKE ALL PRIVILEGES ON TABLE public.{_SYMBOL_VIEW_NAME} FROM torghut_app;")
    op.execute(f"REVOKE ALL PRIVILEGES ON TABLE public.{_STRATEGY_VIEW_NAME} FROM torghut_app;")
    op.execute("REVOKE ALL PRIVILEGES ON TABLE public.execution_tca_metrics FROM torghut_app;")
    op.execute(f"DROP VIEW IF EXISTS public.{_SYMBOL_VIEW_NAME};")
    op.execute(f"DROP VIEW IF EXISTS public.{_STRATEGY_VIEW_NAME};")

    if inspector.has_table("execution_tca_metrics"):
        index_names = {index["name"] for index in inspector.get_indexes("execution_tca_metrics")}
        if "ix_execution_tca_metrics_computed_at" in index_names:
            op.drop_index("ix_execution_tca_metrics_computed_at", table_name="execution_tca_metrics")
        if "ix_execution_tca_metrics_symbol" in index_names:
            op.drop_index("ix_execution_tca_metrics_symbol", table_name="execution_tca_metrics")
        if "ix_execution_tca_metrics_strategy_symbol" in index_names:
            op.drop_index("ix_execution_tca_metrics_strategy_symbol", table_name="execution_tca_metrics")
        op.drop_table("execution_tca_metrics")

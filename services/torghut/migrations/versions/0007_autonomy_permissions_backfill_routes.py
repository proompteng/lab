"""Grant runtime write access to research ledger and backfill execution route metadata."""

from __future__ import annotations

from alembic import op


# revision identifiers, used by Alembic.
revision = "0007_autonomy_permissions_backfill_routes"
down_revision = "0006_autonomy_ledger_and_execution_route"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table_name in (
        "research_runs",
        "research_candidates",
        "research_fold_metrics",
        "research_stress_metrics",
        "research_promotions",
    ):
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.{table_name} TO torghut_app;")

    op.execute(
        """
        WITH normalized_routes AS (
            SELECT
                id,
                NULLIF(BTRIM(raw_order ->> '_execution_route_actual'), '') AS route_actual,
                NULLIF(BTRIM(raw_order ->> '_execution_route_expected'), '') AS route_expected,
                NULLIF(BTRIM(raw_order ->> '_execution_adapter'), '') AS adapter_marker,
                NULLIF(BTRIM(raw_order ->> 'execution_actual_adapter'), '') AS response_actual,
                NULLIF(BTRIM(raw_order ->> 'execution_expected_adapter'), '') AS response_expected
            FROM public.executions
        ),
        normalized AS (
            SELECT
                id,
                CASE
                    WHEN route_actual = 'alpaca_fallback' THEN 'alpaca'
                    WHEN route_actual IS NOT NULL THEN route_actual
                    WHEN adapter_marker = 'alpaca_fallback' THEN 'alpaca'
                    WHEN adapter_marker IS NOT NULL THEN adapter_marker
                    WHEN response_actual IS NOT NULL THEN response_actual
                    ELSE NULL
                END AS derived_actual,
                CASE
                    WHEN route_expected = 'alpaca_fallback' THEN 'alpaca'
                    WHEN route_expected IS NOT NULL THEN route_expected
                    WHEN adapter_marker = 'alpaca_fallback' THEN 'alpaca'
                    WHEN adapter_marker IS NOT NULL THEN adapter_marker
                    WHEN response_expected IS NOT NULL THEN response_expected
                    ELSE NULL
                END AS derived_expected
            FROM normalized_routes
        )
        UPDATE public.executions e
        SET
            execution_actual_adapter = COALESCE(NULLIF(BTRIM(e.execution_actual_adapter), ''), n.derived_actual),
            execution_expected_adapter = COALESCE(
                NULLIF(BTRIM(e.execution_expected_adapter), ''),
                n.derived_expected,
                COALESCE(NULLIF(BTRIM(e.execution_actual_adapter), ''), n.derived_actual)
            )
        FROM normalized n
        WHERE n.id = e.id
            AND (
                NULLIF(BTRIM(e.execution_actual_adapter), '') IS NULL
                OR NULLIF(BTRIM(e.execution_expected_adapter), '') IS NULL
            );
        """
    )


def downgrade() -> None:
    for table_name in (
        "research_runs",
        "research_candidates",
        "research_fold_metrics",
        "research_stress_metrics",
        "research_promotions",
    ):
        op.execute(f"REVOKE ALL PRIVILEGES ON TABLE public.{table_name} FROM torghut_app;")

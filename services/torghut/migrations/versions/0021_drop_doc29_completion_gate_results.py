"""Drop doc-scoped completion gate table in favor of generic dataset snapshot traces."""

from __future__ import annotations

from alembic import op

revision = "0021_drop_doc29_completion_gate_results"
down_revision = "0020_vnext_completion_gate_results"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index(
        "uq_vnext_completion_gate_results_gate_run",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_status",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_candidate_id",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_run_id",
        table_name="vnext_completion_gate_results",
    )
    op.drop_index(
        "ix_vnext_completion_gate_results_gate_id",
        table_name="vnext_completion_gate_results",
    )
    op.drop_table("vnext_completion_gate_results")


def downgrade() -> None:
    raise RuntimeError(
        "Downgrade not supported; use the original 0020 migration to recreate vnext_completion_gate_results if needed."
    )

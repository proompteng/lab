"""Add strategy-factory research ledger objects.

Revision ID: 0026_strategy_factory_research_objects
Revises: 0025_widen_lean_shadow_parity_status
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = "0026_strategy_factory_research_objects"
down_revision = "0025_widen_lean_shadow_parity_status"
branch_labels = None
depends_on = None


def _json_type() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def _inspector() -> sa.Inspector[sa.engine.Connection]:
    return inspect(op.get_bind())


def _table_exists(
    inspector: sa.Inspector[sa.engine.Connection],
    table_name: str,
) -> bool:
    return inspector.has_table(table_name)


def _column_names(
    inspector: sa.Inspector[sa.engine.Connection],
    table_name: str,
) -> set[str]:
    if not _table_exists(inspector, table_name):
        return set()
    return {
        str(column.get("name"))
        for column in inspector.get_columns(table_name)
        if column.get("name")
    }


def _index_names(
    inspector: sa.Inspector[sa.engine.Connection],
    table_name: str,
) -> set[str]:
    if not _table_exists(inspector, table_name):
        return set()
    return {
        str(index.get("name"))
        for index in inspector.get_indexes(table_name)
        if index.get("name")
    }


def _add_column_if_missing(
    inspector: sa.Inspector[sa.engine.Connection],
    table_name: str,
    column: sa.Column[Any],
) -> None:
    if column.name in _column_names(inspector, table_name):
        return
    op.add_column(table_name, column)


def _drop_column_if_present(
    inspector: sa.Inspector[sa.engine.Connection],
    table_name: str,
    column_name: str,
) -> None:
    if column_name not in _column_names(inspector, table_name):
        return
    op.drop_column(table_name, column_name)


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

    for column in (
        sa.Column("discovery_mode", sa.String(length=64), nullable=True),
        sa.Column("generator_family", sa.String(length=128), nullable=True),
        sa.Column("grammar_version", sa.String(length=64), nullable=True),
        sa.Column("search_budget", sa.BigInteger(), nullable=True),
        sa.Column("selection_protocol_version", sa.String(length=64), nullable=True),
        sa.Column("pilot_program_id", sa.String(length=64), nullable=True),
        sa.Column("kill_criteria_version", sa.String(length=64), nullable=True),
    ):
        _add_column_if_missing(inspector, "research_runs", column)
    inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_research_runs_discovery_mode",
        "research_runs",
        ["discovery_mode"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_runs_generator_family",
        "research_runs",
        ["generator_family"],
    )

    for column in (
        sa.Column("candidate_family", sa.String(length=128), nullable=True),
        sa.Column("canonical_spec", _json_type(), nullable=True),
        sa.Column("semantic_hash", sa.String(length=128), nullable=True),
        sa.Column("economic_rationale", sa.Text(), nullable=True),
        sa.Column("complexity_score", sa.Numeric(20, 8), nullable=True),
        sa.Column("discovery_rank", sa.BigInteger(), nullable=True),
        sa.Column("posterior_edge_summary", _json_type(), nullable=True),
        sa.Column("economic_validity_card", _json_type(), nullable=True),
        sa.Column("valid_regime_envelope", _json_type(), nullable=True),
        sa.Column("invalidation_clauses", _json_type(), nullable=True),
        sa.Column("null_comparator_summary", _json_type(), nullable=True),
    ):
        _add_column_if_missing(inspector, "research_candidates", column)
    inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_research_candidates_family",
        "research_candidates",
        ["candidate_family"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_candidates_semantic_hash",
        "research_candidates",
        ["semantic_hash"],
    )

    for column in (
        sa.Column("stat_bundle", _json_type(), nullable=True),
        sa.Column("purge_window", sa.BigInteger(), nullable=True),
        sa.Column("embargo_window", sa.BigInteger(), nullable=True),
        sa.Column("feature_availability_hash", sa.String(length=128), nullable=True),
    ):
        _add_column_if_missing(inspector, "research_fold_metrics", column)
    inspector = _inspector()

    if not _table_exists(inspector, "research_attempts"):
        op.create_table(
            "research_attempts",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("attempt_id", sa.String(length=64), nullable=False),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("candidate_hash", sa.String(length=128), nullable=True),
            sa.Column("generator_family", sa.String(length=128), nullable=True),
            sa.Column("attempt_stage", sa.String(length=64), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("reason_codes", _json_type(), nullable=True),
            sa.Column("artifact_ref", sa.String(length=255), nullable=True),
            sa.Column("metadata_bundle", _json_type(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("id", name="pk_research_attempts"),
            sa.UniqueConstraint("attempt_id", name="uq_research_attempts_attempt_id"),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_research_attempts_run_id",
        "research_attempts",
        ["run_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_attempts_stage",
        "research_attempts",
        ["attempt_stage"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_attempts_status",
        "research_attempts",
        ["status"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_attempts_generator_family",
        "research_attempts",
        ["generator_family"],
    )

    if not _table_exists(inspector, "research_validation_tests"):
        op.create_table(
            "research_validation_tests",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=False),
            sa.Column("test_name", sa.String(length=64), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("metric_bundle", _json_type(), nullable=True),
            sa.Column("artifact_ref", sa.String(length=255), nullable=True),
            sa.Column(
                "computed_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("id", name="pk_research_validation_tests"),
            sa.UniqueConstraint(
                "candidate_id",
                "test_name",
                name="uq_research_validation_tests_candidate_name",
            ),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_research_validation_tests_candidate",
        "research_validation_tests",
        ["candidate_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_validation_tests_name",
        "research_validation_tests",
        ["test_name"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_validation_tests_status",
        "research_validation_tests",
        ["status"],
    )

    if not _table_exists(inspector, "research_sequential_trials"):
        op.create_table(
            "research_sequential_trials",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("candidate_id", sa.String(length=64), nullable=False),
            sa.Column("trial_stage", sa.String(length=32), nullable=False),
            sa.Column("account", sa.String(length=64), nullable=False),
            sa.Column("start_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_update_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "sample_count",
                sa.BigInteger(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("confidence_sequence_lower", sa.Numeric(20, 8), nullable=True),
            sa.Column("confidence_sequence_upper", sa.Numeric(20, 8), nullable=True),
            sa.Column("posterior_edge_mean", sa.Numeric(20, 8), nullable=True),
            sa.Column("posterior_edge_lower", sa.Numeric(20, 8), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("reason_codes", _json_type(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("id", name="pk_research_sequential_trials"),
            sa.UniqueConstraint(
                "candidate_id",
                "trial_stage",
                "account",
                name="uq_research_sequential_trials_candidate_stage_account",
            ),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_research_sequential_trials_candidate",
        "research_sequential_trials",
        ["candidate_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_sequential_trials_stage",
        "research_sequential_trials",
        ["trial_stage"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_sequential_trials_status",
        "research_sequential_trials",
        ["status"],
    )

    if not _table_exists(inspector, "research_cost_calibrations"):
        op.create_table(
            "research_cost_calibrations",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("calibration_id", sa.String(length=64), nullable=False),
            sa.Column("scope_type", sa.String(length=64), nullable=False),
            sa.Column("scope_id", sa.String(length=128), nullable=False),
            sa.Column("window_start", sa.DateTime(timezone=True), nullable=True),
            sa.Column("window_end", sa.DateTime(timezone=True), nullable=True),
            sa.Column("modeled_slippage_bps", sa.Numeric(20, 8), nullable=True),
            sa.Column("realized_slippage_bps", sa.Numeric(20, 8), nullable=True),
            sa.Column("modeled_shortfall_bps", sa.Numeric(20, 8), nullable=True),
            sa.Column("realized_shortfall_bps", sa.Numeric(20, 8), nullable=True),
            sa.Column("calibration_error_bundle", _json_type(), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column(
                "computed_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("id", name="pk_research_cost_calibrations"),
            sa.UniqueConstraint(
                "calibration_id",
                name="uq_research_cost_calibrations_calibration_id",
            ),
        )
        inspector = _inspector()
    _create_index_if_missing(
        inspector,
        "ix_research_cost_calibrations_scope",
        "research_cost_calibrations",
        ["scope_type", "scope_id"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_cost_calibrations_status",
        "research_cost_calibrations",
        ["status"],
    )
    _create_index_if_missing(
        inspector,
        "ix_research_cost_calibrations_computed_at",
        "research_cost_calibrations",
        ["computed_at"],
    )


def downgrade() -> None:
    inspector = _inspector()

    for name, table_name in (
        ("ix_research_cost_calibrations_computed_at", "research_cost_calibrations"),
        ("ix_research_cost_calibrations_status", "research_cost_calibrations"),
        ("ix_research_cost_calibrations_scope", "research_cost_calibrations"),
    ):
        _drop_index_if_present(inspector, name, table_name=table_name)
    _drop_table_if_present(inspector, "research_cost_calibrations")

    inspector = _inspector()
    for name, table_name in (
        ("ix_research_sequential_trials_status", "research_sequential_trials"),
        ("ix_research_sequential_trials_stage", "research_sequential_trials"),
        ("ix_research_sequential_trials_candidate", "research_sequential_trials"),
    ):
        _drop_index_if_present(inspector, name, table_name=table_name)
    _drop_table_if_present(inspector, "research_sequential_trials")

    inspector = _inspector()
    for name, table_name in (
        ("ix_research_validation_tests_status", "research_validation_tests"),
        ("ix_research_validation_tests_name", "research_validation_tests"),
        ("ix_research_validation_tests_candidate", "research_validation_tests"),
    ):
        _drop_index_if_present(inspector, name, table_name=table_name)
    _drop_table_if_present(inspector, "research_validation_tests")

    inspector = _inspector()
    for name, table_name in (
        ("ix_research_attempts_generator_family", "research_attempts"),
        ("ix_research_attempts_status", "research_attempts"),
        ("ix_research_attempts_stage", "research_attempts"),
        ("ix_research_attempts_run_id", "research_attempts"),
    ):
        _drop_index_if_present(inspector, name, table_name=table_name)
    _drop_table_if_present(inspector, "research_attempts")

    inspector = _inspector()
    for column_name in (
        "feature_availability_hash",
        "embargo_window",
        "purge_window",
        "stat_bundle",
    ):
        _drop_column_if_present(inspector, "research_fold_metrics", column_name)

    inspector = _inspector()
    for name in (
        "ix_research_candidates_semantic_hash",
        "ix_research_candidates_family",
    ):
        _drop_index_if_present(inspector, name, table_name="research_candidates")
    for column_name in (
        "null_comparator_summary",
        "invalidation_clauses",
        "valid_regime_envelope",
        "economic_validity_card",
        "posterior_edge_summary",
        "discovery_rank",
        "complexity_score",
        "economic_rationale",
        "semantic_hash",
        "canonical_spec",
        "candidate_family",
    ):
        _drop_column_if_present(inspector, "research_candidates", column_name)

    inspector = _inspector()
    for name in (
        "ix_research_runs_generator_family",
        "ix_research_runs_discovery_mode",
    ):
        _drop_index_if_present(inspector, name, table_name="research_runs")
    for column_name in (
        "kill_criteria_version",
        "pilot_program_id",
        "selection_protocol_version",
        "search_budget",
        "grammar_version",
        "generator_family",
        "discovery_mode",
    ):
        _drop_column_if_present(inspector, "research_runs", column_name)

"""Add immutable fresh-broker observations for economic-ledger runs.

Revision ID: 0079_broker_econ_reconciliation
Revises: 0078_broker_economic_ledger
Create Date: 2026-07-16 09:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import conv


revision = "0079_broker_econ_reconciliation"
down_revision = "0078_broker_economic_ledger"
branch_labels = None
depends_on = None


_TABLE = "broker_economic_ledger_reconciliations"
_INPUT_TABLE = "broker_economic_ledger_inputs"
_RUN_TABLE = "broker_economic_ledger_runs"
_GUARD = "torghut_guard_broker_economic_reconciliation_0079"


def _create_table() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("input_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("journal_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_watermark", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_age_seconds", sa.BigInteger(), nullable=False),
        sa.Column("max_source_age_seconds", sa.BigInteger(), nullable=False),
        sa.Column(
            "broker_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("broker_snapshot_canonical_json", sa.Text(), nullable=False),
        sa.Column("broker_snapshot_sha256", sa.String(length=64), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result_canonical_json", sa.Text(), nullable=False),
        sa.Column("result_sha256", sa.String(length=64), nullable=False),
        sa.Column("comparison_sha256", sa.String(length=64), nullable=False),
        sa.Column("journal_sha256", sa.String(length=64), nullable=False),
        sa.Column("reconciled", sa.Boolean(), nullable=False),
        sa.Column("residual_count", sa.BigInteger(), nullable=False),
        sa.Column("open_order_count", sa.BigInteger(), nullable=False),
        sa.Column("source_commit", sa.String(length=64), nullable=False),
        sa.Column("image_digest", sa.String(length=128), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "journal_run_id <> state_run_id",
            name=conv("ck_broker_econ_recon_distinct_runs"),
        ),
        sa.CheckConstraint(
            "observed_at >= source_watermark",
            name=conv("ck_broker_econ_recon_watermark_order"),
        ),
        sa.CheckConstraint(
            "source_age_seconds >= 0 AND max_source_age_seconds > 0 "
            "AND residual_count >= 0 AND open_order_count >= 0",
            name=conv("ck_broker_econ_recon_counts"),
        ),
        sa.CheckConstraint(
            "length(broker_snapshot_sha256) = 64 "
            "AND length(result_sha256) = 64 "
            "AND length(comparison_sha256) = 64 "
            "AND length(journal_sha256) = 64",
            name=conv("ck_broker_econ_recon_digests"),
        ),
        sa.CheckConstraint(
            "source_commit ~ '^[0-9a-f]{40,64}$' "
            "AND image_digest ~ '^sha256:[0-9a-f]{64}$'",
            name=conv("ck_broker_econ_recon_build"),
        ),
        sa.ForeignKeyConstraint(
            ["input_id"],
            [f"{_INPUT_TABLE}.id"],
            name=conv("fk_broker_econ_recon_input"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["journal_run_id"],
            [f"{_RUN_TABLE}.id"],
            name=conv("fk_broker_econ_recon_journal_run"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["state_run_id"],
            [f"{_RUN_TABLE}.id"],
            name=conv("fk_broker_econ_recon_state_run"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_broker_econ_recon")),
    )
    op.create_index(
        "uq_broker_econ_recon_observation",
        _TABLE,
        ["journal_run_id", "state_run_id", "observed_at", "broker_snapshot_sha256"],
        unique=True,
    )
    op.create_index(
        "ix_broker_econ_recon_latest",
        _TABLE,
        ["input_id", sa.text("observed_at DESC")],
        unique=False,
    )


def _create_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                snapshot_document jsonb;
                result_document jsonb;
                stored_input_manifest_sha text;
                stored_input_watermark timestamptz;
                journal_input uuid;
                journal_reducer text;
                journal_reducer_version text;
                journal_admissible boolean;
                journal_comparison text;
                stored_journal_sha text;
                state_input uuid;
                state_reducer text;
                state_reducer_version text;
                state_admissible boolean;
                state_comparison text;
                stored_state_journal_sha text;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker economic reconciliation is append-only'
                        USING ERRCODE = '23514';
                END IF;
                BEGIN
                    snapshot_document := NEW.broker_snapshot_canonical_json::jsonb;
                    result_document := NEW.result_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'broker economic reconciliation JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                IF snapshot_document IS DISTINCT FROM NEW.broker_snapshot
                   OR result_document IS DISTINCT FROM NEW.result THEN
                    RAISE EXCEPTION 'broker economic reconciliation JSON identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.broker_snapshot_sha256 IS DISTINCT FROM encode(
                    sha256(convert_to(NEW.broker_snapshot_canonical_json, 'UTF8')),
                    'hex'
                ) OR NEW.result_sha256 IS DISTINCT FROM encode(
                    sha256(convert_to(NEW.result_canonical_json, 'UTF8')),
                    'hex'
                ) THEN
                    RAISE EXCEPTION 'broker economic reconciliation hash mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF snapshot_document->>'schema_version'
                       IS DISTINCT FROM 'torghut.broker-economic-snapshot.v1'
                   OR (snapshot_document->>'observed_at')::timestamptz
                       IS DISTINCT FROM NEW.observed_at
                   OR jsonb_typeof(snapshot_document->'open_orders')
                       IS DISTINCT FROM 'array'
                   OR jsonb_array_length(snapshot_document->'open_orders')
                       IS DISTINCT FROM NEW.open_order_count THEN
                    RAISE EXCEPTION 'broker economic reconciliation snapshot identity mismatch'
                        USING ERRCODE = '23514';
                END IF;

                SELECT input_id, reducer_name, reducer_version, admissible,
                       comparison_sha256, journal_sha256
                INTO journal_input, journal_reducer, journal_reducer_version,
                     journal_admissible, journal_comparison, stored_journal_sha
                FROM {_RUN_TABLE} WHERE id = NEW.journal_run_id;
                SELECT input_id, reducer_name, reducer_version, admissible,
                       comparison_sha256, journal_sha256
                INTO state_input, state_reducer, state_reducer_version,
                     state_admissible, state_comparison, stored_state_journal_sha
                FROM {_RUN_TABLE} WHERE id = NEW.state_run_id;
                IF journal_input IS NULL OR state_input IS NULL
                   OR journal_input <> NEW.input_id OR state_input <> NEW.input_id
                   OR journal_reducer <> 'balanced_journal'
                   OR state_reducer <> 'independent_position_state'
                   OR journal_admissible IS DISTINCT FROM true
                   OR state_admissible IS DISTINCT FROM true
                   OR journal_comparison <> NEW.comparison_sha256
                   OR state_comparison <> NEW.comparison_sha256
                   OR stored_journal_sha <> NEW.journal_sha256
                   OR stored_state_journal_sha IS NOT NULL THEN
                    RAISE EXCEPTION 'broker economic reconciliation run identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                SELECT manifest_sha256, source_watermark
                INTO stored_input_manifest_sha, stored_input_watermark
                FROM {_INPUT_TABLE} WHERE id = NEW.input_id;
                IF stored_input_manifest_sha IS NULL
                   OR stored_input_watermark IS DISTINCT FROM NEW.source_watermark THEN
                    RAISE EXCEPTION 'broker economic reconciliation source identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF FLOOR(EXTRACT(EPOCH FROM (
                       NEW.observed_at - NEW.source_watermark
                   )))::bigint IS DISTINCT FROM NEW.source_age_seconds THEN
                    RAISE EXCEPTION 'broker economic reconciliation source age mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF result_document->>'schema_version'
                       IS DISTINCT FROM 'torghut.broker-economic-ledger-reconciliation.v1'
                   OR result_document->>'input_id'
                       IS DISTINCT FROM NEW.input_id::text
                   OR result_document->>'journal_run_id'
                       IS DISTINCT FROM NEW.journal_run_id::text
                   OR result_document->>'state_run_id'
                       IS DISTINCT FROM NEW.state_run_id::text
                   OR result_document->>'comparison_sha256'
                       IS DISTINCT FROM NEW.comparison_sha256
                   OR result_document->>'journal_sha256'
                       IS DISTINCT FROM NEW.journal_sha256
                   OR result_document->>'broker_snapshot_sha256'
                       IS DISTINCT FROM NEW.broker_snapshot_sha256
                   OR result_document->>'input_manifest_sha256'
                       IS DISTINCT FROM stored_input_manifest_sha
                   OR result_document#>>'{{reducers,journal}}'
                       IS DISTINCT FROM journal_reducer_version
                   OR result_document#>>'{{reducers,state}}'
                       IS DISTINCT FROM state_reducer_version
                   OR (result_document#>>'{{reducers,admissible}}')::boolean
                       IS DISTINCT FROM journal_admissible
                   OR (result_document#>>'{{reducers,differential_equivalent}}')::boolean
                       IS DISTINCT FROM true
                   OR (result_document->>'source_watermark')::timestamptz
                       IS DISTINCT FROM NEW.source_watermark
                   OR (result_document->>'observed_at')::timestamptz
                       IS DISTINCT FROM NEW.observed_at
                   OR (result_document->>'source_age_seconds')::bigint
                       IS DISTINCT FROM NEW.source_age_seconds
                   OR (result_document->>'max_source_age_seconds')::bigint
                       IS DISTINCT FROM NEW.max_source_age_seconds
                   OR (result_document->>'reconciled')::boolean
                       IS DISTINCT FROM NEW.reconciled
                   OR (result_document->>'residual_count')::bigint
                       IS DISTINCT FROM NEW.residual_count
                   OR (result_document->>'open_order_count')::bigint
                       IS DISTINCT FROM NEW.open_order_count
                   OR jsonb_typeof(result_document->'residuals')
                       IS DISTINCT FROM 'array'
                   OR jsonb_array_length(result_document->'residuals')
                       IS DISTINCT FROM NEW.residual_count
                   OR jsonb_typeof(result_document->'reason_codes')
                       IS DISTINCT FROM 'array'
                   OR NEW.reconciled IS DISTINCT FROM (
                       jsonb_array_length(result_document->'residuals') = 0
                       AND jsonb_array_length(result_document->'reason_codes') = 0
                   )
                   OR result_document->>'source_commit'
                       IS DISTINCT FROM NEW.source_commit
                   OR result_document->>'image_digest'
                       IS DISTINCT FROM NEW.image_digest THEN
                    RAISE EXCEPTION 'broker economic reconciliation result identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                NEW.created_at := clock_timestamp();
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_econ_recon
            BEFORE INSERT OR UPDATE OR DELETE ON {_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {_GUARD}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_econ_recon_truncate
            BEFORE TRUNCATE ON {_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_GUARD}()
            """
        )
    )


def upgrade() -> None:
    _create_table()
    _create_guard()


def downgrade() -> None:
    op.execute(
        sa.text(
            f"""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM {_TABLE}) THEN
                    RAISE EXCEPTION 'refusing to discard broker economic reconciliation evidence'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )
    op.execute(
        sa.text(f"DROP TRIGGER trg_guard_broker_econ_recon_truncate ON {_TABLE}")
    )
    op.execute(sa.text(f"DROP TRIGGER trg_guard_broker_econ_recon ON {_TABLE}"))
    op.execute(sa.text(f"DROP FUNCTION {_GUARD}()"))
    op.drop_table(_TABLE)

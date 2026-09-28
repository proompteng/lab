"""Separate immutable input identity from reconciliation freshness.

Revision ID: 0080_broker_econ_recon_freshness
Revises: 0079_broker_econ_reconciliation
Create Date: 2026-07-16 10:40:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.schema import conv


revision = "0080_broker_econ_recon_freshness"
down_revision = "0079_broker_econ_reconciliation"
branch_labels = None
depends_on = None


_TABLE = "broker_economic_ledger_reconciliations"
_INPUT_TABLE = "broker_economic_ledger_inputs"
_RUN_TABLE = "broker_economic_ledger_runs"
_OLD_GUARD = "torghut_guard_broker_economic_reconciliation_0079"
_NEW_GUARD = "torghut_guard_broker_economic_reconciliation_0080"
_ROW_TRIGGER = "trg_guard_broker_econ_recon"
_TRUNCATE_TRIGGER = "trg_guard_broker_econ_recon_truncate"
_WATERMARK_CONSTRAINT = "ck_broker_econ_recon_input_watermark_order"


def _drop_guard(function_name: str) -> None:
    op.execute(sa.text(f"DROP TRIGGER {_TRUNCATE_TRIGGER} ON {_TABLE}"))
    op.execute(sa.text(f"DROP TRIGGER {_ROW_TRIGGER} ON {_TABLE}"))
    op.execute(sa.text(f"DROP FUNCTION {function_name}()"))


def _create_guard(function_name: str, *, separate_input_watermark: bool) -> None:
    input_watermark = (
        "NEW.input_source_watermark"
        if separate_input_watermark
        else "NEW.source_watermark"
    )
    result_input_watermark_guard = (
        """
                   OR (result_document->>'input_source_watermark')::timestamptz
                       IS DISTINCT FROM NEW.input_source_watermark"""
        if separate_input_watermark
        else ""
    )
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {function_name}()
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
                   OR stored_input_watermark IS DISTINCT FROM {input_watermark} THEN
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
                       IS DISTINCT FROM true{result_input_watermark_guard}
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
            CREATE TRIGGER {_ROW_TRIGGER}
            BEFORE INSERT OR UPDATE OR DELETE ON {_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {function_name}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {_TRUNCATE_TRIGGER}
            BEFORE TRUNCATE ON {_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {function_name}()
            """
        )
    )


def upgrade() -> None:
    _drop_guard(_OLD_GUARD)
    op.add_column(
        _TABLE,
        sa.Column("input_source_watermark", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        sa.text(
            f"UPDATE {_TABLE} SET input_source_watermark = source_watermark "
            "WHERE input_source_watermark IS NULL"
        )
    )
    op.alter_column(_TABLE, "input_source_watermark", nullable=False)
    op.create_check_constraint(
        conv(_WATERMARK_CONSTRAINT),
        _TABLE,
        "source_watermark >= input_source_watermark",
    )
    _create_guard(_NEW_GUARD, separate_input_watermark=True)


def downgrade() -> None:
    op.execute(
        sa.text(
            f"""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM {_TABLE}) THEN
                    RAISE EXCEPTION 'refusing to discard reconciliation watermark evidence'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )
    _drop_guard(_NEW_GUARD)
    op.drop_constraint(conv(_WATERMARK_CONSTRAINT), _TABLE, type_="check")
    op.drop_column(_TABLE, "input_source_watermark")
    _create_guard(_OLD_GUARD, separate_input_watermark=False)

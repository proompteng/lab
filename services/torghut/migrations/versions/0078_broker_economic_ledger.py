"""Add immutable broker-economic ledger inputs, runs, and balanced lines.

Revision ID: 0078_broker_economic_ledger
Revises: 0077_validation_quarantine
Create Date: 2026-07-16 06:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import conv


revision = "0078_broker_economic_ledger"
down_revision = "0077_validation_quarantine"
branch_labels = None
depends_on = None


_CURSOR_TABLE = "broker_account_activity_cursors"
_INPUT_TABLE = "broker_economic_ledger_inputs"
_RUN_TABLE = "broker_economic_ledger_runs"
_ENTRY_TABLE = "broker_economic_ledger_entries"
_ACTIVITY_GUARD = "torghut_guard_broker_account_activity_0076"
_INPUT_GUARD = "torghut_guard_broker_economic_ledger_input_0078"
_RUN_GUARD = "torghut_guard_broker_economic_ledger_run_0078"
_ENTRY_GUARD = "torghut_guard_broker_economic_ledger_entry_0078"


def _add_closed_scan_watermark() -> None:
    op.add_column(
        _CURSOR_TABLE,
        sa.Column(
            "last_completed_scan_until",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_check_constraint(
        "ck_broker_account_activity_cursors_completed_watermark",
        _CURSOR_TABLE,
        "last_completed_scan_until IS NULL "
        "OR last_completed_at IS NULL "
        "OR last_completed_scan_until <= last_completed_at",
    )


def _remove_activity_guard_pgcrypto_dependency() -> None:
    """Keep the existing source guard schema-local by using core SHA-256."""

    op.execute(
        sa.text(
            f"""
            CREATE OR REPLACE FUNCTION {_ACTIVITY_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                canonical_document jsonb;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker account activity is append-only'
                        USING ERRCODE = '23514';
                END IF;
                BEGIN
                    canonical_document := NEW.raw_payload_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'broker account activity canonical JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                IF canonical_document IS DISTINCT FROM NEW.raw_payload THEN
                    RAISE EXCEPTION 'broker account activity payload identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.raw_payload_sha256 IS DISTINCT FROM encode(
                    sha256(convert_to(NEW.raw_payload_canonical_json, 'UTF8')),
                    'hex'
                ) THEN
                    RAISE EXCEPTION 'broker account activity payload hash mismatch'
                        USING ERRCODE = '23514';
                END IF;
                NEW.created_at := clock_timestamp();
                RETURN NEW;
            END;
            $$
            """
        )
    )


def _create_input_table() -> None:
    op.create_table(
        _INPUT_TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("endpoint_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("quote_currency", sa.String(length=16), nullable=False),
        sa.Column("source_cursor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_watermark", sa.DateTime(timezone=True), nullable=False),
        sa.Column("input_count", sa.BigInteger(), nullable=False),
        sa.Column("duplicate_count", sa.BigInteger(), nullable=False),
        sa.Column("corrected_count", sa.BigInteger(), nullable=False),
        sa.Column("manifest_canonical_json", sa.Text(), nullable=False),
        sa.Column("manifest_sha256", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "btrim(provider) <> '' AND btrim(source) <> '' "
            "AND btrim(environment) <> '' AND btrim(account_label) <> '' "
            "AND btrim(quote_currency) <> ''",
            name=conv("ck_broker_economic_ledger_inputs_scope"),
        ),
        sa.CheckConstraint(
            "endpoint_fingerprint ~ '^[0-9a-f]{64}$' "
            "AND manifest_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_broker_economic_ledger_inputs_digests"),
        ),
        sa.CheckConstraint(
            "input_count > 0 AND duplicate_count >= 0 AND corrected_count >= 0 "
            "AND corrected_count < input_count",
            name=conv("ck_broker_economic_ledger_inputs_counts"),
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_broker_economic_ledger_inputs")),
    )
    op.create_index(
        "uq_broker_economic_ledger_inputs_identity",
        _INPUT_TABLE,
        [
            "provider",
            "source",
            "environment",
            "account_label",
            "endpoint_fingerprint",
            "source_cursor_id",
            "manifest_sha256",
        ],
        unique=True,
    )
    op.create_index(
        "ix_broker_economic_ledger_inputs_scope_watermark",
        _INPUT_TABLE,
        ["provider", "environment", "account_label", "source_watermark"],
    )


def _create_run_table() -> None:
    op.create_table(
        _RUN_TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("input_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reducer_name", sa.String(length=64), nullable=False),
        sa.Column("reducer_version", sa.String(length=128), nullable=False),
        sa.Column("unsupported_count", sa.BigInteger(), nullable=False),
        sa.Column("transaction_count", sa.BigInteger(), nullable=False),
        sa.Column("entry_count", sa.BigInteger(), nullable=False),
        sa.Column("admissible", sa.Boolean(), nullable=False),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("result_canonical_json", sa.Text(), nullable=False),
        sa.Column("result_sha256", sa.String(length=64), nullable=False),
        sa.Column("projection_sha256", sa.String(length=64), nullable=False),
        sa.Column("comparison_sha256", sa.String(length=64), nullable=False),
        sa.Column("journal_sha256", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "btrim(reducer_name) <> '' AND btrim(reducer_version) <> ''",
            name=conv("ck_broker_economic_ledger_runs_reducer"),
        ),
        sa.CheckConstraint(
            "result_sha256 ~ '^[0-9a-f]{64}$' "
            "AND projection_sha256 ~ '^[0-9a-f]{64}$' "
            "AND comparison_sha256 ~ '^[0-9a-f]{64}$' "
            "AND (journal_sha256 IS NULL OR journal_sha256 ~ '^[0-9a-f]{64}$')",
            name=conv("ck_broker_economic_ledger_runs_digests"),
        ),
        sa.CheckConstraint(
            "unsupported_count >= 0 AND transaction_count >= 0 AND entry_count >= 0",
            name=conv("ck_broker_economic_ledger_runs_counts"),
        ),
        sa.CheckConstraint(
            "admissible = (unsupported_count = 0)",
            name=conv("ck_broker_economic_ledger_runs_admissibility"),
        ),
        sa.ForeignKeyConstraint(
            ["input_id"],
            [f"{_INPUT_TABLE}.id"],
            name=conv(
                "fk_broker_economic_ledger_runs_input_id_broker_economic_ledger_inputs"
            ),
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_broker_economic_ledger_runs")),
    )
    op.create_index(
        "uq_broker_economic_ledger_runs_identity",
        _RUN_TABLE,
        ["input_id", "reducer_name", "reducer_version"],
        unique=True,
    )


def _create_entry_table() -> None:
    op.create_table(
        _ENTRY_TABLE,
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("transaction_index", sa.BigInteger(), nullable=False),
        sa.Column("line_number", sa.BigInteger(), nullable=False),
        sa.Column("source_activity_id", sa.String(length=256), nullable=False),
        sa.Column("transaction_id", sa.String(length=512), nullable=False),
        sa.Column("reverses_transaction_id", sa.String(length=512), nullable=True),
        sa.Column("posting_rule", sa.String(length=128), nullable=False),
        sa.Column("transaction_sha256", sa.String(length=64), nullable=False),
        sa.Column("account", sa.String(length=128), nullable=False),
        sa.Column("commodity", sa.String(length=64), nullable=False),
        sa.Column("amount", sa.Numeric(38, 18), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "transaction_index >= 0 AND line_number >= 0 AND amount <> 0",
            name=conv("ck_broker_economic_ledger_entries_values"),
        ),
        sa.CheckConstraint(
            "btrim(source_activity_id) <> '' AND btrim(transaction_id) <> '' "
            "AND btrim(posting_rule) <> '' AND btrim(account) <> '' "
            "AND btrim(commodity) <> ''",
            name=conv("ck_broker_economic_ledger_entries_identity"),
        ),
        sa.CheckConstraint(
            "transaction_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_broker_economic_ledger_entries_digest"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            [f"{_RUN_TABLE}.id"],
            name=conv(
                "fk_broker_economic_ledger_entries_run_id_broker_economic_ledger_runs"
            ),
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.PrimaryKeyConstraint(
            "run_id",
            "transaction_index",
            "line_number",
            name=conv("pk_broker_economic_ledger_entries"),
        ),
    )
    op.create_index(
        "uq_broker_economic_ledger_entries_transaction_line",
        _ENTRY_TABLE,
        ["run_id", "transaction_id", "line_number"],
        unique=True,
    )


def _create_input_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_INPUT_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                manifest_document jsonb;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker economic ledger input is append-only'
                        USING ERRCODE = '23514';
                END IF;
                BEGIN
                    manifest_document := NEW.manifest_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'broker economic ledger manifest JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                IF jsonb_typeof(manifest_document) <> 'array'
                   OR NEW.manifest_sha256 IS DISTINCT FROM encode(
                       sha256(convert_to(NEW.manifest_canonical_json, 'UTF8')),
                       'hex'
                   )
                   OR jsonb_array_length(manifest_document) <> NEW.input_count THEN
                    RAISE EXCEPTION 'broker economic ledger manifest mismatch'
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
            CREATE TRIGGER trg_guard_broker_economic_ledger_input
            BEFORE INSERT OR UPDATE OR DELETE ON {_INPUT_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {_INPUT_GUARD}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_economic_ledger_input_truncate
            BEFORE TRUNCATE ON {_INPUT_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_INPUT_GUARD}()
            """
        )
    )


def _create_entry_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_ENTRY_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker economic ledger entry is append-only'
                        USING ERRCODE = '23514';
                END IF;
                IF EXISTS (SELECT 1 FROM {_RUN_TABLE} WHERE id = NEW.run_id) THEN
                    RAISE EXCEPTION 'broker economic ledger run is already sealed'
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
            CREATE TRIGGER trg_guard_broker_economic_ledger_entry
            BEFORE INSERT OR UPDATE OR DELETE ON {_ENTRY_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {_ENTRY_GUARD}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_economic_ledger_entry_truncate
            BEFORE TRUNCATE ON {_ENTRY_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_ENTRY_GUARD}()
            """
        )
    )


def _create_run_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_RUN_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                computed_journal_sha256 text;
                entry_rows bigint;
                input_manifest_sha256 text;
                input_row_count bigint;
                result_document jsonb;
                transaction_rows bigint;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker economic ledger run is append-only'
                        USING ERRCODE = '23514';
                END IF;
                SELECT input_count, manifest_sha256
                  INTO input_row_count, input_manifest_sha256
                  FROM {_INPUT_TABLE}
                 WHERE id = NEW.input_id;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'broker economic ledger input is missing'
                        USING ERRCODE = '23503';
                END IF;
                BEGIN
                    result_document := NEW.result_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'broker economic ledger result JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                IF jsonb_typeof(result_document) <> 'object'
                   OR result_document IS DISTINCT FROM NEW.result
                   OR NEW.result_sha256 IS DISTINCT FROM encode(
                       sha256(convert_to(NEW.result_canonical_json, 'UTF8')),
                       'hex'
                   )
                   OR result_document ->> 'schema_version' IS DISTINCT FROM
                       'torghut.broker-economic-ledger-result.v1'
                   OR result_document ->> 'reducer_name' IS DISTINCT FROM NEW.reducer_name
                   OR result_document ->> 'reducer_version' IS DISTINCT FROM NEW.reducer_version
                   OR result_document ->> 'projection_sha256' IS DISTINCT FROM NEW.projection_sha256
                   OR result_document ->> 'comparison_sha256' IS DISTINCT FROM NEW.comparison_sha256
                   OR result_document -> 'journal_sha256' IS DISTINCT FROM
                       COALESCE(to_jsonb(NEW.journal_sha256), 'null'::jsonb)
                   OR result_document -> 'admissible' IS DISTINCT FROM
                       to_jsonb(NEW.admissible)
                   OR (result_document ->> 'input_count')::bigint IS DISTINCT FROM
                       input_row_count
                   OR result_document ->> 'input_manifest_sha256' IS DISTINCT FROM
                       input_manifest_sha256 THEN
                    RAISE EXCEPTION 'broker economic ledger result identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                SELECT count(*), count(DISTINCT transaction_index)
                  INTO entry_rows, transaction_rows
                  FROM {_ENTRY_TABLE}
                 WHERE run_id = NEW.id;
                IF entry_rows <> NEW.entry_count
                   OR transaction_rows <> NEW.transaction_count THEN
                    RAISE EXCEPTION 'broker economic ledger entry count mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.reducer_name = 'independent_position_state' THEN
                    IF NEW.entry_count <> 0 OR NEW.transaction_count <> 0
                       OR NEW.journal_sha256 IS NOT NULL THEN
                        RAISE EXCEPTION 'independent state run contains journal entries'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF NEW.reducer_name = 'balanced_journal' THEN
                    IF NEW.journal_sha256 IS NULL THEN
                        RAISE EXCEPTION 'balanced journal digest is missing'
                            USING ERRCODE = '23514';
                    END IF;
                    IF NEW.transaction_count > 0 AND EXISTS (
                        SELECT 1
                          FROM (
                              SELECT transaction_index,
                                     min(line_number) AS first_line,
                                     max(line_number) AS last_line,
                                     count(*) AS line_count,
                                     count(DISTINCT transaction_sha256) AS digest_count
                                FROM {_ENTRY_TABLE}
                               WHERE run_id = NEW.id
                               GROUP BY transaction_index
                          ) AS transactions
                         WHERE first_line <> 0
                            OR last_line + 1 <> line_count
                            OR digest_count <> 1
                    ) THEN
                        RAISE EXCEPTION 'broker economic ledger transaction lines are not contiguous'
                            USING ERRCODE = '23514';
                    END IF;
                    IF NEW.transaction_count > 0 AND (
                        SELECT min(transaction_index) <> 0
                            OR max(transaction_index) + 1 <> count(DISTINCT transaction_index)
                          FROM {_ENTRY_TABLE}
                         WHERE run_id = NEW.id
                    ) THEN
                        RAISE EXCEPTION 'broker economic ledger transactions are not contiguous'
                            USING ERRCODE = '23514';
                    END IF;
                    IF EXISTS (
                        SELECT 1
                          FROM {_ENTRY_TABLE}
                         WHERE run_id = NEW.id
                         GROUP BY transaction_index, commodity
                        HAVING sum(amount) <> 0
                    ) THEN
                        RAISE EXCEPTION 'broker economic ledger transaction is unbalanced'
                            USING ERRCODE = '23514';
                    END IF;
                           SELECT encode(
                               sha256(
                                   convert_to(
                                       '[' || COALESCE(
                                           string_agg(
                                               to_json(transaction_sha256)::text,
                                               ',' ORDER BY transaction_index
                                           ),
                                           ''
                                       ) || ']',
                                       'UTF8'
                                   )
                               ),
                               'hex'
                           )
                      INTO computed_journal_sha256
                      FROM (
                          SELECT transaction_index,
                                 min(transaction_sha256) AS transaction_sha256
                            FROM {_ENTRY_TABLE}
                           WHERE run_id = NEW.id
                           GROUP BY transaction_index
                      ) AS transaction_digests;
                    IF computed_journal_sha256 IS DISTINCT FROM NEW.journal_sha256 THEN
                        RAISE EXCEPTION 'broker economic ledger journal digest mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'broker economic ledger reducer is unsupported'
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
            CREATE TRIGGER trg_guard_broker_economic_ledger_run
            BEFORE INSERT OR UPDATE OR DELETE ON {_RUN_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {_RUN_GUARD}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_economic_ledger_run_truncate
            BEFORE TRUNCATE ON {_RUN_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_RUN_GUARD}()
            """
        )
    )


def upgrade() -> None:
    _add_closed_scan_watermark()
    _remove_activity_guard_pgcrypto_dependency()
    _create_input_table()
    _create_run_table()
    _create_entry_table()
    _create_input_guard()
    _create_entry_guard()
    _create_run_guard()


def downgrade() -> None:
    op.execute(
        sa.text(
            f"""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM {_INPUT_TABLE})
                   OR EXISTS (SELECT 1 FROM {_RUN_TABLE})
                   OR EXISTS (SELECT 1 FROM {_ENTRY_TABLE}) THEN
                    RAISE EXCEPTION 'refusing to discard broker economic ledger evidence'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )
    op.execute(
        sa.text(
            f"DROP TRIGGER trg_guard_broker_economic_ledger_run_truncate ON {_RUN_TABLE}"
        )
    )
    op.execute(
        sa.text(f"DROP TRIGGER trg_guard_broker_economic_ledger_run ON {_RUN_TABLE}")
    )
    op.execute(sa.text(f"DROP FUNCTION {_RUN_GUARD}()"))
    op.execute(
        sa.text(
            f"DROP TRIGGER trg_guard_broker_economic_ledger_entry_truncate ON {_ENTRY_TABLE}"
        )
    )
    op.execute(
        sa.text(
            f"DROP TRIGGER trg_guard_broker_economic_ledger_entry ON {_ENTRY_TABLE}"
        )
    )
    op.execute(sa.text(f"DROP FUNCTION {_ENTRY_GUARD}()"))
    op.execute(
        sa.text(
            f"DROP TRIGGER trg_guard_broker_economic_ledger_input_truncate ON {_INPUT_TABLE}"
        )
    )
    op.execute(
        sa.text(
            f"DROP TRIGGER trg_guard_broker_economic_ledger_input ON {_INPUT_TABLE}"
        )
    )
    op.execute(sa.text(f"DROP FUNCTION {_INPUT_GUARD}()"))
    op.drop_table(_ENTRY_TABLE)
    op.drop_table(_RUN_TABLE)
    op.drop_table(_INPUT_TABLE)
    op.drop_constraint(
        "ck_broker_account_activity_cursors_completed_watermark",
        _CURSOR_TABLE,
        type_="check",
    )
    op.drop_column(_CURSOR_TABLE, "last_completed_scan_until")

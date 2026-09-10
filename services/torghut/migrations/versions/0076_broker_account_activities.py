"""Add immutable Alpaca account activities and one durable REST cursor.

Revision ID: 0076_broker_account_activities
Revises: 0075_validation_observed_at
Create Date: 2026-07-16 01:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import conv


revision = "0076_broker_account_activities"
down_revision = "0075_validation_observed_at"
branch_labels = None
depends_on = None


_ACTIVITY_TABLE = "broker_account_activities"
_CURSOR_TABLE = "broker_account_activity_cursors"
_GUARD_FUNCTION = "torghut_guard_broker_account_activity_0076"


def _create_activity_table() -> None:
    op.create_table(
        _ACTIVITY_TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("endpoint_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("external_activity_id", sa.String(length=256), nullable=False),
        sa.Column("activity_type", sa.String(length=32), nullable=False),
        sa.Column("activity_subtype", sa.String(length=32), nullable=True),
        sa.Column("correction_of_external_id", sa.String(length=256), nullable=True),
        sa.Column("event_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settle_date", sa.Date(), nullable=True),
        sa.Column("order_id", sa.String(length=128), nullable=True),
        sa.Column("client_order_id", sa.String(length=128), nullable=True),
        sa.Column("symbol", sa.String(length=64), nullable=True),
        sa.Column("side", sa.String(length=16), nullable=True),
        sa.Column("quantity", sa.Numeric(38, 18), nullable=True),
        sa.Column("price", sa.Numeric(38, 18), nullable=True),
        sa.Column("cumulative_quantity", sa.Numeric(38, 18), nullable=True),
        sa.Column("leaves_quantity", sa.Numeric(38, 18), nullable=True),
        sa.Column("net_amount", sa.Numeric(38, 18), nullable=True),
        sa.Column("currency", sa.String(length=16), nullable=True),
        sa.Column(
            "raw_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("raw_payload_canonical_json", sa.Text(), nullable=False),
        sa.Column("raw_payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("normalized_economic_sha256", sa.String(length=64), nullable=False),
        sa.Column("source_page_token", sa.String(length=256), nullable=True),
        sa.Column("source_topic", sa.String(length=128), nullable=True),
        sa.Column("source_partition", sa.BigInteger(), nullable=True),
        sa.Column("source_offset", sa.BigInteger(), nullable=True),
        sa.Column("first_observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "btrim(provider) <> '' AND btrim(source) <> '' "
            "AND btrim(environment) <> '' AND btrim(account_label) <> ''",
            name=conv("ck_broker_account_activities_scope"),
        ),
        sa.CheckConstraint(
            "btrim(external_activity_id) <> '' AND btrim(activity_type) <> ''",
            name=conv("ck_broker_account_activities_identity"),
        ),
        sa.CheckConstraint(
            "endpoint_fingerprint ~ '^[0-9a-f]{64}$'",
            name=conv("ck_broker_account_activities_endpoint_fingerprint"),
        ),
        sa.CheckConstraint(
            "raw_payload_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_broker_account_activities_payload_digest"),
        ),
        sa.CheckConstraint(
            "normalized_economic_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_broker_account_activities_economic_digest"),
        ),
        sa.CheckConstraint(
            "num_nonnulls(source_topic, source_partition, source_offset) IN (0, 3) "
            "AND (source_topic IS NULL OR btrim(source_topic) <> '') "
            "AND (source_partition IS NULL OR source_partition >= 0) "
            "AND (source_offset IS NULL OR source_offset >= 0)",
            name=conv("ck_broker_account_activities_stream_position"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(raw_payload) = 'object'",
            name=conv("ck_broker_account_activities_payload_object"),
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_broker_account_activities")),
    )
    op.create_index(
        "uq_broker_account_activities_external_identity",
        _ACTIVITY_TABLE,
        [
            "provider",
            "source",
            "environment",
            "account_label",
            "external_activity_id",
        ],
        unique=True,
    )
    op.create_index(
        "ix_broker_account_activities_scope_event",
        _ACTIVITY_TABLE,
        [
            "provider",
            "environment",
            "account_label",
            "source",
            "activity_type",
            "event_at",
        ],
    )
    op.create_index(
        "uq_broker_account_activities_source_offset",
        _ACTIVITY_TABLE,
        ["source_topic", "source_partition", "source_offset"],
        unique=True,
        postgresql_where=sa.text("source_offset IS NOT NULL"),
    )


def _create_cursor_table() -> None:
    op.create_table(
        _CURSOR_TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("endpoint_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'idle'"),
        ),
        sa.Column("scan_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scan_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_page_token", sa.String(length=256), nullable=True),
        sa.Column("last_activity_id", sa.String(length=256), nullable=True),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("scan_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "pages_processed",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "activities_seen",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "activities_inserted",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "btrim(provider) <> '' AND btrim(source) <> '' "
            "AND btrim(environment) <> '' AND btrim(account_label) <> ''",
            name=conv("ck_broker_account_activity_cursors_scope"),
        ),
        sa.CheckConstraint(
            "endpoint_fingerprint ~ '^[0-9a-f]{64}$'",
            name=conv("ck_broker_account_activity_cursors_endpoint_fingerprint"),
        ),
        sa.CheckConstraint(
            "status IN ('idle', 'scanning', 'complete', 'error')",
            name=conv("ck_broker_account_activity_cursors_status"),
        ),
        sa.CheckConstraint(
            "scan_until IS NULL OR scan_until >= scan_after",
            name=conv("ck_broker_account_activity_cursors_window"),
        ),
        sa.CheckConstraint(
            "pages_processed >= 0 AND activities_seen >= 0 "
            "AND activities_inserted >= 0 "
            "AND activities_inserted <= activities_seen",
            name=conv("ck_broker_account_activity_cursors_counts"),
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_broker_account_activity_cursors")),
    )
    op.create_index(
        "uq_broker_account_activity_cursors_scope",
        _CURSOR_TABLE,
        [
            "provider",
            "source",
            "environment",
            "account_label",
            "endpoint_fingerprint",
        ],
        unique=True,
    )


def _create_activity_guard() -> None:
    op.execute(sa.text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_GUARD_FUNCTION}()
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
                    digest(
                        convert_to(NEW.raw_payload_canonical_json, 'UTF8'),
                        'sha256'
                    ),
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
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_account_activity
            BEFORE INSERT OR UPDATE OR DELETE ON {_ACTIVITY_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {_GUARD_FUNCTION}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER trg_guard_broker_account_activity_truncate
            BEFORE TRUNCATE ON {_ACTIVITY_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_GUARD_FUNCTION}()
            """
        )
    )


def upgrade() -> None:
    _create_activity_table()
    _create_cursor_table()
    _create_activity_guard()


def downgrade() -> None:
    op.execute(
        sa.text(
            f"""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM {_ACTIVITY_TABLE}) THEN
                    RAISE EXCEPTION
                        'refusing to discard broker account activity evidence'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )
    op.execute(
        sa.text(
            f"DROP TRIGGER trg_guard_broker_account_activity_truncate "
            f"ON {_ACTIVITY_TABLE}"
        )
    )
    op.execute(
        sa.text(f"DROP TRIGGER trg_guard_broker_account_activity ON {_ACTIVITY_TABLE}")
    )
    op.execute(sa.text(f"DROP FUNCTION {_GUARD_FUNCTION}()"))
    op.drop_table(_CURSOR_TABLE)
    op.drop_table(_ACTIVITY_TABLE)

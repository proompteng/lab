"""Add closed order-lineage census runs.

Revision ID: 0082_order_lineage_runs
Revises: 0081_order_lineage_receipts
Create Date: 2026-07-17 01:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import conv


revision = "0082_order_lineage_runs"
down_revision = "0081_order_lineage_receipts"
branch_labels = None
depends_on = None


_TABLE = "order_lineage_repair_runs"
_GUARD = "torghut_guard_order_lineage_run_0082"
_ROW_TRIGGER = "trg_guard_order_lineage_run"
_TRUNCATE_TRIGGER = "trg_guard_order_lineage_run_truncate"


def _create_table() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("repair_version", sa.String(length=64), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column(
            "broker_economic_input_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "input_manifest",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("input_manifest_canonical_json", sa.Text(), nullable=False),
        sa.Column("input_manifest_sha256", sa.String(length=64), nullable=False),
        sa.Column("receipt_count", sa.BigInteger(), nullable=False),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("result_canonical_json", sa.Text(), nullable=False),
        sa.Column("result_sha256", sa.String(length=64), nullable=False),
        sa.Column(
            "promotion_authority_eligible",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(repair_version) BETWEEN 1 AND 64 "
            "AND length(provider) BETWEEN 1 AND 32 "
            "AND length(environment) BETWEEN 1 AND 16 "
            "AND length(account_label) BETWEEN 1 AND 64",
            name=conv("ck_order_lineage_run_scope"),
        ),
        sa.CheckConstraint(
            "input_manifest_sha256 ~ '^[0-9a-f]{64}$' "
            "AND result_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_order_lineage_run_hashes"),
        ),
        sa.CheckConstraint(
            "receipt_count >= 0",
            name=conv("ck_order_lineage_run_receipt_count"),
        ),
        sa.CheckConstraint(
            "promotion_authority_eligible IS FALSE",
            name=conv("ck_order_lineage_run_non_promotional"),
        ),
        sa.ForeignKeyConstraint(
            ["broker_economic_input_id"],
            ["broker_economic_ledger_inputs.id"],
            name=conv("fk_order_lineage_run_broker_input"),
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_order_lineage_repair_runs")),
    )
    op.create_index(
        "uq_order_lineage_run_input",
        _TABLE,
        [
            "repair_version",
            "provider",
            "environment",
            "account_label",
            "input_manifest_sha256",
        ],
        unique=True,
    )
    op.create_index(
        "ix_order_lineage_run_current",
        _TABLE,
        [
            "repair_version",
            "provider",
            "environment",
            "account_label",
            "created_at",
        ],
    )
    op.create_index(
        "ix_order_lineage_run_broker_input",
        _TABLE,
        ["broker_economic_input_id"],
    )


def _create_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                input_document jsonb;
                result_document jsonb;
                scope_document jsonb;
                broker_order_links_document jsonb;
                order_feed_document jsonb;
                executions_document jsonb;
                expected_input_canonical_json text;
                expected_result_canonical_json text;
                expected_broker_source_watermark text;
                classification_counts jsonb;
                classified_receipt_count bigint;
                confidence_counts jsonb;
                confidence_receipt_count bigint;
                execution_source_counts jsonb;
                execution_source_receipt_count bigint;
                source_coverage_counts jsonb;
                source_covered_receipt_count bigint;
                persisted_receipt_count bigint;
                persisted_receipt_set_sha256 text;
                persisted_classification_counts jsonb;
                persisted_confidence_counts jsonb;
                persisted_execution_source_counts jsonb;
                persisted_source_coverage_counts jsonb;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'order lineage repair run is append-only'
                        USING ERRCODE = '23514';
                END IF;
                BEGIN
                    input_document := NEW.input_manifest_canonical_json::jsonb;
                    result_document := NEW.result_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'order lineage repair run JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                expected_input_canonical_json := NEW.input_manifest::text;
                expected_result_canonical_json := NEW.result::text;
                IF NEW.input_manifest_canonical_json
                       IS DISTINCT FROM expected_input_canonical_json
                   OR NEW.result_canonical_json
                       IS DISTINCT FROM expected_result_canonical_json THEN
                    RAISE EXCEPTION 'order lineage run JSON is not canonical'
                        USING ERRCODE = '23514';
                END IF;
                IF input_document IS DISTINCT FROM NEW.input_manifest
                   OR result_document IS DISTINCT FROM NEW.result THEN
                    RAISE EXCEPTION 'order lineage repair run document mismatch'
                        USING ERRCODE = '23514';
                END IF;
                scope_document := input_document->'scope';
                broker_order_links_document :=
                    input_document->'broker_order_links';
                order_feed_document := input_document->'order_feed';
                executions_document := input_document->'executions';
                IF jsonb_typeof(input_document) IS DISTINCT FROM 'object'
                   OR jsonb_typeof(result_document) IS DISTINCT FROM 'object'
                   OR jsonb_typeof(scope_document) IS DISTINCT FROM 'object'
                   OR jsonb_typeof(broker_order_links_document)
                       IS DISTINCT FROM 'object'
                   OR jsonb_typeof(order_feed_document) IS DISTINCT FROM 'object'
                   OR jsonb_typeof(executions_document) IS DISTINCT FROM 'object'
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(input_document)
                   ) <> 12
                   OR NOT input_document ?& ARRAY[
                       'broker_activity_count',
                       'broker_economic_input_id',
                       'broker_economic_manifest_sha256',
                       'broker_economic_source',
                       'broker_order_links',
                       'broker_source_watermark',
                       'executions',
                       'expected_order_identity_count',
                       'order_feed',
                       'repair_version',
                       'schema_version',
                       'scope'
                   ]
                   OR (SELECT count(*) FROM jsonb_object_keys(scope_document)) <> 3
                   OR NOT scope_document ?& ARRAY[
                       'account_label', 'environment', 'provider'
                   ]
                   OR (
                       SELECT count(*)
                         FROM jsonb_object_keys(broker_order_links_document)
                   ) <> 5
                   OR NOT broker_order_links_document ?& ARRAY[
                       'activity_count',
                       'activity_set_sha256',
                       'fill_count',
                       'first_activity_at',
                       'last_activity_at'
                   ]
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(order_feed_document)
                   ) <> 5
                   OR NOT order_feed_document ?& ARRAY[
                       'event_count',
                       'event_set_sha256',
                       'first_event_at',
                       'last_event_at',
                       'partitions'
                   ]
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(executions_document)
                   ) <> 5
                   OR NOT executions_document ?& ARRAY[
                       'canonical_account_label_sha256',
                       'canonical_execution_count',
                       'execution_set_sha256',
                       'latest_updated_at',
                       'local_execution_count'
                   ]
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(result_document)
                   ) <> 9
                   OR NOT result_document ?& ARRAY[
                       'classification_counts',
                       'confidence_counts',
                       'execution_source_counts',
                       'promotion_authority_eligible',
                       'receipt_count',
                       'receipt_set_sha256',
                       'repair_version',
                       'schema_version',
                       'source_coverage_counts'
                   ] THEN
                    RAISE EXCEPTION 'order lineage repair run shape mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF jsonb_typeof(input_document->'schema_version')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(input_document->'repair_version')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(input_document->'broker_economic_input_id')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(input_document->'broker_economic_source')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(
                       input_document->'broker_economic_manifest_sha256'
                   ) IS DISTINCT FROM 'string'
                   OR jsonb_typeof(input_document->'broker_source_watermark')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(input_document->'broker_activity_count')
                       IS DISTINCT FROM 'number'
                   OR jsonb_typeof(
                       input_document->'expected_order_identity_count'
                   ) IS DISTINCT FROM 'number'
                   OR jsonb_typeof(scope_document->'provider')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(scope_document->'environment')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(scope_document->'account_label')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(
                       broker_order_links_document->'activity_count'
                   ) IS DISTINCT FROM 'number'
                   OR jsonb_typeof(
                       broker_order_links_document->'activity_set_sha256'
                   ) IS DISTINCT FROM 'string'
                   OR jsonb_typeof(broker_order_links_document->'fill_count')
                       IS DISTINCT FROM 'number'
                   OR jsonb_typeof(
                       broker_order_links_document->'first_activity_at'
                   ) NOT IN ('null', 'string')
                   OR jsonb_typeof(
                       broker_order_links_document->'last_activity_at'
                   ) NOT IN ('null', 'string')
                   OR jsonb_typeof(order_feed_document->'event_count')
                       IS DISTINCT FROM 'number'
                   OR jsonb_typeof(order_feed_document->'event_set_sha256')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(order_feed_document->'first_event_at')
                       NOT IN ('null', 'string')
                   OR jsonb_typeof(order_feed_document->'last_event_at')
                       NOT IN ('null', 'string')
                   OR jsonb_typeof(order_feed_document->'partitions')
                       IS DISTINCT FROM 'array'
                   OR jsonb_typeof(
                       executions_document->'canonical_account_label_sha256'
                   ) IS DISTINCT FROM 'string'
                   OR jsonb_typeof(
                       executions_document->'canonical_execution_count'
                   ) IS DISTINCT FROM 'number'
                   OR jsonb_typeof(executions_document->'execution_set_sha256')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(executions_document->'latest_updated_at')
                       NOT IN ('null', 'string')
                   OR jsonb_typeof(
                       executions_document->'local_execution_count'
                   ) IS DISTINCT FROM 'number'
                   OR jsonb_typeof(result_document->'schema_version')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(result_document->'repair_version')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(result_document->'receipt_count')
                       IS DISTINCT FROM 'number'
                   OR jsonb_typeof(result_document->'receipt_set_sha256')
                       IS DISTINCT FROM 'string'
                   OR jsonb_typeof(
                       result_document->'promotion_authority_eligible'
                   ) IS DISTINCT FROM 'boolean' THEN
                    RAISE EXCEPTION 'order lineage repair run types mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF input_document->>'broker_activity_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR input_document->>'expected_order_identity_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR broker_order_links_document->>'activity_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR broker_order_links_document->>'fill_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR order_feed_document->>'event_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR executions_document->>'canonical_execution_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR executions_document->>'local_execution_count'
                       !~ '^(0|[1-9][0-9]*)$'
                   OR broker_order_links_document->>'activity_set_sha256'
                       !~ '^[0-9a-f]{{64}}$'
                   OR order_feed_document->>'event_set_sha256'
                       !~ '^[0-9a-f]{{64}}$'
                   OR executions_document->>'canonical_account_label_sha256'
                       !~ '^[0-9a-f]{{64}}$'
                   OR executions_document->>'execution_set_sha256'
                       !~ '^[0-9a-f]{{64}}$' THEN
                    RAISE EXCEPTION 'order lineage repair source manifest mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(
                          order_feed_document->'partitions'
                      ) AS partition_document
                     WHERE jsonb_typeof(partition_document)
                               IS DISTINCT FROM 'object'
                        OR NOT (
                            (
                                (SELECT count(*)
                                   FROM jsonb_object_keys(partition_document)) = 5
                                AND partition_document ?& ARRAY[
                                    'event_count',
                                    'max_offset',
                                    'min_offset',
                                    'partition',
                                    'topic'
                                ]
                                AND jsonb_typeof(
                                    partition_document->'event_count'
                                ) = 'number'
                                AND jsonb_typeof(
                                    partition_document->'max_offset'
                                ) = 'number'
                                AND jsonb_typeof(
                                    partition_document->'min_offset'
                                ) = 'number'
                                AND jsonb_typeof(
                                    partition_document->'partition'
                                ) = 'number'
                                AND jsonb_typeof(partition_document->'topic')
                                    = 'string'
                                AND partition_document->>'event_count'
                                    ~ '^[1-9][0-9]*$'
                                AND partition_document->>'max_offset'
                                    ~ '^(0|[1-9][0-9]*)$'
                                AND partition_document->>'min_offset'
                                    ~ '^(0|[1-9][0-9]*)$'
                                AND partition_document->>'partition'
                                    ~ '^(0|[1-9][0-9]*)$'
                                AND length(btrim(partition_document->>'topic')) > 0
                            )
                            OR (
                                (SELECT count(*)
                                   FROM jsonb_object_keys(partition_document)) = 1
                                AND partition_document ? 'missing_offset_count'
                                AND jsonb_typeof(
                                    partition_document->'missing_offset_count'
                                ) = 'number'
                                AND partition_document->>'missing_offset_count'
                                    ~ '^[1-9][0-9]*$'
                            )
                        )
                ) THEN
                    RAISE EXCEPTION 'order lineage order-feed partitions mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.input_manifest_sha256 IS DISTINCT FROM encode(
                    sha256(convert_to(NEW.input_manifest_canonical_json, 'UTF8')),
                    'hex'
                ) OR NEW.result_sha256 IS DISTINCT FROM encode(
                    sha256(convert_to(NEW.result_canonical_json, 'UTF8')),
                    'hex'
                ) THEN
                    RAISE EXCEPTION 'order lineage repair run hash mismatch'
                        USING ERRCODE = '23514';
                END IF;
                SELECT to_char(
                           broker_input.source_watermark AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS'
                       ) || CASE
                           WHEN extract(
                               microseconds FROM broker_input.source_watermark
                           )::bigint % 1000000 = 0 THEN ''
                           ELSE '.' || lpad(
                               (
                                   extract(
                                       microseconds
                                       FROM broker_input.source_watermark
                                   )::bigint % 1000000
                               )::text,
                               6,
                               '0'
                           )
                       END || '+00:00'
                  INTO expected_broker_source_watermark
                  FROM broker_economic_ledger_inputs AS broker_input
                 WHERE broker_input.id = NEW.broker_economic_input_id;
                IF NEW.repair_version IS DISTINCT FROM btrim(NEW.repair_version)
                   OR NEW.provider IS DISTINCT FROM btrim(NEW.provider)
                   OR NEW.environment IS DISTINCT FROM btrim(NEW.environment)
                   OR NEW.account_label IS DISTINCT FROM btrim(NEW.account_label)
                   OR input_document->>'schema_version'
                       IS DISTINCT FROM 'torghut.order-lineage-census-input.v1'
                   OR input_document->>'repair_version'
                       IS DISTINCT FROM NEW.repair_version
                   OR input_document#>>'{{scope,provider}}'
                       IS DISTINCT FROM NEW.provider
                   OR input_document#>>'{{scope,environment}}'
                       IS DISTINCT FROM NEW.environment
                   OR input_document#>>'{{scope,account_label}}'
                       IS DISTINCT FROM NEW.account_label
                   OR input_document->>'broker_economic_input_id'
                       IS DISTINCT FROM NEW.broker_economic_input_id::text
                   OR (input_document->>'expected_order_identity_count')::bigint
                       IS DISTINCT FROM NEW.receipt_count
                   OR input_document->>'broker_economic_source'
                       IS DISTINCT FROM btrim(
                           input_document->>'broker_economic_source'
                       )
                   OR length(input_document->>'broker_economic_source') = 0
                   OR input_document->>'broker_economic_manifest_sha256'
                       !~ '^[0-9a-f]{{64}}$'
                   OR input_document->>'broker_source_watermark'
                       IS DISTINCT FROM expected_broker_source_watermark THEN
                    RAISE EXCEPTION 'order lineage repair run input mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NOT EXISTS (
                    SELECT 1
                      FROM broker_economic_ledger_inputs AS broker_input
                     WHERE broker_input.id = NEW.broker_economic_input_id
                       AND broker_input.provider = NEW.provider
                       AND broker_input.source =
                           input_document->>'broker_economic_source'
                       AND broker_input.environment = NEW.environment
                       AND broker_input.account_label = NEW.account_label
                       AND broker_input.manifest_sha256 =
                           input_document->>'broker_economic_manifest_sha256'
                       AND broker_input.input_count =
                           (input_document->>'broker_activity_count')::bigint
                       AND broker_input.source_watermark =
                           (input_document->>'broker_source_watermark')::timestamptz
                ) THEN
                    RAISE EXCEPTION 'order lineage broker input mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF result_document->>'schema_version'
                       IS DISTINCT FROM 'torghut.order-lineage-census-result.v1'
                   OR result_document->>'repair_version'
                       IS DISTINCT FROM NEW.repair_version
                   OR (result_document->>'receipt_count')::bigint
                       IS DISTINCT FROM NEW.receipt_count
                   OR (result_document->>'promotion_authority_eligible')::boolean
                       IS DISTINCT FROM NEW.promotion_authority_eligible
                   OR result_document->>'receipt_set_sha256'
                       !~ '^[0-9a-f]{{64}}$' THEN
                    RAISE EXCEPTION 'order lineage repair run result mismatch'
                        USING ERRCODE = '23514';
                END IF;
                WITH current_receipts AS (
                    SELECT DISTINCT ON (receipt.order_identity_sha256)
                           receipt.order_identity_sha256,
                           receipt.evidence_sha256,
                           receipt.classification,
                           receipt.confidence,
                           receipt.execution_source,
                           receipt.evidence
                      FROM order_lineage_repair_receipts AS receipt
                     WHERE receipt.repair_version = NEW.repair_version
                       AND receipt.provider = NEW.provider
                       AND receipt.environment = NEW.environment
                       AND receipt.account_label = NEW.account_label
                     ORDER BY receipt.order_identity_sha256,
                              receipt.source_last_at DESC,
                              receipt.created_at DESC,
                              receipt.id DESC
                )
                SELECT count(*),
                       encode(
                           sha256(
                               convert_to(
                                   COALESCE(
                                       jsonb_agg(
                                           jsonb_build_array(
                                               order_identity_sha256,
                                               evidence_sha256
                                           )
                                           ORDER BY order_identity_sha256
                                       ),
                                       '[]'::jsonb
                                   )::text,
                                   'UTF8'
                               )
                           ),
                           'hex'
                       ),
                       jsonb_build_object(
                           'ambiguous', count(*) FILTER (
                               WHERE classification = 'ambiguous'
                           ),
                           'broker_activity_only', count(*) FILTER (
                               WHERE classification = 'broker_activity_only'
                           ),
                           'complete', count(*) FILTER (
                               WHERE classification = 'complete'
                           ),
                           'external_or_unproved', count(*) FILTER (
                               WHERE classification = 'external_or_unproved'
                           ),
                           'linked_incomplete', count(*) FILTER (
                               WHERE classification = 'linked_incomplete'
                           ),
                           'order_feed_only', count(*) FILTER (
                               WHERE classification = 'order_feed_only'
                           )
                       ),
                       jsonb_build_object(
                           'ambiguous', count(*) FILTER (
                               WHERE confidence = 'ambiguous'
                           ),
                           'exact', count(*) FILTER (
                               WHERE confidence = 'exact'
                           ),
                           'unproved', count(*) FILTER (
                               WHERE confidence = 'unproved'
                           )
                       ),
                       jsonb_build_object(
                           'canonical_cross_dsn', count(*) FILTER (
                               WHERE execution_source = 'canonical_cross_dsn'
                           ),
                           'local', count(*) FILTER (
                               WHERE execution_source = 'local'
                           ),
                           'none', count(*) FILTER (
                               WHERE execution_source = 'none'
                           )
                       ),
                       jsonb_build_object(
                           'both', count(*) FILTER (
                               WHERE (evidence#>>'{{sources,counts,order_events}}')::bigint > 0
                                 AND (evidence#>>'{{sources,counts,broker_activities}}')::bigint > 0
                           ),
                           'broker_activity_only', count(*) FILTER (
                               WHERE (evidence#>>'{{sources,counts,order_events}}')::bigint = 0
                                 AND (evidence#>>'{{sources,counts,broker_activities}}')::bigint > 0
                           ),
                           'order_feed_only', count(*) FILTER (
                               WHERE (evidence#>>'{{sources,counts,order_events}}')::bigint > 0
                                 AND (evidence#>>'{{sources,counts,broker_activities}}')::bigint = 0
                           )
                       )
                  INTO persisted_receipt_count,
                       persisted_receipt_set_sha256,
                       persisted_classification_counts,
                       persisted_confidence_counts,
                       persisted_execution_source_counts,
                       persisted_source_coverage_counts
                  FROM current_receipts;
                IF persisted_receipt_count IS DISTINCT FROM NEW.receipt_count
                   OR persisted_receipt_set_sha256 IS DISTINCT FROM
                       result_document->>'receipt_set_sha256' THEN
                    RAISE EXCEPTION 'order lineage receipt membership mismatch'
                        USING ERRCODE = '23514';
                END IF;
                classification_counts := result_document->'classification_counts';
                IF jsonb_typeof(classification_counts) IS DISTINCT FROM 'object'
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(classification_counts)
                   ) <> 6
                   OR NOT classification_counts ?& ARRAY[
                       'ambiguous',
                       'broker_activity_only',
                       'complete',
                       'external_or_unproved',
                       'linked_incomplete',
                       'order_feed_only'
                   ]
                   OR EXISTS (
                       SELECT 1
                         FROM jsonb_each_text(classification_counts)
                        WHERE value !~ '^(0|[1-9][0-9]*)$'
                   ) THEN
                    RAISE EXCEPTION 'order lineage classification counts missing'
                        USING ERRCODE = '23514';
                END IF;
                SELECT COALESCE(sum(value::bigint), 0)
                  INTO classified_receipt_count
                  FROM jsonb_each_text(classification_counts);
                IF classified_receipt_count IS DISTINCT FROM NEW.receipt_count
                   OR classification_counts IS DISTINCT FROM
                       persisted_classification_counts THEN
                    RAISE EXCEPTION 'order lineage classification counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                confidence_counts := result_document->'confidence_counts';
                IF jsonb_typeof(confidence_counts) IS DISTINCT FROM 'object'
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(confidence_counts)
                   ) <> 3
                   OR NOT confidence_counts ?& ARRAY[
                       'ambiguous', 'exact', 'unproved'
                   ]
                   OR EXISTS (
                       SELECT 1
                         FROM jsonb_each_text(confidence_counts)
                        WHERE value !~ '^(0|[1-9][0-9]*)$'
                   ) THEN
                    RAISE EXCEPTION 'order lineage confidence counts missing'
                        USING ERRCODE = '23514';
                END IF;
                SELECT COALESCE(sum(value::bigint), 0)
                  INTO confidence_receipt_count
                  FROM jsonb_each_text(confidence_counts);
                IF confidence_receipt_count IS DISTINCT FROM NEW.receipt_count
                   OR confidence_counts IS DISTINCT FROM
                       persisted_confidence_counts THEN
                    RAISE EXCEPTION 'order lineage confidence counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                execution_source_counts :=
                    result_document->'execution_source_counts';
                IF jsonb_typeof(execution_source_counts) IS DISTINCT FROM 'object'
                   OR (
                       SELECT count(*)
                         FROM jsonb_object_keys(execution_source_counts)
                   ) <> 3
                   OR NOT execution_source_counts ?& ARRAY[
                       'canonical_cross_dsn', 'local', 'none'
                   ]
                   OR EXISTS (
                       SELECT 1
                         FROM jsonb_each_text(execution_source_counts)
                        WHERE value !~ '^(0|[1-9][0-9]*)$'
                   ) THEN
                    RAISE EXCEPTION 'order lineage execution source counts missing'
                        USING ERRCODE = '23514';
                END IF;
                SELECT COALESCE(sum(value::bigint), 0)
                  INTO execution_source_receipt_count
                  FROM jsonb_each_text(execution_source_counts);
                IF execution_source_receipt_count
                       IS DISTINCT FROM NEW.receipt_count
                   OR execution_source_counts IS DISTINCT FROM
                       persisted_execution_source_counts THEN
                    RAISE EXCEPTION 'order lineage execution source counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                source_coverage_counts :=
                    result_document->'source_coverage_counts';
                IF jsonb_typeof(source_coverage_counts) IS DISTINCT FROM 'object'
                   OR (
                       SELECT count(*) FROM jsonb_object_keys(source_coverage_counts)
                   ) <> 3
                   OR NOT source_coverage_counts ?& ARRAY[
                       'both',
                       'broker_activity_only',
                       'order_feed_only'
                   ]
                   OR EXISTS (
                       SELECT 1
                         FROM jsonb_each_text(source_coverage_counts)
                        WHERE value !~ '^(0|[1-9][0-9]*)$'
                   ) THEN
                    RAISE EXCEPTION 'order lineage source coverage counts missing'
                        USING ERRCODE = '23514';
                END IF;
                SELECT COALESCE(sum(value::bigint), 0)
                  INTO source_covered_receipt_count
                  FROM jsonb_each_text(source_coverage_counts);
                IF source_covered_receipt_count IS DISTINCT FROM NEW.receipt_count
                   OR source_coverage_counts IS DISTINCT FROM
                       persisted_source_coverage_counts THEN
                    RAISE EXCEPTION 'order lineage source coverage counts mismatch'
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
            FOR EACH ROW EXECUTE FUNCTION {_GUARD}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {_TRUNCATE_TRIGGER}
            BEFORE TRUNCATE ON {_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_GUARD}()
            """
        )
    )


def upgrade() -> None:
    _create_table()
    _create_guard()


def downgrade() -> None:
    op.execute(sa.text(f"DROP TRIGGER {_TRUNCATE_TRIGGER} ON {_TABLE}"))
    op.execute(sa.text(f"DROP TRIGGER {_ROW_TRIGGER} ON {_TABLE}"))
    op.execute(sa.text(f"DROP FUNCTION {_GUARD}()"))
    op.drop_table(_TABLE)

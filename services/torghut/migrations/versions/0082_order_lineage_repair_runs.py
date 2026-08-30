"""Add source-closed order-lineage census runs.

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


_IMPORT_TABLE = "order_lineage_canonical_execution_imports"
_IMPORT_GUARD = "torghut_guard_order_lineage_execution_import_0082"
_IMPORT_ROW_TRIGGER = "trg_guard_order_lineage_execution_import"
_IMPORT_TRUNCATE_TRIGGER = "trg_guard_order_lineage_execution_import_truncate"
_RUN_TABLE = "order_lineage_repair_runs"
_RUN_GUARD = "torghut_guard_order_lineage_run_0082"
_RUN_ROW_TRIGGER = "trg_guard_order_lineage_run"
_RUN_TRUNCATE_TRIGGER = "trg_guard_order_lineage_run_truncate"


def _create_import_table() -> None:
    op.create_table(
        _IMPORT_TABLE,
        sa.Column("manifest_sha256", sa.String(length=64), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("source_database_sha256", sa.String(length=64), nullable=False),
        sa.Column(
            "canonical_account_label_sha256",
            sa.String(length=64),
            nullable=False,
        ),
        sa.Column("execution_count", sa.BigInteger(), nullable=False),
        sa.Column("execution_set_sha256", sa.String(length=64), nullable=False),
        sa.Column("latest_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "manifest",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("manifest_canonical_json", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "manifest_sha256 ~ '^[0-9a-f]{64}$' "
            "AND source_database_sha256 ~ '^[0-9a-f]{64}$' "
            "AND canonical_account_label_sha256 ~ '^[0-9a-f]{64}$' "
            "AND execution_set_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_order_lineage_execution_import_hashes"),
        ),
        sa.CheckConstraint(
            "execution_count >= 0",
            name=conv("ck_order_lineage_execution_import_count"),
        ),
        sa.PrimaryKeyConstraint(
            "manifest_sha256",
            name=conv("pk_order_lineage_canonical_execution_imports"),
        ),
    )
    op.create_index(
        "ix_order_lineage_execution_import_scope",
        _IMPORT_TABLE,
        ["provider", "environment", "account_label", "created_at"],
    )


def _create_run_table() -> None:
    op.create_table(
        _RUN_TABLE,
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
            "canonical_execution_import_sha256",
            sa.String(length=64),
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
        sa.ForeignKeyConstraint(
            ["canonical_execution_import_sha256"],
            [f"{_IMPORT_TABLE}.manifest_sha256"],
            name=conv("fk_order_lineage_run_execution_import"),
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_order_lineage_repair_runs")),
    )
    op.create_index(
        "uq_order_lineage_run_input",
        _RUN_TABLE,
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
        _RUN_TABLE,
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
        _RUN_TABLE,
        ["broker_economic_input_id"],
    )
    op.create_index(
        "ix_order_lineage_run_execution_import",
        _RUN_TABLE,
        ["canonical_execution_import_sha256"],
    )


def _create_import_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_IMPORT_GUARD}()
            RETURNS trigger LANGUAGE plpgsql SET timezone TO 'UTC' AS $$
            DECLARE
                manifest_document jsonb;
                expected_manifest jsonb;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'order lineage execution import is append-only'
                        USING ERRCODE = '23514';
                END IF;
                BEGIN
                    manifest_document := NEW.manifest_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'order lineage execution import JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                IF NEW.manifest_canonical_json IS DISTINCT FROM NEW.manifest::text
                   OR manifest_document IS DISTINCT FROM NEW.manifest THEN
                    RAISE EXCEPTION 'order lineage execution import JSON is not canonical'
                        USING ERRCODE = '23514';
                END IF;
                expected_manifest := jsonb_build_object(
                    'canonical_account_label_sha256',
                    NEW.canonical_account_label_sha256,
                    'execution_count', NEW.execution_count,
                    'execution_set_sha256', NEW.execution_set_sha256,
                    'latest_updated_at', to_jsonb(NEW.latest_updated_at),
                    'schema_version',
                    'torghut.order-lineage-canonical-execution-import.v1',
                    'scope', jsonb_build_object(
                        'account_label', NEW.account_label,
                        'environment', NEW.environment,
                        'provider', NEW.provider
                    ),
                    'source', 'canonical_cross_dsn',
                    'source_database_sha256', NEW.source_database_sha256
                );
                IF manifest_document IS DISTINCT FROM expected_manifest
                   OR NEW.provider IS DISTINCT FROM btrim(NEW.provider)
                   OR NEW.environment IS DISTINCT FROM btrim(NEW.environment)
                   OR NEW.account_label IS DISTINCT FROM btrim(NEW.account_label)
                   OR NEW.manifest_sha256 IS DISTINCT FROM encode(
                       sha256(convert_to(NEW.manifest_canonical_json, 'UTF8')),
                       'hex'
                   ) THEN
                    RAISE EXCEPTION 'order lineage execution import mismatch'
                        USING ERRCODE = '23514';
                END IF;
                NEW.created_at := clock_timestamp();
                RETURN NEW;
            END;
            $$
            """
        )
    )
    _create_guard_triggers(
        table=_IMPORT_TABLE,
        function=_IMPORT_GUARD,
        row_trigger=_IMPORT_ROW_TRIGGER,
        truncate_trigger=_IMPORT_TRUNCATE_TRIGGER,
    )


def _create_run_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_RUN_GUARD}()
            RETURNS trigger LANGUAGE plpgsql SET timezone TO 'UTC' AS $$
            DECLARE
                input_document jsonb;
                result_document jsonb;
                expected_input_document jsonb;
                expected_result_document jsonb;
                broker_source text;
                broker_endpoint_fingerprint text;
                broker_source_watermark timestamptz;
                broker_input_count bigint;
                broker_manifest_sha256 text;
                persisted_broker_links jsonb;
                persisted_order_feed jsonb;
                persisted_partitions jsonb;
                missing_offset_count bigint;
                local_execution_count bigint;
                local_execution_set_sha256 text;
                local_latest_updated_at timestamptz;
                imported_canonical_account_sha256 text;
                imported_execution_count bigint;
                imported_execution_set_sha256 text;
                imported_latest_updated_at timestamptz;
                expected_execution_set_sha256 text;
                expected_executions jsonb;
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
                IF NEW.input_manifest_canonical_json
                       IS DISTINCT FROM NEW.input_manifest::text
                   OR NEW.result_canonical_json IS DISTINCT FROM NEW.result::text
                   OR input_document IS DISTINCT FROM NEW.input_manifest
                   OR result_document IS DISTINCT FROM NEW.result THEN
                    RAISE EXCEPTION 'order lineage run JSON is not canonical'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.input_manifest_sha256 IS DISTINCT FROM encode(
                       sha256(convert_to(NEW.input_manifest_canonical_json, 'UTF8')),
                       'hex'
                   )
                   OR NEW.result_sha256 IS DISTINCT FROM encode(
                       sha256(convert_to(NEW.result_canonical_json, 'UTF8')),
                       'hex'
                   ) THEN
                    RAISE EXCEPTION 'order lineage repair run hash mismatch'
                        USING ERRCODE = '23514';
                END IF;

                SELECT broker_input.source,
                       broker_input.endpoint_fingerprint,
                       broker_input.source_watermark,
                       broker_input.input_count,
                       broker_input.manifest_sha256
                  INTO broker_source,
                       broker_endpoint_fingerprint,
                       broker_source_watermark,
                       broker_input_count,
                       broker_manifest_sha256
                  FROM broker_economic_ledger_inputs AS broker_input
                 WHERE broker_input.id = NEW.broker_economic_input_id
                   AND broker_input.provider = NEW.provider
                   AND broker_input.environment = NEW.environment
                   AND broker_input.account_label = NEW.account_label;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'order lineage broker input mismatch'
                        USING ERRCODE = '23514';
                END IF;

                WITH broker_rows AS (
                    SELECT activity.id,
                           activity.activity_type,
                           COALESCE(
                               activity.event_at,
                               activity.first_observed_at
                           ) AS effective_event_at,
                           jsonb_build_object(
                               'activity_type', activity.activity_type,
                               'broker_order_id', activity.order_id,
                               'client_order_id', activity.client_order_id,
                               'event_at', to_jsonb(COALESCE(
                                   activity.event_at,
                                   activity.first_observed_at
                               )),
                               'external_activity_id',
                               activity.external_activity_id,
                               'id', activity.id::text
                           ) AS payload
                      FROM broker_account_activities AS activity
                     WHERE activity.provider = NEW.provider
                       AND activity.source = broker_source
                       AND activity.environment = NEW.environment
                       AND activity.account_label = NEW.account_label
                       AND activity.endpoint_fingerprint =
                           broker_endpoint_fingerprint
                       AND (
                           activity.order_id IS NOT NULL
                           OR activity.client_order_id IS NOT NULL
                       )
                )
                SELECT jsonb_build_object(
                           'activity_count', count(*),
                           'activity_set_sha256', encode(
                               sha256(convert_to(COALESCE(
                                   jsonb_agg(payload ORDER BY id::text),
                                   '[]'::jsonb
                               )::text, 'UTF8')),
                               'hex'
                           ),
                           'fill_count', count(*) FILTER (
                               WHERE upper(activity_type) = 'FILL'
                           ),
                           'first_activity_at', to_jsonb(min(effective_event_at)),
                           'last_activity_at', to_jsonb(max(effective_event_at))
                       )
                  INTO persisted_broker_links
                  FROM broker_rows;

                SELECT COALESCE(jsonb_agg(
                           jsonb_build_object(
                               'event_count', partition_row.event_count,
                               'max_offset', partition_row.max_offset,
                               'min_offset', partition_row.min_offset,
                               'partition', partition_row.source_partition,
                               'topic', partition_row.source_topic
                           )
                           ORDER BY partition_row.source_topic,
                                    partition_row.source_partition
                       ), '[]'::jsonb)
                  INTO persisted_partitions
                  FROM (
                      SELECT event.source_topic,
                             event.source_partition,
                             count(*) AS event_count,
                             max(event.source_offset) AS max_offset,
                             min(event.source_offset) AS min_offset
                        FROM execution_order_events AS event
                       WHERE event.alpaca_account_label = NEW.account_label
                         AND event.source_partition IS NOT NULL
                         AND event.source_offset IS NOT NULL
                       GROUP BY event.source_topic, event.source_partition
                  ) AS partition_row;
                SELECT count(*)
                  INTO missing_offset_count
                  FROM execution_order_events AS event
                 WHERE event.alpaca_account_label = NEW.account_label
                   AND (
                       event.source_partition IS NULL
                       OR event.source_offset IS NULL
                   );
                IF missing_offset_count > 0 THEN
                    persisted_partitions := persisted_partitions ||
                        jsonb_build_array(jsonb_build_object(
                            'missing_offset_count', missing_offset_count
                        ));
                END IF;
                WITH event_rows AS (
                    SELECT event.id,
                           COALESCE(event.event_ts, event.created_at)
                               AS effective_event_at,
                           jsonb_build_object(
                               'broker_order_id', event.alpaca_order_id,
                               'client_order_id', event.client_order_id,
                               'event_at', to_jsonb(COALESCE(
                                   event.event_ts,
                                   event.created_at
                               )),
                               'event_fingerprint', event.event_fingerprint,
                               'execution_id', event.execution_id::text,
                               'id', event.id::text,
                               'is_fill', (
                                   event.filled_qty_delta IS NOT NULL
                                   AND event.filled_qty_delta > 0
                               ),
                               'source_offset', event.source_offset,
                               'source_partition', event.source_partition,
                               'source_topic', event.source_topic,
                               'trade_decision_id',
                               event.trade_decision_id::text
                           ) AS payload
                      FROM execution_order_events AS event
                     WHERE event.alpaca_account_label = NEW.account_label
                )
                SELECT jsonb_build_object(
                           'event_count', count(*),
                           'event_set_sha256', encode(
                               sha256(convert_to(COALESCE(
                                   jsonb_agg(payload ORDER BY id::text),
                                   '[]'::jsonb
                               )::text, 'UTF8')),
                               'hex'
                           ),
                           'first_event_at', to_jsonb(min(effective_event_at)),
                           'last_event_at', to_jsonb(max(effective_event_at)),
                           'partitions', persisted_partitions
                       )
                  INTO persisted_order_feed
                  FROM event_rows;

                WITH execution_rows AS (
                    SELECT execution.id,
                           execution.updated_at,
                           jsonb_build_object(
                               'broker_order_id', execution.alpaca_order_id,
                               'client_order_id', execution.client_order_id,
                               'execution_id', execution.id::text,
                               'idempotency_key',
                               execution.execution_idempotency_key,
                               'source', 'local',
                               'strategy_id', COALESCE(
                                   decision.strategy_id,
                                   metric.strategy_id
                               )::text,
                               'submission_claim_id',
                               claim.trade_decision_id::text,
                               'tca_metric_id', metric.id::text,
                               'trade_decision_id', decision.id::text,
                               'updated_at', to_jsonb(execution.updated_at)
                           ) AS payload
                      FROM executions AS execution
                      LEFT JOIN execution_tca_metrics AS metric
                        ON metric.execution_id = execution.id
                      LEFT JOIN trade_decisions AS decision
                        ON decision.id = COALESCE(
                            execution.trade_decision_id,
                            metric.trade_decision_id
                        )
                      LEFT JOIN trade_decision_submission_claims AS claim
                        ON claim.trade_decision_id = decision.id
                     WHERE execution.alpaca_account_label = NEW.account_label
                )
                SELECT count(*),
                       encode(sha256(convert_to(COALESCE(
                           jsonb_agg(payload ORDER BY id::text),
                           '[]'::jsonb
                       )::text, 'UTF8')), 'hex'),
                       max(updated_at)
                  INTO local_execution_count,
                       local_execution_set_sha256,
                       local_latest_updated_at
                  FROM execution_rows;

                SELECT imported.canonical_account_label_sha256,
                       imported.execution_count,
                       imported.execution_set_sha256,
                       imported.latest_updated_at
                  INTO imported_canonical_account_sha256,
                       imported_execution_count,
                       imported_execution_set_sha256,
                       imported_latest_updated_at
                  FROM {_IMPORT_TABLE} AS imported
                 WHERE imported.manifest_sha256 =
                           NEW.canonical_execution_import_sha256
                   AND imported.provider = NEW.provider
                   AND imported.environment = NEW.environment
                   AND imported.account_label = NEW.account_label;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'order lineage execution import mismatch'
                        USING ERRCODE = '23514';
                END IF;
                expected_execution_set_sha256 := encode(sha256(convert_to(
                    jsonb_build_array(
                        jsonb_build_object(
                            'execution_count', imported_execution_count,
                            'execution_set_sha256',
                            imported_execution_set_sha256,
                            'source', 'canonical_cross_dsn'
                        ),
                        jsonb_build_object(
                            'execution_count', local_execution_count,
                            'execution_set_sha256', local_execution_set_sha256,
                            'source', 'local'
                        )
                    )::text,
                    'UTF8'
                )), 'hex');
                expected_executions := jsonb_build_object(
                    'canonical_account_label_sha256',
                    imported_canonical_account_sha256,
                    'canonical_execution_count', imported_execution_count,
                    'canonical_execution_import_sha256',
                    NEW.canonical_execution_import_sha256,
                    'canonical_execution_set_sha256',
                    imported_execution_set_sha256,
                    'canonical_latest_updated_at',
                    to_jsonb(imported_latest_updated_at),
                    'execution_set_sha256', expected_execution_set_sha256,
                    'latest_updated_at', to_jsonb(greatest(
                        imported_latest_updated_at,
                        local_latest_updated_at
                    )),
                    'local_execution_count', local_execution_count,
                    'local_execution_set_sha256',
                    local_execution_set_sha256,
                    'local_latest_updated_at', to_jsonb(local_latest_updated_at)
                );
                expected_input_document := jsonb_build_object(
                    'broker_activity_count', broker_input_count,
                    'broker_economic_input_id',
                    NEW.broker_economic_input_id::text,
                    'broker_economic_manifest_sha256', broker_manifest_sha256,
                    'broker_economic_source', broker_source,
                    'broker_order_links', persisted_broker_links,
                    'broker_source_watermark', to_jsonb(broker_source_watermark),
                    'executions', expected_executions,
                    'expected_order_identity_count', NEW.receipt_count,
                    'order_feed', persisted_order_feed,
                    'repair_version', NEW.repair_version,
                    'schema_version',
                    'torghut.order-lineage-census-input.v1',
                    'scope', jsonb_build_object(
                        'account_label', NEW.account_label,
                        'environment', NEW.environment,
                        'provider', NEW.provider
                    )
                );
                IF input_document IS DISTINCT FROM expected_input_document THEN
                    RAISE EXCEPTION 'order lineage persisted source manifest mismatch'
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
                SELECT jsonb_build_object(
                           'classification_counts', jsonb_build_object(
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
                           'confidence_counts', jsonb_build_object(
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
                           'execution_source_counts', jsonb_build_object(
                               'canonical_cross_dsn', count(*) FILTER (
                                   WHERE execution_source =
                                       'canonical_cross_dsn'
                               ),
                               'local', count(*) FILTER (
                                   WHERE execution_source = 'local'
                               ),
                               'none', count(*) FILTER (
                                   WHERE execution_source = 'none'
                               )
                           ),
                           'promotion_authority_eligible', false,
                           'receipt_count', count(*),
                           'receipt_set_sha256', encode(sha256(convert_to(
                               COALESCE(jsonb_agg(jsonb_build_array(
                                   order_identity_sha256,
                                   evidence_sha256
                               ) ORDER BY order_identity_sha256), '[]'::jsonb)::text,
                               'UTF8'
                           )), 'hex'),
                           'repair_version', NEW.repair_version,
                           'schema_version',
                           'torghut.order-lineage-census-result.v1',
                           'source_coverage_counts', jsonb_build_object(
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
                       )
                  INTO expected_result_document
                  FROM current_receipts;
                IF result_document->'classification_counts' IS DISTINCT FROM
                       expected_result_document->'classification_counts' THEN
                    RAISE EXCEPTION 'order lineage classification counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF result_document->'confidence_counts' IS DISTINCT FROM
                       expected_result_document->'confidence_counts' THEN
                    RAISE EXCEPTION 'order lineage confidence counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF result_document->'execution_source_counts' IS DISTINCT FROM
                       expected_result_document->'execution_source_counts' THEN
                    RAISE EXCEPTION 'order lineage execution source counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF result_document->'source_coverage_counts' IS DISTINCT FROM
                       expected_result_document->'source_coverage_counts' THEN
                    RAISE EXCEPTION 'order lineage source coverage counts mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF result_document IS DISTINCT FROM expected_result_document
                   OR (result_document->>'receipt_count')::bigint
                       IS DISTINCT FROM NEW.receipt_count
                   OR NEW.promotion_authority_eligible IS NOT FALSE THEN
                    RAISE EXCEPTION 'order lineage persisted receipt result mismatch'
                        USING ERRCODE = '23514';
                END IF;
                NEW.created_at := clock_timestamp();
                RETURN NEW;
            END;
            $$
            """
        )
    )
    _create_guard_triggers(
        table=_RUN_TABLE,
        function=_RUN_GUARD,
        row_trigger=_RUN_ROW_TRIGGER,
        truncate_trigger=_RUN_TRUNCATE_TRIGGER,
    )


def _create_guard_triggers(
    *,
    table: str,
    function: str,
    row_trigger: str,
    truncate_trigger: str,
) -> None:
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {row_trigger}
            BEFORE INSERT OR UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION {function}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {truncate_trigger}
            BEFORE TRUNCATE ON {table}
            FOR EACH STATEMENT EXECUTE FUNCTION {function}()
            """
        )
    )


def upgrade() -> None:
    _create_import_table()
    _create_run_table()
    _create_import_guard()
    _create_run_guard()


def downgrade() -> None:
    op.execute(
        sa.text(f"DROP TRIGGER IF EXISTS {_RUN_TRUNCATE_TRIGGER} ON {_RUN_TABLE}")
    )
    op.execute(sa.text(f"DROP TRIGGER IF EXISTS {_RUN_ROW_TRIGGER} ON {_RUN_TABLE}"))
    op.execute(sa.text(f"DROP FUNCTION IF EXISTS {_RUN_GUARD}()"))
    op.drop_table(_RUN_TABLE)
    op.execute(
        sa.text(f"DROP TRIGGER IF EXISTS {_IMPORT_TRUNCATE_TRIGGER} ON {_IMPORT_TABLE}")
    )
    op.execute(
        sa.text(f"DROP TRIGGER IF EXISTS {_IMPORT_ROW_TRIGGER} ON {_IMPORT_TABLE}")
    )
    op.execute(sa.text(f"DROP FUNCTION IF EXISTS {_IMPORT_GUARD}()"))
    op.drop_table(_IMPORT_TABLE)

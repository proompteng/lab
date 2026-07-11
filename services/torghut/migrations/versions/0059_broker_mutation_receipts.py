"""Add immutable, broker-reconciled mutation receipts.

Revision ID: 0059_broker_mutation_receipts
Revises: 0058_decision_submission_claims
Create Date: 2026-07-11 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0059_broker_mutation_receipts"
down_revision = "0058_decision_submission_claims"
branch_labels = None
depends_on = None


def _create_receipt_header() -> None:
    op.create_table(
        "broker_mutation_receipts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("broker_route", sa.String(length=32), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("endpoint_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("operation", sa.String(length=32), nullable=False),
        sa.Column("risk_class", sa.String(length=32), nullable=False),
        sa.Column("purpose", sa.String(length=64), nullable=False),
        sa.Column(
            "submission_claim_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column("workflow_id", sa.String(length=128), nullable=False),
        sa.Column("client_request_id", sa.String(length=128), nullable=False),
        sa.Column("target_kind", sa.String(length=32), nullable=False),
        sa.Column("target_key", sa.String(length=256), nullable=False),
        sa.Column("intent_schema_version", sa.String(length=64), nullable=False),
        sa.Column("canonical_intent_json", sa.Text(), nullable=False),
        sa.Column(
            "canonical_intent_sha256",
            sa.String(length=64),
            nullable=False,
        ),
        sa.Column("creator_owner", sa.String(length=128), nullable=False),
        sa.Column("origin_writer_generation", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "broker_route IN ('alpaca', 'hyperliquid')",
            name="ck_bm_receipt_route",
        ),
        sa.CheckConstraint(
            "operation IN ('submit_order', 'replace_order', 'cancel_order', "
            "'cancel_all_orders', 'close_position', 'close_all_positions')",
            name="ck_bm_receipt_operation",
        ),
        sa.CheckConstraint(
            "risk_class IN ('risk_increasing', 'risk_neutral', 'risk_reducing')",
            name="ck_bm_receipt_risk_class",
        ),
        sa.CheckConstraint(
            "purpose IN ('initial_submission', 'repricing', "
            "'inventory_conflict', 'opposite_side_cleanup', 'kill_switch', "
            "'governance', 'closeout', 'flatten', 'operator')",
            name="ck_bm_receipt_purpose",
        ),
        sa.CheckConstraint(
            "target_kind IN ('order', 'position', 'account')",
            name="ck_bm_receipt_target_kind",
        ),
        sa.CheckConstraint(
            "((operation IN ('submit_order', 'replace_order') "
            "AND target_kind = 'order' AND submission_claim_id IS NOT NULL) OR "
            "(operation = 'cancel_order' AND target_kind = 'order' "
            "AND submission_claim_id IS NULL) OR "
            "(operation = 'cancel_all_orders' AND target_kind = 'account' "
            "AND target_key = account_label AND submission_claim_id IS NULL) OR "
            "(operation = 'close_position' AND target_kind = 'position' "
            "AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_reducing') OR "
            "(operation = 'close_all_positions' AND target_kind = 'account' "
            "AND target_key = account_label AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_reducing'))",
            name="ck_bm_receipt_operation_contract",
        ),
        sa.CheckConstraint(
            "length(account_label) BETWEEN 1 AND 64 "
            "AND length(workflow_id) BETWEEN 1 AND 128 "
            "AND length(client_request_id) BETWEEN 1 AND 128 "
            "AND length(target_key) BETWEEN 1 AND 256 "
            "AND length(creator_owner) BETWEEN 1 AND 128",
            name="ck_bm_receipt_required_text",
        ),
        sa.CheckConstraint(
            "endpoint_fingerprint ~ '^[0-9a-f]{64}$'",
            name="ck_bm_receipt_endpoint_hash",
        ),
        sa.CheckConstraint(
            "intent_schema_version = 'torghut.broker-mutation-intent.v1'",
            name="ck_bm_receipt_intent_version",
        ),
        sa.CheckConstraint(
            "octet_length(canonical_intent_json) BETWEEN 2 AND 65536",
            name="ck_bm_receipt_intent_size",
        ),
        sa.CheckConstraint(
            "canonical_intent_sha256 ~ '^[0-9a-f]{64}$'",
            name="ck_bm_receipt_intent_hash",
        ),
        sa.CheckConstraint(
            "origin_writer_generation > 0",
            name="ck_bm_receipt_origin_gen",
        ),
        sa.ForeignKeyConstraint(
            ["submission_claim_id"],
            ["trade_decision_submission_claims.trade_decision_id"],
            name="fk_bm_receipt_submission_claim",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_broker_mutation_receipts"),
    )


def _create_receipt_events() -> None:
    op.create_table(
        "broker_mutation_receipt_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "receipt_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("sequence_no", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("event_writer_generation", sa.BigInteger(), nullable=False),
        sa.Column("primary_token", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("primary_epoch", sa.BigInteger(), nullable=False),
        sa.Column("primary_owner", sa.String(length=128), nullable=False),
        sa.Column("primary_writer_generation", sa.BigInteger(), nullable=False),
        sa.Column("primary_claimed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "primary_lease_expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("release_reason", sa.Text(), nullable=True),
        sa.Column("broker_io_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recovery_after", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recovery_token", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "recovery_epoch",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("recovery_owner", sa.String(length=128), nullable=True),
        sa.Column("recovery_writer_generation", sa.BigInteger(), nullable=True),
        sa.Column(
            "recovery_lease_started_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "recovery_lease_expires_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("recovery_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recovery_observation_epoch", sa.BigInteger(), nullable=True),
        sa.Column("recovery_outcome", sa.String(length=32), nullable=True),
        sa.Column("recovery_evidence_json", sa.Text(), nullable=True),
        sa.Column(
            "recovery_evidence_sha256",
            sa.String(length=64),
            nullable=True,
        ),
        sa.Column("settlement_source", sa.String(length=32), nullable=True),
        sa.Column("settlement_outcome", sa.String(length=32), nullable=True),
        sa.Column("broker_reference", sa.String(length=256), nullable=True),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("settlement_evidence_json", sa.Text(), nullable=True),
        sa.Column(
            "settlement_evidence_sha256",
            sa.String(length=64),
            nullable=True,
        ),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint("sequence_no > 0", name="ck_bm_event_sequence"),
        sa.CheckConstraint("primary_epoch > 0", name="ck_bm_event_primary_epoch"),
        sa.CheckConstraint(
            "event_writer_generation > 0 AND primary_writer_generation > 0",
            name="ck_bm_event_writer_generations",
        ),
        sa.CheckConstraint(
            "recovery_epoch >= 0 AND "
            "(recovery_writer_generation IS NULL "
            "OR recovery_writer_generation > 0)",
            name="ck_bm_event_recovery_generation",
        ),
        sa.CheckConstraint(
            "event_type IN ('primary_claimed', 'primary_renewed', "
            "'primary_released', 'broker_io_started', 'recovery_claimed', "
            "'recovery_renewed', 'recovery_observed', 'recovery_released', "
            "'settled')",
            name="ck_bm_event_type",
        ),
        sa.CheckConstraint(
            "state IN ('claimed', 'released', 'broker_io', 'settled')",
            name="ck_bm_event_state",
        ),
        sa.CheckConstraint(
            "((event_type IN ('primary_claimed', 'primary_renewed') "
            "AND state = 'claimed') OR "
            "(event_type = 'primary_released' AND state = 'released') OR "
            "(event_type IN ('broker_io_started', 'recovery_claimed', "
            "'recovery_renewed', 'recovery_observed', 'recovery_released') "
            "AND state = 'broker_io') OR "
            "(event_type = 'settled' AND state = 'settled'))",
            name="ck_bm_event_type_state",
        ),
        sa.CheckConstraint(
            "primary_lease_expires_at > primary_claimed_at",
            name="ck_bm_event_primary_lease",
        ),
        sa.CheckConstraint(
            "((released_at IS NULL AND release_reason IS NULL) OR "
            "(released_at IS NOT NULL AND release_reason IS NOT NULL "
            "AND state = 'released' "
            "AND primary_lease_expires_at <= released_at)) "
            "AND (state <> 'released' OR released_at IS NOT NULL)",
            name="ck_bm_event_release_metadata",
        ),
        sa.CheckConstraint(
            "((recovery_epoch = 0 AND recovery_token IS NULL "
            "AND recovery_owner IS NULL "
            "AND recovery_writer_generation IS NULL "
            "AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL) OR "
            "(recovery_epoch > 0 AND recovery_token IS NOT NULL "
            "AND recovery_owner IS NOT NULL "
            "AND recovery_writer_generation IS NOT NULL "
            "AND recovery_lease_started_at IS NOT NULL "
            "AND recovery_lease_expires_at IS NOT NULL "
            "AND recovery_lease_expires_at >= recovery_lease_started_at))",
            name="ck_bm_event_recovery_lease",
        ),
        sa.CheckConstraint(
            "state <> 'broker_io' OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)",
            name="ck_bm_event_broker_io_metadata",
        ),
        sa.CheckConstraint(
            "state <> 'settled' OR settlement_outcome = 'already_satisfied' OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)",
            name="ck_bm_event_settled_io_metadata",
        ),
        sa.CheckConstraint(
            "((recovery_checked_at IS NULL "
            "AND recovery_observation_epoch IS NULL "
            "AND recovery_outcome IS NULL "
            "AND recovery_evidence_json IS NULL "
            "AND recovery_evidence_sha256 IS NULL) OR "
            "(recovery_checked_at IS NOT NULL "
            "AND recovery_observation_epoch IS NOT NULL "
            "AND recovery_observation_epoch > 0 "
            "AND recovery_observation_epoch <= recovery_epoch "
            "AND recovery_outcome IN ('not_found', 'indeterminate') "
            "AND recovery_evidence_json IS NOT NULL "
            "AND recovery_evidence_sha256 ~ '^[0-9a-f]{64}$' "
            "AND octet_length(recovery_evidence_json) BETWEEN 2 AND 4096))",
            name="ck_bm_event_recovery_observation",
        ),
        sa.CheckConstraint(
            "event_type <> 'recovery_observed' OR recovery_checked_at IS NOT NULL",
            name="ck_bm_event_observation_required",
        ),
        sa.CheckConstraint(
            "settlement_source IS NULL OR "
            "settlement_source IN ('primary', 'recovery', 'preflight')",
            name="ck_bm_event_settlement_source",
        ),
        sa.CheckConstraint(
            "settlement_outcome IS NULL OR settlement_outcome IN "
            "('acknowledged', 'reconciled', 'rejected', 'already_satisfied')",
            name="ck_bm_event_settlement_outcome",
        ),
        sa.CheckConstraint(
            "settlement_outcome IS NULL OR "
            "(settlement_outcome = 'already_satisfied' "
            "AND settlement_source = 'preflight') OR "
            "(settlement_outcome <> 'already_satisfied' "
            "AND settlement_source IN ('primary', 'recovery'))",
            name="ck_bm_event_settlement_pair",
        ),
        sa.CheckConstraint(
            "((state = 'settled' AND settlement_source IS NOT NULL "
            "AND settlement_outcome IS NOT NULL AND settled_at IS NOT NULL "
            "AND settlement_evidence_json IS NOT NULL "
            "AND settlement_evidence_sha256 ~ '^[0-9a-f]{64}$' "
            "AND octet_length(settlement_evidence_json) BETWEEN 2 AND 4096) OR "
            "(state <> 'settled' AND settlement_source IS NULL "
            "AND settlement_outcome IS NULL AND broker_reference IS NULL "
            "AND execution_id IS NULL AND settlement_evidence_json IS NULL "
            "AND settlement_evidence_sha256 IS NULL AND settled_at IS NULL))",
            name="ck_bm_event_settlement_metadata",
        ),
        sa.CheckConstraint(
            "settlement_source <> 'recovery' OR recovery_epoch > 0",
            name="ck_bm_event_recovery_settlement",
        ),
        sa.ForeignKeyConstraint(
            ["receipt_id"],
            ["broker_mutation_receipts.id"],
            name="fk_bm_receipt_event_receipt",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["execution_id"],
            ["executions.id"],
            name="fk_bm_receipt_event_execution",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_broker_mutation_receipt_events"),
    )


def _create_indexes() -> None:
    op.create_index(
        "uq_broker_mutation_receipt_client",
        "broker_mutation_receipts",
        [
            "broker_route",
            "account_label",
            "endpoint_fingerprint",
            "operation",
            "client_request_id",
        ],
        unique=True,
    )
    op.create_index(
        "uq_broker_mutation_receipt_intent",
        "broker_mutation_receipts",
        [
            "broker_route",
            "account_label",
            "endpoint_fingerprint",
            "canonical_intent_sha256",
        ],
        unique=True,
    )
    op.create_index(
        "ix_broker_mutation_receipt_claim",
        "broker_mutation_receipts",
        ["submission_claim_id"],
    )
    op.create_index(
        "ix_broker_mutation_receipt_workflow",
        "broker_mutation_receipts",
        ["workflow_id"],
    )
    op.create_index(
        "ix_broker_mutation_receipt_target",
        "broker_mutation_receipts",
        ["broker_route", "account_label", "target_kind", "target_key"],
    )
    op.create_index(
        "uq_broker_mutation_receipt_event_seq",
        "broker_mutation_receipt_events",
        ["receipt_id", "sequence_no"],
        unique=True,
    )
    op.create_index(
        "ix_broker_mutation_receipt_latest",
        "broker_mutation_receipt_events",
        ["receipt_id", sa.text("sequence_no DESC")],
    )
    op.create_index(
        "ix_broker_mutation_receipt_recovery_due",
        "broker_mutation_receipt_events",
        [
            "state",
            "recovery_after",
            "recovery_lease_expires_at",
            "receipt_id",
            sa.text("sequence_no DESC"),
        ],
    )


def _create_header_guards() -> None:
    op.execute(sa.text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_broker_mutation_receipt()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            DECLARE
                intent_document jsonb;
                intent_key_count integer;
                claim_account text;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker mutation receipt header is immutable'
                        USING ERRCODE = '23514';
                END IF;

                NEW.created_at := clock_timestamp();
                IF NEW.canonical_intent_sha256 IS DISTINCT FROM encode(
                    digest(convert_to(NEW.canonical_intent_json, 'UTF8'), 'sha256'),
                    'hex'
                ) THEN
                    RAISE EXCEPTION 'broker mutation receipt intent hash mismatch'
                        USING ERRCODE = '23514';
                END IF;
                intent_document := NEW.canonical_intent_json::jsonb;
                SELECT count(*) INTO intent_key_count
                  FROM jsonb_object_keys(intent_document);
                IF jsonb_typeof(intent_document) <> 'object'
                   OR intent_key_count <> 12
                   OR jsonb_typeof(intent_document -> 'request') <> 'object'
                   OR jsonb_typeof(intent_document -> 'target') <> 'object'
                   OR (SELECT count(*) FROM jsonb_object_keys(
                           intent_document -> 'target'
                       )) <> 2
                   OR intent_document ->> 'broker_route'
                        IS DISTINCT FROM NEW.broker_route
                   OR intent_document ->> 'account_label'
                        IS DISTINCT FROM NEW.account_label
                   OR intent_document ->> 'endpoint_fingerprint'
                        IS DISTINCT FROM NEW.endpoint_fingerprint
                   OR intent_document ->> 'operation'
                        IS DISTINCT FROM NEW.operation
                   OR intent_document ->> 'risk_class'
                        IS DISTINCT FROM NEW.risk_class
                   OR intent_document ->> 'purpose'
                        IS DISTINCT FROM NEW.purpose
                   OR intent_document ->> 'workflow_id'
                        IS DISTINCT FROM NEW.workflow_id
                   OR intent_document ->> 'client_request_id'
                        IS DISTINCT FROM NEW.client_request_id
                   OR intent_document ->> 'schema_version'
                        IS DISTINCT FROM NEW.intent_schema_version
                   OR intent_document #>> '{target,kind}'
                        IS DISTINCT FROM NEW.target_kind
                   OR intent_document #>> '{target,key}'
                        IS DISTINCT FROM NEW.target_key
                   OR (
                       NEW.submission_claim_id IS NULL
                       AND intent_document -> 'submission_claim_id'
                           IS DISTINCT FROM 'null'::jsonb
                   )
                   OR (
                       NEW.submission_claim_id IS NOT NULL
                       AND intent_document ->> 'submission_claim_id'
                           IS DISTINCT FROM NEW.submission_claim_id::text
                   ) THEN
                    RAISE EXCEPTION 'broker mutation receipt intent identity mismatch'
                        USING ERRCODE = '23514';
                END IF;

                PERFORM torghut_lock_submission_identities(
                    ARRAY[
                        'torghut:broker-mutation:client:' || NEW.broker_route
                            || chr(31) || NEW.account_label || chr(31)
                            || NEW.endpoint_fingerprint || chr(31)
                            || NEW.operation || chr(31) || NEW.client_request_id,
                        'torghut:broker-mutation:intent:' || NEW.broker_route
                            || chr(31) || NEW.account_label || chr(31)
                            || NEW.endpoint_fingerprint || chr(31)
                            || NEW.canonical_intent_sha256,
                        CASE WHEN NEW.submission_claim_id IS NOT NULL THEN
                            'torghut:submission:decision:'
                                || NEW.submission_claim_id::text
                        END,
                        CASE WHEN NEW.submission_claim_id IS NOT NULL THEN
                            'torghut:submission:client:' || NEW.account_label
                                || chr(31) || NEW.client_request_id
                        END
                    ]
                );
                IF NEW.submission_claim_id IS NOT NULL THEN
                    SELECT account_label INTO claim_account
                      FROM trade_decision_submission_claims
                     WHERE trade_decision_id = NEW.submission_claim_id
                       FOR KEY SHARE;
                    IF NOT FOUND OR claim_account IS DISTINCT FROM NEW.account_label THEN
                        RAISE EXCEPTION
                            'broker mutation receipt submission claim mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt
            BEFORE INSERT OR UPDATE OR DELETE ON broker_mutation_receipts
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_broker_mutation_receipt()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_truncate
            BEFORE TRUNCATE ON broker_mutation_receipts
            FOR EACH STATEMENT
            EXECUTE FUNCTION torghut_guard_broker_mutation_receipt()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_require_bm_receipt_first_event()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM broker_mutation_receipt_events
                     WHERE receipt_id = NEW.id
                       AND sequence_no = 1
                       AND event_type = 'primary_claimed'
                       AND state = 'claimed'
                ) THEN
                    RAISE EXCEPTION
                        'broker mutation receipt requires sequence-one claimed event'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NULL;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE CONSTRAINT TRIGGER trg_require_bm_receipt_first_event
            AFTER INSERT ON broker_mutation_receipts
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW
            EXECUTE FUNCTION torghut_require_bm_receipt_first_event()
            """
        )
    )


def _create_event_guards() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_bm_events_equal_except(
                left_event broker_mutation_receipt_events,
                right_event broker_mutation_receipt_events,
                ignored_keys text[]
            ) RETURNS boolean
            LANGUAGE sql
            IMMUTABLE
            AS $$
                SELECT (to_jsonb(left_event) - ignored_keys)
                    IS NOT DISTINCT FROM
                       (to_jsonb(right_event) - ignored_keys)
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_broker_mutation_event()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            DECLARE
                receipt_row broker_mutation_receipts%ROWTYPE;
                previous broker_mutation_receipt_events%ROWTYPE;
                now_at timestamptz;
                requested_interval interval;
                base_ignored text[] := ARRAY[
                    'id', 'sequence_no', 'event_type',
                    'event_writer_generation', 'recorded_at'
                ];
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'broker mutation receipt event is append-only'
                        USING ERRCODE = '23514';
                END IF;
                now_at := clock_timestamp();
                NEW.recorded_at := now_at;
                IF NEW.recovery_evidence_json IS NOT NULL AND
                   NEW.recovery_evidence_sha256 IS DISTINCT FROM encode(
                       digest(convert_to(NEW.recovery_evidence_json, 'UTF8'), 'sha256'),
                       'hex'
                   ) THEN
                    RAISE EXCEPTION
                        'broker mutation receipt evidence hash mismatch: recovery'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.settlement_evidence_json IS NOT NULL AND
                   NEW.settlement_evidence_sha256 IS DISTINCT FROM encode(
                       digest(convert_to(NEW.settlement_evidence_json, 'UTF8'), 'sha256'),
                       'hex'
                   ) THEN
                    RAISE EXCEPTION
                        'broker mutation receipt evidence hash mismatch: settlement'
                        USING ERRCODE = '23514';
                END IF;

                PERFORM torghut_lock_submission_identities(ARRAY[
                    'torghut:broker-mutation:receipt:' || NEW.receipt_id::text
                ]);
                SELECT * INTO receipt_row
                  FROM broker_mutation_receipts
                 WHERE id = NEW.receipt_id
                   FOR UPDATE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'broker mutation receipt header not found'
                        USING ERRCODE = '23503';
                END IF;
                SELECT * INTO previous
                  FROM broker_mutation_receipt_events
                 WHERE receipt_id = NEW.receipt_id
                 ORDER BY sequence_no DESC
                 LIMIT 1
                   FOR UPDATE;

                IF NOT FOUND THEN
                    requested_interval :=
                        NEW.primary_lease_expires_at - NEW.primary_claimed_at;
                    IF NEW.sequence_no <> 1
                       OR NEW.event_type <> 'primary_claimed'
                       OR NEW.state <> 'claimed'
                       OR NEW.primary_epoch <> 1
                       OR NEW.primary_token IS NULL
                       OR NEW.primary_owner IS DISTINCT FROM receipt_row.creator_owner
                       OR NEW.primary_writer_generation
                            IS DISTINCT FROM receipt_row.origin_writer_generation
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM NEW.primary_writer_generation
                       OR requested_interval < interval '5 seconds'
                       OR requested_interval > interval '300 seconds'
                       OR NEW.recovery_epoch <> 0
                       OR NEW.released_at IS NOT NULL
                       OR NEW.broker_io_started_at IS NOT NULL
                       OR NEW.settlement_outcome IS NOT NULL THEN
                        RAISE EXCEPTION
                            'broker mutation receipt requires sequence-one claimed event'
                            USING ERRCODE = '23514';
                    END IF;
                    NEW.primary_claimed_at := now_at;
                    NEW.primary_lease_expires_at := now_at + requested_interval;
                    RETURN NEW;
                END IF;

                IF NEW.sequence_no <> previous.sequence_no + 1 THEN
                    RAISE EXCEPTION
                        'broker mutation receipt sequence must be contiguous'
                        USING ERRCODE = '23514';
                END IF;
                IF previous.state = 'settled' THEN
                    RAISE EXCEPTION 'settled broker mutation receipt is terminal'
                        USING ERRCODE = '23514';
                END IF;
                IF previous.state = 'broker_io'
                   AND NEW.state NOT IN ('broker_io', 'settled') THEN
                    RAISE EXCEPTION 'broker I/O quarantine is irreversible'
                        USING ERRCODE = '23514';
                END IF;

                IF NEW.event_type = 'primary_claimed' THEN
                    requested_interval :=
                        NEW.primary_lease_expires_at - NEW.primary_claimed_at;
                    IF previous.state NOT IN ('claimed', 'released')
                       OR (previous.state = 'claimed'
                           AND previous.primary_lease_expires_at > now_at)
                       OR NEW.state <> 'claimed'
                       OR NEW.primary_epoch <> previous.primary_epoch + 1
                       OR NEW.primary_token IS NOT DISTINCT FROM previous.primary_token
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM NEW.primary_writer_generation
                       OR requested_interval < interval '5 seconds'
                       OR requested_interval > interval '300 seconds'
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous, base_ignored || ARRAY[
                               'state', 'primary_token', 'primary_epoch',
                               'primary_owner', 'primary_writer_generation',
                               'primary_claimed_at', 'primary_lease_expires_at',
                               'released_at', 'release_reason'
                           ]
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation primary acquisition'
                            USING ERRCODE = '23514';
                    END IF;
                    NEW.primary_claimed_at := now_at;
                    NEW.primary_lease_expires_at := now_at + requested_interval;
                    RETURN NEW;
                ELSIF NEW.event_type = 'primary_renewed' THEN
                    IF previous.state <> 'claimed'
                       OR previous.primary_lease_expires_at <= now_at
                       OR NEW.primary_lease_expires_at
                            <= previous.primary_lease_expires_at
                       OR NEW.primary_lease_expires_at > now_at + interval '300 seconds'
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM previous.primary_writer_generation
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous,
                           base_ignored || ARRAY['primary_lease_expires_at']
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation primary renewal'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'primary_released' THEN
                    NEW.released_at := now_at;
                    NEW.primary_lease_expires_at := now_at;
                    IF previous.state <> 'claimed'
                       OR previous.primary_lease_expires_at <= now_at
                       OR NEW.state <> 'released'
                       OR btrim(coalesce(NEW.release_reason, '')) = ''
                       OR length(NEW.release_reason) > 1024
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM previous.primary_writer_generation
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous, base_ignored || ARRAY[
                               'state', 'primary_lease_expires_at',
                               'released_at', 'release_reason'
                           ]
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation primary release'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'broker_io_started' THEN
                    requested_interval :=
                        NEW.recovery_after - NEW.broker_io_started_at;
                    NEW.broker_io_started_at := now_at;
                    NEW.recovery_after := now_at + requested_interval;
                    IF previous.state <> 'claimed'
                       OR previous.primary_lease_expires_at <= now_at
                       OR NEW.state <> 'broker_io'
                       OR requested_interval < interval '30 seconds'
                       OR requested_interval > interval '3600 seconds'
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM previous.primary_writer_generation
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous, base_ignored || ARRAY[
                               'state', 'broker_io_started_at', 'recovery_after'
                           ]
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation broker I/O boundary'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'recovery_claimed' THEN
                    requested_interval :=
                        NEW.recovery_lease_expires_at
                            - NEW.recovery_lease_started_at;
                    NEW.recovery_lease_started_at := now_at;
                    NEW.recovery_lease_expires_at := now_at + requested_interval;
                    IF previous.state <> 'broker_io'
                       OR previous.recovery_after > now_at
                       OR (previous.recovery_lease_expires_at IS NOT NULL
                           AND previous.recovery_lease_expires_at > now_at)
                       OR NEW.state <> 'broker_io'
                       OR NEW.recovery_epoch <> previous.recovery_epoch + 1
                       OR NEW.recovery_token IS NULL
                       OR NEW.recovery_token
                            IS NOT DISTINCT FROM previous.recovery_token
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM NEW.recovery_writer_generation
                       OR requested_interval < interval '5 seconds'
                       OR requested_interval > interval '300 seconds'
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous, base_ignored || ARRAY[
                               'recovery_token', 'recovery_epoch',
                               'recovery_owner', 'recovery_writer_generation',
                               'recovery_lease_started_at',
                               'recovery_lease_expires_at'
                           ]
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation recovery acquisition'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'recovery_renewed' THEN
                    IF previous.state <> 'broker_io'
                       OR previous.recovery_lease_expires_at <= now_at
                       OR NEW.recovery_lease_expires_at
                            <= previous.recovery_lease_expires_at
                       OR NEW.recovery_lease_expires_at
                            > now_at + interval '300 seconds'
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM previous.recovery_writer_generation
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous,
                           base_ignored || ARRAY['recovery_lease_expires_at']
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation recovery renewal'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'recovery_observed' THEN
                    requested_interval :=
                        NEW.recovery_after - NEW.recovery_checked_at;
                    NEW.recovery_checked_at := now_at;
                    NEW.recovery_after := now_at + requested_interval;
                    IF previous.state <> 'broker_io'
                       OR previous.recovery_lease_expires_at <= now_at
                       OR NEW.recovery_observation_epoch <> NEW.recovery_epoch
                       OR NEW.recovery_outcome NOT IN ('not_found', 'indeterminate')
                       OR requested_interval < interval '30 seconds'
                       OR requested_interval > interval '3600 seconds'
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM previous.recovery_writer_generation
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous, base_ignored || ARRAY[
                               'recovery_after', 'recovery_checked_at',
                               'recovery_observation_epoch', 'recovery_outcome',
                               'recovery_evidence_json',
                               'recovery_evidence_sha256'
                           ]
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation recovery observation'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'recovery_released' THEN
                    NEW.recovery_lease_expires_at := now_at;
                    IF previous.state <> 'broker_io'
                       OR previous.recovery_lease_expires_at <= now_at
                       OR NEW.event_writer_generation
                            IS DISTINCT FROM previous.recovery_writer_generation
                       OR NOT torghut_bm_events_equal_except(
                           NEW, previous,
                           base_ignored || ARRAY['recovery_lease_expires_at']
                       ) THEN
                        RAISE EXCEPTION 'invalid broker mutation recovery release'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                ELSIF NEW.event_type = 'settled' THEN
                    NEW.settled_at := now_at;
                    IF previous.state = 'claimed' THEN
                        IF previous.primary_lease_expires_at <= now_at
                           OR NEW.settlement_source <> 'preflight'
                           OR NEW.settlement_outcome <> 'already_satisfied'
                           OR NEW.event_writer_generation
                                IS DISTINCT FROM previous.primary_writer_generation
                           OR NOT torghut_bm_events_equal_except(
                               NEW, previous, base_ignored || ARRAY[
                                   'state', 'settlement_source',
                                   'settlement_outcome', 'broker_reference',
                                   'execution_id', 'settlement_evidence_json',
                                   'settlement_evidence_sha256', 'settled_at'
                               ]
                           ) THEN
                            RAISE EXCEPTION 'invalid preflight broker mutation settlement'
                                USING ERRCODE = '23514';
                        END IF;
                    ELSIF previous.state = 'broker_io' THEN
                        IF NEW.settlement_source NOT IN ('primary', 'recovery')
                           OR NEW.settlement_outcome = 'already_satisfied'
                           OR (NEW.settlement_source = 'primary' AND
                               NEW.event_writer_generation IS DISTINCT FROM
                                   previous.primary_writer_generation)
                           OR (NEW.settlement_source = 'recovery' AND
                               (previous.recovery_lease_expires_at <= now_at OR
                                NEW.event_writer_generation IS DISTINCT FROM
                                    previous.recovery_writer_generation))
                           OR NOT torghut_bm_events_equal_except(
                               NEW, previous, base_ignored || ARRAY[
                                   'state', 'settlement_source',
                                   'settlement_outcome', 'broker_reference',
                                   'execution_id', 'settlement_evidence_json',
                                   'settlement_evidence_sha256', 'settled_at'
                               ]
                           ) THEN
                            RAISE EXCEPTION 'invalid broker mutation settlement'
                                USING ERRCODE = '23514';
                        END IF;
                    ELSE
                        RAISE EXCEPTION 'invalid broker mutation settlement source state'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION 'invalid broker mutation receipt event transition'
                    USING ERRCODE = '23514';
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_event
            BEFORE INSERT OR UPDATE OR DELETE ON broker_mutation_receipt_events
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_broker_mutation_event()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_event_truncate
            BEFORE TRUNCATE ON broker_mutation_receipt_events
            FOR EACH STATEMENT
            EXECUTE FUNCTION torghut_guard_broker_mutation_event()
            """
        )
    )


def upgrade() -> None:
    _create_receipt_header()
    _create_receipt_events()
    _create_indexes()
    _create_header_guards()
    _create_event_guards()


def downgrade() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE broker_mutation_receipts, "
            "broker_mutation_receipt_events "
            "IN ACCESS EXCLUSIVE MODE NOWAIT"
        )
    )
    op.execute(
        sa.text("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM broker_mutation_receipts)
               OR EXISTS (SELECT 1 FROM broker_mutation_receipt_events) THEN
                RAISE EXCEPTION
                    'refusing to downgrade nonempty broker mutation receipt audit state';
            END IF;
        END; $$
    """)
    )
    for statement in (
        "DROP TRIGGER trg_require_bm_receipt_first_event ON broker_mutation_receipts",
        "DROP FUNCTION torghut_require_bm_receipt_first_event()",
        "DROP TRIGGER trg_guard_bm_receipt_event_truncate ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_event ON broker_mutation_receipt_events",
        "DROP FUNCTION torghut_guard_broker_mutation_event()",
        "DROP FUNCTION torghut_bm_events_equal_except(broker_mutation_receipt_events, broker_mutation_receipt_events, text[])",
        "DROP TRIGGER trg_guard_bm_receipt_truncate ON broker_mutation_receipts",
        "DROP TRIGGER trg_guard_bm_receipt ON broker_mutation_receipts",
        "DROP FUNCTION torghut_guard_broker_mutation_receipt()",
    ):
        op.execute(sa.text(statement))
    for index_name, table_name in (
        ("ix_broker_mutation_receipt_recovery_due", "broker_mutation_receipt_events"),
        ("ix_broker_mutation_receipt_latest", "broker_mutation_receipt_events"),
        ("uq_broker_mutation_receipt_event_seq", "broker_mutation_receipt_events"),
        ("ix_broker_mutation_receipt_target", "broker_mutation_receipts"),
        ("ix_broker_mutation_receipt_workflow", "broker_mutation_receipts"),
        ("ix_broker_mutation_receipt_claim", "broker_mutation_receipts"),
        ("uq_broker_mutation_receipt_intent", "broker_mutation_receipts"),
        ("uq_broker_mutation_receipt_client", "broker_mutation_receipts"),
    ):
        op.drop_index(index_name, table_name=table_name)
    op.drop_table("broker_mutation_receipt_events")
    op.drop_table("broker_mutation_receipts")

"""Bind broker-mutation evidence envelopes to immutable receipt state.

Revision ID: 0060_bm_evidence_envelopes
Revises: 0059_broker_mutation_receipts
Create Date: 2026-07-11 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0060_bm_evidence_envelopes"
down_revision = "0059_broker_mutation_receipts"
branch_labels = None
depends_on = None


def _refuse_nonempty_parent_state() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE broker_mutation_receipts, "
            "broker_mutation_receipt_events IN ACCESS EXCLUSIVE MODE NOWAIT"
        )
    )
    op.execute(
        sa.text(
            """
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM broker_mutation_receipts)
                   OR EXISTS (SELECT 1 FROM broker_mutation_receipt_events) THEN
                    RAISE EXCEPTION
                        'refusing to upgrade nonempty unsafe 0059 broker mutation receipt state'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )


def _create_canonical_json_helper() -> None:
    op.execute(
        sa.text(
            r"""
            CREATE FUNCTION torghut_bm_canonical_json_0060(
                document json,
                nesting_depth integer DEFAULT 0
            ) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
            DECLARE
                document_kind text;
                normalized_text text;
                raw_number text;
                rendered text;
            BEGIN
                IF nesting_depth > 32 THEN
                    RAISE EXCEPTION
                        'broker mutation canonical JSON nesting exceeds 32'
                        USING ERRCODE = '23514';
                END IF;
                document_kind := json_typeof(document);
                IF document_kind = 'object' THEN
                    IF EXISTS (
                        SELECT 1
                          FROM json_each(document)
                         GROUP BY key
                        HAVING count(*) > 1
                    ) THEN
                        RAISE EXCEPTION
                            'broker mutation canonical JSON has duplicate keys'
                            USING ERRCODE = '23514';
                    END IF;
                    IF EXISTS (
                        SELECT 1
                          FROM json_each(document)
                         WHERE key = ''
                            OR char_length(key) > 128
                            OR key IS DISTINCT FROM normalize(key, NFC)
                            OR key ~ '[[:cntrl:]]'
                            OR key ~ '^[[:space:]]|[[:space:]]$'
                    ) THEN
                        RAISE EXCEPTION
                            'broker mutation canonical JSON key is invalid'
                            USING ERRCODE = '23514';
                    END IF;
                    SELECT '{' || coalesce(
                        string_agg(
                            to_json(item.key)::text || ':' ||
                            torghut_bm_canonical_json_0060(
                                item.value,
                                nesting_depth + 1
                            ),
                            ',' ORDER BY item.key COLLATE "C"
                        ),
                        ''
                    ) || '}'
                      INTO rendered
                      FROM json_each(document) AS item;
                    RETURN rendered;
                ELSIF document_kind = 'array' THEN
                    SELECT '[' || coalesce(
                        string_agg(
                            torghut_bm_canonical_json_0060(
                                item.value,
                                nesting_depth + 1
                            ),
                            ',' ORDER BY item.ordinality
                        ),
                        ''
                    ) || ']'
                      INTO rendered
                      FROM json_array_elements(document)
                           WITH ORDINALITY AS item(value, ordinality);
                    RETURN rendered;
                ELSIF document_kind = 'string' THEN
                    normalized_text := document::jsonb #>> '{}';
                    IF normalized_text IS DISTINCT FROM normalize(
                        normalized_text,
                        NFC
                    ) OR normalized_text ~ '[[:cntrl:]]' THEN
                        RAISE EXCEPTION
                            'broker mutation canonical JSON string is invalid'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN to_json(normalized_text)::text;
                ELSIF document_kind = 'number' THEN
                    raw_number := btrim(document::text);
                    IF raw_number !~ '^(0|-?[1-9][0-9]*)$' THEN
                        RAISE EXCEPTION
                            'broker mutation canonical JSON number is not an integer'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN raw_number;
                ELSIF document_kind = 'boolean' THEN
                    RETURN lower(btrim(document::text));
                ELSIF document_kind = 'null' THEN
                    RETURN 'null';
                END IF;
                RAISE EXCEPTION 'broker mutation canonical JSON type is invalid'
                    USING ERRCODE = '23514';
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_assert_bm_canonical_json_0060(
                raw_document text,
                payload_name text,
                maximum_bytes integer
            ) RETURNS void LANGUAGE plpgsql IMMUTABLE STRICT AS $$
            DECLARE
                rebuilt text;
            BEGIN
                IF maximum_bytes <= 0
                   OR octet_length(raw_document) NOT BETWEEN 2 AND maximum_bytes THEN
                    RAISE EXCEPTION
                        'broker mutation % JSON size is invalid', payload_name
                        USING ERRCODE = '23514';
                END IF;
                IF json_typeof(raw_document::json) <> 'object' THEN
                    RAISE EXCEPTION
                        'broker mutation % JSON must be an object', payload_name
                        USING ERRCODE = '23514';
                END IF;
                rebuilt := torghut_bm_canonical_json_0060(
                    raw_document::json,
                    0
                );
                IF convert_to(raw_document, 'UTF8')
                   IS DISTINCT FROM convert_to(rebuilt, 'UTF8') THEN
                    RAISE EXCEPTION
                        'broker mutation % JSON is not canonical', payload_name
                        USING ERRCODE = '23514';
                END IF;
            END;
            $$
            """
        )
    )


def _add_linked_claim_identity_columns() -> None:
    op.add_column(
        "broker_mutation_receipt_events",
        sa.Column("submission_claim_token", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "broker_mutation_receipt_events",
        sa.Column("submission_claim_fencing_epoch", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "broker_mutation_receipt_events",
        sa.Column("submission_claim_owner", sa.String(length=128), nullable=True),
    )
    op.create_check_constraint(
        "ck_bm_event_submission_claim_identity",
        "broker_mutation_receipt_events",
        "(submission_claim_token IS NULL "
        "AND submission_claim_fencing_epoch IS NULL "
        "AND submission_claim_owner IS NULL) OR "
        "(submission_claim_token IS NOT NULL "
        "AND submission_claim_fencing_epoch > 0 "
        "AND submission_claim_owner IS NOT NULL)",
    )


def _create_secret_key_helpers() -> None:
    op.execute(
        sa.text(
            r"""
            CREATE FUNCTION torghut_bm_security_key_0060(raw_key text)
            RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
                SELECT regexp_replace(
                    translate(
                        replace(
                            replace(lower(normalize(raw_key, NFKC)), 'ß', 'ss'),
                            'ẞ', 'ss'
                        ),
                        'ǰẖẗẘẙ', 'jhtwy'
                    ),
                    '[^a-z0-9]', '', 'g'
                )
            $$
            """
        )
    )
    op.execute(
        sa.text(
            r"""
            CREATE FUNCTION torghut_assert_bm_no_secret_keys_0060(
                document jsonb,
                payload_name text
            ) RETURNS void LANGUAGE plpgsql IMMUTABLE STRICT AS $$
            DECLARE
                item record;
                normalized_key text;
            BEGIN
                IF jsonb_typeof(document) = 'object' THEN
                    FOR item IN SELECT key, value FROM jsonb_each(document)
                    LOOP
                        normalized_key := torghut_bm_security_key_0060(item.key);
                        IF normalized_key ~
                           '(apikey|authorization|bearer|cookie|credential|password|passwd|privatekey|secret|token)' THEN
                            RAISE EXCEPTION
                                'broker mutation % secret-bearing key forbidden: %',
                                payload_name, item.key
                                USING ERRCODE = '23514';
                        END IF;
                        PERFORM torghut_assert_bm_no_secret_keys_0060(
                            item.value,
                            payload_name
                        );
                    END LOOP;
                ELSIF jsonb_typeof(document) = 'array' THEN
                    FOR item IN SELECT value FROM jsonb_array_elements(document)
                    LOOP
                        PERFORM torghut_assert_bm_no_secret_keys_0060(
                            item.value,
                            payload_name
                        );
                    END LOOP;
                END IF;
            END;
            $$
            """
        )
    )


def _create_receipt_guards() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_claim_0060()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                claim_account text;
                claim_client_request_id text;
                claim_lease_expires_at timestamptz;
                claim_owner text;
                claim_released_at timestamptz;
                claim_state text;
            BEGIN
                IF NEW.operation = 'replace_order' THEN
                    RAISE EXCEPTION
                        'broker mutation replace receipts remain disabled'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.operation <> 'submit_order' THEN
                    RETURN NEW;
                END IF;
                SELECT claim.account_label, claim.client_order_id,
                       claim.lease_expires_at, claim.claim_owner,
                       claim.released_at, claim.state
                  INTO claim_account, claim_client_request_id,
                       claim_lease_expires_at, claim_owner, claim_released_at,
                       claim_state
                  FROM trade_decision_submission_claims AS claim
                 WHERE claim.trade_decision_id = NEW.submission_claim_id
                   FOR UPDATE;
                IF NOT FOUND
                   OR claim_account IS DISTINCT FROM NEW.account_label
                   OR claim_client_request_id IS DISTINCT FROM NEW.client_request_id
                   OR claim_owner IS DISTINCT FROM NEW.creator_owner
                   OR claim_state IS DISTINCT FROM 'claimed' THEN
                    RAISE EXCEPTION
                        'broker mutation submit claim identity or state mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF claim_released_at IS NOT NULL
                   OR claim_lease_expires_at <= clock_timestamp() THEN
                    RAISE EXCEPTION
                        'broker mutation submit claim lease is not live'
                        USING ERRCODE = '23514';
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
            CREATE TRIGGER trg_guard_bm_receipt_a_claim_0060
            BEFORE INSERT ON broker_mutation_receipts
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_bm_claim_0060()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_request_secrets_0060()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                intent_document jsonb;
            BEGIN
                PERFORM torghut_assert_bm_canonical_json_0060(
                    NEW.canonical_intent_json,
                    'intent',
                    65536
                );
                intent_document := NEW.canonical_intent_json::jsonb;
                IF jsonb_typeof(intent_document -> 'request') <> 'object' THEN
                    RAISE EXCEPTION
                        'broker mutation canonical request must be an object'
                        USING ERRCODE = '23514';
                END IF;
                PERFORM torghut_assert_bm_no_secret_keys_0060(
                    intent_document -> 'request',
                    'canonical request'
                );
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_b_request_secrets_0060
            BEFORE INSERT ON broker_mutation_receipts
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_bm_request_secrets_0060()
            """
        )
    )


def _create_event_secret_guard() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_evidence_secrets_0060()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.recovery_evidence_json IS NOT NULL THEN
                    PERFORM torghut_assert_bm_canonical_json_0060(
                        NEW.recovery_evidence_json,
                        'recovery evidence',
                        4096
                    );
                    PERFORM torghut_assert_bm_no_secret_keys_0060(
                        NEW.recovery_evidence_json::jsonb,
                        'recovery evidence'
                    );
                END IF;
                IF NEW.settlement_evidence_json IS NOT NULL THEN
                    PERFORM torghut_assert_bm_canonical_json_0060(
                        NEW.settlement_evidence_json,
                        'settlement evidence',
                        4096
                    );
                    PERFORM torghut_assert_bm_no_secret_keys_0060(
                        NEW.settlement_evidence_json::jsonb,
                        'settlement evidence'
                    );
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
            CREATE TRIGGER trg_guard_bm_receipt_event_a_secrets_0060
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_bm_evidence_secrets_0060()
            """
        )
    )


def _create_linked_event_guard() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_linked_event_0060()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                claim_account text;
                claim_broker_io_started_at timestamptz;
                claim_client_request_id text;
                claim_epoch bigint;
                claim_lease_expires_at timestamptz;
                claim_owner text;
                claim_recovery_after timestamptz;
                claim_released_at timestamptz;
                claim_state text;
                claim_token uuid;
                receipt_account text;
                receipt_client_request_id text;
                submission_claim_id uuid;
            BEGIN
                SELECT receipt.account_label, receipt.client_request_id,
                       receipt.submission_claim_id
                  INTO receipt_account, receipt_client_request_id,
                       submission_claim_id
                  FROM broker_mutation_receipts AS receipt
                 WHERE receipt.id = NEW.receipt_id
                   FOR KEY SHARE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'broker mutation linked receipt not found'
                        USING ERRCODE = '23503';
                END IF;
                IF submission_claim_id IS NULL THEN
                    IF NEW.submission_claim_token IS NOT NULL
                       OR NEW.submission_claim_fencing_epoch IS NOT NULL
                       OR NEW.submission_claim_owner IS NOT NULL THEN
                        RAISE EXCEPTION
                            'unlinked broker mutation event has claim identity'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END IF;
                SELECT claim.account_label, claim.broker_io_started_at,
                       claim.client_order_id, claim.fencing_epoch,
                       claim.lease_expires_at, claim.claim_owner,
                       claim.recovery_after, claim.released_at, claim.state,
                       claim.claim_token
                  INTO claim_account, claim_broker_io_started_at,
                       claim_client_request_id, claim_epoch,
                       claim_lease_expires_at, claim_owner,
                       claim_recovery_after, claim_released_at, claim_state,
                       claim_token
                  FROM trade_decision_submission_claims AS claim
                 WHERE claim.trade_decision_id = submission_claim_id
                   FOR UPDATE;
                IF NOT FOUND
                   OR claim_account IS DISTINCT FROM receipt_account
                   OR claim_client_request_id
                        IS DISTINCT FROM receipt_client_request_id
                   OR claim_token
                        IS DISTINCT FROM NEW.submission_claim_token
                   OR claim_epoch
                        IS DISTINCT FROM NEW.submission_claim_fencing_epoch
                   OR claim_owner
                        IS DISTINCT FROM NEW.submission_claim_owner
                   OR NEW.primary_owner
                        IS DISTINCT FROM NEW.submission_claim_owner THEN
                    RAISE EXCEPTION
                        'broker mutation linked event claim identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.event_type = 'primary_claimed' THEN
                    IF NEW.state <> 'claimed'
                       OR claim_state <> 'claimed'
                       OR claim_released_at IS NOT NULL
                       OR claim_lease_expires_at <= clock_timestamp()
                       OR NEW.primary_lease_expires_at
                            > NEW.primary_claimed_at + interval '30 seconds' THEN
                        RAISE EXCEPTION
                            'broker mutation linked primary acquisition mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF NEW.event_type = 'primary_renewed' THEN
                    RAISE EXCEPTION
                        'broker mutation linked primary renewal is forbidden'
                        USING ERRCODE = '23514';
                ELSIF NEW.event_type = 'primary_released' THEN
                    IF NEW.state <> 'released' OR claim_state <> 'claimed' THEN
                        RAISE EXCEPTION
                            'broker mutation linked primary release mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF NEW.event_type IN (
                    'broker_io_started', 'recovery_claimed',
                    'recovery_renewed', 'recovery_observed',
                    'recovery_released'
                ) THEN
                    IF NEW.state <> 'broker_io'
                       OR claim_state <> 'broker_io'
                       OR claim_broker_io_started_at IS NULL
                       OR claim_recovery_after IS NULL THEN
                        RAISE EXCEPTION
                            'broker mutation linked broker I/O lifecycle mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF NEW.event_type = 'settled' THEN
                    RAISE EXCEPTION
                        'linked broker mutation settlement requires atomic coordinator'
                        USING ERRCODE = '23514';
                ELSE
                    RAISE EXCEPTION
                        'broker mutation linked event type unsupported'
                        USING ERRCODE = '23514';
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
            CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_0060
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_bm_linked_event_0060()
            """
        )
    )


def _create_recovery_envelope_guard() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_recovery_envelope_0060()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                evidence_document jsonb;
                expected_client_request_id text;
                expected_target_key text;
            BEGIN
                IF NEW.recovery_evidence_json IS NULL THEN
                    RETURN NEW;
                END IF;
                evidence_document := NEW.recovery_evidence_json::jsonb;
                SELECT client_request_id, target_key
                  INTO expected_client_request_id, expected_target_key
                  FROM broker_mutation_receipts
                 WHERE id = NEW.receipt_id
                   FOR KEY SHARE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'broker mutation recovery receipt not found'
                        USING ERRCODE = '23503';
                END IF;
                IF jsonb_typeof(evidence_document) <> 'object'
                   OR (SELECT count(*) FROM jsonb_object_keys(evidence_document)) <> 5
                   OR NOT evidence_document ?& ARRAY[
                       'schema_version', 'checked_client_request_id',
                       'checked_target_key', 'outcome', 'observation'
                   ]
                   OR evidence_document ->> 'schema_version' IS DISTINCT FROM
                       'torghut.broker-mutation-recovery-evidence.v1'
                   OR jsonb_typeof(
                       evidence_document -> 'checked_client_request_id'
                   ) <> 'string'
                   OR evidence_document ->> 'checked_client_request_id'
                        IS DISTINCT FROM expected_client_request_id
                   OR jsonb_typeof(evidence_document -> 'checked_target_key')
                        <> 'string'
                   OR evidence_document ->> 'checked_target_key'
                        IS DISTINCT FROM expected_target_key
                   OR jsonb_typeof(evidence_document -> 'outcome') <> 'string'
                   OR evidence_document ->> 'outcome'
                        IS DISTINCT FROM NEW.recovery_outcome
                   OR jsonb_typeof(evidence_document -> 'observation') <> 'object' THEN
                    RAISE EXCEPTION
                        'broker mutation recovery evidence envelope mismatch'
                        USING ERRCODE = '23514';
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
            CREATE TRIGGER trg_guard_bm_receipt_event_b_recovery_0060
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_bm_recovery_envelope_0060()
            """
        )
    )


def _create_settlement_envelope_guard() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_settlement_envelope_0060()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                evidence_document jsonb;
                linked_submission_claim_id uuid;
            BEGIN
                IF NEW.event_type = 'settled' THEN
                    SELECT submission_claim_id INTO linked_submission_claim_id
                      FROM broker_mutation_receipts
                     WHERE id = NEW.receipt_id
                       FOR KEY SHARE;
                    IF NOT FOUND THEN
                        RAISE EXCEPTION 'broker mutation settlement receipt not found'
                            USING ERRCODE = '23503';
                    END IF;
                    IF linked_submission_claim_id IS NOT NULL THEN
                        RAISE EXCEPTION
                            'linked broker mutation settlement requires atomic coordinator'
                            USING ERRCODE = '23514';
                    END IF;
                END IF;
                IF NEW.settlement_evidence_json IS NULL THEN
                    RETURN NEW;
                END IF;
                evidence_document := NEW.settlement_evidence_json::jsonb;
                IF jsonb_typeof(evidence_document) <> 'object'
                   OR (SELECT count(*) FROM jsonb_object_keys(evidence_document)) <> 6
                   OR NOT evidence_document ?& ARRAY[
                       'schema_version', 'source', 'outcome',
                       'broker_reference', 'execution_id', 'evidence'
                   ]
                   OR evidence_document ->> 'schema_version' IS DISTINCT FROM
                       'torghut.broker-mutation-settlement-evidence.v1'
                   OR jsonb_typeof(evidence_document -> 'source') <> 'string'
                   OR evidence_document ->> 'source'
                        IS DISTINCT FROM NEW.settlement_source
                   OR jsonb_typeof(evidence_document -> 'outcome') <> 'string'
                   OR evidence_document ->> 'outcome'
                        IS DISTINCT FROM NEW.settlement_outcome
                   OR evidence_document ->> 'broker_reference'
                        IS DISTINCT FROM NEW.broker_reference
                   OR evidence_document ->> 'execution_id'
                        IS DISTINCT FROM NEW.execution_id::text
                   OR jsonb_typeof(evidence_document -> 'evidence') <> 'object' THEN
                    RAISE EXCEPTION
                        'broker mutation settlement evidence envelope mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF (
                    NEW.broker_reference IS NULL
                    AND evidence_document -> 'broker_reference' <> 'null'::jsonb
                ) OR (
                    NEW.broker_reference IS NOT NULL
                    AND jsonb_typeof(evidence_document -> 'broker_reference')
                        <> 'string'
                ) OR (
                    NEW.execution_id IS NULL
                    AND evidence_document -> 'execution_id' <> 'null'::jsonb
                ) OR (
                    NEW.execution_id IS NOT NULL
                    AND jsonb_typeof(evidence_document -> 'execution_id') <> 'string'
                ) THEN
                    RAISE EXCEPTION
                        'broker mutation settlement evidence nullability mismatch'
                        USING ERRCODE = '23514';
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
            CREATE TRIGGER trg_guard_bm_receipt_event_c_settlement_0060
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_bm_settlement_envelope_0060()
            """
        )
    )


def upgrade() -> None:
    _refuse_nonempty_parent_state()
    _add_linked_claim_identity_columns()
    _create_canonical_json_helper()
    _create_secret_key_helpers()
    _create_receipt_guards()
    _create_event_secret_guard()
    _create_linked_event_guard()
    _create_recovery_envelope_guard()
    _create_settlement_envelope_guard()


def downgrade() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE broker_mutation_receipts, "
            "broker_mutation_receipt_events IN ACCESS EXCLUSIVE MODE NOWAIT"
        )
    )
    op.execute(
        sa.text(
            """
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM broker_mutation_receipts)
                   OR EXISTS (SELECT 1 FROM broker_mutation_receipt_events) THEN
                    RAISE EXCEPTION
                        'refusing to downgrade nonempty broker mutation evidence envelopes';
                END IF;
            END; $$
            """
        )
    )
    for statement in (
        "DROP TRIGGER trg_guard_bm_receipt_event_c_settlement_0060 ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_event_b_recovery_0060 ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_event_b_linked_0060 ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_event_a_secrets_0060 ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_b_request_secrets_0060 ON broker_mutation_receipts",
        "DROP TRIGGER trg_guard_bm_receipt_a_claim_0060 ON broker_mutation_receipts",
        "DROP FUNCTION torghut_guard_bm_settlement_envelope_0060()",
        "DROP FUNCTION torghut_guard_bm_recovery_envelope_0060()",
        "DROP FUNCTION torghut_guard_bm_linked_event_0060()",
        "DROP FUNCTION torghut_guard_bm_evidence_secrets_0060()",
        "DROP FUNCTION torghut_guard_bm_request_secrets_0060()",
        "DROP FUNCTION torghut_guard_bm_claim_0060()",
        "DROP FUNCTION torghut_assert_bm_no_secret_keys_0060(jsonb, text)",
        "DROP FUNCTION torghut_bm_security_key_0060(text)",
        "DROP FUNCTION torghut_assert_bm_canonical_json_0060(text, text, integer)",
        "DROP FUNCTION torghut_bm_canonical_json_0060(json, integer)",
    ):
        op.execute(sa.text(statement))
    op.drop_constraint(
        "ck_bm_event_submission_claim_identity",
        "broker_mutation_receipt_events",
        type_="check",
    )
    op.drop_column(
        "broker_mutation_receipt_events",
        "submission_claim_owner",
    )
    op.drop_column(
        "broker_mutation_receipt_events",
        "submission_claim_fencing_epoch",
    )
    op.drop_column(
        "broker_mutation_receipt_events",
        "submission_claim_token",
    )

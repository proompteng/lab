"""Coordinate fenced recovery for linked submission receipts.

Revision ID: 0062_linked_submission_recovery
Revises: 0061_linked_submission_terminal
Create Date: 2026-07-11 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0062_linked_submission_recovery"
down_revision = "0061_linked_submission_terminal"
branch_labels = None
depends_on = None


_LOCK_SQL = """
LOCK TABLE executions, trade_decision_submission_claims,
    broker_mutation_receipts, broker_mutation_receipt_events
IN ACCESS EXCLUSIVE MODE NOWAIT
"""


_UPGRADE_COMPATIBILITY_SQL = """
DO $$ BEGIN
    IF EXISTS (
        SELECT 1
          FROM broker_mutation_receipts AS receipt
          JOIN trade_decision_submission_claims AS claim
            ON claim.trade_decision_id = receipt.submission_claim_id
          LEFT JOIN LATERAL (
              SELECT event.*
                FROM broker_mutation_receipt_events AS event
               WHERE event.receipt_id = receipt.id
               ORDER BY event.sequence_no DESC
               LIMIT 1
          ) AS latest ON true
         WHERE receipt.operation = 'submit_order'
           AND claim.state = 'broker_io'
           AND (
               latest.id IS NULL
               OR latest.state <> 'broker_io'
               OR latest.recovery_token IS DISTINCT FROM claim.recovery_token
               OR latest.recovery_epoch
                    IS DISTINCT FROM claim.recovery_fencing_epoch
               OR latest.recovery_owner IS DISTINCT FROM claim.recovery_owner
               OR latest.recovery_lease_started_at
                    IS DISTINCT FROM claim.recovery_lease_started_at
               OR latest.recovery_lease_expires_at
                    IS DISTINCT FROM claim.recovery_lease_expires_at
               OR latest.recovery_checked_at
                    IS DISTINCT FROM claim.recovery_checked_at
               OR latest.recovery_observation_epoch
                    IS DISTINCT FROM claim.recovery_observation_epoch
               OR latest.recovery_outcome
                    IS DISTINCT FROM claim.recovery_outcome
               OR latest.recovery_evidence_json
                    IS DISTINCT FROM claim.recovery_evidence
           )
    ) THEN
        RAISE EXCEPTION
            'refusing to upgrade asymmetric linked submission recovery state'
            USING ERRCODE = '55000';
    END IF;
END; $$
"""


_DOWNGRADE_COMPATIBILITY_SQL = """
DO $$ BEGIN
    IF EXISTS (
        SELECT 1
          FROM broker_mutation_receipt_events AS event
          JOIN broker_mutation_receipts AS receipt ON receipt.id = event.receipt_id
         WHERE receipt.submission_claim_id IS NOT NULL
           AND event.event_type = 'settled'
           AND event.settlement_source = 'recovery'
    ) THEN
        RAISE EXCEPTION 'refusing to downgrade linked recovery terminal state'
            USING ERRCODE = '55000';
    END IF;
END; $$
"""


def _linked_terminal_guard_sql(*, allow_recovery: bool) -> str:
    if allow_recovery:
        source_guard = """
                IF NEW.settlement_source = 'primary' THEN
                    IF NEW.settlement_outcome NOT IN (
                        'acknowledged', 'reconciled', 'rejected'
                    ) THEN
                        RAISE EXCEPTION 'linked terminal source or outcome invalid'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF NEW.settlement_source = 'recovery' THEN
                    IF NEW.settlement_outcome <> 'reconciled'
                       OR claim.state <> 'broker_io'
                       OR NEW.recovery_token IS NULL
                       OR NEW.recovery_epoch <= 0
                       OR NEW.recovery_token
                            IS DISTINCT FROM claim.recovery_token
                       OR NEW.recovery_epoch
                            IS DISTINCT FROM claim.recovery_fencing_epoch
                       OR NEW.recovery_owner
                            IS DISTINCT FROM claim.recovery_owner
                       OR NEW.recovery_lease_started_at
                            IS DISTINCT FROM claim.recovery_lease_started_at
                       OR claim.recovery_lease_expires_at IS NULL
                       OR claim.recovery_lease_expires_at <= NEW.settled_at
                       OR NEW.recovery_lease_expires_at
                            IS DISTINCT FROM NEW.settled_at THEN
                        RAISE EXCEPTION 'linked recovery terminal fence mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'linked terminal source or outcome invalid'
                        USING ERRCODE = '23514';
                END IF;
        """
    else:
        source_guard = """
                IF NEW.settlement_source <> 'primary'
                   OR NEW.settlement_outcome NOT IN (
                       'acknowledged', 'reconciled', 'rejected'
                   ) THEN
                    RAISE EXCEPTION 'linked terminal source or outcome invalid'
                        USING ERRCODE = '23514';
                END IF;
        """
    return f"""
        CREATE OR REPLACE FUNCTION torghut_guard_bm_linked_terminal_0061()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            claim trade_decision_submission_claims%ROWTYPE;
            receipt broker_mutation_receipts%ROWTYPE;
        BEGIN
            SELECT * INTO receipt FROM broker_mutation_receipts
             WHERE id = NEW.receipt_id FOR KEY SHARE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'linked terminal receipt not found'
                    USING ERRCODE = '23503';
            END IF;
            IF receipt.submission_claim_id IS NULL THEN
                IF NEW.submission_claim_token IS NOT NULL
                   OR NEW.submission_claim_fencing_epoch IS NOT NULL
                   OR NEW.submission_claim_owner IS NOT NULL THEN
                    RAISE EXCEPTION
                        'unlinked broker mutation event has claim identity'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NEW;
            END IF;
            SELECT * INTO claim FROM trade_decision_submission_claims
             WHERE trade_decision_id = receipt.submission_claim_id FOR UPDATE;
            IF NOT FOUND
               OR receipt.operation <> 'submit_order'
               OR receipt.account_label IS DISTINCT FROM claim.account_label
               OR receipt.client_request_id IS DISTINCT FROM claim.client_order_id
               OR NEW.submission_claim_token IS DISTINCT FROM claim.claim_token
               OR NEW.submission_claim_fencing_epoch
                    IS DISTINCT FROM claim.fencing_epoch
               OR NEW.submission_claim_owner IS DISTINCT FROM claim.claim_owner
               OR NEW.primary_owner IS DISTINCT FROM claim.claim_owner
               OR claim.state NOT IN ('broker_io', 'submitted', 'rejected') THEN
                RAISE EXCEPTION 'linked terminal claim identity mismatch'
                    USING ERRCODE = '23514';
            END IF;
            {source_guard}
            IF NEW.settlement_outcome IN ('acknowledged', 'reconciled') THEN
                IF NEW.broker_reference IS NULL OR NEW.execution_id IS NULL THEN
                    RAISE EXCEPTION 'linked success requires execution identity'
                        USING ERRCODE = '23514';
                END IF;
            ELSIF NEW.broker_reference IS NOT NULL OR NEW.execution_id IS NOT NULL THEN
                RAISE EXCEPTION 'linked rejection forbids execution identity'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
    """


_PRIMARY_TERMINAL_EVIDENCE_SQL = """
                IF (SELECT count(*) FROM jsonb_object_keys(terminal_document)) <> 6
                   OR NOT terminal_document ?& ARRAY[
                       'schema_version', 'decision_id', 'account_label',
                       'client_order_id', 'broker_status', 'rejection_code'
                   ]
                   OR terminal_document ->> 'schema_version' IS DISTINCT FROM
                       'torghut.linked-submission-terminal.v1'
                   OR terminal_document ->> 'decision_id'
                        IS DISTINCT FROM claim_id::text
                   OR terminal_document ->> 'account_label'
                        IS DISTINCT FROM receipt_account
                   OR terminal_document ->> 'client_order_id'
                        IS DISTINCT FROM receipt_client
                   OR jsonb_typeof(terminal_document -> 'broker_status') <> 'string'
                   OR terminal_document ->> 'broker_status' !~
                        '^[a-z0-9][a-z0-9_.:-]{0,63}$'
                   OR (NEW.settlement_outcome = 'rejected' AND (
                       jsonb_typeof(terminal_document -> 'rejection_code') <> 'string'
                       OR terminal_document ->> 'rejection_code' !~
                           '^[a-z0-9][a-z0-9_.:-]{0,127}$'
                   ))
                   OR (NEW.settlement_outcome <> 'rejected'
                       AND terminal_document -> 'rejection_code' <> 'null'::jsonb) THEN
                    RAISE EXCEPTION 'linked terminal evidence envelope mismatch'
                        USING ERRCODE = '23514';
                END IF;
"""


_RECOVERY_TERMINAL_EVIDENCE_SQL = """
                IF NEW.settlement_outcome <> 'reconciled'
                   OR (SELECT count(*) FROM jsonb_object_keys(terminal_document)) <> 9
                   OR NOT terminal_document ?& ARRAY[
                       'schema_version', 'decision_id', 'account_label',
                       'client_order_id', 'checked_client_order_id',
                       'checked_target_key', 'observation_outcome',
                       'broker_status', 'rejection_code'
                   ]
                   OR terminal_document ->> 'schema_version' IS DISTINCT FROM
                       'torghut.linked-submission-recovery-terminal.v1'
                   OR terminal_document ->> 'decision_id'
                        IS DISTINCT FROM claim_id::text
                   OR terminal_document ->> 'account_label'
                        IS DISTINCT FROM receipt_account
                   OR terminal_document ->> 'client_order_id'
                        IS DISTINCT FROM receipt_client
                   OR terminal_document ->> 'checked_client_order_id'
                        IS DISTINCT FROM receipt_client
                   OR terminal_document ->> 'checked_target_key'
                        IS DISTINCT FROM receipt_target
                   OR jsonb_typeof(terminal_document -> 'observation_outcome')
                        <> 'string'
                   OR terminal_document ->> 'observation_outcome'
                        IS DISTINCT FROM 'found'
                   OR jsonb_typeof(terminal_document -> 'broker_status') <> 'string'
                   OR terminal_document ->> 'broker_status' !~
                        '^[a-z0-9][a-z0-9_.:-]{0,63}$'
                   OR terminal_document -> 'rejection_code' <> 'null'::jsonb THEN
                    RAISE EXCEPTION
                        'linked recovery terminal evidence envelope mismatch'
                        USING ERRCODE = '23514';
                END IF;
"""


def _settlement_envelope_guard_sql(*, allow_recovery: bool) -> str:
    if allow_recovery:
        target_declaration = "receipt_target text;"
        receipt_select = """
            SELECT submission_claim_id, account_label, client_request_id, target_key
              INTO claim_id, receipt_account, receipt_client, receipt_target
              FROM broker_mutation_receipts
             WHERE id = NEW.receipt_id FOR KEY SHARE;
        """
        terminal_guard = f"""
                IF NEW.settlement_source = 'primary' THEN
                    {_PRIMARY_TERMINAL_EVIDENCE_SQL}
                ELSIF NEW.settlement_source = 'recovery' THEN
                    {_RECOVERY_TERMINAL_EVIDENCE_SQL}
                ELSE
                    RAISE EXCEPTION 'linked terminal evidence envelope mismatch'
                        USING ERRCODE = '23514';
                END IF;
        """
    else:
        target_declaration = ""
        receipt_select = """
            SELECT submission_claim_id, account_label, client_request_id
              INTO claim_id, receipt_account, receipt_client
              FROM broker_mutation_receipts
             WHERE id = NEW.receipt_id FOR KEY SHARE;
        """
        terminal_guard = _PRIMARY_TERMINAL_EVIDENCE_SQL
    return f"""
        CREATE OR REPLACE FUNCTION torghut_guard_bm_settlement_envelope_0061()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            claim_id uuid;
            evidence_document jsonb;
            receipt_account text;
            receipt_client text;
            {target_declaration}
            terminal_document jsonb;
        BEGIN
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
               OR evidence_document ->> 'source'
                    IS DISTINCT FROM NEW.settlement_source
               OR evidence_document ->> 'outcome'
                    IS DISTINCT FROM NEW.settlement_outcome
               OR evidence_document ->> 'broker_reference'
                    IS DISTINCT FROM NEW.broker_reference
               OR evidence_document ->> 'execution_id'
                    IS DISTINCT FROM NEW.execution_id::text
               OR jsonb_typeof(evidence_document -> 'evidence') <> 'object'
               OR (NEW.broker_reference IS NULL
                   AND evidence_document -> 'broker_reference' <> 'null'::jsonb)
               OR (NEW.broker_reference IS NOT NULL
                   AND jsonb_typeof(evidence_document -> 'broker_reference')
                       <> 'string')
               OR (NEW.execution_id IS NULL
                   AND evidence_document -> 'execution_id' <> 'null'::jsonb)
               OR (NEW.execution_id IS NOT NULL
                   AND jsonb_typeof(evidence_document -> 'execution_id')
                       <> 'string') THEN
                RAISE EXCEPTION 'broker mutation settlement envelope mismatch'
                    USING ERRCODE = '23514';
            END IF;
            {receipt_select}
            IF NOT FOUND THEN
                RAISE EXCEPTION 'broker mutation settlement receipt not found'
                    USING ERRCODE = '23503';
            END IF;
            IF claim_id IS NULL THEN
                RETURN NEW;
            END IF;
            terminal_document := evidence_document -> 'evidence';
            {terminal_guard}
            RETURN NEW;
        END;
        $$
    """


_TERMINAL_ASSERTION_0062_SQL = """
CREATE OR REPLACE FUNCTION torghut_assert_linked_submission_terminal_0061(
    target_claim_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    claim trade_decision_submission_claims%ROWTYPE;
    event broker_mutation_receipt_events%ROWTYPE;
    has_execution boolean;
    latest_event_id uuid;
    receipt broker_mutation_receipts%ROWTYPE;
BEGIN
    SELECT * INTO claim FROM trade_decision_submission_claims
     WHERE trade_decision_id = target_claim_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO receipt FROM broker_mutation_receipts
     WHERE submission_claim_id = target_claim_id AND operation = 'submit_order';
    IF NOT FOUND THEN
        IF claim.state = 'rejected' OR claim.terminal_receipt_event_id IS NOT NULL THEN
            RAISE EXCEPTION 'claim terminal is missing its linked receipt'
                USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM executions
             WHERE trade_decision_id = claim.trade_decision_id
                OR (alpaca_account_label = claim.account_label
                    AND client_order_id = claim.client_order_id)
        ) INTO has_execution;
        IF claim.state IN ('claimed', 'broker_io') AND has_execution THEN
            RAISE EXCEPTION 'nonterminal claim has matching execution'
                USING ERRCODE = '23514';
        END IF;
        RETURN;
    END IF;
    IF receipt.broker_route <> 'alpaca'
       OR receipt.account_label IS DISTINCT FROM claim.account_label
       OR receipt.client_request_id IS DISTINCT FROM claim.client_order_id
       OR receipt.target_kind <> 'order'
       OR receipt.target_key IS DISTINCT FROM claim.client_order_id THEN
        RAISE EXCEPTION 'linked receipt claim identity mismatch'
            USING ERRCODE = '23514';
    END IF;
    SELECT id INTO latest_event_id FROM broker_mutation_receipt_events
     WHERE receipt_id = receipt.id ORDER BY sequence_no DESC LIMIT 1;
    SELECT EXISTS (
        SELECT 1 FROM executions
         WHERE trade_decision_id = claim.trade_decision_id
            OR (alpaca_account_label = claim.account_label
                AND client_order_id = claim.client_order_id)
    ) INTO has_execution;
    IF claim.state IN ('claimed', 'broker_io') THEN
        SELECT * INTO event FROM broker_mutation_receipt_events
         WHERE id = latest_event_id;
        IF latest_event_id IS NULL
           OR claim.terminal_receipt_event_id IS NOT NULL OR has_execution
           OR (claim.state = 'claimed' AND event.state NOT IN ('claimed', 'released'))
           OR (claim.state = 'broker_io' AND event.state <> 'broker_io') THEN
            RAISE EXCEPTION 'linked nonterminal state is asymmetric'
                USING ERRCODE = '23514';
        END IF;
        IF claim.state = 'broker_io' AND (
            event.recovery_token IS DISTINCT FROM claim.recovery_token
            OR event.recovery_epoch
                IS DISTINCT FROM claim.recovery_fencing_epoch
            OR event.recovery_owner IS DISTINCT FROM claim.recovery_owner
            OR event.recovery_lease_started_at
                IS DISTINCT FROM claim.recovery_lease_started_at
            OR event.recovery_lease_expires_at
                IS DISTINCT FROM claim.recovery_lease_expires_at
            OR event.recovery_checked_at
                IS DISTINCT FROM claim.recovery_checked_at
            OR event.recovery_observation_epoch
                IS DISTINCT FROM claim.recovery_observation_epoch
            OR event.recovery_outcome IS DISTINCT FROM claim.recovery_outcome
            OR event.recovery_evidence_json
                IS DISTINCT FROM claim.recovery_evidence
        ) THEN
            RAISE EXCEPTION 'linked nonterminal recovery state is asymmetric'
                USING ERRCODE = '23514';
        END IF;
        RETURN;
    END IF;
    IF claim.state NOT IN ('submitted', 'rejected')
       OR claim.terminal_receipt_event_id IS NULL THEN
        RAISE EXCEPTION 'linked claim terminal state is invalid'
            USING ERRCODE = '23514';
    END IF;
    SELECT * INTO event FROM broker_mutation_receipt_events
     WHERE id = claim.terminal_receipt_event_id;
    IF NOT FOUND OR event.receipt_id IS DISTINCT FROM receipt.id
       OR event.id IS DISTINCT FROM latest_event_id
       OR event.event_type <> 'settled' OR event.state <> 'settled'
       OR event.settlement_source NOT IN ('primary', 'recovery')
       OR event.settled_at IS NULL
       OR event.submission_claim_token IS DISTINCT FROM claim.claim_token
       OR event.submission_claim_fencing_epoch IS DISTINCT FROM claim.fencing_epoch
       OR event.submission_claim_owner IS DISTINCT FROM claim.claim_owner
       OR event.primary_owner IS DISTINCT FROM claim.claim_owner
       OR claim.completed_at IS DISTINCT FROM event.settled_at THEN
        RAISE EXCEPTION 'linked terminal event pointer or fence mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF event.settlement_source = 'recovery' AND (
        claim.state <> 'submitted'
        OR event.settlement_outcome <> 'reconciled'
        OR event.recovery_token IS NULL
        OR event.recovery_token IS DISTINCT FROM claim.recovery_token
        OR event.recovery_epoch IS DISTINCT FROM claim.recovery_fencing_epoch
        OR event.recovery_owner IS DISTINCT FROM claim.recovery_owner
        OR event.recovery_lease_started_at
            IS DISTINCT FROM claim.recovery_lease_started_at
        OR event.recovery_lease_expires_at IS DISTINCT FROM event.settled_at
        OR claim.recovery_lease_expires_at IS DISTINCT FROM event.settled_at
        OR claim.recovery_checked_at IS DISTINCT FROM event.settled_at
        OR claim.recovery_observation_epoch
            IS DISTINCT FROM claim.recovery_fencing_epoch
        OR claim.recovery_outcome <> 'found'
        OR claim.recovery_evidence
            IS DISTINCT FROM event.settlement_evidence_json
    ) THEN
        RAISE EXCEPTION 'linked recovery terminal observation mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF claim.state = 'submitted' THEN
        IF event.settlement_outcome NOT IN ('acknowledged', 'reconciled')
           OR event.broker_reference IS DISTINCT FROM claim.broker_order_id
           OR event.execution_id IS DISTINCT FROM claim.execution_id
           OR claim.broker_client_order_id IS DISTINCT FROM claim.client_order_id
           OR NOT EXISTS (
               SELECT 1 FROM executions
                WHERE id = claim.execution_id
                  AND trade_decision_id = claim.trade_decision_id
                  AND alpaca_account_label = claim.account_label
                  AND client_order_id = claim.client_order_id
                  AND alpaca_order_id = claim.broker_order_id
           ) THEN
            RAISE EXCEPTION 'linked submitted execution truth mismatch'
                USING ERRCODE = '23514';
        END IF;
    ELSIF event.settlement_source <> 'primary'
       OR event.settlement_outcome <> 'rejected'
       OR event.broker_reference IS NOT NULL OR event.execution_id IS NOT NULL
       OR claim.broker_order_id IS NOT NULL
       OR claim.broker_client_order_id IS NOT NULL OR claim.execution_id IS NOT NULL
       OR has_execution THEN
        RAISE EXCEPTION 'linked rejected execution truth mismatch'
            USING ERRCODE = '23514';
    END IF;
END;
$$
"""


_TERMINAL_ASSERTION_0061_SQL = """
CREATE OR REPLACE FUNCTION torghut_assert_linked_submission_terminal_0061(
    target_claim_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    claim trade_decision_submission_claims%ROWTYPE;
    event broker_mutation_receipt_events%ROWTYPE;
    has_execution boolean;
    latest_event_id uuid;
    receipt broker_mutation_receipts%ROWTYPE;
BEGIN
    SELECT * INTO claim FROM trade_decision_submission_claims
     WHERE trade_decision_id = target_claim_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO receipt FROM broker_mutation_receipts
     WHERE submission_claim_id = target_claim_id AND operation = 'submit_order';
    IF NOT FOUND THEN
        IF claim.state = 'rejected' OR claim.terminal_receipt_event_id IS NOT NULL THEN
            RAISE EXCEPTION 'claim terminal is missing its linked receipt'
                USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM executions
             WHERE trade_decision_id = claim.trade_decision_id
                OR (alpaca_account_label = claim.account_label
                    AND client_order_id = claim.client_order_id)
        ) INTO has_execution;
        IF claim.state IN ('claimed', 'broker_io') AND has_execution THEN
            RAISE EXCEPTION 'nonterminal claim has matching execution'
                USING ERRCODE = '23514';
        END IF;
        RETURN;
    END IF;
    IF receipt.broker_route <> 'alpaca'
       OR receipt.account_label IS DISTINCT FROM claim.account_label
       OR receipt.client_request_id IS DISTINCT FROM claim.client_order_id
       OR receipt.target_kind <> 'order'
       OR receipt.target_key IS DISTINCT FROM claim.client_order_id THEN
        RAISE EXCEPTION 'linked receipt claim identity mismatch'
            USING ERRCODE = '23514';
    END IF;
    SELECT id INTO latest_event_id FROM broker_mutation_receipt_events
     WHERE receipt_id = receipt.id ORDER BY sequence_no DESC LIMIT 1;
    SELECT EXISTS (
        SELECT 1 FROM executions
         WHERE trade_decision_id = claim.trade_decision_id
            OR (alpaca_account_label = claim.account_label
                AND client_order_id = claim.client_order_id)
    ) INTO has_execution;
    IF claim.state IN ('claimed', 'broker_io') THEN
        SELECT * INTO event FROM broker_mutation_receipt_events
         WHERE id = latest_event_id;
        IF claim.terminal_receipt_event_id IS NOT NULL OR has_execution
           OR (claim.state = 'claimed' AND event.state NOT IN ('claimed', 'released'))
           OR (claim.state = 'broker_io' AND event.state <> 'broker_io') THEN
            RAISE EXCEPTION 'linked nonterminal state is asymmetric'
                USING ERRCODE = '23514';
        END IF;
        RETURN;
    END IF;
    IF claim.state NOT IN ('submitted', 'rejected')
       OR claim.terminal_receipt_event_id IS NULL THEN
        RAISE EXCEPTION 'linked claim terminal state is invalid'
            USING ERRCODE = '23514';
    END IF;
    SELECT * INTO event FROM broker_mutation_receipt_events
     WHERE id = claim.terminal_receipt_event_id;
    IF NOT FOUND OR event.receipt_id IS DISTINCT FROM receipt.id
       OR event.id IS DISTINCT FROM latest_event_id
       OR event.event_type <> 'settled' OR event.state <> 'settled'
       OR event.settlement_source <> 'primary'
       OR event.settled_at IS NULL
       OR event.submission_claim_token IS DISTINCT FROM claim.claim_token
       OR event.submission_claim_fencing_epoch IS DISTINCT FROM claim.fencing_epoch
       OR event.submission_claim_owner IS DISTINCT FROM claim.claim_owner
       OR event.primary_owner IS DISTINCT FROM claim.claim_owner
       OR claim.completed_at IS DISTINCT FROM event.settled_at THEN
        RAISE EXCEPTION 'linked terminal event pointer or fence mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF claim.state = 'submitted' THEN
        IF event.settlement_outcome NOT IN ('acknowledged', 'reconciled')
           OR event.broker_reference IS DISTINCT FROM claim.broker_order_id
           OR event.execution_id IS DISTINCT FROM claim.execution_id
           OR claim.broker_client_order_id IS DISTINCT FROM claim.client_order_id
           OR NOT EXISTS (
               SELECT 1 FROM executions
                WHERE id = claim.execution_id
                  AND trade_decision_id = claim.trade_decision_id
                  AND alpaca_account_label = claim.account_label
                  AND client_order_id = claim.client_order_id
                  AND alpaca_order_id = claim.broker_order_id
           ) THEN
            RAISE EXCEPTION 'linked submitted execution truth mismatch'
                USING ERRCODE = '23514';
        END IF;
    ELSIF event.settlement_outcome <> 'rejected'
       OR event.broker_reference IS NOT NULL OR event.execution_id IS NOT NULL
       OR claim.broker_order_id IS NOT NULL
       OR claim.broker_client_order_id IS NOT NULL OR claim.execution_id IS NOT NULL
       OR has_execution THEN
        RAISE EXCEPTION 'linked rejected execution truth mismatch'
            USING ERRCODE = '23514';
    END IF;
END;
$$
"""


# The exact 0059 body is retained below so downgrade does not depend on source files
# from another revision. The 0062 variant is derived with two checked, one-time edits.
_BROKER_EVENT_GUARD_0061_SQL = """
CREATE OR REPLACE FUNCTION torghut_guard_broker_mutation_event()
RETURNS trigger LANGUAGE plpgsql AS $$
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
                   'submission_claim_token', 'submission_claim_fencing_epoch', 'submission_claim_owner',
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
               OR (NEW.settlement_source = 'recovery' AND
                   NEW.settlement_outcome = 'acknowledged')
               OR (NEW.settlement_outcome IN
                   ('acknowledged', 'reconciled') AND
                   NEW.broker_reference IS NULL)
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


def _broker_event_guard_0062_sql() -> str:
    sql = _BROKER_EVENT_GUARD_0061_SQL
    state_branch = """        ELSIF previous.state = 'broker_io' THEN
"""
    replacement = """        ELSIF previous.state = 'broker_io' THEN
            IF NEW.settlement_source = 'recovery'
               AND NEW.settlement_outcome = 'reconciled' THEN
                NEW.recovery_lease_expires_at := now_at;
            END IF;
"""
    if sql.count(state_branch) != 1:
        raise RuntimeError("0062 broker event state branch drifted")
    sql = sql.replace(state_branch, replacement)
    equality = """                   NEW, previous, base_ignored || ARRAY[
                       'state', 'settlement_source',
                       'settlement_outcome', 'broker_reference',
                       'execution_id', 'settlement_evidence_json',
                       'settlement_evidence_sha256', 'settled_at'
                   ]
"""
    recovery_equality = """                   NEW, previous, base_ignored || ARRAY[
                       'state', 'settlement_source',
                       'settlement_outcome', 'broker_reference',
                       'execution_id', 'settlement_evidence_json',
                       'settlement_evidence_sha256', 'settled_at'
                   ] || CASE
                       WHEN NEW.settlement_source = 'recovery'
                        AND NEW.settlement_outcome = 'reconciled'
                       THEN ARRAY['recovery_lease_expires_at']
                       ELSE ARRAY[]::text[]
                   END
"""
    if sql.count(equality) != 2:
        raise RuntimeError("0062 broker event settlement equality drifted")
    head, separator, tail = sql.rpartition(equality)
    if not separator:
        raise RuntimeError("0062 broker event settlement equality missing")
    return head + recovery_equality + tail


def upgrade() -> None:
    op.execute(sa.text(_LOCK_SQL))
    op.execute(sa.text(_UPGRADE_COMPATIBILITY_SQL))
    op.execute(sa.text(_broker_event_guard_0062_sql()))
    op.execute(sa.text(_linked_terminal_guard_sql(allow_recovery=True)))
    op.execute(sa.text(_settlement_envelope_guard_sql(allow_recovery=True)))
    op.execute(sa.text(_TERMINAL_ASSERTION_0062_SQL))


def downgrade() -> None:
    op.execute(sa.text(_LOCK_SQL))
    op.execute(sa.text(_DOWNGRADE_COMPATIBILITY_SQL))
    op.execute(sa.text(_BROKER_EVENT_GUARD_0061_SQL))
    op.execute(sa.text(_linked_terminal_guard_sql(allow_recovery=False)))
    op.execute(sa.text(_settlement_envelope_guard_sql(allow_recovery=False)))
    op.execute(sa.text(_TERMINAL_ASSERTION_0061_SQL))

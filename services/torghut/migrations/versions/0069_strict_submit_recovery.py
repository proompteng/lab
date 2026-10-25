"""Allow fenced linked-submit recovery terminals.

Revision ID: 0069_strict_submit_recovery
Revises: 0068_validation_submit
Create Date: 2026-07-15 02:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0069_strict_submit_recovery"
down_revision = "0068_validation_submit"
branch_labels = None
depends_on = None


_CLAIM_TABLE = "trade_decision_submission_claims"
_CLAIM_RECOVERY_OUTCOME_CHECK = "ck_td_submission_claim_recovery_outcome"


_RECOVERY_REJECTED_CLAIM_GUARD_SQL = """
CREATE FUNCTION torghut_guard_rejected_submission_claim_0069()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    recovery_changed boolean;
BEGIN
    IF OLD.state = 'rejected' THEN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'rejected claim tombstone is immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.state <> 'broker_io' OR NEW.state <> 'rejected' THEN
        RAISE EXCEPTION 'invalid rejected submission transition'
            USING ERRCODE = '23514';
    END IF;
    recovery_changed :=
        NEW.recovery_lease_expires_at IS DISTINCT FROM OLD.recovery_lease_expires_at
        OR NEW.recovery_checked_at IS DISTINCT FROM OLD.recovery_checked_at
        OR NEW.recovery_observation_epoch
            IS DISTINCT FROM OLD.recovery_observation_epoch
        OR NEW.recovery_outcome IS DISTINCT FROM OLD.recovery_outcome
        OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence;
    IF recovery_changed THEN
        IF OLD.recovery_token IS NULL
           OR OLD.recovery_lease_expires_at <= clock_timestamp()
           OR NEW.recovery_token IS DISTINCT FROM OLD.recovery_token
           OR NEW.recovery_fencing_epoch
                IS DISTINCT FROM OLD.recovery_fencing_epoch
           OR NEW.recovery_owner IS DISTINCT FROM OLD.recovery_owner
           OR NEW.recovery_lease_started_at
                IS DISTINCT FROM OLD.recovery_lease_started_at
           OR NEW.recovery_checked_at IS NULL
           OR NEW.recovery_checked_at IS DISTINCT FROM NEW.completed_at
           OR NEW.recovery_observation_epoch
                IS DISTINCT FROM NEW.recovery_fencing_epoch
           OR NEW.recovery_outcome <> 'found'
           OR NEW.recovery_evidence IS NULL
           OR NEW.recovery_evidence !~
                '^receipt:[0-9a-f-]{36}:sha256:[0-9a-f]{64}$'
           OR NEW.recovery_lease_expires_at IS DISTINCT FROM NEW.completed_at THEN
            RAISE EXCEPTION 'rejected recovery terminal metadata invalid'
                USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY[
                'state', 'completed_at', 'terminal_receipt_event_id',
                'recovery_lease_expires_at', 'recovery_checked_at',
                'recovery_observation_epoch', 'recovery_outcome',
                'recovery_evidence', 'updated_at'
            ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
                'state', 'completed_at', 'terminal_receipt_event_id',
                'recovery_lease_expires_at', 'recovery_checked_at',
                'recovery_observation_epoch', 'recovery_outcome',
                'recovery_evidence', 'updated_at'
            ]) THEN
            RAISE EXCEPTION 'rejected recovery changed immutable truth'
                USING ERRCODE = '23514';
        END IF;
    ELSIF (to_jsonb(NEW) - ARRAY[
            'state', 'completed_at', 'terminal_receipt_event_id', 'updated_at'
        ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
            'state', 'completed_at', 'terminal_receipt_event_id', 'updated_at'
        ]) THEN
        RAISE EXCEPTION 'rejected transition changed nonterminal truth'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$
"""


_LINKED_TERMINAL_GUARD_SQL = """
CREATE FUNCTION torghut_guard_bm_linked_terminal_0069()
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
            RAISE EXCEPTION 'unlinked broker mutation event has claim identity'
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
       OR NEW.submission_claim_fencing_epoch IS DISTINCT FROM claim.fencing_epoch
       OR NEW.submission_claim_owner IS DISTINCT FROM claim.claim_owner
       OR NEW.primary_owner IS DISTINCT FROM claim.claim_owner
       OR claim.state <> 'broker_io' THEN
        RAISE EXCEPTION 'linked terminal claim identity mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.settlement_source = 'primary' THEN
        IF NEW.settlement_outcome NOT IN (
            'acknowledged', 'reconciled', 'rejected'
        ) THEN
            RAISE EXCEPTION 'linked primary terminal outcome invalid'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.settlement_source = 'recovery' THEN
        IF NEW.settlement_outcome NOT IN ('reconciled', 'rejected')
           OR NEW.recovery_token IS DISTINCT FROM claim.recovery_token
           OR NEW.recovery_owner IS DISTINCT FROM claim.recovery_owner
           OR NEW.recovery_writer_generation IS NULL
           OR NEW.event_writer_generation
                IS DISTINCT FROM NEW.recovery_writer_generation
           OR claim.recovery_lease_expires_at IS NULL
           OR claim.recovery_lease_expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'linked recovery terminal fence invalid'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'linked terminal source invalid'
            USING ERRCODE = '23514';
    END IF;
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


_SETTLEMENT_ENVELOPE_GUARD_SQL = """
CREATE FUNCTION torghut_guard_bm_settlement_envelope_0069()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    claim_id uuid;
    evidence_document jsonb;
    receipt_account text;
    receipt_client text;
    recovery_document jsonb;
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
       OR evidence_document ->> 'source' IS DISTINCT FROM NEW.settlement_source
       OR evidence_document ->> 'outcome' IS DISTINCT FROM NEW.settlement_outcome
       OR evidence_document ->> 'broker_reference'
            IS DISTINCT FROM NEW.broker_reference
       OR evidence_document ->> 'execution_id'
            IS DISTINCT FROM NEW.execution_id::text
       OR jsonb_typeof(evidence_document -> 'evidence') <> 'object'
       OR (NEW.broker_reference IS NULL
           AND evidence_document -> 'broker_reference' <> 'null'::jsonb)
       OR (NEW.broker_reference IS NOT NULL
           AND jsonb_typeof(evidence_document -> 'broker_reference') <> 'string')
       OR (NEW.execution_id IS NULL
           AND evidence_document -> 'execution_id' <> 'null'::jsonb)
       OR (NEW.execution_id IS NOT NULL
           AND jsonb_typeof(evidence_document -> 'execution_id') <> 'string') THEN
        RAISE EXCEPTION 'broker mutation settlement envelope mismatch'
            USING ERRCODE = '23514';
    END IF;
    SELECT submission_claim_id, account_label, client_request_id
      INTO claim_id, receipt_account, receipt_client
      FROM broker_mutation_receipts
     WHERE id = NEW.receipt_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'broker mutation settlement receipt not found'
            USING ERRCODE = '23503';
    END IF;
    IF claim_id IS NULL THEN
        RETURN NEW;
    END IF;
    terminal_document := evidence_document -> 'evidence';
    IF NOT terminal_document ?& ARRAY[
           'schema_version', 'decision_id', 'account_label',
           'client_order_id', 'broker_status', 'rejection_code'
       ]
       OR terminal_document ->> 'decision_id' IS DISTINCT FROM claim_id::text
       OR terminal_document ->> 'account_label' IS DISTINCT FROM receipt_account
       OR terminal_document ->> 'client_order_id' IS DISTINCT FROM receipt_client
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
    IF NEW.settlement_source = 'primary' THEN
        IF (SELECT count(*) FROM jsonb_object_keys(terminal_document)) <> 6
           OR terminal_document ->> 'schema_version' IS DISTINCT FROM
                'torghut.linked-submission-terminal.v1'
           OR terminal_document ? 'recovery' THEN
            RAISE EXCEPTION 'linked primary terminal evidence mismatch'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.settlement_source <> 'recovery'
       OR (SELECT count(*) FROM jsonb_object_keys(terminal_document)) <> 7
       OR terminal_document ->> 'schema_version' IS DISTINCT FROM
            'torghut.linked-submission-recovery-terminal.v1'
       OR jsonb_typeof(terminal_document -> 'recovery') <> 'object' THEN
        RAISE EXCEPTION 'linked recovery terminal evidence mismatch'
            USING ERRCODE = '23514';
    END IF;
    recovery_document := terminal_document -> 'recovery';
    IF jsonb_typeof(recovery_document -> 'schema_version') <> 'string'
       OR recovery_document ->> 'schema_version' !~ '^torghut\\.'
       OR recovery_document -> 'automatic_resubmission_attempted' <> 'false'::jsonb
       OR NOT recovery_document ? 'resolution_state'
       OR (NEW.settlement_outcome = 'reconciled'
           AND recovery_document ->> 'resolution_state' <> 'acknowledged')
       OR (NEW.settlement_outcome = 'rejected'
           AND recovery_document ->> 'resolution_state' <> 'rejected') THEN
        RAISE EXCEPTION 'linked recovery evidence semantics invalid'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$
"""


_TERMINAL_ASSERTION_SQL = """
CREATE FUNCTION torghut_assert_linked_submission_terminal_0069(target_claim_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    claim trade_decision_submission_claims%ROWTYPE;
    event broker_mutation_receipt_events%ROWTYPE;
    has_execution boolean;
    latest_event_id uuid;
    receipt broker_mutation_receipts%ROWTYPE;
    recovery_resolution text;
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
        IF claim.state = 'broker_io'
           AND event.event_type IN ('recovery_observed', 'recovery_released')
           AND event.recovery_checked_at IS NOT NULL
           AND (
               event.recovery_token IS DISTINCT FROM claim.recovery_token
               OR event.recovery_owner IS DISTINCT FROM claim.recovery_owner
               OR event.recovery_checked_at
                    IS DISTINCT FROM claim.recovery_checked_at
               OR event.recovery_outcome IS DISTINCT FROM claim.recovery_outcome
               OR event.recovery_after IS DISTINCT FROM claim.recovery_after
               OR event.recovery_lease_expires_at
                    IS DISTINCT FROM claim.recovery_lease_expires_at
               OR claim.recovery_evidence IS DISTINCT FROM (
                    'receipt:' || receipt.id::text || ':sha256:' ||
                    event.recovery_evidence_sha256
               )
           ) THEN
            RAISE EXCEPTION 'linked recovery observation is asymmetric'
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
    IF event.settlement_source = 'recovery' THEN
        recovery_resolution := event.settlement_evidence_json::jsonb #>>
            '{evidence,recovery,resolution_state}';
        IF event.recovery_token IS DISTINCT FROM claim.recovery_token
           OR event.recovery_owner IS DISTINCT FROM claim.recovery_owner
           OR event.event_writer_generation
                IS DISTINCT FROM event.recovery_writer_generation
           OR claim.recovery_checked_at IS DISTINCT FROM event.settled_at
           OR claim.recovery_observation_epoch
                IS DISTINCT FROM claim.recovery_fencing_epoch
           OR claim.recovery_lease_expires_at IS DISTINCT FROM event.settled_at
           OR claim.recovery_evidence IS DISTINCT FROM (
                'receipt:' || receipt.id::text || ':sha256:' ||
                event.settlement_evidence_sha256
           )
           OR claim.recovery_outcome <> 'found'
           OR recovery_resolution NOT IN ('acknowledged', 'rejected') THEN
            RAISE EXCEPTION 'linked recovery terminal truth mismatch'
                USING ERRCODE = '23514';
        END IF;
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


_TERMINAL_WRAPPERS_SQL = """
CREATE FUNCTION torghut_check_submission_claim_terminal_0069()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM torghut_assert_linked_submission_terminal_0069(NEW.trade_decision_id);
    RETURN NULL;
END;
$$;
CREATE FUNCTION torghut_check_bm_event_terminal_0069()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_claim_id uuid;
BEGIN
    SELECT submission_claim_id INTO target_claim_id
      FROM broker_mutation_receipts WHERE id = NEW.receipt_id;
    IF target_claim_id IS NOT NULL THEN
        PERFORM torghut_assert_linked_submission_terminal_0069(target_claim_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE FUNCTION torghut_check_execution_terminal_0069()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_claim_id uuid;
BEGIN
    FOR target_claim_id IN
        SELECT DISTINCT claim.trade_decision_id
          FROM trade_decision_submission_claims AS claim
         WHERE (TG_OP <> 'DELETE' AND (
                    claim.trade_decision_id = NEW.trade_decision_id
                    OR (claim.account_label = NEW.alpaca_account_label
                        AND claim.client_order_id = NEW.client_order_id)))
            OR (TG_OP <> 'INSERT' AND (
                    claim.trade_decision_id = OLD.trade_decision_id
                    OR (claim.account_label = OLD.alpaca_account_label
                        AND claim.client_order_id = OLD.client_order_id)))
    LOOP
        PERFORM torghut_assert_linked_submission_terminal_0069(target_claim_id);
    END LOOP;
    RETURN NULL;
END;
$$
"""


def _lock_terminal_tables() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE executions, trade_decision_submission_claims, "
            "broker_mutation_receipts, broker_mutation_receipt_events "
            "IN ACCESS EXCLUSIVE MODE"
        )
    )


def _drop_0061_triggers() -> None:
    statements = (
        "DROP TRIGGER trg_guard_td_submission_claim_0061_rejected "
        "ON trade_decision_submission_claims",
        "DROP TRIGGER trg_guard_bm_receipt_event_b_linked_terminal_0061 "
        "ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_event_c_settlement_0061 "
        "ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_check_submission_claim_terminal_0061 "
        "ON trade_decision_submission_claims",
        "DROP TRIGGER trg_check_bm_event_terminal_0061 "
        "ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_check_execution_terminal_0061 ON executions",
    )
    for statement in statements:
        op.execute(sa.text(statement))


def _create_0069_triggers() -> None:
    statements = (
        "CREATE TRIGGER trg_guard_td_submission_claim_0069_rejected "
        "BEFORE UPDATE ON trade_decision_submission_claims FOR EACH ROW "
        "WHEN (OLD.state = 'rejected' OR NEW.state = 'rejected') "
        "EXECUTE FUNCTION torghut_guard_rejected_submission_claim_0069()",
        "CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_terminal_0069 "
        "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
        "WHEN (NEW.event_type = 'settled') "
        "EXECUTE FUNCTION torghut_guard_bm_linked_terminal_0069()",
        "CREATE TRIGGER trg_guard_bm_receipt_event_c_settlement_0069 "
        "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
        "WHEN (NEW.event_type = 'settled') "
        "EXECUTE FUNCTION torghut_guard_bm_settlement_envelope_0069()",
        "CREATE CONSTRAINT TRIGGER trg_check_submission_claim_terminal_0069 "
        "AFTER INSERT OR UPDATE ON trade_decision_submission_claims "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW "
        "EXECUTE FUNCTION torghut_check_submission_claim_terminal_0069()",
        "CREATE CONSTRAINT TRIGGER trg_check_bm_event_terminal_0069 "
        "AFTER INSERT ON broker_mutation_receipt_events "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW "
        "EXECUTE FUNCTION torghut_check_bm_event_terminal_0069()",
        "CREATE CONSTRAINT TRIGGER trg_check_execution_terminal_0069 "
        "AFTER INSERT OR UPDATE OR DELETE ON executions "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW "
        "EXECUTE FUNCTION torghut_check_execution_terminal_0069()",
    )
    for statement in statements:
        op.execute(sa.text(statement))


def _drop_0069_triggers_and_functions() -> None:
    trigger_statements = (
        "DROP TRIGGER trg_check_execution_terminal_0069 ON executions",
        "DROP TRIGGER trg_check_bm_event_terminal_0069 "
        "ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_check_submission_claim_terminal_0069 "
        "ON trade_decision_submission_claims",
        "DROP TRIGGER trg_guard_bm_receipt_event_c_settlement_0069 "
        "ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_bm_receipt_event_b_linked_terminal_0069 "
        "ON broker_mutation_receipt_events",
        "DROP TRIGGER trg_guard_td_submission_claim_0069_rejected "
        "ON trade_decision_submission_claims",
    )
    for statement in trigger_statements:
        op.execute(sa.text(statement))
    functions = (
        "torghut_check_execution_terminal_0069()",
        "torghut_check_bm_event_terminal_0069()",
        "torghut_check_submission_claim_terminal_0069()",
        "torghut_assert_linked_submission_terminal_0069(uuid)",
        "torghut_guard_bm_settlement_envelope_0069()",
        "torghut_guard_bm_linked_terminal_0069()",
        "torghut_guard_rejected_submission_claim_0069()",
    )
    for function in functions:
        op.execute(sa.text(f"DROP FUNCTION {function}"))


def _create_0061_triggers() -> None:
    statements = (
        "CREATE TRIGGER trg_guard_td_submission_claim_0061_rejected "
        "BEFORE UPDATE ON trade_decision_submission_claims FOR EACH ROW "
        "WHEN (OLD.state = 'rejected' OR NEW.state = 'rejected') "
        "EXECUTE FUNCTION torghut_guard_rejected_submission_claim_0061()",
        "CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_terminal_0061 "
        "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
        "WHEN (NEW.event_type = 'settled') "
        "EXECUTE FUNCTION torghut_guard_bm_linked_terminal_0061()",
        "CREATE TRIGGER trg_guard_bm_receipt_event_c_settlement_0061 "
        "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
        "WHEN (NEW.event_type = 'settled') "
        "EXECUTE FUNCTION torghut_guard_bm_settlement_envelope_0061()",
        "CREATE CONSTRAINT TRIGGER trg_check_submission_claim_terminal_0061 "
        "AFTER INSERT OR UPDATE ON trade_decision_submission_claims "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW "
        "EXECUTE FUNCTION torghut_check_submission_claim_terminal_0061()",
        "CREATE CONSTRAINT TRIGGER trg_check_bm_event_terminal_0061 "
        "AFTER INSERT ON broker_mutation_receipt_events "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW "
        "EXECUTE FUNCTION torghut_check_bm_event_terminal_0061()",
        "CREATE CONSTRAINT TRIGGER trg_check_execution_terminal_0061 "
        "AFTER INSERT OR UPDATE OR DELETE ON executions "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW "
        "EXECUTE FUNCTION torghut_check_execution_terminal_0061()",
    )
    for statement in statements:
        op.execute(sa.text(statement))


def _create_recovery_outcome_check_0069() -> None:
    op.create_check_constraint(
        _CLAIM_RECOVERY_OUTCOME_CHECK,
        _CLAIM_TABLE,
        "recovery_outcome IS NULL OR (recovery_outcome = 'found' "
        "AND state IN ('submitted', 'rejected')) OR "
        "(recovery_outcome IN ('not_found', 'indeterminate') "
        "AND state IN ('broker_io', 'submitted', 'rejected'))",
    )


def _create_recovery_outcome_check_0061() -> None:
    op.create_check_constraint(
        _CLAIM_RECOVERY_OUTCOME_CHECK,
        _CLAIM_TABLE,
        "recovery_outcome IS NULL OR (recovery_outcome = 'found' "
        "AND state = 'submitted') OR "
        "(recovery_outcome IN ('not_found', 'indeterminate') "
        "AND state IN ('broker_io', 'submitted', 'rejected'))",
    )


def _require_downgrade_compatible() -> None:
    op.execute(
        sa.text(
            """
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM broker_mutation_receipt_events AS event
                    JOIN broker_mutation_receipts AS receipt
                      ON receipt.id = event.receipt_id
                    WHERE receipt.submission_claim_id IS NOT NULL
                      AND event.event_type = 'settled'
                      AND event.settlement_source = 'recovery'
                ) OR EXISTS (
                    SELECT 1 FROM trade_decision_submission_claims
                    WHERE state = 'rejected' AND recovery_outcome = 'found'
                ) THEN
                    RAISE EXCEPTION
                        'refusing to downgrade strict submit recovery terminal data'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )


def upgrade() -> None:
    _lock_terminal_tables()
    _drop_0061_triggers()
    op.drop_constraint(
        _CLAIM_RECOVERY_OUTCOME_CHECK,
        _CLAIM_TABLE,
        type_="check",
    )
    _create_recovery_outcome_check_0069()
    op.execute(sa.text(_RECOVERY_REJECTED_CLAIM_GUARD_SQL))
    op.execute(sa.text(_LINKED_TERMINAL_GUARD_SQL))
    op.execute(sa.text(_SETTLEMENT_ENVELOPE_GUARD_SQL))
    op.execute(sa.text(_TERMINAL_ASSERTION_SQL))
    op.execute(sa.text(_TERMINAL_WRAPPERS_SQL))
    _create_0069_triggers()


def downgrade() -> None:
    _lock_terminal_tables()
    _require_downgrade_compatible()
    _drop_0069_triggers_and_functions()
    op.drop_constraint(
        _CLAIM_RECOVERY_OUTCOME_CHECK,
        _CLAIM_TABLE,
        type_="check",
    )
    _create_recovery_outcome_check_0061()
    _create_0061_triggers()

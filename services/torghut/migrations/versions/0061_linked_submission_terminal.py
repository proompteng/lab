"""Coordinate linked submission terminal truth atomically.

Revision ID: 0061_linked_submission_terminal
Revises: 0060_bm_evidence_envelopes
Create Date: 2026-07-11 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0061_linked_submission_terminal"
down_revision = "0060_bm_evidence_envelopes"
branch_labels = None
depends_on = None


_TABLE = "trade_decision_submission_claims"


def _lock_and_require_empty(direction: str) -> None:
    op.execute(
        sa.text(
            "LOCK TABLE executions, trade_decision_submission_claims, "
            "broker_mutation_receipts, broker_mutation_receipt_events "
            "IN ACCESS EXCLUSIVE MODE NOWAIT"
        )
    )
    op.execute(
        sa.text(
            f"""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM trade_decision_submission_claims)
                   OR EXISTS (SELECT 1 FROM broker_mutation_receipts)
                   OR EXISTS (SELECT 1 FROM broker_mutation_receipt_events) THEN
                    RAISE EXCEPTION
                        'refusing to {direction} nonempty linked submission terminal state'
                        USING ERRCODE = '55000';
                END IF;
            END; $$
            """
        )
    )


def _drop_claim_checks() -> None:
    for name in (
        "ck_td_submission_claim_state",
        "ck_td_submission_claim_broker_io_metadata",
        "ck_td_submission_claim_claimed_metadata",
        "ck_td_submission_claim_broker_io_terminal",
        "ck_td_submission_claim_recovery_lease",
        "ck_td_submission_claim_recovery_outcome",
    ):
        op.drop_constraint(name, _TABLE, type_="check")


def _create_claim_checks_0061() -> None:
    checks = {
        "ck_td_submission_claim_state": (
            "state IN ('claimed', 'broker_io', 'submitted', 'rejected')"
        ),
        "ck_td_submission_claim_broker_io_metadata": (
            "state NOT IN ('broker_io', 'submitted', 'rejected') OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)"
        ),
        "ck_td_submission_claim_claimed_metadata": (
            "state <> 'claimed' OR (broker_io_started_at IS NULL "
            "AND recovery_after IS NULL AND recovery_fencing_epoch = 0 "
            "AND recovery_token IS NULL AND recovery_owner IS NULL "
            "AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL "
            "AND recovery_checked_at IS NULL "
            "AND recovery_observation_epoch IS NULL "
            "AND recovery_outcome IS NULL AND recovery_evidence IS NULL "
            "AND broker_order_id IS NULL AND broker_client_order_id IS NULL "
            "AND execution_id IS NULL AND completed_at IS NULL "
            "AND terminal_receipt_event_id IS NULL)"
        ),
        "ck_td_submission_claim_broker_io_terminal": (
            "state <> 'broker_io' OR (broker_order_id IS NULL "
            "AND broker_client_order_id IS NULL AND execution_id IS NULL "
            "AND completed_at IS NULL AND terminal_receipt_event_id IS NULL)"
        ),
        "ck_td_submission_claim_recovery_lease": (
            "(recovery_fencing_epoch = 0 AND recovery_token IS NULL "
            "AND recovery_owner IS NULL AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL) OR "
            "(recovery_fencing_epoch > 0 AND recovery_token IS NOT NULL "
            "AND recovery_owner IS NOT NULL "
            "AND recovery_lease_started_at IS NOT NULL "
            "AND recovery_lease_expires_at IS NOT NULL "
            "AND state IN ('broker_io', 'submitted', 'rejected'))"
        ),
        "ck_td_submission_claim_recovery_outcome": (
            "recovery_outcome IS NULL OR (recovery_outcome = 'found' "
            "AND state = 'submitted') OR "
            "(recovery_outcome IN ('not_found', 'indeterminate') "
            "AND state IN ('broker_io', 'submitted', 'rejected'))"
        ),
        "ck_td_submission_claim_rejected_metadata": (
            "state <> 'rejected' OR (broker_order_id IS NULL "
            "AND broker_client_order_id IS NULL AND execution_id IS NULL "
            "AND completed_at IS NOT NULL "
            "AND terminal_receipt_event_id IS NOT NULL)"
        ),
        "ck_td_submission_claim_terminal_receipt_state": (
            "terminal_receipt_event_id IS NULL OR state IN ('submitted', 'rejected')"
        ),
    }
    for name, condition in checks.items():
        op.create_check_constraint(name, _TABLE, condition)


def _create_claim_checks_0058() -> None:
    checks = {
        "ck_td_submission_claim_state": (
            "state IN ('claimed', 'broker_io', 'submitted')"
        ),
        "ck_td_submission_claim_broker_io_metadata": (
            "state NOT IN ('broker_io', 'submitted') OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)"
        ),
        "ck_td_submission_claim_claimed_metadata": (
            "state <> 'claimed' OR (broker_io_started_at IS NULL "
            "AND recovery_after IS NULL AND recovery_fencing_epoch = 0 "
            "AND recovery_token IS NULL AND recovery_owner IS NULL "
            "AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL "
            "AND recovery_checked_at IS NULL "
            "AND recovery_observation_epoch IS NULL "
            "AND recovery_outcome IS NULL AND recovery_evidence IS NULL "
            "AND broker_order_id IS NULL AND broker_client_order_id IS NULL "
            "AND execution_id IS NULL AND completed_at IS NULL)"
        ),
        "ck_td_submission_claim_broker_io_terminal": (
            "state <> 'broker_io' OR (broker_order_id IS NULL "
            "AND broker_client_order_id IS NULL AND execution_id IS NULL "
            "AND completed_at IS NULL)"
        ),
        "ck_td_submission_claim_recovery_lease": (
            "(recovery_fencing_epoch = 0 AND recovery_token IS NULL "
            "AND recovery_owner IS NULL AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL) OR "
            "(recovery_fencing_epoch > 0 AND recovery_token IS NOT NULL "
            "AND recovery_owner IS NOT NULL "
            "AND recovery_lease_started_at IS NOT NULL "
            "AND recovery_lease_expires_at IS NOT NULL "
            "AND state IN ('broker_io', 'submitted'))"
        ),
        "ck_td_submission_claim_recovery_outcome": (
            "recovery_outcome IS NULL OR (recovery_outcome = 'found' "
            "AND state = 'submitted') OR "
            "(recovery_outcome IN ('not_found', 'indeterminate') "
            "AND state IN ('broker_io', 'submitted'))"
        ),
    }
    for name, condition in checks.items():
        op.create_check_constraint(name, _TABLE, condition)


def _rewire_claim_guard() -> None:
    op.execute(sa.text("DROP TRIGGER trg_guard_td_submission_claim ON " + _TABLE))
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_rejected_submission_claim_0061()
            RETURNS trigger LANGUAGE plpgsql AS $$
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
                IF (to_jsonb(NEW) - ARRAY[
                        'state', 'completed_at', 'terminal_receipt_event_id',
                        'updated_at'
                    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
                        'state', 'completed_at', 'terminal_receipt_event_id',
                        'updated_at'
                    ]) THEN
                    RAISE EXCEPTION 'rejected transition changed nonterminal truth'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NEW;
            END;
            $$
            """
        )
    )
    statements = (
        "CREATE TRIGGER trg_guard_td_submission_claim_0061_insert "
        "BEFORE INSERT ON trade_decision_submission_claims FOR EACH ROW "
        "EXECUTE FUNCTION torghut_guard_submission_claim()",
        "CREATE TRIGGER trg_guard_td_submission_claim_0061_update "
        "BEFORE UPDATE ON trade_decision_submission_claims FOR EACH ROW "
        "WHEN (OLD.state IS DISTINCT FROM 'rejected' "
        "AND NEW.state IS DISTINCT FROM 'rejected') "
        "EXECUTE FUNCTION torghut_guard_submission_claim()",
        "CREATE TRIGGER trg_guard_td_submission_claim_0061_rejected "
        "BEFORE UPDATE ON trade_decision_submission_claims FOR EACH ROW "
        "WHEN (OLD.state = 'rejected' OR NEW.state = 'rejected') "
        "EXECUTE FUNCTION torghut_guard_rejected_submission_claim_0061()",
        "CREATE TRIGGER trg_guard_td_submission_claim_0061_delete "
        "BEFORE DELETE ON trade_decision_submission_claims FOR EACH ROW "
        "EXECUTE FUNCTION torghut_guard_submission_claim()",
    )
    for statement in statements:
        op.execute(sa.text(statement))


def _restore_claim_guard() -> None:
    for name in (
        "trg_guard_td_submission_claim_0061_rejected",
        "trg_guard_td_submission_claim_0061_update",
        "trg_guard_td_submission_claim_0061_insert",
        "trg_guard_td_submission_claim_0061_delete",
    ):
        op.execute(sa.text(f"DROP TRIGGER {name} ON {_TABLE}"))
    op.execute(sa.text("DROP FUNCTION torghut_guard_rejected_submission_claim_0061()"))
    op.execute(
        sa.text(
            "CREATE TRIGGER trg_guard_td_submission_claim "
            "BEFORE INSERT OR UPDATE OR DELETE ON trade_decision_submission_claims "
            "FOR EACH ROW EXECUTE FUNCTION torghut_guard_submission_claim()"
        )
    )


def _rewire_linked_event_guards() -> None:
    op.execute(
        sa.text(
            "DROP TRIGGER trg_guard_bm_receipt_event_b_linked_0060 "
            "ON broker_mutation_receipt_events"
        )
    )
    op.execute(
        sa.text(
            "DROP TRIGGER trg_guard_bm_receipt_event_c_settlement_0060 "
            "ON broker_mutation_receipt_events"
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_0060
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW WHEN (NEW.event_type <> 'settled')
            EXECUTE FUNCTION torghut_guard_bm_linked_event_0060()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_linked_terminal_0061()
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
                IF NEW.settlement_source <> 'primary'
                   OR NEW.settlement_outcome NOT IN (
                       'acknowledged', 'reconciled', 'rejected'
                   ) THEN
                    RAISE EXCEPTION 'linked terminal source or outcome invalid'
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
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_terminal_0061
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW WHEN (NEW.event_type = 'settled')
            EXECUTE FUNCTION torghut_guard_bm_linked_terminal_0061()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_bm_settlement_envelope_0061()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                claim_id uuid;
                evidence_document jsonb;
                receipt_account text;
                receipt_client text;
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
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_bm_receipt_event_c_settlement_0061
            BEFORE INSERT ON broker_mutation_receipt_events
            FOR EACH ROW WHEN (NEW.event_type = 'settled')
            EXECUTE FUNCTION torghut_guard_bm_settlement_envelope_0061()
            """
        )
    )


def _restore_linked_event_guards() -> None:
    for name in (
        "trg_guard_bm_receipt_event_c_settlement_0061",
        "trg_guard_bm_receipt_event_b_linked_terminal_0061",
        "trg_guard_bm_receipt_event_b_linked_0060",
    ):
        op.execute(sa.text(f"DROP TRIGGER {name} ON broker_mutation_receipt_events"))
    op.execute(sa.text("DROP FUNCTION torghut_guard_bm_settlement_envelope_0061()"))
    op.execute(sa.text("DROP FUNCTION torghut_guard_bm_linked_terminal_0061()"))
    op.execute(
        sa.text(
            "CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_0060 "
            "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
            "EXECUTE FUNCTION torghut_guard_bm_linked_event_0060()"
        )
    )
    op.execute(
        sa.text(
            "CREATE TRIGGER trg_guard_bm_receipt_event_c_settlement_0060 "
            "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
            "EXECUTE FUNCTION torghut_guard_bm_settlement_envelope_0060()"
        )
    )


_TERMINAL_ASSERTION_SQL = """
CREATE FUNCTION torghut_assert_linked_submission_terminal_0061(target_claim_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
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


_TERMINAL_WRAPPERS_SQL = """
CREATE FUNCTION torghut_check_submission_claim_terminal_0061()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM torghut_assert_linked_submission_terminal_0061(NEW.trade_decision_id);
    RETURN NULL;
END;
$$;
CREATE FUNCTION torghut_check_bm_event_terminal_0061()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_claim_id uuid;
BEGIN
    SELECT submission_claim_id INTO target_claim_id
      FROM broker_mutation_receipts WHERE id = NEW.receipt_id;
    IF target_claim_id IS NOT NULL THEN
        PERFORM torghut_assert_linked_submission_terminal_0061(target_claim_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE FUNCTION torghut_check_execution_terminal_0061()
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
        PERFORM torghut_assert_linked_submission_terminal_0061(target_claim_id);
    END LOOP;
    RETURN NULL;
END;
$$
"""


def _create_deferred_terminal_guards() -> None:
    op.execute(sa.text(_TERMINAL_ASSERTION_SQL))
    op.execute(sa.text(_TERMINAL_WRAPPERS_SQL))
    statements = (
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


def _drop_deferred_terminal_guards() -> None:
    op.execute(sa.text("DROP TRIGGER trg_check_execution_terminal_0061 ON executions"))
    op.execute(
        sa.text(
            "DROP TRIGGER trg_check_bm_event_terminal_0061 "
            "ON broker_mutation_receipt_events"
        )
    )
    op.execute(
        sa.text(
            "DROP TRIGGER trg_check_submission_claim_terminal_0061 "
            "ON trade_decision_submission_claims"
        )
    )
    for name in (
        "torghut_check_execution_terminal_0061()",
        "torghut_check_bm_event_terminal_0061()",
        "torghut_check_submission_claim_terminal_0061()",
        "torghut_assert_linked_submission_terminal_0061(uuid)",
    ):
        op.execute(sa.text(f"DROP FUNCTION {name}"))


def upgrade() -> None:
    _lock_and_require_empty("upgrade")
    op.add_column(
        _TABLE,
        sa.Column(
            "terminal_receipt_event_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_td_submission_claim_terminal_receipt_event",
        _TABLE,
        "broker_mutation_receipt_events",
        ["terminal_receipt_event_id"],
        ["id"],
        ondelete="RESTRICT",
        onupdate="RESTRICT",
    )
    op.create_index(
        "uq_trade_decision_submission_terminal_receipt_event",
        _TABLE,
        ["terminal_receipt_event_id"],
        unique=True,
    )
    _drop_claim_checks()
    _create_claim_checks_0061()
    _rewire_claim_guard()
    _rewire_linked_event_guards()
    _create_deferred_terminal_guards()


def downgrade() -> None:
    _lock_and_require_empty("downgrade")
    _drop_deferred_terminal_guards()
    _restore_linked_event_guards()
    _restore_claim_guard()
    _drop_claim_checks()
    op.drop_constraint(
        "ck_td_submission_claim_rejected_metadata",
        _TABLE,
        type_="check",
    )
    op.drop_constraint(
        "ck_td_submission_claim_terminal_receipt_state",
        _TABLE,
        type_="check",
    )
    op.drop_index(
        "uq_trade_decision_submission_terminal_receipt_event",
        table_name=_TABLE,
    )
    op.drop_constraint(
        "fk_td_submission_claim_terminal_receipt_event",
        _TABLE,
        type_="foreignkey",
    )
    op.drop_column(_TABLE, "terminal_receipt_event_id")
    _create_claim_checks_0058()

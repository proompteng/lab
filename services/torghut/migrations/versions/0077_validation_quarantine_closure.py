"""Add an honest terminal for non-promotable paper-IOC validation debt.

Revision ID: 0077_validation_quarantine
Revises: 0076_broker_account_activities
Create Date: 2026-07-16 03:30:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0077_validation_quarantine"
down_revision = "0076_broker_account_activities"
branch_labels = None
depends_on = None


_TABLE = "broker_mutation_receipt_events"
_SOURCE_CHECK = "ck_bm_event_settlement_source"
_OUTCOME_CHECK = "ck_bm_event_settlement_outcome"
_PAIR_CHECK = "ck_bm_event_settlement_pair"


_OPERATOR_GUARD_SQL = r"""
CREATE FUNCTION torghut_guard_validation_quarantine_terminal_0077()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    evidence jsonb;
    intent jsonb;
    now_at timestamptz;
    previous broker_mutation_receipt_events%ROWTYPE;
    receipt broker_mutation_receipts%ROWTYPE;
    recovery_observation jsonb;
BEGIN
    now_at := clock_timestamp();
    NEW.recorded_at := now_at;
    NEW.settled_at := now_at;
    IF NEW.settlement_evidence_json IS NULL
       OR NEW.settlement_evidence_sha256 IS DISTINCT FROM encode(
           digest(convert_to(NEW.settlement_evidence_json, 'UTF8'), 'sha256'),
           'hex'
       ) THEN
        RAISE EXCEPTION 'validation quarantine settlement hash mismatch'
            USING ERRCODE = '23514';
    END IF;
    PERFORM torghut_lock_submission_identities(ARRAY[
        'torghut:broker-mutation:receipt:' || NEW.receipt_id::text
    ]);
    SELECT * INTO receipt
      FROM broker_mutation_receipts
     WHERE id = NEW.receipt_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'validation quarantine receipt not found'
            USING ERRCODE = '23503';
    END IF;
    SELECT * INTO previous
      FROM broker_mutation_receipt_events
     WHERE receipt_id = NEW.receipt_id
     ORDER BY sequence_no DESC
     LIMIT 1
       FOR UPDATE;
    IF NOT FOUND
       OR NEW.sequence_no <> previous.sequence_no + 1
       OR previous.state <> 'broker_io'
       OR NEW.event_type <> 'settled'
       OR NEW.state <> 'settled'
       OR NEW.settlement_source <> 'operator_confirmation'
       OR NEW.settlement_outcome <> 'validation_quarantine_closed'
       OR NEW.broker_reference IS NOT NULL
       OR NEW.execution_id IS NOT NULL
       OR NEW.event_writer_generation <= 0
       OR NOT torghut_bm_events_equal_except(
           NEW, previous, ARRAY[
               'id', 'sequence_no', 'event_type', 'state',
               'event_writer_generation', 'recorded_at', 'settlement_source',
               'settlement_outcome', 'broker_reference', 'execution_id',
               'settlement_evidence_json', 'settlement_evidence_sha256',
               'settled_at'
           ]
       ) THEN
        RAISE EXCEPTION 'invalid validation quarantine transition'
            USING ERRCODE = '23514';
    END IF;
    intent := receipt.canonical_intent_json::jsonb;
    recovery_observation := previous.recovery_evidence_json::jsonb -> 'observation';
    IF receipt.broker_route <> 'alpaca'
       OR receipt.endpoint_fingerprint <>
          'e7ce2f426f96cfc1606a46bc494cdfff68192ac2de4529bf406007d11d059ad7'
       OR receipt.operation <> 'submit_order'
       OR receipt.risk_class <> 'risk_neutral'
       OR receipt.purpose <> 'control_plane_validation'
       OR receipt.submission_claim_id IS NOT NULL
       OR intent #>> '{request,broker_request,time_in_force}' IS DISTINCT FROM 'ioc'
       OR intent #>> '{request,infrastructure_validation,permit,account_mode}'
          IS DISTINCT FROM 'paper'
       OR intent #>> '{request,infrastructure_validation,permit,evidence_tag}'
          IS DISTINCT FROM 'non_promotable_validation'
       OR intent #> '{request,infrastructure_validation,permit,promotable}'
          IS DISTINCT FROM 'false'::jsonb
       OR previous.broker_io_started_at IS NULL
       OR previous.broker_io_started_at > now_at - interval '1 minute'
       OR previous.recovery_outcome IS DISTINCT FROM 'not_found'
       OR previous.recovery_evidence_sha256 IS NULL
       OR recovery_observation ->> 'resolution_state' IS DISTINCT FROM 'expired'
       OR recovery_observation -> 'absence_proof_complete'
          IS DISTINCT FROM 'true'::jsonb
       OR recovery_observation -> 'operator_confirmation_required'
          IS DISTINCT FROM 'true'::jsonb
       OR recovery_observation -> 'automatic_resubmission_attempted'
          IS DISTINCT FROM 'false'::jsonb
    THEN
        RAISE EXCEPTION 'validation quarantine receipt is ineligible'
            USING ERRCODE = '23514';
    END IF;
    evidence := NEW.settlement_evidence_json::jsonb -> 'evidence';
    IF jsonb_typeof(evidence) <> 'object'
       OR NOT evidence ?& ARRAY[
          'schema_version', 'receipt_id', 'client_order_id', 'intent_sha256',
          'account_label', 'endpoint_fingerprint', 'operator_id',
          'support_confirmation_reference', 'confirmation_reason',
          'order_existence_resolution', 'prior_recovery_evidence_sha256',
          'exact_client_order_lookup', 'history_complete', 'history_count',
          'history_match_count', 'open_order_count', 'position_count',
          'account_number', 'account_status', 'account_blocked',
          'trading_blocked', 'transfers_blocked', 'time_in_force',
          'evidence_tag', 'promotable', 'automatic_resubmission_attempted',
          'broker_mutation_attempted', 'observed_at'
       ]
       OR evidence ->> 'schema_version' IS DISTINCT FROM
          'torghut.infrastructure-validation-quarantine-closure.v1'
       OR evidence ->> 'receipt_id' IS DISTINCT FROM receipt.id::text
       OR evidence ->> 'client_order_id' IS DISTINCT FROM receipt.client_request_id
       OR evidence ->> 'intent_sha256' IS DISTINCT FROM receipt.canonical_intent_sha256
       OR evidence ->> 'account_label' IS DISTINCT FROM receipt.account_label
       OR evidence ->> 'endpoint_fingerprint' IS DISTINCT FROM receipt.endpoint_fingerprint
       OR jsonb_typeof(evidence -> 'operator_id') IS DISTINCT FROM 'string'
       OR length(btrim(evidence ->> 'operator_id')) NOT BETWEEN 1 AND 128
       OR evidence ->> 'confirmation_reason' IS DISTINCT FROM
          'paper_ioc_future_exposure_impossible'
       OR evidence ->> 'order_existence_resolution' IS DISTINCT FROM 'unresolved'
       OR evidence ->> 'prior_recovery_evidence_sha256'
          IS DISTINCT FROM previous.recovery_evidence_sha256
       OR evidence ->> 'exact_client_order_lookup' IS DISTINCT FROM 'not_found'
       OR evidence -> 'history_complete' IS DISTINCT FROM 'true'::jsonb
       OR (evidence ->> 'history_count') IS NULL
       OR (evidence ->> 'history_count')::integer < 0
       OR (evidence ->> 'history_match_count')::integer IS DISTINCT FROM 0
       OR (evidence ->> 'open_order_count')::integer IS DISTINCT FROM 0
       OR (evidence ->> 'position_count')::integer IS DISTINCT FROM 0
       OR evidence ->> 'account_number' IS DISTINCT FROM receipt.account_label
       OR evidence ->> 'account_status' IS DISTINCT FROM 'ACTIVE'
       OR evidence -> 'account_blocked' IS DISTINCT FROM 'false'::jsonb
       OR evidence -> 'trading_blocked' IS DISTINCT FROM 'false'::jsonb
       OR evidence -> 'transfers_blocked' IS DISTINCT FROM 'false'::jsonb
       OR evidence ->> 'time_in_force' IS DISTINCT FROM 'ioc'
       OR evidence ->> 'evidence_tag' IS DISTINCT FROM 'non_promotable_validation'
       OR evidence -> 'promotable' IS DISTINCT FROM 'false'::jsonb
       OR evidence -> 'automatic_resubmission_attempted'
          IS DISTINCT FROM 'false'::jsonb
       OR evidence -> 'broker_mutation_attempted' IS DISTINCT FROM 'false'::jsonb
       OR jsonb_typeof(evidence -> 'observed_at') IS DISTINCT FROM 'string'
       OR (evidence ->> 'observed_at')::timestamptz < now_at - interval '5 minutes'
       OR (evidence ->> 'observed_at')::timestamptz > now_at + interval '5 seconds'
       OR (
           evidence -> 'support_confirmation_reference' <> 'null'::jsonb
           AND (
               jsonb_typeof(evidence -> 'support_confirmation_reference') <> 'string'
               OR length(evidence ->> 'support_confirmation_reference') > 256
           )
       )
    THEN
        RAISE EXCEPTION 'validation quarantine evidence is invalid'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$
"""


def _drop_settlement_checks() -> None:
    for constraint in (_SOURCE_CHECK, _OUTCOME_CHECK, _PAIR_CHECK):
        op.drop_constraint(constraint, _TABLE, type_="check")


def _create_0077_settlement_checks() -> None:
    op.create_check_constraint(
        _SOURCE_CHECK,
        _TABLE,
        "settlement_source IS NULL OR settlement_source IN "
        "('primary', 'recovery', 'preflight', 'operator_confirmation')",
    )
    op.create_check_constraint(
        _OUTCOME_CHECK,
        _TABLE,
        "settlement_outcome IS NULL OR settlement_outcome IN "
        "('acknowledged', 'reconciled', 'rejected', 'already_satisfied', "
        "'validation_quarantine_closed')",
    )
    op.create_check_constraint(
        _PAIR_CHECK,
        _TABLE,
        "settlement_outcome IS NULL OR "
        "(settlement_outcome = 'already_satisfied' "
        "AND settlement_source = 'preflight') OR "
        "(settlement_outcome = 'acknowledged' "
        "AND settlement_source = 'primary') OR "
        "(settlement_outcome IN ('reconciled', 'rejected') "
        "AND settlement_source IN ('primary', 'recovery')) OR "
        "(settlement_outcome = 'validation_quarantine_closed' "
        "AND settlement_source = 'operator_confirmation')",
    )


def _create_0059_settlement_checks() -> None:
    op.create_check_constraint(
        _SOURCE_CHECK,
        _TABLE,
        "settlement_source IS NULL OR "
        "settlement_source IN ('primary', 'recovery', 'preflight')",
    )
    op.create_check_constraint(
        _OUTCOME_CHECK,
        _TABLE,
        "settlement_outcome IS NULL OR settlement_outcome IN "
        "('acknowledged', 'reconciled', 'rejected', 'already_satisfied')",
    )
    op.create_check_constraint(
        _PAIR_CHECK,
        _TABLE,
        "settlement_outcome IS NULL OR "
        "(settlement_outcome = 'already_satisfied' "
        "AND settlement_source = 'preflight') OR "
        "(settlement_outcome = 'acknowledged' "
        "AND settlement_source = 'primary') OR "
        "(settlement_outcome IN ('reconciled', 'rejected') "
        "AND settlement_source IN ('primary', 'recovery'))",
    )


def _split_event_guard() -> None:
    op.execute(sa.text("DROP TRIGGER trg_guard_bm_receipt_event ON " + _TABLE))
    op.execute(sa.text(_OPERATOR_GUARD_SQL))
    statements = (
        "CREATE TRIGGER trg_guard_bm_receipt_event_insert "
        "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
        "WHEN (NEW.settlement_source IS DISTINCT FROM 'operator_confirmation') "
        "EXECUTE FUNCTION torghut_guard_broker_mutation_event()",
        "CREATE TRIGGER trg_guard_bm_receipt_event_update_delete "
        "BEFORE UPDATE OR DELETE ON broker_mutation_receipt_events FOR EACH ROW "
        "EXECUTE FUNCTION torghut_guard_broker_mutation_event()",
        "CREATE TRIGGER trg_guard_bm_receipt_event_operator_confirmation "
        "BEFORE INSERT ON broker_mutation_receipt_events FOR EACH ROW "
        "WHEN (NEW.settlement_source = 'operator_confirmation') "
        "EXECUTE FUNCTION torghut_guard_validation_quarantine_terminal_0077()",
    )
    for statement in statements:
        op.execute(sa.text(statement))


def _restore_event_guard() -> None:
    for trigger in (
        "trg_guard_bm_receipt_event_operator_confirmation",
        "trg_guard_bm_receipt_event_update_delete",
        "trg_guard_bm_receipt_event_insert",
    ):
        op.execute(sa.text(f"DROP TRIGGER {trigger} ON {_TABLE}"))
    op.execute(
        sa.text("DROP FUNCTION torghut_guard_validation_quarantine_terminal_0077()")
    )
    op.execute(
        sa.text(
            "CREATE TRIGGER trg_guard_bm_receipt_event "
            "BEFORE INSERT OR UPDATE OR DELETE ON broker_mutation_receipt_events "
            "FOR EACH ROW EXECUTE FUNCTION torghut_guard_broker_mutation_event()"
        )
    )


def upgrade() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE broker_mutation_receipts, "
            + _TABLE
            + " IN ACCESS EXCLUSIVE MODE"
        )
    )
    _drop_settlement_checks()
    _create_0077_settlement_checks()
    _split_event_guard()


def downgrade() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE broker_mutation_receipts, "
            + _TABLE
            + " IN ACCESS EXCLUSIVE MODE"
        )
    )
    op.execute(
        sa.text(
            "DO $$ BEGIN IF EXISTS (SELECT 1 FROM broker_mutation_receipt_events "
            "WHERE settlement_outcome = 'validation_quarantine_closed') THEN "
            "RAISE EXCEPTION 'refusing to downgrade validation quarantine evidence' "
            "USING ERRCODE = '55000'; END IF; END; $$"
        )
    )
    _restore_event_guard()
    _drop_settlement_checks()
    _create_0059_settlement_checks()

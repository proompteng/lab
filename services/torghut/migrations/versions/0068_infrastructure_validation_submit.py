"""Authorize one non-promotable, permit-bound Alpaca paper submit.

Revision ID: 0068_validation_submit
Revises: 0067_options_archive_status
Create Date: 2026-07-14 23:05:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0068_validation_submit"
down_revision = "0067_options_archive_status"
branch_labels = None
depends_on = None


_PURPOSE_CONSTRAINT = "ck_bm_receipt_purpose"
_OPERATION_CONSTRAINT = "ck_bm_receipt_operation_contract"
_VALIDATION_CONSTRAINT = "ck_bm_receipt_validation_authority"
_VALIDATION_PERMIT_INDEX = "uq_bm_receipt_validation_permit"
_PURPOSES_0066 = """
purpose IN ('initial_submission', 'repricing', 'inventory_conflict',
            'opposite_side_cleanup', 'kill_switch', 'governance',
            'closeout', 'flatten', 'operator')
"""
_PURPOSES_0068 = """
purpose IN ('initial_submission', 'repricing', 'inventory_conflict',
            'opposite_side_cleanup', 'kill_switch', 'governance',
            'closeout', 'flatten', 'operator', 'control_plane_validation')
"""
_OPERATION_CONTRACT_0066 = """
((operation = 'submit_order' AND target_kind = 'order' AND
  ((broker_route = 'alpaca' AND
    (submission_claim_id IS NOT NULL OR
     (submission_claim_id IS NULL AND risk_class = 'risk_reducing'
      AND purpose IN ('closeout', 'flatten')))) OR
   (broker_route = 'hyperliquid' AND submission_claim_id IS NULL
    AND risk_class = 'risk_increasing'
    AND purpose = 'initial_submission'))) OR
 (operation = 'replace_order' AND target_kind = 'order'
  AND submission_claim_id IS NOT NULL) OR
 (operation = 'cancel_order' AND target_kind = 'order'
  AND submission_claim_id IS NULL) OR
 (operation = 'cancel_all_orders' AND target_kind = 'account'
  AND target_key = account_label AND submission_claim_id IS NULL) OR
 (operation = 'close_position' AND target_kind = 'position'
  AND submission_claim_id IS NULL AND risk_class = 'risk_reducing') OR
 (operation = 'close_all_positions' AND target_kind = 'account'
  AND target_key = account_label AND submission_claim_id IS NULL
  AND risk_class = 'risk_reducing'))
"""
_OPERATION_CONTRACT_0068 = """
((operation = 'submit_order' AND target_kind = 'order' AND
  ((broker_route = 'alpaca' AND
    (submission_claim_id IS NOT NULL OR
     (submission_claim_id IS NULL AND risk_class = 'risk_reducing'
      AND purpose IN ('closeout', 'flatten')) OR
     (submission_claim_id IS NULL AND risk_class = 'risk_neutral'
      AND purpose = 'control_plane_validation'))) OR
   (broker_route = 'hyperliquid' AND submission_claim_id IS NULL
    AND risk_class = 'risk_increasing'
    AND purpose = 'initial_submission'))) OR
 (operation = 'replace_order' AND target_kind = 'order'
  AND submission_claim_id IS NOT NULL) OR
 (operation = 'cancel_order' AND target_kind = 'order'
  AND submission_claim_id IS NULL) OR
 (operation = 'cancel_all_orders' AND target_kind = 'account'
  AND target_key = account_label AND submission_claim_id IS NULL) OR
 (operation = 'close_position' AND target_kind = 'position'
  AND submission_claim_id IS NULL AND risk_class = 'risk_reducing') OR
 (operation = 'close_all_positions' AND target_kind = 'account'
  AND target_key = account_label AND submission_claim_id IS NULL
  AND risk_class = 'risk_reducing'))
"""
_VALIDATION_AUTHORITY = """
purpose <> 'control_plane_validation' OR COALESCE((
  broker_route = 'alpaca'
  AND endpoint_fingerprint =
      'e7ce2f426f96cfc1606a46bc494cdfff68192ac2de4529bf406007d11d059ad7'
  AND operation = 'submit_order'
  AND risk_class = 'risk_neutral'
  AND submission_claim_id IS NULL
  AND workflow_id = client_request_id
  AND client_request_id ~ '^ivp-[0-9a-f]{44}$'
  AND target_kind = 'order'
  AND target_key = client_request_id
  AND canonical_intent_json::jsonb #>>
      '{request,broker_request,extra_params,client_order_id}' = client_request_id
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,schema_version}' =
      'torghut.infrastructure-validation-permit.v2'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,purpose}' =
      'control_plane_validation'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,venue}' = 'alpaca'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,account_mode}' = 'paper'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,account_label}' = account_label
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,broker_base_url}' IN
      ('https://paper-api.alpaca.markets',
       'https://paper-api.alpaca.markets/')
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,asset_class}' = 'crypto'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,market_session}' = 'continuous'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,evidence_tag}' =
      'non_promotable_validation'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,promotable}' = 'false'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,max_orders}' = '1'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,max_outstanding_intents}' = '1'
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_notional_usd}')::numeric
      > 0
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_notional_usd}')::numeric
      <= 1
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
      > 0
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
      <= 1
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
      <= (canonical_intent_json::jsonb #>>
          '{request,infrastructure_validation,permit,max_notional_usd}')::numeric
  AND lower(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,issued_by}') <>
      lower(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,approved_by}')
  AND length(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,issued_by}') BETWEEN 1 AND 128
  AND length(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,approved_by}') BETWEEN 1 AND 128
  AND length(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,permit_id}') BETWEEN 1 AND 128
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit_sha256}' ~ '^[0-9a-f]{64}$'
  AND created_at >= (canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,issued_at}')::timestamptz
  AND created_at < (canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,expires_at}')::timestamptz
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,expires_at}')::timestamptz
      - (canonical_intent_json::jsonb #>>
         '{request,infrastructure_validation,permit,issued_at}')::timestamptz
      <= interval '15 minutes'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,test_plan_digest}' =
      canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan_sha256}'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan_sha256}' ~ '^[0-9a-f]{64}$'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,expected_terminal_state_digest}' =
      canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,expected_terminal_state_sha256}'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,expected_terminal_state_sha256}' =
      '796e64c0dfebb4e72c3c56990b7976a952ff772822b3b02104af024a5fefd03e'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,expected_terminal_state}' =
      'no_open_orders_no_positions_no_unsettled_claims'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,expected_terminal_state,schema_version}' =
      'torghut.infrastructure-validation-terminal.v1'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,expected_terminal_state,state}' =
      'no_open_orders_no_positions_no_unsettled_claims'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,schema_version}' =
      'torghut.infrastructure-validation-order-plan.v1'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,venue}' = 'alpaca'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,asset_class}' =
      canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,permit,asset_class}'
  AND canonical_intent_json::jsonb #>>
      '{request,broker_request,symbol}' =
      canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,symbol}'
  AND canonical_intent_json::jsonb #>
      '{request,infrastructure_validation,permit,symbols}' =
      jsonb_build_array(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,symbol}')
  AND canonical_intent_json::jsonb #>>
      '{request,broker_request,side}' = 'buy'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,side}' = 'buy'
  AND canonical_intent_json::jsonb #>
      '{request,infrastructure_validation,permit,sides}' = '["buy"]'::jsonb
  AND canonical_intent_json::jsonb #>>
      '{request,broker_request,order_type}' = 'limit'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,order_type}' = 'limit'
  AND canonical_intent_json::jsonb #>
      '{request,infrastructure_validation,permit,order_types}' = '["limit"]'::jsonb
  AND canonical_intent_json::jsonb #>>
      '{request,broker_request,time_in_force}' = 'ioc'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation,test_plan,time_in_force}' = 'ioc'
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,qty}')::numeric > 0
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,limit_price}')::numeric > 0
  AND (canonical_intent_json::jsonb #>>
       '{request,broker_request,qty}')::numeric =
      (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,qty}')::numeric
  AND (canonical_intent_json::jsonb #>>
       '{request,broker_request,limit_price}')::numeric =
      (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,limit_price}')::numeric
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,qty}')::numeric *
      (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,limit_price}')::numeric
      <= (canonical_intent_json::jsonb #>>
          '{request,infrastructure_validation,permit,max_notional_usd}')::numeric
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,qty}')::numeric *
      (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,test_plan,limit_price}')::numeric
      <= (canonical_intent_json::jsonb #>>
          '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
  AND canonical_intent_json::jsonb #>
      '{request,broker_request,extra_params}' =
      jsonb_build_object('client_order_id', client_request_id)
  AND canonical_intent_json::jsonb #>
      '{request,broker_request,stop_price}' = 'null'::jsonb
  AND canonical_intent_json::jsonb #>
      '{request,infrastructure_validation,test_plan,stop_price}' = 'null'::jsonb
), FALSE)
"""


def _replace_check(name: str, condition: str) -> None:
    op.drop_constraint(name, "broker_mutation_receipts", type_="check")
    op.create_check_constraint(name, "broker_mutation_receipts", condition)


def _replace_claim_guard(*, allow_validation: bool) -> None:
    validation_contract = (
        """
                       OR (NEW.broker_route = 'alpaca'
                           AND NEW.risk_class = 'risk_neutral'
                           AND NEW.purpose = 'control_plane_validation')
        """
        if allow_validation
        else ""
    )
    op.execute(
        sa.text(
            f"""
            CREATE OR REPLACE FUNCTION torghut_guard_bm_claim_0060()
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
                IF NEW.submission_claim_id IS NULL THEN
                    IF (NEW.broker_route = 'alpaca'
                        AND NEW.risk_class = 'risk_reducing'
                        AND NEW.purpose IN ('closeout', 'flatten'))
                       {validation_contract}
                       OR (NEW.broker_route = 'hyperliquid'
                           AND NEW.risk_class = 'risk_increasing'
                           AND NEW.purpose = 'initial_submission') THEN
                        RETURN NEW;
                    END IF;
                    RAISE EXCEPTION
                        'unlinked broker mutation submit contract invalid'
                        USING ERRCODE = '23514';
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


def upgrade() -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    _replace_check(_PURPOSE_CONSTRAINT, _PURPOSES_0068)
    _replace_check(_OPERATION_CONSTRAINT, _OPERATION_CONTRACT_0068)
    _replace_claim_guard(allow_validation=True)
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              ADD CONSTRAINT {_VALIDATION_CONSTRAINT}
              CHECK ({_VALIDATION_AUTHORITY}) NOT VALID
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              VALIDATE CONSTRAINT {_VALIDATION_CONSTRAINT}
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE UNIQUE INDEX {_VALIDATION_PERMIT_INDEX}
              ON broker_mutation_receipts
              ((canonical_intent_json::jsonb #>>
                '{{request,infrastructure_validation,permit,permit_id}}'))
             WHERE purpose = 'control_plane_validation'
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    op.execute(
        sa.text(
            """
            DO $torghut$
            BEGIN
                IF EXISTS (
                    SELECT 1
                      FROM broker_mutation_receipts
                     WHERE purpose = 'control_plane_validation'
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with infrastructure-validation receipts';
                END IF;
            END
            $torghut$;
            """
        )
    )
    op.execute(sa.text(f"DROP INDEX {_VALIDATION_PERMIT_INDEX}"))
    op.drop_constraint(
        _VALIDATION_CONSTRAINT,
        "broker_mutation_receipts",
        type_="check",
    )
    _replace_claim_guard(allow_validation=False)
    _replace_check(_OPERATION_CONSTRAINT, _OPERATION_CONTRACT_0066)
    _replace_check(_PURPOSE_CONSTRAINT, _PURPOSES_0066)

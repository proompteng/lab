"""Allow permit-bound unlinked replacement receipts.

Revision ID: 0070_reduction_fencing
Revises: 0069_strict_submit_recovery
Create Date: 2026-07-15 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0070_reduction_fencing"
down_revision = "0069_strict_submit_recovery"
branch_labels = None
depends_on = None


_CONSTRAINT = "ck_bm_receipt_operation_contract"
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
_OPERATION_CONTRACT_0070 = """
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
 (operation = 'replace_order' AND target_kind = 'order' AND
  broker_route = 'alpaca' AND submission_claim_id IS NULL
  AND risk_class = 'risk_neutral'
  AND purpose = 'repricing') OR
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


def _replace_claim_guard(*, allow_repricing: bool) -> None:
    repricing_contract = (
        """
                    IF NEW.submission_claim_id IS NULL
                       AND NEW.broker_route = 'alpaca'
                       AND NEW.risk_class = 'risk_neutral'
                       AND NEW.purpose = 'repricing' THEN
                        RETURN NEW;
                    END IF;
        """
        if allow_repricing
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
                    {repricing_contract}
                    RAISE EXCEPTION
                        'broker mutation replace receipt contract invalid'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.operation <> 'submit_order' THEN
                    RETURN NEW;
                END IF;
                IF NEW.submission_claim_id IS NULL THEN
                    IF (NEW.broker_route = 'alpaca'
                        AND NEW.risk_class = 'risk_reducing'
                        AND NEW.purpose IN ('closeout', 'flatten'))
                       OR (NEW.broker_route = 'alpaca'
                           AND NEW.risk_class = 'risk_neutral'
                           AND NEW.purpose = 'control_plane_validation')
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
    op.drop_constraint(_CONSTRAINT, "broker_mutation_receipts", type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        "broker_mutation_receipts",
        sa.text(_OPERATION_CONTRACT_0070),
    )
    _replace_claim_guard(allow_repricing=True)


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
                     WHERE operation = 'replace_order'
                       AND submission_claim_id IS NULL
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with unlinked replacement receipts';
                END IF;
            END
            $torghut$;
            """
        )
    )
    _replace_claim_guard(allow_repricing=False)
    op.drop_constraint(_CONSTRAINT, "broker_mutation_receipts", type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        "broker_mutation_receipts",
        sa.text(_OPERATION_CONTRACT_0068),
    )

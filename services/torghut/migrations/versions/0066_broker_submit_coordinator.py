"""Allow durable unlinked Hyperliquid entry and Alpaca closeout submissions.

Revision ID: 0066_broker_submit_coordinator
Revises: 0065_strategy_capital_compat
Create Date: 2026-07-14 16:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0066_broker_submit_coordinator"
down_revision = "0065_strategy_capital_compat"
branch_labels = None
depends_on = None


_CONSTRAINT = "ck_bm_receipt_operation_contract"
_UPGRADE_CONTRACT = """
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
_DOWNGRADE_CONTRACT = """
((operation IN ('submit_order', 'replace_order')
  AND target_kind = 'order' AND submission_claim_id IS NOT NULL) OR
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


def _replace_contract(condition: str) -> None:
    op.drop_constraint(_CONSTRAINT, "broker_mutation_receipts", type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        "broker_mutation_receipts",
        condition,
    )


def _replace_claim_guard(*, allow_unlinked_submit: bool) -> None:
    unlinked_contract = (
        """
                IF NEW.submission_claim_id IS NULL THEN
                    IF (NEW.broker_route = 'alpaca'
                        AND NEW.risk_class = 'risk_reducing'
                        AND NEW.purpose IN ('closeout', 'flatten'))
                       OR (NEW.broker_route = 'hyperliquid'
                           AND NEW.risk_class = 'risk_increasing'
                           AND NEW.purpose = 'initial_submission') THEN
                        RETURN NEW;
                    END IF;
                    RAISE EXCEPTION
                        'unlinked broker mutation submit contract invalid'
                        USING ERRCODE = '23514';
                END IF;
        """
        if allow_unlinked_submit
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
                {unlinked_contract}
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
    _replace_contract(_UPGRADE_CONTRACT)
    _replace_claim_guard(allow_unlinked_submit=True)


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
                    WHERE operation = 'submit_order'
                      AND submission_claim_id IS NULL
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with unlinked submit-order receipts';
                END IF;
            END
            $torghut$;
            """
        )
    )
    _replace_claim_guard(allow_unlinked_submit=False)
    _replace_contract(_DOWNGRADE_CONTRACT)

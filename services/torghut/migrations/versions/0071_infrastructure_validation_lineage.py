"""Bind reduction receipts to database-proven validation ancestry.

Revision ID: 0071_validation_lineage
Revises: 0070_reduction_fencing
Create Date: 2026-07-15 13:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.schema import conv


revision = "0071_validation_lineage"
down_revision = "0070_reduction_fencing"
branch_labels = None
depends_on = None


_CONSTRAINT = "ck_bm_receipt_validation_lineage"
_BROKER_REFERENCE_INDEX = "ix_bm_receipt_event_broker_reference"
_TRIGGER = "trg_guard_bm_validation_lineage_0071"
_FUNCTION = "torghut_guard_bm_validation_lineage_0071"
_LINEAGE_CONTRACT = r"""
(canonical_intent_json::jsonb #>
  '{request,infrastructure_validation_lineage}') IS NULL
OR COALESCE((
  broker_route = 'alpaca'
  AND submission_claim_id IS NULL
  AND operation IN ('replace_order', 'cancel_order',
                    'close_position', 'close_all_positions')
  AND jsonb_typeof(canonical_intent_json::jsonb #>
      '{request,infrastructure_validation_lineage}') = 'object'
  AND (canonical_intent_json::jsonb #>
      '{request,infrastructure_validation_lineage}') ?& ARRAY[
        'schema_version', 'root_receipt_id', 'root_client_order_id',
        'parent_receipt_id', 'parent_broker_order_id', 'permit_id',
        'permit_sha256', 'evidence_tag', 'promotable'
      ]
  AND ((canonical_intent_json::jsonb #>
      '{request,infrastructure_validation_lineage}') - ARRAY[
        'schema_version', 'root_receipt_id', 'root_client_order_id',
        'parent_receipt_id', 'parent_broker_order_id', 'permit_id',
        'permit_sha256', 'evidence_tag', 'promotable'
      ]) = '{}'::jsonb
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,schema_version}' =
      'torghut.infrastructure-validation-lineage.v1'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,root_receipt_id}' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,root_client_order_id}' ~
      '^ivp-[0-9a-f]{44}$'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,parent_receipt_id}' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND length(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,parent_broker_order_id}')
      BETWEEN 1 AND 256
  AND length(canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,permit_id}') BETWEEN 1 AND 128
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,permit_sha256}' ~
      '^[0-9a-f]{64}$'
  AND canonical_intent_json::jsonb #>>
      '{request,infrastructure_validation_lineage,evidence_tag}' =
      'non_promotable_validation'
  AND canonical_intent_json::jsonb #>
      '{request,infrastructure_validation_lineage,promotable}' = 'false'::jsonb
), FALSE)
"""


def _install_lineage_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE OR REPLACE FUNCTION {_FUNCTION}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                lineage jsonb;
                root broker_mutation_receipts%ROWTYPE;
                ancestor broker_mutation_receipts%ROWTYPE;
                root_state text;
                root_outcome text;
                root_reference text;
                root_symbol text;
                root_plan_schema text;
                ancestor_state text;
                ancestor_outcome text;
                ancestor_reference text;
            BEGIN
                lineage := NEW.canonical_intent_json::jsonb #>
                    '{{request,infrastructure_validation_lineage}}';
                IF lineage IS NULL THEN
                    RETURN NEW;
                END IF;

                SELECT * INTO root
                  FROM broker_mutation_receipts
                 WHERE id = (lineage #>> '{{root_receipt_id}}')::uuid
                   FOR KEY SHARE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage root missing'
                        USING ERRCODE = '23514';
                END IF;
                IF root.broker_route IS DISTINCT FROM 'alpaca'
                   OR root.operation IS DISTINCT FROM 'submit_order'
                   OR root.risk_class IS DISTINCT FROM 'risk_neutral'
                   OR root.purpose IS DISTINCT FROM 'control_plane_validation'
                   OR root.submission_claim_id IS NOT NULL
                   OR root.account_label IS DISTINCT FROM NEW.account_label
                   OR root.endpoint_fingerprint IS DISTINCT FROM NEW.endpoint_fingerprint
                   OR root.client_request_id IS DISTINCT FROM
                      lineage #>> '{{root_client_order_id}}'
                   OR root.canonical_intent_json::jsonb #>>
                      '{{request,infrastructure_validation,permit,permit_id}}'
                      IS DISTINCT FROM lineage #>> '{{permit_id}}'
                   OR root.canonical_intent_json::jsonb #>>
                      '{{request,infrastructure_validation,permit_sha256}}'
                      IS DISTINCT FROM lineage #>> '{{permit_sha256}}' THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage root mismatch'
                        USING ERRCODE = '23514';
                END IF;

                SELECT event.state, event.settlement_outcome,
                       event.broker_reference
                  INTO root_state, root_outcome, root_reference
                  FROM broker_mutation_receipt_events AS event
                 WHERE event.receipt_id = root.id
                 ORDER BY event.sequence_no DESC
                 LIMIT 1;
                IF NOT FOUND
                   OR root_state IS DISTINCT FROM 'settled'
                   OR root_outcome IS NULL
                   OR root_outcome NOT IN ('acknowledged', 'reconciled')
                   OR NULLIF(root_reference, '') IS NULL THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage root is not broker-terminal'
                        USING ERRCODE = '23514';
                END IF;

                root_symbol := root.canonical_intent_json::jsonb #>>
                    '{{request,infrastructure_validation,test_plan,symbol}}';
                root_plan_schema := root.canonical_intent_json::jsonb #>>
                    '{{request,infrastructure_validation,test_plan,schema_version}}';
                SELECT * INTO ancestor
                  FROM broker_mutation_receipts
                 WHERE id = (lineage #>> '{{parent_receipt_id}}')::uuid
                   FOR KEY SHARE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage parent missing'
                        USING ERRCODE = '23514';
                END IF;
                IF ancestor.account_label IS DISTINCT FROM NEW.account_label
                   OR ancestor.endpoint_fingerprint IS DISTINCT FROM
                      NEW.endpoint_fingerprint
                   OR ancestor.created_at >= NEW.created_at
                   OR ancestor.operation NOT IN (
                        'submit_order', 'replace_order',
                        'close_position', 'close_all_positions'
                   )
                   OR (
                        ancestor.id IS DISTINCT FROM root.id
                        AND ancestor.canonical_intent_json::jsonb #>>
                            '{{request,infrastructure_validation_lineage,root_receipt_id}}'
                            IS DISTINCT FROM root.id::text
                   ) THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage parent mismatch'
                        USING ERRCODE = '23514';
                END IF;

                SELECT event.state, event.settlement_outcome,
                       event.broker_reference
                  INTO ancestor_state, ancestor_outcome, ancestor_reference
                  FROM broker_mutation_receipt_events AS event
                 WHERE event.receipt_id = ancestor.id
                 ORDER BY event.sequence_no DESC
                 LIMIT 1;
                IF NOT FOUND
                   OR ancestor_state IS DISTINCT FROM 'settled'
                   OR ancestor_outcome IS NULL
                   OR ancestor_outcome NOT IN ('acknowledged', 'reconciled')
                   OR ancestor_reference IS DISTINCT FROM
                      lineage #>> '{{parent_broker_order_id}}' THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage parent is not terminal'
                        USING ERRCODE = '23514';
                END IF;

                IF (
                       NEW.operation IN ('close_position', 'close_all_positions')
                       AND root_plan_schema IS DISTINCT FROM
                           'torghut.infrastructure-validation-lifecycle-plan.v1'
                   ) OR (
                       NEW.operation IN ('replace_order', 'cancel_order')
                       AND NEW.target_key IS DISTINCT FROM ancestor_reference
                   ) OR (
                       NEW.operation = 'close_position'
                       AND NEW.target_key IS DISTINCT FROM root_symbol
                   ) OR (
                       NEW.operation = 'close_all_positions'
                       AND NEW.canonical_intent_json::jsonb #>
                           '{{request,symbols}}'
                           IS DISTINCT FROM jsonb_build_array(root_symbol)
                   ) THEN
                    RAISE EXCEPTION
                        'infrastructure validation lineage target mismatch'
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
            f"""
            CREATE TRIGGER {_TRIGGER}
            BEFORE INSERT ON broker_mutation_receipts
            FOR EACH ROW EXECUTE FUNCTION {_FUNCTION}()
            """
        )
    )


def upgrade() -> None:
    op.execute(
        sa.text("LOCK TABLE broker_mutation_receipts IN ACCESS EXCLUSIVE MODE NOWAIT")
    )
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              ADD CONSTRAINT {_CONSTRAINT}
              CHECK ({_LINEAGE_CONTRACT}) NOT VALID
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              VALIDATE CONSTRAINT {_CONSTRAINT}
            """
        )
    )
    op.create_index(
        _BROKER_REFERENCE_INDEX,
        "broker_mutation_receipt_events",
        ["broker_reference", "receipt_id"],
        unique=False,
        postgresql_where=sa.text("state = 'settled' AND broker_reference IS NOT NULL"),
    )
    _install_lineage_guard()


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
                     WHERE canonical_intent_json::jsonb #>
                           '{request,infrastructure_validation_lineage}' IS NOT NULL
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with validation-lineage receipts';
                END IF;
            END
            $torghut$;
            """
        )
    )
    op.execute(sa.text(f"DROP TRIGGER {_TRIGGER} ON broker_mutation_receipts"))
    op.execute(sa.text(f"DROP FUNCTION {_FUNCTION}()"))
    op.drop_index(
        _BROKER_REFERENCE_INDEX,
        table_name="broker_mutation_receipt_events",
    )
    op.drop_constraint(
        conv(_CONSTRAINT),
        "broker_mutation_receipts",
        type_="check",
    )

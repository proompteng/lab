"""Prove validation position ancestry before any lifecycle reduction.

Revision ID: 0072_validation_lifecycle
Revises: 0071_validation_lineage
Create Date: 2026-07-15 15:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.schema import conv


revision = "0072_validation_lifecycle"
down_revision = "0071_validation_lineage"
branch_labels = None
depends_on = None


_VALIDATION_CONSTRAINT = "ck_bm_receipt_validation_authority"
_LINEAGE_CONSTRAINT = "ck_bm_receipt_validation_lineage"
_POSITION_INDEX = "ix_order_event_validation_position"
_OLD_TRIGGER = "trg_guard_bm_validation_lineage_0071"
_OLD_FUNCTION = "torghut_guard_bm_validation_lineage_0071"
_TRIGGER = "trg_guard_bm_validation_lineage_0072"
_FUNCTION = "torghut_guard_bm_validation_lineage_0072"

_VALIDATION_COMMON = r"""
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
    ('https://paper-api.alpaca.markets', 'https://paper-api.alpaca.markets/')
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
     '{request,infrastructure_validation,permit,max_notional_usd}')::numeric > 0
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_loss_usd}')::numeric > 0
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_loss_usd}')::numeric <=
    (canonical_intent_json::jsonb #>>
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
     '{request,infrastructure_validation,permit,expires_at}')::timestamptz -
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,issued_at}')::timestamptz <=
    interval '15 minutes'
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
    '{request,infrastructure_validation,test_plan,venue}' = 'alpaca'
AND canonical_intent_json::jsonb #>>
    '{request,infrastructure_validation,test_plan,asset_class}' = 'crypto'
AND canonical_intent_json::jsonb #>>
    '{request,broker_request,symbol}' =
    canonical_intent_json::jsonb #>>
    '{request,infrastructure_validation,test_plan,symbol}'
AND canonical_intent_json::jsonb #>
    '{request,infrastructure_validation,permit,symbols}' =
    jsonb_build_array(canonical_intent_json::jsonb #>>
    '{request,infrastructure_validation,test_plan,symbol}')
AND canonical_intent_json::jsonb #>> '{request,broker_request,side}' = 'buy'
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
AND (canonical_intent_json::jsonb #>> '{request,broker_request,qty}')::numeric =
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,qty}')::numeric
AND (canonical_intent_json::jsonb #>>
     '{request,broker_request,limit_price}')::numeric =
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,limit_price}')::numeric
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,qty}')::numeric *
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,limit_price}')::numeric <=
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_notional_usd}')::numeric
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,qty}')::numeric *
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,limit_price}')::numeric <=
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
AND canonical_intent_json::jsonb #>
    '{request,broker_request,extra_params}' =
    jsonb_build_object('client_order_id', client_request_id)
AND canonical_intent_json::jsonb #> '{request,broker_request,stop_price}' =
    'null'::jsonb
AND canonical_intent_json::jsonb #>
    '{request,infrastructure_validation,test_plan,stop_price}' = 'null'::jsonb
"""

_KNOWN_NULL_PLAN = r"""
canonical_intent_json::jsonb #>>
    '{request,infrastructure_validation,test_plan,schema_version}' =
    'torghut.infrastructure-validation-order-plan.v1'
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_notional_usd}')::numeric <= 1
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_loss_usd}')::numeric <= 1
"""

_LIFECYCLE_PLAN = r"""
canonical_intent_json::jsonb #>>
    '{request,infrastructure_validation,test_plan,schema_version}' =
    'torghut.infrastructure-validation-lifecycle-plan.v1'
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_notional_usd}')::numeric <= 5
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,permit,max_loss_usd}')::numeric <= 5
AND ((canonical_intent_json::jsonb #>
    '{request,infrastructure_validation,test_plan}') - ARRAY[
      'schema_version', 'venue', 'asset_class', 'symbol', 'side', 'qty',
      'order_type', 'time_in_force', 'limit_price', 'stop_price',
      'resting_close_limit_price', 'replacement_close_limit_price',
      'partial_close_qty'
    ]) = '{}'::jsonb
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,partial_close_qty}')::numeric > 0
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,partial_close_qty}')::numeric <
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,qty}')::numeric
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,resting_close_limit_price}')::numeric >
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,limit_price}')::numeric
AND (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,replacement_close_limit_price}')::numeric >
    (canonical_intent_json::jsonb #>>
     '{request,infrastructure_validation,test_plan,resting_close_limit_price}')::numeric
"""


def _validation_authority(plan_contract: str) -> str:
    return f"""
    purpose <> 'control_plane_validation' OR COALESCE((
      {_VALIDATION_COMMON}
      AND ({plan_contract})
    ), FALSE)
    """


_VALIDATION_AUTHORITY_0071 = _validation_authority(_KNOWN_NULL_PLAN)
_VALIDATION_AUTHORITY_0072 = _validation_authority(
    f"({_KNOWN_NULL_PLAN}) OR ({_LIFECYCLE_PLAN})"
)

_LINEAGE_CONTRACT_0071 = r"""
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

_LINEAGE_CONTRACT_0072 = _LINEAGE_CONTRACT_0071.replace(
    "operation IN ('replace_order', 'cancel_order',\n                    'close_position', 'close_all_positions')",
    "operation IN ('submit_order', 'replace_order', 'cancel_order',\n"
    "                    'close_position', 'close_all_positions')\n"
    "  AND (operation <> 'submit_order' OR (risk_class = 'risk_reducing'\n"
    "       AND purpose = 'closeout' AND target_kind = 'order'))",
)


def _replace_check(name: str, condition: str) -> None:
    op.drop_constraint(conv(name), "broker_mutation_receipts", type_="check")
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            ALTER TABLE broker_mutation_receipts
              VALIDATE CONSTRAINT {name}
            """
        )
    )


def _install_lifecycle_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE OR REPLACE FUNCTION {_FUNCTION}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                lineage jsonb;
                risk jsonb;
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
                event_receipt broker_mutation_receipts%ROWTYPE;
                event_receipt_id uuid;
                event_receipt_state text;
                event_receipt_outcome text;
                event_receipt_reference text;
                latest_alpaca_order_id text;
                latest_position_qty numeric;
                observed_position_qty numeric;
                observed_at timestamptz;
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
                    RAISE EXCEPTION 'infrastructure validation lineage root missing'
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
                    RAISE EXCEPTION 'infrastructure validation lineage root mismatch'
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
                    RAISE EXCEPTION 'infrastructure validation lineage parent missing'
                        USING ERRCODE = '23514';
                END IF;
                IF ancestor.account_label IS DISTINCT FROM NEW.account_label
                   OR ancestor.endpoint_fingerprint IS DISTINCT FROM
                      NEW.endpoint_fingerprint
                   OR ancestor.created_at > NEW.created_at
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
                    RAISE EXCEPTION 'infrastructure validation lineage parent mismatch'
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

                IF NEW.operation IN ('replace_order', 'cancel_order')
                   AND NEW.target_key IS DISTINCT FROM ancestor_reference THEN
                    RAISE EXCEPTION 'infrastructure validation lineage target mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.operation = 'submit_order' AND (
                       root_plan_schema IS DISTINCT FROM
                           'torghut.infrastructure-validation-lifecycle-plan.v1'
                       OR ancestor.id IS DISTINCT FROM root.id
                       OR NEW.target_key IS DISTINCT FROM root_symbol
                       OR NEW.canonical_intent_json::jsonb #>>
                           '{{request,symbol}}' IS DISTINCT FROM root_symbol
                       OR NEW.canonical_intent_json::jsonb #>>
                           '{{request,side}}' IS DISTINCT FROM 'sell'
                       OR NEW.canonical_intent_json::jsonb #>>
                           '{{request,order_type}}' IS DISTINCT FROM 'limit'
                       OR NEW.canonical_intent_json::jsonb #>>
                           '{{request,time_in_force}}' IS DISTINCT FROM 'gtc'
                       OR NEW.canonical_intent_json::jsonb #>>
                           '{{request,extra_params,client_order_id}}'
                           IS DISTINCT FROM NEW.client_request_id
                   ) THEN
                    RAISE EXCEPTION 'infrastructure validation lineage target mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.operation = 'close_position' AND (
                       root_plan_schema IS DISTINCT FROM
                           'torghut.infrastructure-validation-lifecycle-plan.v1'
                       OR NEW.target_key IS DISTINCT FROM root_symbol
                   ) THEN
                    RAISE EXCEPTION 'infrastructure validation lineage target mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.operation = 'close_all_positions' AND (
                       root_plan_schema IS DISTINCT FROM
                           'torghut.infrastructure-validation-lifecycle-plan.v1'
                       OR NEW.canonical_intent_json::jsonb #>
                           '{{request,symbols}}'
                           IS DISTINCT FROM jsonb_build_array(root_symbol)
                   ) THEN
                    RAISE EXCEPTION 'infrastructure validation lineage target mismatch'
                        USING ERRCODE = '23514';
                END IF;

                IF NEW.operation IN (
                    'submit_order', 'close_position', 'close_all_positions'
                ) THEN
                    SELECT event.position_qty, event.alpaca_order_id,
                           (event.raw_event::jsonb #>>
                            '{{_torghut_evidence_contract,broker_mutation_receipt_id}}')::uuid
                      INTO latest_position_qty, latest_alpaca_order_id,
                           event_receipt_id
                      FROM execution_order_events AS event
                     WHERE event.alpaca_account_label = NEW.account_label
                       AND event.symbol = root_symbol
                       AND event.event_type IN ('fill', 'partial_fill')
                       AND event.filled_qty > 0
                       AND event.avg_fill_price > 0
                       AND event.position_qty IS NOT NULL
                       AND event.execution_id IS NULL
                       AND event.trade_decision_id IS NULL
                       AND event.raw_event::jsonb #>>
                           '{{_torghut_evidence_contract,schema_version}}' =
                           'torghut.order-event-evidence-contract.v1'
                       AND event.raw_event::jsonb #>>
                           '{{_torghut_evidence_contract,provenance}}' =
                           'non_promotable_validation'
                       AND event.raw_event::jsonb #>>
                           '{{_torghut_evidence_contract,validation_root_receipt_id}}' =
                           root.id::text
                       AND event.raw_event::jsonb #>>
                           '{{_torghut_evidence_contract,validation_root_client_order_id}}' =
                           root.client_request_id
                       AND event.raw_event::jsonb #>>
                           '{{_torghut_evidence_contract,permit_id}}' =
                           lineage #>> '{{permit_id}}'
                       AND event.raw_event::jsonb #>>
                           '{{_torghut_evidence_contract,permit_sha256}}' =
                           lineage #>> '{{permit_sha256}}'
                     ORDER BY event.event_ts DESC NULLS LAST,
                              event.created_at DESC, event.id DESC
                     LIMIT 1;
                    IF NOT FOUND OR latest_position_qty <= 0 THEN
                        RAISE EXCEPTION
                            'infrastructure validation position fill missing'
                            USING ERRCODE = '23514';
                    END IF;

                    SELECT * INTO event_receipt
                      FROM broker_mutation_receipts
                     WHERE id = event_receipt_id
                       FOR KEY SHARE;
                    IF NOT FOUND
                       OR event_receipt.broker_route IS DISTINCT FROM 'alpaca'
                       OR event_receipt.account_label IS DISTINCT FROM
                          NEW.account_label
                       OR event_receipt.endpoint_fingerprint IS DISTINCT FROM
                          NEW.endpoint_fingerprint
                       OR event_receipt.operation NOT IN (
                            'submit_order', 'replace_order',
                            'close_position', 'close_all_positions'
                       )
                       OR (
                            event_receipt.id IS DISTINCT FROM root.id
                            AND (
                                event_receipt.canonical_intent_json::jsonb #>>
                                    '{{request,infrastructure_validation_lineage,root_receipt_id}}'
                                    IS DISTINCT FROM root.id::text
                                OR event_receipt.canonical_intent_json::jsonb #>>
                                    '{{request,infrastructure_validation_lineage,permit_id}}'
                                    IS DISTINCT FROM lineage #>> '{{permit_id}}'
                                OR event_receipt.canonical_intent_json::jsonb #>>
                                    '{{request,infrastructure_validation_lineage,permit_sha256}}'
                                    IS DISTINCT FROM lineage #>> '{{permit_sha256}}'
                            )
                       ) THEN
                        RAISE EXCEPTION
                            'infrastructure validation fill receipt mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                    SELECT event.state, event.settlement_outcome,
                           event.broker_reference
                      INTO event_receipt_state, event_receipt_outcome,
                           event_receipt_reference
                      FROM broker_mutation_receipt_events AS event
                     WHERE event.receipt_id = event_receipt.id
                     ORDER BY event.sequence_no DESC
                     LIMIT 1;
                    IF NOT FOUND
                       OR event_receipt_state IS DISTINCT FROM 'settled'
                       OR event_receipt_outcome IS NULL
                       OR event_receipt_outcome NOT IN (
                            'acknowledged', 'reconciled'
                       )
                       OR event_receipt_reference IS DISTINCT FROM
                          latest_alpaca_order_id THEN
                        RAISE EXCEPTION
                            'infrastructure validation fill order mismatch'
                            USING ERRCODE = '23514';
                    END IF;

                    risk := NEW.canonical_intent_json::jsonb #>
                        '{{request,risk_reduction}}';
                    IF risk IS NULL
                       OR risk #>> '{{schema_version}}' IS DISTINCT FROM
                          'torghut.risk-reduction-evidence.v1'
                       OR risk #>> '{{broker_route}}' IS DISTINCT FROM 'alpaca'
                       OR risk #>> '{{account_label}}' IS DISTINCT FROM
                          NEW.account_label
                       OR risk #>> '{{endpoint_fingerprint}}' IS DISTINCT FROM
                          NEW.endpoint_fingerprint
                       OR risk #>> '{{observation,complete}}' IS DISTINCT FROM 'true'
                       OR jsonb_typeof(risk #> '{{observation,positions}}')
                          IS DISTINCT FROM 'array'
                       OR jsonb_array_length(risk #> '{{observation,positions}}') <> 1
                       OR risk #>> '{{observation,positions,0,symbol}}'
                          IS DISTINCT FROM root_symbol THEN
                        RAISE EXCEPTION
                            'infrastructure validation position observation invalid'
                            USING ERRCODE = '23514';
                    END IF;
                    observed_position_qty := (
                        risk #>> '{{observation,positions,0,signed_quantity}}'
                    )::numeric;
                    observed_at := (risk #>> '{{observation,observed_at}}')::timestamptz;
                    IF observed_position_qty IS DISTINCT FROM latest_position_qty
                       OR observed_at > NEW.created_at + interval '1 second'
                       OR NEW.created_at - observed_at > interval '5 seconds' THEN
                        RAISE EXCEPTION
                            'infrastructure validation position not reconciled'
                            USING ERRCODE = '23514';
                    END IF;

                    IF NEW.operation = 'submit_order' AND (
                           risk #>> '{{target_key}}' IS DISTINCT FROM root_symbol
                           OR risk #>> '{{action,type}}' IS DISTINCT FROM
                              'submit_close_order'
                           OR risk #>> '{{action,leg,symbol}}' IS DISTINCT FROM
                              root_symbol
                           OR risk #>> '{{action,leg,side}}' IS DISTINCT FROM 'sell'
                           OR (risk #>> '{{action,leg,quantity}}')::numeric <= 0
                           OR (risk #>> '{{action,leg,quantity}}')::numeric >
                              latest_position_qty
                           OR (NEW.canonical_intent_json::jsonb #>>
                              '{{request,qty}}')::numeric IS DISTINCT FROM
                              (risk #>> '{{action,leg,quantity}}')::numeric
                       ) THEN
                        RAISE EXCEPTION
                            'infrastructure validation close action mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                    IF NEW.operation = 'close_position' AND (
                           risk #>> '{{target_key}}' IS DISTINCT FROM root_symbol
                           OR risk #>> '{{action,type}}' IS DISTINCT FROM
                              'close_position'
                           OR risk #>> '{{action,leg,symbol}}' IS DISTINCT FROM
                              root_symbol
                           OR risk #>> '{{action,leg,side}}' IS DISTINCT FROM 'sell'
                           OR (risk #>> '{{action,leg,quantity}}')::numeric <= 0
                           OR (risk #>> '{{action,leg,quantity}}')::numeric >
                              latest_position_qty
                           OR (NEW.canonical_intent_json::jsonb #>>
                              '{{request,quantity}}')::numeric IS DISTINCT FROM
                              (risk #>> '{{action,leg,quantity}}')::numeric
                       ) THEN
                        RAISE EXCEPTION
                            'infrastructure validation close action mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                    IF NEW.operation = 'close_all_positions' AND (
                           risk #>> '{{target_key}}' IS DISTINCT FROM NEW.account_label
                           OR risk #>> '{{action,type}}' IS DISTINCT FROM
                              'close_all_positions'
                           OR jsonb_array_length(risk #> '{{action,legs}}') <> 1
                           OR risk #>> '{{action,legs,0,symbol}}' IS DISTINCT FROM
                              root_symbol
                           OR risk #>> '{{action,legs,0,side}}' IS DISTINCT FROM 'sell'
                           OR (risk #>> '{{action,legs,0,quantity}}')::numeric
                              IS DISTINCT FROM latest_position_qty
                       ) THEN
                        RAISE EXCEPTION
                            'infrastructure validation close action mismatch'
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
    op.add_column(
        "execution_order_events",
        sa.Column("position_qty", sa.Numeric(20, 8), nullable=True),
    )
    op.create_index(
        _POSITION_INDEX,
        "execution_order_events",
        ["alpaca_account_label", "symbol", "event_ts", "created_at"],
        unique=False,
        postgresql_where=sa.text(
            "position_qty IS NOT NULL AND execution_id IS NULL "
            "AND trade_decision_id IS NULL"
        ),
    )
    _replace_check(_VALIDATION_CONSTRAINT, _VALIDATION_AUTHORITY_0072)
    _replace_check(_LINEAGE_CONSTRAINT, _LINEAGE_CONTRACT_0072)
    op.execute(sa.text(f"DROP TRIGGER {_OLD_TRIGGER} ON broker_mutation_receipts"))
    _install_lifecycle_guard()


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
                     WHERE canonical_intent_json::jsonb #>>
                           '{request,infrastructure_validation,test_plan,schema_version}' =
                           'torghut.infrastructure-validation-lifecycle-plan.v1'
                ) OR EXISTS (
                    SELECT 1 FROM execution_order_events
                     WHERE position_qty IS NOT NULL
                ) THEN
                    RAISE EXCEPTION
                        'cannot downgrade with validation lifecycle evidence';
                END IF;
            END
            $torghut$;
            """
        )
    )
    op.execute(sa.text(f"DROP TRIGGER {_TRIGGER} ON broker_mutation_receipts"))
    op.execute(sa.text(f"DROP FUNCTION {_FUNCTION}()"))
    _replace_check(_LINEAGE_CONSTRAINT, _LINEAGE_CONTRACT_0071)
    _replace_check(_VALIDATION_CONSTRAINT, _VALIDATION_AUTHORITY_0071)
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {_OLD_TRIGGER}
            BEFORE INSERT ON broker_mutation_receipts
            FOR EACH ROW EXECUTE FUNCTION {_OLD_FUNCTION}()
            """
        )
    )
    op.drop_index(_POSITION_INDEX, table_name="execution_order_events")
    op.drop_column("execution_order_events", "position_qty")

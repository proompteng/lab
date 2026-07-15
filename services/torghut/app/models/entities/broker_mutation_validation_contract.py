"""PostgreSQL-only ORM guards for infrastructure-validation receipts."""

from __future__ import annotations

BROKER_MUTATION_VALIDATION_AUTHORITY_SQL = r"""
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
      <= CASE
          WHEN canonical_intent_json::jsonb #>>
               '{request,infrastructure_validation,test_plan,schema_version}' =
               'torghut.infrastructure-validation-lifecycle-plan.v1'
          THEN 5 ELSE 1
         END
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
      > 0
  AND (canonical_intent_json::jsonb #>>
       '{request,infrastructure_validation,permit,max_loss_usd}')::numeric
      <= CASE
          WHEN canonical_intent_json::jsonb #>>
               '{request,infrastructure_validation,test_plan,schema_version}' =
               'torghut.infrastructure-validation-lifecycle-plan.v1'
          THEN 5 ELSE 1
         END
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
      '{request,infrastructure_validation,test_plan,schema_version}' IN (
      'torghut.infrastructure-validation-order-plan.v1',
      'torghut.infrastructure-validation-lifecycle-plan.v1')
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
  AND (
      canonical_intent_json::jsonb #>>
          '{request,infrastructure_validation,test_plan,schema_version}' <>
          'torghut.infrastructure-validation-lifecycle-plan.v1'
      OR COALESCE((
        ((canonical_intent_json::jsonb #>
          '{request,infrastructure_validation,test_plan}') - ARRAY[
            'schema_version', 'venue', 'asset_class', 'symbol', 'side', 'qty',
            'order_type', 'time_in_force', 'limit_price', 'stop_price',
            'resting_close_limit_price', 'replacement_close_limit_price',
            'partial_close_qty'
          ]) = '{}'::jsonb
        AND (canonical_intent_json::jsonb #>>
             '{request,infrastructure_validation,test_plan,partial_close_qty}')::numeric
            > 0
        AND (canonical_intent_json::jsonb #>>
             '{request,infrastructure_validation,test_plan,partial_close_qty}')::numeric
            < (canonical_intent_json::jsonb #>>
               '{request,infrastructure_validation,test_plan,qty}')::numeric
        AND (canonical_intent_json::jsonb #>>
             '{request,infrastructure_validation,test_plan,resting_close_limit_price}')::numeric
            > (canonical_intent_json::jsonb #>>
               '{request,infrastructure_validation,test_plan,limit_price}')::numeric
        AND (canonical_intent_json::jsonb #>>
             '{request,infrastructure_validation,test_plan,replacement_close_limit_price}')::numeric
            > (canonical_intent_json::jsonb #>>
               '{request,infrastructure_validation,test_plan,resting_close_limit_price}')::numeric
      ), FALSE)
  )
), FALSE)
"""

BROKER_MUTATION_VALIDATION_PERMIT_ID_SQL = (
    "(canonical_intent_json::jsonb #>> "
    "'{request,infrastructure_validation,permit,permit_id}')"
)

BROKER_MUTATION_VALIDATION_LINEAGE_SQL = r"""
(canonical_intent_json::jsonb #>
  '{request,infrastructure_validation_lineage}') IS NULL
OR COALESCE((
  broker_route = 'alpaca'
  AND submission_claim_id IS NULL
  AND operation IN ('submit_order', 'replace_order', 'cancel_order',
                    'close_position', 'close_all_positions')
  AND (operation <> 'submit_order' OR (risk_class = 'risk_reducing'
       AND purpose = 'closeout' AND target_kind = 'order'))
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

__all__ = [
    "BROKER_MUTATION_VALIDATION_AUTHORITY_SQL",
    "BROKER_MUTATION_VALIDATION_LINEAGE_SQL",
    "BROKER_MUTATION_VALIDATION_PERMIT_ID_SQL",
]

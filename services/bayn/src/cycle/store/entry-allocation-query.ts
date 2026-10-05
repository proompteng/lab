import type { PgClient } from '@effect/sql-pg'

/** Composed into the single status read so a new session cannot change the attribution midway through the read. */
export const lastEntryAllocationQuery = (sql: PgClient.PgClient) => sql`
  SELECT jsonb_build_object(
    'noTrade', coalesce(decision.document #>> '{targetPlan,status}' = 'NO_TRADE', false),
    'positiveTarget', EXISTS (
      SELECT 1 FROM jsonb_each_text(coalesce(decision.document #> '{plannerInput,targetWeights}', '{}'::jsonb))
      AS weight(symbol, value) WHERE weight.value::numeric > 0
    ),
    'flat', NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(decision.document #> '{plannerInput,brokerState,positions}') AS position
      WHERE (position ->> 'quantityMicros')::numeric <> 0
    ),
    'allocationCapitalMicros', decision.document #>> '{plannerInput,allocationCapitalMicros}',
    'maximumTurnoverMicros', decision.document #>> '{riskPolicy,maxDailyTradedNotionalMicros}',
    'priorRecordedTurnoverMicros', (
      SELECT coalesce(sum(transaction.notional_micros), 0)::text
      FROM accounting_transactions AS transaction
      WHERE transaction.account_id = cycle.account_id
        AND transaction.occurred_at <= decision.created_at
        AND transaction.occurred_at >= (cycle.execution_session_date::timestamp AT TIME ZONE 'America/New_York')
        AND transaction.occurred_at < ((cycle.execution_session_date + 1)::timestamp AT TIME ZONE 'America/New_York')
        AND EXISTS (
          SELECT 1 FROM accounting_receipts AS receipt
          WHERE receipt.intent_id = transaction.intent_id
            AND receipt.broker_event_id = transaction.broker_event_id
            AND receipt.recorded_at <= decision.created_at
        )
    )
  ) AS facts
  FROM last_cycle AS cycle
  JOIN autonomous_cycle_shadow_decisions AS decision ON decision.cycle_id = cycle.cycle_id
  WHERE cycle.account_id = (SELECT account_id FROM selected_account)
    AND cycle.state = 'NO_TRADE'
    AND decision.document #>> '{bindings,accountId}' = cycle.account_id
    AND jsonb_typeof(decision.document #> '{plannerInput,brokerState,positions}') = 'array'
`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted, Schema } from 'effect'

import { baynTestPostgresUrl } from '../../test-environment.test-support'
import {
  describeEntryAllocation,
  EntryAllocationFactsSchema,
  EntryAllocationReason,
} from '../entry-allocation-observation'
import { lastEntryAllocationQuery } from './entry-allocation-query'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe

describePostgres('retained entry allocation SQL attribution', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  beforeAll(() => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing disposable PostgreSQL endpoint')
    const url = new URL(baynTestPostgresUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Allocation attribution tests require an isolated local _test database')
    runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }))
  })
  afterAll(async () => runtime?.dispose())

  test('counts only prior account-session receipts and keeps the exhausted reason separate from stored plan identity', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
              cycle_id text, created_at timestamptz, document jsonb
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE accounting_transactions (
              account_id text, intent_id text, broker_event_id text, occurred_at timestamptz, notional_micros numeric
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE accounting_receipts (
              intent_id text, broker_event_id text, recorded_at timestamptz
            ) ON COMMIT DROP`
            const document = {
              bindings: { accountId: 'fixture-account' },
              targetPlan: { status: 'NO_TRADE', reason: 'TARGETS_SATISFIED' },
              plannerInput: {
                allocationCapitalMicros: '0',
                targetWeights: { EXAMPLE: 0.2 },
                brokerState: { positions: [] },
              },
              riskPolicy: { maxDailyTradedNotionalMicros: '1000000' },
            }
            yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
              'fixture-cycle', '2026-01-05T16:00Z', ${sql.json(document)}
            )`
            yield* sql`INSERT INTO accounting_transactions VALUES
              ('fixture-account', 'buy', 'one', '2026-01-05T14:00Z', 500000),
              ('fixture-account', 'sell', 'two', '2026-01-05T15:00Z', 500000),
              ('other-account', 'other', 'three', '2026-01-05T15:00Z', 9000000),
              ('fixture-account', 'prior', 'four', '2026-01-02T15:00Z', 9000000),
              ('fixture-account', 'later', 'five', '2026-01-05T17:00Z', 9000000),
              ('fixture-account', 'late-receipt', 'six', '2026-01-05T15:00Z', 9000000),
              ('fixture-account', 'prior-ny-date', 'seven', '2026-01-05T01:00Z', 9000000)`
            yield* sql`INSERT INTO accounting_receipts VALUES
              ('buy', 'one', '2026-01-05T14:00:01Z'), ('sell', 'two', '2026-01-05T15:00:01Z'),
              ('buy', 'one', '2026-01-05T14:00:02Z'),
              ('other', 'three', '2026-01-05T15:00:01Z'), ('prior', 'four', '2026-01-02T15:00:01Z'),
              ('later', 'five', '2026-01-05T17:00:01Z'), ('late-receipt', 'six', '2026-01-05T17:00:01Z'),
              ('prior-ny-date', 'seven', '2026-01-05T01:00:01Z')`
            const read = (account: string) => sql<{ facts: unknown }>`
              WITH last_cycle AS (
                SELECT 'fixture-cycle' AS cycle_id, 'fixture-account' AS account_id,
                  '2026-01-05'::date AS execution_session_date, 'NO_TRADE' AS state
              ), selected_account AS (SELECT ${account}::text AS account_id)
              ${lastEntryAllocationQuery(sql)}
            `
            const [row] = yield* read('fixture-account')
            const facts = yield* Schema.decodeUnknownEffect(EntryAllocationFactsSchema)(row?.facts)
            expect(facts.priorRecordedTurnoverMicros).toBe('1000000')
            expect(describeEntryAllocation(facts)).toBe(EntryAllocationReason.TurnoverBudgetExhausted)
            expect(yield* read('other-account')).toEqual([])
            yield* sql`DELETE FROM accounting_receipts WHERE intent_id = 'sell'`
            const [withoutReceipt] = yield* read('fixture-account')
            const incomplete = yield* Schema.decodeUnknownEffect(EntryAllocationFactsSchema)(withoutReceipt?.facts)
            expect(describeEntryAllocation(incomplete)).toBe(EntryAllocationReason.ZeroAllocation)
            const retained = yield* sql<{ reason: string }>`SELECT document #>> '{targetPlan,reason}' AS reason
              FROM autonomous_cycle_shadow_decisions`
            expect(retained[0]?.reason).toBe('TARGETS_SATISFIED')
          }),
        )
      }),
    )
  })
})

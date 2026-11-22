import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { SignedMicrosSchema } from '../execution/contracts'
import { UtcInstantSchema, strictParseOptions } from '../schemas'
import { ReconciliationStoreError } from './reconciliation'

const OpeningCash = Schema.Tuple([Schema.Struct({ cash_micros: SignedMicrosSchema, observed_at: UtcInstantSchema })])
export const readOpeningCash = (sql: PgClient.PgClient, accountId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT snapshot.cash_micros::text AS cash_micros,
    to_char(event.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
    FROM account_snapshots AS snapshot JOIN broker_events AS event ON event.event_id=snapshot.event_id
    WHERE snapshot.account_id=${accountId} AND event.account_id=${accountId} AND event.event_kind='ACCOUNT'
    ORDER BY event.source_sequence LIMIT 1`
    const [opening] = yield* Schema.decodeUnknownEffect(OpeningCash, strictParseOptions)(rows)
    return opening
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ReconciliationStoreError({
          operation: 'reconcile',
          failure: 'query',
          message: 'Opening cash baseline is unavailable or invalid',
          cause,
        }),
    ),
  )

export const retainAccountCashReporting = (
  sql: PgClient.PgClient,
  snapshot: Pick<
    import('./reconciliation').BrokerSnapshot,
    'account' | 'accountEventId' | 'cashReportingQuantumMicros'
  >,
) =>
  Effect.gen(function* () {
    const account = snapshot.account
    const observation = sql`
      SELECT a.event_id FROM account_snapshots a JOIN broker_events e USING(event_id,account_id)
      WHERE a.event_id=${snapshot.accountEventId} AND a.account_id=${account.accountId}
        AND a.schema_version=${account.schemaVersion} AND a.status=${account.status} AND a.currency=${account.currency}
        AND a.cash_micros=${account.cashMicros}::numeric AND a.equity_micros=${account.equityMicros}::numeric
        AND a.buying_power_micros=${account.buyingPowerMicros}::numeric
        AND a.crypto_fee_tier IS NOT DISTINCT FROM ${account.cryptoFeeTier}::integer
        AND e.observed_at=${account.observedAt}::timestamptz`
    yield* sql`INSERT INTO account_cash_reporting(account_event_id,quantum_micros)
    SELECT observed.event_id,${snapshot.cashReportingQuantumMicros}::integer FROM (${observation}) observed
    ON CONFLICT(account_event_id) DO NOTHING`
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ quantum_micros: Schema.NullOr(Schema.Int) })]),
      strictParseOptions,
    )(
      yield* sql`SELECT (SELECT r.quantum_micros FROM account_cash_reporting r
      JOIN (${observation}) observed ON observed.event_id=r.account_event_id) AS quantum_micros`,
    )
    if (String(row.quantum_micros) !== snapshot.cashReportingQuantumMicros)
      return yield* new ReconciliationStoreError({
        operation: 'reconcile',
        failure: 'invariant',
        message: 'Cash reporting precision differs from its retained account observation',
      })
  })

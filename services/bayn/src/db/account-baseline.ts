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
    yield* sql`INSERT INTO account_cash_reporting(account_event_id,quantum_micros)
    SELECT a.event_id,${snapshot.cashReportingQuantumMicros}::integer FROM account_snapshots a JOIN broker_events e USING(event_id)
    WHERE a.event_id=${snapshot.accountEventId} AND a.account_id=${snapshot.account.accountId}
      AND a.cash_micros=${snapshot.account.cashMicros}::numeric AND e.observed_at=${snapshot.account.observedAt}::timestamptz
    ON CONFLICT(account_event_id) DO NOTHING`
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ quantum_micros: Schema.Int })]),
      strictParseOptions,
    )(
      yield* sql`SELECT r.quantum_micros FROM account_cash_reporting r
      JOIN account_snapshots a ON a.event_id=r.account_event_id JOIN broker_events e ON e.event_id=a.event_id
      WHERE r.account_event_id=${snapshot.accountEventId} AND a.account_id=${snapshot.account.accountId}
        AND a.cash_micros=${snapshot.account.cashMicros}::numeric AND e.observed_at=${snapshot.account.observedAt}::timestamptz`,
    )
    if (String(row.quantum_micros) !== snapshot.cashReportingQuantumMicros)
      return yield* new ReconciliationStoreError({
        operation: 'reconcile',
        failure: 'invariant',
        message: 'Cash reporting precision differs from its retained account observation',
      })
  })

import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import type { ValuationInput } from '../../broker/observations'
import type { Valuation } from '../../paper'
import type { PaperStoreError } from './contract'
import { VALUATION_SNAPSHOT_MAX_SKEW_MS } from './contract'
import { decideStoredValuation, planValuation, requireValuationPositionSnapshot } from './decisions'
import { liftPaperDecision, runPaperOperation } from './errors'
import {
  decodeAccountBaseline,
  decodeAccountId,
  decodeAccountRows,
  decodePositionRows,
  decodePositionSnapshotRows,
  decodeValuation,
  decodeValuationInput,
  decodeValuationRows,
  type ValuationRow,
} from './rows'

const valuationFromRow = (row: ValuationRow): Valuation => ({
  schemaVersion: row.schema_version,
  valuationId: row.valuation_id,
  accountId: row.account_id,
  sourceHash: row.source_hash,
  cashMicros: row.cash_micros,
  longMarketValueMicros: row.long_market_value_micros,
  shortMarketValueMicros: row.short_market_value_micros,
  equityMicros: row.equity_micros,
  asOf: row.as_of.toISOString(),
})

export interface ValuationInterpreter {
  readonly value: (input: ValuationInput) => Effect.Effect<Valuation, PaperStoreError>
  readonly hasAccountBaseline: (accountId: string) => Effect.Effect<boolean, PaperStoreError>
}

export const makeValuationInterpreter = (sql: PgClient.PgClient): ValuationInterpreter => {
  const value = (input: ValuationInput): Effect.Effect<Valuation, PaperStoreError> =>
    runPaperOperation(
      'valuation',
      decodeValuationInput(input).pipe(
        Effect.flatMap((decoded) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const [accountSnapshot] = yield* sql<Record<string, unknown>>`
                SELECT
                  snapshot.event_id, snapshot.account_id, snapshot.cash_micros::text AS cash_micros,
                  event.observed_at
                FROM account_snapshots AS snapshot
                JOIN broker_events AS event ON event.event_id = snapshot.event_id
                WHERE snapshot.event_id = ${decoded.accountEventId}
              `.pipe(Effect.flatMap(decodeAccountRows))
              const positionSnapshots = yield* sql<Record<string, unknown>>`
                SELECT
                  snapshot_id, schema_version, account_id, source_hash, observed_at,
                  position_count::integer AS position_count, content_hash
                FROM position_snapshots
                WHERE snapshot_id = ${decoded.positionSnapshotId}
              `.pipe(Effect.flatMap(decodePositionSnapshotRows))
              const positionSnapshot = yield* liftPaperDecision(
                'valuation',
                requireValuationPositionSnapshot(positionSnapshots),
              )
              const positionRows = yield* sql<Record<string, unknown>>`
                SELECT
                  position.event_id, position.account_id, position.symbol, event.source_event_id,
                  position.market_value_micros::text AS market_value_micros, event.observed_at
                FROM positions AS position
                JOIN broker_events AS event ON event.event_id = position.event_id
                WHERE position.snapshot_id = ${positionSnapshot.snapshot_id}
                ORDER BY position.event_id
              `.pipe(Effect.flatMap(decodePositionRows))
              const planned = yield* liftPaperDecision(
                'valuation',
                planValuation(decoded, accountSnapshot, positionSnapshot, positionRows, VALUATION_SNAPSHOT_MAX_SKEW_MS),
              )
              const candidate = yield* decodeValuation(planned)
              yield* sql`
                INSERT INTO valuations (
                  valuation_id, schema_version, account_id, source_hash, cash_micros,
                  long_market_value_micros, short_market_value_micros, equity_micros, as_of
                ) VALUES (
                  ${candidate.valuationId}, ${candidate.schemaVersion}, ${candidate.accountId},
                  ${candidate.sourceHash}, ${candidate.cashMicros}, ${candidate.longMarketValueMicros},
                  ${candidate.shortMarketValueMicros}, ${candidate.equityMicros}, ${candidate.asOf}
                )
                ON CONFLICT (account_id, source_hash) DO NOTHING
              `
              const rows = yield* sql<Record<string, unknown>>`
                SELECT
                  schema_version, valuation_id, account_id, source_hash,
                  cash_micros::text AS cash_micros,
                  long_market_value_micros::text AS long_market_value_micros,
                  short_market_value_micros::text AS short_market_value_micros,
                  equity_micros::text AS equity_micros, as_of
                FROM valuations
                WHERE account_id = ${candidate.accountId} AND source_hash = ${candidate.sourceHash}
              `.pipe(Effect.flatMap(decodeValuationRows))
              const stored = yield* Effect.all(rows.map((row) => decodeValuation(valuationFromRow(row))))
              return yield* liftPaperDecision('valuation', decideStoredValuation(stored, candidate))
            }),
          ),
        ),
      ),
    )

  const hasAccountBaseline = (accountId: string): Effect.Effect<boolean, PaperStoreError> =>
    runPaperOperation(
      'baseline',
      decodeAccountId(accountId).pipe(
        Effect.flatMap((decodedAccountId) =>
          sql<Record<string, unknown>>`
            SELECT EXISTS (
              SELECT 1 FROM account_snapshots WHERE account_id = ${decodedAccountId}
            ) AS exists
          `.pipe(Effect.flatMap(decodeAccountBaseline)),
        ),
        Effect.map((rows) => rows[0].exists),
      ),
    )

  return { value, hasAccountBaseline }
}

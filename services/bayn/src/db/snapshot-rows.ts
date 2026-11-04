import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import type { Statement } from 'effect/sql'

import { DatabaseError } from './database-error'

/** The caller owns rollback cleanup. Large JSON records retain one-row buffering unless a caller opts into batching. */
export const openSnapshotRows = (sql: Statement.Constructor, query: Statement.Fragment, rowsPerFetch = 1) =>
  Effect.gen(function* () {
    if (!Number.isInteger(rowsPerFetch) || rowsPerFetch < 1 || rowsPerFetch > 64)
      return yield* new DatabaseError({
        failure: 'invariant',
        operation: 'read-snapshot',
        message: 'Snapshot fetch size must be an integer between 1 and 64',
      })
    const cursor = sql(`bayn_snapshot_${yield* Effect.sync(randomUUID)}`)
    yield* sql`DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR ${query}`
    // Anchor the opening cut before returning, without prefetching more source documents.
    const first = yield* sql`FETCH NEXT FROM ${cursor}`
    const fetch = sql`FETCH FORWARD ${sql.literal(String(rowsPerFetch))} FROM ${cursor}`
    return <E, R>(consume: (row: unknown) => Effect.Effect<void, E, R>) =>
      Effect.gen(function* () {
        let rows = first
        let fetchLimit = 1
        while (true) {
          if (rows.length === 0) break
          if (rows.length > fetchLimit)
            return yield* new DatabaseError({
              failure: 'invariant',
              operation: 'read-snapshot',
              message: 'Snapshot cursor exceeded its fetch size',
            })
          for (const row of rows) yield* consume(row)
          rows = yield* fetch
          fetchLimit = rowsPerFetch
        }
        yield* sql`CLOSE ${cursor}`
      })
  })

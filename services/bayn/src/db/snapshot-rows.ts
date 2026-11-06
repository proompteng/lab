import type { PgClient } from '@effect/sql-pg'
import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import type { Statement } from 'effect/sql'

import { DatabaseError } from './database-error'

/** The caller's transaction owns rollback cleanup. One fetch bounds buffering of large JSON records. */
export const openSnapshotRows = (sql: PgClient.PgClient, query: Statement.Fragment) =>
  Effect.gen(function* () {
    const cursor = sql(`bayn_snapshot_${yield* Effect.sync(randomUUID)}`)
    yield* sql`DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR ${query}`
    const first = yield* sql`FETCH NEXT FROM ${cursor}`
    return <E, R>(consume: (row: unknown) => Effect.Effect<void, E, R>) =>
      Effect.gen(function* () {
        let rows = first
        while (true) {
          if (rows.length === 0) break
          if (rows.length !== 1)
            return yield* new DatabaseError({
              failure: 'invariant',
              operation: 'read-snapshot',
              message: 'Snapshot cursor returned more than one record',
            })
          yield* consume(rows[0])
          rows = yield* sql`FETCH NEXT FROM ${cursor}`
        }
        yield* sql`CLOSE ${cursor}`
      })
  })

import type { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'
import type { WriterFenceError, WriterFenceService } from '../../execution/writer-fence'

/** Read-only diagnostics own their snapshot. Persistence inherits the execution writer transaction. */
export const forwardPerformanceSnapshot = (sql: PgClient.PgClient, writerFence?: WriterFenceService) => ({
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError | WriterFenceError, R> =>
    writerFence === undefined
      ? sql.withTransaction(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(Effect.andThen(effect)),
        )
      : writerFence.transaction(effect),
})

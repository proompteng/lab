import { PgClient } from '@effect/sql-pg'
import { Effect, Layer } from 'effect'

import type { RuntimeConfig } from '../config'
import { CapitalGrantLifecycleStore } from '../db/execution-store'
import { makeAuthorityPostgres } from '../db/execution-store/authority-shared'
import { makeCapitalGrantInterpreter } from '../db/execution-store/capital-grant'
import { WriterFence } from '../execution/writer-fence'

export const ExecutionPrepareStoreLive = (config: RuntimeConfig) =>
  Layer.effect(
    CapitalGrantLifecycleStore,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const writerFence = yield* WriterFence
      return makeCapitalGrantInterpreter(sql, makeAuthorityPostgres(sql), config, writerFence)
    }),
  )

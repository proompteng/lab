import { PgClient } from '@effect/sql-pg'
import { Effect, Layer } from 'effect'

import type { RuntimeConfig } from '../config'
import { CapitalGrantLifecycleStore } from '../db/execution-store'
import { makeAuthorityPostgres } from '../db/execution-store/authority-shared'
import { makeCapitalGrantInterpreter } from '../db/execution-store/capital-grant'

export const ExecutionPrepareStoreLive = (config: RuntimeConfig) =>
  Layer.effect(
    CapitalGrantLifecycleStore,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return makeCapitalGrantInterpreter(sql, makeAuthorityPostgres(sql), config)
    }),
  )

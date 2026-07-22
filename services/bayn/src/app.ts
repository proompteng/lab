import { Effect, Layer, Ref } from 'effect'

import type { RuntimeConfig } from './config'
import { EvidenceStore } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { monitor } from './health'
import { makeHttpLayer } from './http'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { initialState } from './runtime-state'
import { initialize } from './startup'
import type { Strategy } from './strategy'

export const run = (
  config: RuntimeConfig,
  strategy: Strategy,
  reconciliation: Effect.Effect<void> = Effect.void,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore> =>
  Effect.scoped(
    Effect.gen(function* () {
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make(initialState())
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore.read),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state, strategy)
      yield* monitor(config, state).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* reconciliation
      return yield* Effect.never
    }),
  )

export { monitor, probe } from './health'
export { initialize } from './startup'

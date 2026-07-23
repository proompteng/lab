import { Effect, Layer, Ref } from 'effect'

import type { RuntimeConfig } from './config'
import { CycleObservability } from './db/cycle-observability'
import { EvidenceStore } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { monitor, type BrokerProbe } from './health'
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
  broker?: BrokerProbe,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore | CycleObservability> =>
  Effect.scoped(
    Effect.gen(function* () {
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make(initialState(broker))
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore.read),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state, strategy)
      yield* monitor(config, state, broker).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* reconciliation
      return yield* Effect.never
    }),
  )

export { monitor, probe } from './health'
export { initialize } from './startup'

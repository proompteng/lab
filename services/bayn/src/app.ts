import { Effect, Layer, Ref } from 'effect'

import { BrokerRead } from './broker/alpaca'
import type { RuntimeConfig } from './config'
import { startAutonomousCycleLoop, type CycleCandidate } from './cycle-runner'
import { CycleObservability } from './db/cycle-observability'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import { EvidenceStore } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { monitor, type BrokerProbe, type CycleRunnerFiber } from './health'
import { makeHttpLayer } from './http'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { initialState } from './runtime-state'
import { initialize } from './startup'
import type { Strategy } from './strategy'

export interface AutonomousCycleComposition {
  readonly candidate: Effect.Effect<CycleCandidate | undefined, OperationalError>
  readonly store: CycleStoreShape
}

export const run = (
  config: RuntimeConfig,
  strategy: Strategy,
  reconciliation: Effect.Effect<void> = Effect.void,
  broker?: BrokerProbe,
  autonomousCycle?: AutonomousCycleComposition,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore | CycleObservability> =>
  Effect.scoped(
    Effect.gen(function* () {
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make(initialState(broker, config.autonomousCycle.enabled))
      let cycleRunner: CycleRunnerFiber | undefined
      if (config.autonomousCycle.enabled) {
        if (broker === undefined || autonomousCycle === undefined) {
          return yield* Effect.fail(
            operationalError(
              'config',
              'autonomous-cycle',
              'enabled autonomous cycle composition requires BrokerRead, CycleStore, and a verified candidate source',
            ),
          )
        }
        cycleRunner = yield* startAutonomousCycleLoop({
          candidate: autonomousCycle.candidate,
          pollIntervalMs: config.autonomousCycle.pollIntervalMs,
        }).pipe(
          Effect.provideService(BrokerRead, broker.read),
          Effect.provideService(CycleStore, autonomousCycle.store),
          Effect.mapError((cause) =>
            operationalError('config', 'autonomous-cycle', 'autonomous cycle runner failed to start', cause),
          ),
        )
      }
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore.read),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state, strategy)
      yield* monitor(config, state, broker, cycleRunner).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* reconciliation
      return yield* Effect.never
    }),
  )

export { monitor, probe } from './health'
export { initialize } from './startup'

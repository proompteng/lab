import { Clock, Effect, Fiber, Layer, Ref } from 'effect'

import type { RuntimeConfig } from './config'
import { makeStrategyProtocolHash } from './contracts'
import { CycleObservability } from './db/cycle-observability'
import { EvidenceStore } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { monitor, type BrokerProbe } from './health'
import { makeHttpLayer } from './http'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { initialState, type AutonomousCyclePassObservation, type RuntimeState } from './runtime-state'
import { initialize } from './startup'
import type { Strategy } from './strategy'

export type RecordAutonomousCyclePass = (observation: AutonomousCyclePassObservation) => Effect.Effect<void>

export interface AutonomousCycleStartupInput {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly recordPass: RecordAutonomousCyclePass
}

export type AutonomousCycleLoop = Effect.Effect<void>

export type AutonomousCycleStartup<R = never> = (
  input: AutonomousCycleStartupInput,
) => Effect.Effect<AutonomousCycleLoop, OperationalError, R>

const cyclePassError = (observation: Extract<AutonomousCyclePassObservation, { readonly result: 'FAILURE' }>): string =>
  `cycleRunner: ${observation.operation}/${observation.failure}: ${observation.message}`

const cyclePassDependencyError = (
  observation: Extract<AutonomousCyclePassObservation, { readonly result: 'FAILURE' }>,
): string => `${observation.operation}/${observation.failure}: ${observation.message}`

const recordAutonomousCyclePass = (
  state: Ref.Ref<RuntimeState>,
  observation: AutonomousCyclePassObservation,
): Effect.Effect<void> =>
  Ref.update(state, (current): RuntimeState => {
    const dependencyError = observation.result === 'FAILURE' ? cyclePassDependencyError(observation) : null
    const next: RuntimeState = {
      ...current,
      health: {
        ...current.health,
        dependencies: {
          ...current.health.dependencies,
          cycleRunner: {
            status: observation.result === 'FAILURE' ? 'UNAVAILABLE' : 'AVAILABLE',
            checkedAt: observation.observedAt,
            error: dependencyError,
          },
        },
      },
      autonomousCycleLoop: {
        ...current.autonomousCycleLoop,
        lastPass: observation,
      },
    }
    if (observation.result !== 'FAILURE' || current.evidence === null) return next
    return {
      ...next,
      status: 'DEGRADED',
      error: cyclePassError(observation),
    }
  })

export const run = <R = never>(
  config: RuntimeConfig,
  strategy: Strategy,
  reconciliation: Effect.Effect<void> = Effect.void,
  broker?: BrokerProbe,
  autonomousCycleStartup?: AutonomousCycleStartup<R>,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore | CycleObservability | R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make(initialState(broker, autonomousCycleStartup !== undefined))
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore.read),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state, strategy)
      let autonomousCycleFiber: Fiber.Fiber<void, never> | undefined
      if (autonomousCycleStartup !== undefined) {
        const initialized = yield* Ref.get(state)
        if (initialized.evidence !== null) {
          const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* Ref.update(state, (current) => ({
            ...current,
            autonomousCycleLoop: { ...current.autonomousCycleLoop, startedAt },
          }))
          const autonomousCycleLoop = yield* autonomousCycleStartup({
            qualificationRunId: initialized.evidence.evaluation.runId,
            strategyProtocolHash: makeStrategyProtocolHash(strategy.provenance.strategy),
            recordPass: (observation) => recordAutonomousCyclePass(state, observation),
          })
          autonomousCycleFiber = yield* autonomousCycleLoop.pipe(Effect.forkScoped({ startImmediately: true }))
        }
      }
      yield* monitor(config, state, broker, autonomousCycleFiber).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* reconciliation
      return yield* Effect.never
    }),
  )

export { monitor, probe } from './health'
export { initialize } from './startup'

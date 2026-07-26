import { Clock, Effect, Fiber, Layer, Option, pipe, Ref, Scope } from 'effect'

import type { LoadedRuntimeConfig, RuntimeConfig } from './config'
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
import { utcInstantFromEpochMillis } from './time'

export type RecordAutonomousCyclePass = (observation: AutonomousCyclePassObservation) => Effect.Effect<void>

export type AutonomousCycleStartupInput = {
  readonly qualificationRunId: string
  readonly recordPass: RecordAutonomousCyclePass
}

export type AutonomousCycleLoop = Effect.Effect<void>

export type AutonomousCycleStartup<R = never> = (
  input: AutonomousCycleStartupInput,
) => Effect.Effect<AutonomousCycleLoop, OperationalError, R>

export type BrokerlessApplicationConfig = Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'BrokerlessService' }>

export type AutonomousObserveApplicationConfig = Extract<
  LoadedRuntimeConfig,
  { readonly runtimeMode: 'AutonomousObserveService' }
>

type AutonomousObserveRuntime<R> = {
  readonly broker: BrokerProbe
  readonly startCycle: AutonomousCycleStartup<R>
}

type ApplicationRuntime<R> = Option.Option<AutonomousObserveRuntime<R>>

const cyclePassError = (observation: Extract<AutonomousCyclePassObservation, { readonly result: 'FAILURE' }>): string =>
  `cycleRunner: ${observation.operation}/${observation.failure}: ${observation.message}`

const cyclePassDependencyError = (
  observation: Extract<AutonomousCyclePassObservation, { readonly result: 'FAILURE' }>,
): string => `${observation.operation}/${observation.failure}: ${observation.message}`

const recordAutonomousCyclePass = (
  state: Ref.Ref<RuntimeState>,
  observation: AutonomousCyclePassObservation,
): Effect.Effect<void> => Ref.update(state, (current) => applyAutonomousCyclePass(current, observation))

const applyAutonomousCyclePass = (current: RuntimeState, observation: AutonomousCyclePassObservation): RuntimeState => {
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
  return observation.result === 'FAILURE' && current.evidence !== null
    ? { ...next, status: 'DEGRADED', error: cyclePassError(observation) }
    : next
}

const brokerProbe = <R>(runtime: ApplicationRuntime<R>): BrokerProbe | undefined =>
  pipe(
    runtime,
    Option.map(({ broker }) => broker),
    Option.getOrUndefined,
  )

const initialRuntimeState = <R>(runtime: ApplicationRuntime<R>): RuntimeState =>
  pipe(
    runtime,
    Option.match({
      onNone: initialState,
      onSome: ({ broker }) => initialState(broker, true),
    }),
  )

const currentUtcInstant = Clock.currentTimeMillis.pipe(
  Effect.flatMap((millis) =>
    Effect.try({
      try: () => utcInstantFromEpochMillis(millis),
      catch: (cause) =>
        operationalError(
          'strategy',
          'cycle-loop-clock',
          'runtime clock did not produce a canonical UTC instant',
          cause,
        ),
    }),
  ),
)

const markAutonomousCycleStarted = (state: Ref.Ref<RuntimeState>, startedAt: string): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    autonomousCycleLoop: { ...current.autonomousCycleLoop, startedAt },
  }))

const forkAutonomousCycle = <R>(
  runtime: AutonomousObserveRuntime<R>,
  state: Ref.Ref<RuntimeState>,
  qualificationRunId: string,
): Effect.Effect<Fiber.Fiber<void, never>, OperationalError, R | Scope.Scope> =>
  pipe(
    currentUtcInstant,
    Effect.tap((startedAt) => markAutonomousCycleStarted(state, startedAt)),
    Effect.flatMap(() =>
      runtime.startCycle({
        qualificationRunId,
        recordPass: (observation) => recordAutonomousCyclePass(state, observation),
      }),
    ),
    Effect.flatMap(Effect.forkScoped({ startImmediately: true })),
  )

const startAutonomousCycle = <R>(
  runtime: ApplicationRuntime<R>,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<Fiber.Fiber<void, never> | undefined, OperationalError, R | Scope.Scope> =>
  pipe(
    runtime,
    Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: (configured) =>
        pipe(
          Ref.get(state),
          Effect.flatMap((initialized) =>
            initialized.evidence === null
              ? Effect.succeed(undefined)
              : forkAutonomousCycle(configured, state, initialized.evidence.evaluation.runId),
          ),
        ),
    }),
  )

const startHttpServer = (
  config: RuntimeConfig,
  strategy: Strategy,
  state: Ref.Ref<RuntimeState>,
  evidenceStore: EvidenceStore['Service'],
) =>
  pipe(
    Layer.build(makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore.read)),
    Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)),
  )

const runApplication = <R>(
  config: RuntimeConfig,
  strategy: Strategy,
  runtime: ApplicationRuntime<R>,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore | CycleObservability | R> =>
  pipe(
    Effect.Do,
    Effect.bind('evidenceStore', () => EvidenceStore),
    Effect.bind('state', () => Ref.make(initialRuntimeState(runtime))),
    Effect.tap(({ evidenceStore, state }) => startHttpServer(config, strategy, state, evidenceStore)),
    Effect.tap(({ state }) => initialize(config, state, strategy)),
    Effect.bind('autonomousCycleFiber', ({ state }) => startAutonomousCycle(runtime, state)),
    Effect.tap(({ autonomousCycleFiber, state }) =>
      pipe(
        monitor(config, state, brokerProbe(runtime), autonomousCycleFiber),
        Effect.forkScoped({ startImmediately: true }),
      ),
    ),
    Effect.andThen(Effect.never),
    Effect.scoped,
  )

export const brokerlessApplication = (
  config: BrokerlessApplicationConfig,
  strategy: Strategy,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore | CycleObservability> =>
  runApplication(config, strategy, Option.none())

export const autonomousObserveApplication = <R>(
  config: AutonomousObserveApplicationConfig,
  strategy: Strategy,
  broker: BrokerProbe,
  startCycle: AutonomousCycleStartup<R>,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore | CycleObservability | R> =>
  runApplication(config, strategy, Option.some({ broker, startCycle }))

export { monitor, probe } from './health'
export { initialize } from './startup'

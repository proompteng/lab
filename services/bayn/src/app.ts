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

export type AutonomousCycleLoop<R = never> = Effect.Effect<void, never, R>

export type AutonomousCycleStartup<StartupR = never, LoopR = StartupR> = (
  input: AutonomousCycleStartupInput,
) => Effect.Effect<AutonomousCycleLoop<LoopR>, OperationalError, StartupR>

export type BrokerlessApplicationConfig = Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'BrokerlessService' }>

export type AutonomousObserveApplicationConfig = Extract<
  LoadedRuntimeConfig,
  { readonly runtimeMode: 'AutonomousObserveService' }
>

type AutonomousObserveRuntime<StartupR, LoopR> = {
  readonly broker: BrokerProbe
  readonly startCycle: AutonomousCycleStartup<StartupR, LoopR>
}

type ApplicationRuntime<StartupR, LoopR> = Option.Option<AutonomousObserveRuntime<StartupR, LoopR>>

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

const brokerProbe = <StartupR, LoopR>(runtime: ApplicationRuntime<StartupR, LoopR>): BrokerProbe | undefined =>
  pipe(
    runtime,
    Option.map(({ broker }) => broker),
    Option.getOrUndefined,
  )

const initialRuntimeState = <StartupR, LoopR>(runtime: ApplicationRuntime<StartupR, LoopR>): RuntimeState =>
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

const forkAutonomousCycle = <StartupR, LoopR>(
  runtime: AutonomousObserveRuntime<StartupR, LoopR>,
  state: Ref.Ref<RuntimeState>,
  qualificationRunId: string,
): Effect.Effect<Fiber.Fiber<void, never>, OperationalError, StartupR | LoopR | Scope.Scope> =>
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

const startAutonomousCycle = <StartupR, LoopR>(
  runtime: ApplicationRuntime<StartupR, LoopR>,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<Fiber.Fiber<void, never> | undefined, OperationalError, StartupR | LoopR | Scope.Scope> =>
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

const runApplication = <StartupR, LoopR>(
  config: RuntimeConfig,
  strategy: Strategy,
  runtime: ApplicationRuntime<StartupR, LoopR>,
): Effect.Effect<
  never,
  OperationalError,
  MarketData | Journal | EvidenceStore | CycleObservability | StartupR | LoopR
> =>
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

export const autonomousObserveApplication = <StartupR, LoopR>(
  config: AutonomousObserveApplicationConfig,
  strategy: Strategy,
  broker: BrokerProbe,
  startCycle: AutonomousCycleStartup<StartupR, LoopR>,
): Effect.Effect<
  never,
  OperationalError,
  MarketData | Journal | EvidenceStore | CycleObservability | StartupR | LoopR
> => runApplication(config, strategy, Option.some({ broker, startCycle }))

export { monitor, probe } from './health'
export { initialize } from './startup'

import { Clock, Effect, Fiber, Match, pipe, Ref, Scope } from 'effect'
import { HttpServer } from 'effect/unstable/http'

import type { LoadedRuntimeConfig, RuntimeConfig } from './config'
import type { CausalProtocol } from './protocol'
import type { CycleObservabilityShape } from './db/cycle-observability'
import type { EvidenceStoreService } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { runHealthMonitor, type BrokerProbe, type HealthDependencies } from './health'
import { serveHttp } from './http'
import type { JournalService } from './ledger'
import type { MarketDataService } from './market-data'
import { initialState, type AutonomousCyclePassObservation, type RuntimeState } from './runtime-state'
import { runStartup, type StartupDependencies } from './startup'
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

export type ApplicationIdentity<C extends LoadedRuntimeConfig = LoadedRuntimeConfig> = {
  readonly config: C
  readonly protocol: CausalProtocol
  readonly parameterHash: string
  readonly strategy: Strategy
  readonly strategyProtocolHash: string
}

type ApplicationMode = LoadedRuntimeConfig['runtimeMode']

export type ApplicationPlanFor<M extends ApplicationMode> = ApplicationIdentity<
  Extract<LoadedRuntimeConfig, { readonly runtimeMode: M }>
> & {
  readonly _tag: M
}

export type ApplicationPlan = { readonly [M in ApplicationMode]: ApplicationPlanFor<M> }[ApplicationMode]

export const makeApplicationPlan = (identity: ApplicationIdentity): ApplicationPlan =>
  Match.value(identity.config).pipe(
    Match.when({ runtimeMode: 'BrokerlessService' }, (config) => ({
      ...identity,
      _tag: 'BrokerlessService' as const,
      config,
    })),
    Match.when({ runtimeMode: 'AutonomousObserveService' }, (config) => ({
      ...identity,
      _tag: 'AutonomousObserveService' as const,
      config,
    })),
    Match.when({ runtimeMode: 'PaperCandidateDiscovery' }, (config) => ({
      ...identity,
      _tag: 'PaperCandidateDiscovery' as const,
      config,
    })),
    Match.exhaustive,
  )

export interface ApplicationDependencies extends StartupDependencies, HealthDependencies {
  readonly marketData: MarketDataService
  readonly journal: JournalService
  readonly evidenceStore: EvidenceStoreService
  readonly cycleObservability: CycleObservabilityShape
}

export type ApplicationRuntime<StartupR, LoopR> =
  | { readonly _tag: 'Brokerless' }
  | {
      readonly _tag: 'AutonomousObserve'
      readonly broker: BrokerProbe
      readonly startCycle: AutonomousCycleStartup<StartupR, LoopR>
    }

type AutonomousObserveRuntime<StartupR, LoopR> = Extract<
  ApplicationRuntime<StartupR, LoopR>,
  { readonly _tag: 'AutonomousObserve' }
>

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
  runtime._tag === 'AutonomousObserve' ? runtime.broker : undefined

const initialRuntimeState = <StartupR, LoopR>(runtime: ApplicationRuntime<StartupR, LoopR>): RuntimeState =>
  runtime._tag === 'AutonomousObserve' ? initialState(runtime.broker, true) : initialState()

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
  runtime._tag === 'Brokerless'
    ? Effect.succeed(undefined)
    : Ref.get(state).pipe(
        Effect.flatMap((initialized) =>
          initialized.evidence === null
            ? Effect.succeed(undefined)
            : forkAutonomousCycle(runtime, state, initialized.evidence.evaluation.runId),
        ),
      )

export const runApplication = <StartupR, LoopR>(
  config: RuntimeConfig,
  strategy: Strategy,
  dependencies: ApplicationDependencies,
  runtime: ApplicationRuntime<StartupR, LoopR>,
): Effect.Effect<never, OperationalError, HttpServer.HttpServer | StartupR | LoopR> =>
  pipe(
    Effect.Do,
    Effect.bind('state', () => Ref.make(initialRuntimeState(runtime))),
    Effect.tap(({ state }) =>
      serveHttp(config, state, strategy.provenance, config.build.verification, dependencies.evidenceStore.read),
    ),
    Effect.tap(({ state }) => runStartup(config, state, strategy, dependencies)),
    Effect.bind('autonomousCycleFiber', ({ state }) => startAutonomousCycle(runtime, state)),
    Effect.tap(({ autonomousCycleFiber, state }) =>
      pipe(
        runHealthMonitor(config, state, dependencies, brokerProbe(runtime), autonomousCycleFiber),
        Effect.forkScoped({ startImmediately: true }),
      ),
    ),
    Effect.andThen(Effect.never),
    Effect.scoped,
  )

import { Clock, Effect, Fiber, Match, pipe, Ref, Scope } from 'effect'
import { HttpServer } from 'effect/unstable/http'

import type { LoadedRuntimeConfig, RuntimeConfig } from './config'
import type { CausalProtocol } from './protocol'
import type { CycleObservabilityShape } from './cycle/store'
import type { EvidenceStoreService } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { runHealthMonitor, type BrokerProbe, type CycleObservationBinding, type HealthDependencies } from './health'
import { serveHttp } from './http'
import type { JournalService } from './ledger'
import type { MarketDataService } from './market-data'
import {
  initialState,
  type AutonomousCyclePassObservation,
  type BrokerConfiguration,
  type RuntimeState,
} from './runtime-state'
import { runStartup, type StartupDependencies } from './startup'
import type { StrategyRuntime } from './strategy'
import { utcInstantFromEpochMillis } from './time'
import type { ExecutionProgram } from './execution/runtime-program'
import { Pipeable } from './pipeable'

export type RecordAutonomousCyclePass = (observation: AutonomousCyclePassObservation) => Effect.Effect<void>

export type AutonomousCycleStartupInput = {
  readonly qualificationRunId: string
  readonly recordPass: RecordAutonomousCyclePass
}

export type AutonomousCycleLoop<R = never> = Effect.Effect<void, never, R>

export type AutonomousCycleStartup<StartupR = never, LoopR = StartupR> = (
  input: AutonomousCycleStartupInput,
) => Effect.Effect<AutonomousCycleLoop<LoopR>, OperationalError, StartupR>

/**
 * Builds one externally scheduled cycle driver without choosing its owner. The outer effect performs startup work;
 * the returned effect binds the driver to the runtime services that execute its advances.
 */
export type AutonomousCycleDriverStartup<Driver, StartupR = never, DriverR = never> = (
  input: AutonomousCycleStartupInput,
) => Effect.Effect<Effect.Effect<Driver, never, DriverR>, OperationalError, StartupR>

export type BrokerlessApplicationConfig = Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'BrokerlessService' }>

export type AutonomousApplicationConfig = Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>

export type ApplicationIdentity<C extends LoadedRuntimeConfig = LoadedRuntimeConfig> = {
  readonly config: C
  readonly protocol: CausalProtocol
  readonly parameterHash: string
  readonly strategy: StrategyRuntime
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
    Match.when({ runtimeMode: 'AutonomousService' }, (config) => ({
      ...identity,
      _tag: 'AutonomousService' as const,
      config,
    })),
    Match.when({ runtimeMode: 'ExecutionCandidateDiscovery' }, (config) => ({
      ...identity,
      _tag: 'ExecutionCandidateDiscovery' as const,
      config,
    })),
    Match.when({ runtimeMode: 'ExecutionPrepare' }, (config) => ({
      ...identity,
      _tag: 'ExecutionPrepare' as const,
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
      readonly _tag: 'AutonomousRead'
      readonly requiresQualificationEvidence?: boolean
      readonly broker?: BrokerProbe
      readonly brokerConfiguration?: BrokerConfiguration
      /** null explicitly suppresses cycles even when startup recovered historical qualification evidence. */
      readonly cycleBindingId?: string | null
      /** Overrides startup qualification evidence when health observes a separately bound research cycle. */
      readonly cycleObservationId?: string
      readonly startCycle: AutonomousCycleStartup<StartupR, LoopR>
      readonly resolveAfterStartup?: AutonomousRuntimeResolver<StartupR, LoopR>
    }
  | {
      readonly _tag: 'AutonomousMutation'
      readonly requiresQualificationEvidence?: boolean
      readonly broker: BrokerProbe
      readonly cycleBindingId?: string | null
      readonly cycleObservationId?: string
      readonly executionProgram: ExecutionProgram
      readonly startCycle: AutonomousCycleStartup<StartupR, LoopR>
    }

export type AutonomousRuntime<StartupR, LoopR> = Extract<
  ApplicationRuntime<StartupR, LoopR>,
  { readonly _tag: 'AutonomousRead' | 'AutonomousMutation' }
>

export type AutonomousRuntimeResolver<StartupR, LoopR> = (
  state: Ref.Ref<RuntimeState>,
) => Effect.Effect<AutonomousRuntime<StartupR, LoopR>, never, StartupR | LoopR | Scope.Scope>

const cyclePassError = (observation: Extract<AutonomousCyclePassObservation, { readonly result: 'FAILURE' }>): string =>
  `cycleRunner: ${observation.operation}/${observation.failure}: ${observation.message}`

const cyclePassDependencyError = (
  observation: Extract<AutonomousCyclePassObservation, { readonly result: 'FAILURE' }>,
): string => `${observation.operation}/${observation.failure}: ${observation.message}`

export const recordAutonomousCyclePass = (
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
  runtime._tag === 'Brokerless' ? undefined : runtime.broker

const qualificationEvidenceRequired = <StartupR, LoopR>(runtime: ApplicationRuntime<StartupR, LoopR>): boolean =>
  runtime._tag === 'Brokerless' || runtime.requiresQualificationEvidence !== false

const cycleObservationBinding = <StartupR, LoopR>(
  runtime: ApplicationRuntime<StartupR, LoopR>,
): CycleObservationBinding => {
  if (runtime._tag === 'Brokerless') return { _tag: 'FromEvidence' }
  const bindingId = runtime.cycleObservationId ?? runtime.cycleBindingId
  if (bindingId === null) return { _tag: 'Unavailable' }
  return bindingId === undefined ? { _tag: 'FromEvidence' } : { _tag: 'Exact', bindingId }
}

const initialRuntimeState = <StartupR, LoopR>(runtime: ApplicationRuntime<StartupR, LoopR>): RuntimeState =>
  runtime._tag === 'Brokerless'
    ? initialState({})
    : initialState({
        qualificationEvidenceRequired: qualificationEvidenceRequired(runtime),
        broker: runtime._tag === 'AutonomousRead' ? (runtime.broker ?? runtime.brokerConfiguration) : runtime.broker,
        autonomousCycleLoopConfigured: true,
        autonomousCycleLoopOwner: 'Restate',
      })

const resolveRuntimeAfterStartup = <StartupR, LoopR>(
  runtime: ApplicationRuntime<StartupR, LoopR>,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<
  AutonomousRuntime<StartupR, LoopR> | ApplicationRuntime<StartupR, LoopR>,
  never,
  StartupR | LoopR | Scope.Scope
> =>
  runtime._tag === 'AutonomousRead' && runtime.resolveAfterStartup !== undefined
    ? runtime.resolveAfterStartup(state)
    : Effect.succeed(runtime)

export interface PreparedAutonomousApplication<StartupR, LoopR> {
  readonly cycleFiber: Fiber.Fiber<void, never>
  readonly runtime: AutonomousRuntime<StartupR, LoopR>
  readonly state: Ref.Ref<RuntimeState>
}

const currentUtcInstant = Clock.currentTimeMillis.pipe(
  Effect.flatMap((millis) =>
    Effect.try({
      try: () => utcInstantFromEpochMillis(millis),
      catch: (cause) =>
        operationalError({
          component: 'strategy',
          operation: 'cycle-loop-clock',
          message: 'runtime clock did not produce a canonical UTC instant',
          cause,
        }),
    }),
  ),
)

const markAutonomousCycleStarted = (state: Ref.Ref<RuntimeState>, startedAt: string): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    autonomousCycleLoop: { ...current.autonomousCycleLoop, startedAt },
  }))

const forkAutonomousCycle = <StartupR, LoopR>(
  runtime: AutonomousRuntime<StartupR, LoopR>,
  state: Ref.Ref<RuntimeState>,
  cycleBindingId: string,
): Effect.Effect<Fiber.Fiber<void, never>, OperationalError, StartupR | LoopR | Scope.Scope> =>
  pipe(
    currentUtcInstant,
    Effect.tap((startedAt) => markAutonomousCycleStarted(state, startedAt)),
    Effect.flatMap(() =>
      runtime.startCycle({
        qualificationRunId: cycleBindingId,
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
    ? Effect.as(Effect.void, undefined)
    : Ref.get(state).pipe(
        Effect.flatMap((initialized) => {
          const cycleBindingId =
            runtime.cycleBindingId === null
              ? undefined
              : (runtime.cycleBindingId ?? initialized.evidence?.evaluation.runId)
          return cycleBindingId === undefined
            ? Effect.as(Effect.void, undefined)
            : forkAutonomousCycle(runtime, state, cycleBindingId)
        }),
      )

export const prepareAutonomousApplication = <StartupR, LoopR>(
  config: RuntimeConfig,
  strategy: StrategyRuntime,
  dependencies: ApplicationDependencies,
  runtime: AutonomousRuntime<StartupR, LoopR>,
): Effect.Effect<PreparedAutonomousApplication<StartupR, LoopR>, OperationalError, StartupR | LoopR | Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialRuntimeState(runtime))
    if (qualificationEvidenceRequired(runtime)) {
      yield* runStartup(config, state, strategy, dependencies)
    }
    const resolvedRuntime = yield* resolveRuntimeAfterStartup(runtime, state)
    if (resolvedRuntime._tag === 'Brokerless') {
      return yield* operationalError({
        component: 'config',
        operation: 'prepare-autonomous-application',
        message: 'native execution preparation requires an autonomous runtime',
      })
    }
    const cycleFiber = yield* startAutonomousCycle(resolvedRuntime, state)
    if (cycleFiber === undefined) {
      return yield* operationalError({
        component: 'config',
        operation: 'prepare-autonomous-application',
        message: 'native execution preparation requires a durable cycle binding',
      })
    }
    return { cycleFiber, runtime: resolvedRuntime, state }
  })

const runApplicationDataFirst = <StartupR, LoopR>(
  config: RuntimeConfig,
  strategy: StrategyRuntime,
  dependencies: ApplicationDependencies,
  runtime: ApplicationRuntime<StartupR, LoopR>,
): Effect.Effect<never, OperationalError, HttpServer.HttpServer | StartupR | LoopR> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialRuntimeState(runtime))
    yield* serveHttp(config, state, strategy.provenance, config.build.verification, dependencies.evidenceStore.read)
    if (qualificationEvidenceRequired(runtime)) {
      yield* runStartup(config, state, strategy, dependencies)
    }
    const resolvedRuntime = yield* resolveRuntimeAfterStartup(runtime, state)
    yield* runHealthMonitor(
      config,
      state,
      dependencies,
      brokerProbe(resolvedRuntime),
      undefined,
      cycleObservationBinding(resolvedRuntime),
      qualificationEvidenceRequired(resolvedRuntime),
    ).pipe(Effect.forkScoped({ startImmediately: true }))
    return yield* Effect.never
  }).pipe(Effect.scoped)

export const runApplication = Pipeable.generic<
  <StartupR, LoopR>(
    strategy: StrategyRuntime,
    dependencies: ApplicationDependencies,
    runtime: ApplicationRuntime<StartupR, LoopR>,
  ) => (config: RuntimeConfig) => Effect.Effect<never, OperationalError, HttpServer.HttpServer | StartupR | LoopR>,
  typeof runApplicationDataFirst
>(4, runApplicationDataFirst)

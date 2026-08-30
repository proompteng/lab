import { Clock, Effect, Fiber, pipe, Ref, Scope } from 'effect'

import type { LoadedRuntimeConfig } from './config'
import { operationalError, type OperationalError } from './errors'
import type { BrokerProbe } from './health'
import {
  initialState,
  type AutonomousCyclePassObservation,
  type BrokerConfiguration,
  type RuntimeState,
} from './runtime-state'
import type { StrategyRuntime } from './strategy'
import { utcInstantFromEpochMillis } from './time'
import type { ExecutionProgram } from './execution/runtime-program'

export type RecordAutonomousCyclePass = (observation: AutonomousCyclePassObservation) => Effect.Effect<void>

export type AutonomousCycleStartupInput = {
  readonly cycleBindingId: string
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

export type ApplicationIdentity<C extends LoadedRuntimeConfig = LoadedRuntimeConfig> = {
  readonly config: C
  readonly parameterHash: string
  readonly strategy: StrategyRuntime
  readonly strategyProtocolHash: string
}

export type ApplicationPlan = ApplicationIdentity & { readonly _tag: 'AutonomousService' }

export type ApplicationPlanFor<M extends 'AutonomousService'> = M extends 'AutonomousService' ? ApplicationPlan : never

export const makeApplicationPlan = (identity: ApplicationIdentity): ApplicationPlan => ({
  ...identity,
  _tag: 'AutonomousService',
})

export type AutonomousRuntime<StartupR, LoopR> =
  | {
      readonly _tag: 'AutonomousRead'
      readonly broker?: BrokerProbe
      readonly brokerConfiguration?: BrokerConfiguration
      readonly cycleBindingId?: string | null
      readonly startCycle: AutonomousCycleStartup<StartupR, LoopR>
      readonly resolveAfterStartup?: AutonomousRuntimeResolver<StartupR, LoopR>
    }
  | {
      readonly _tag: 'AutonomousMutation'
      readonly broker: BrokerProbe
      readonly cycleBindingId?: string | null
      readonly executionProgram: ExecutionProgram
      readonly startCycle: AutonomousCycleStartup<StartupR, LoopR>
    }

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
  return observation.result === 'FAILURE' ? { ...next, status: 'DEGRADED', error: cyclePassError(observation) } : next
}

const initialRuntimeState = <StartupR, LoopR>(runtime: AutonomousRuntime<StartupR, LoopR>): RuntimeState =>
  initialState({
    broker: runtime._tag === 'AutonomousRead' ? (runtime.broker ?? runtime.brokerConfiguration) : runtime.broker,
    autonomousCycleLoopConfigured: true,
    autonomousCycleLoopOwner: 'Restate',
  })

const resolveRuntime = <StartupR, LoopR>(
  runtime: AutonomousRuntime<StartupR, LoopR>,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<AutonomousRuntime<StartupR, LoopR>, never, StartupR | LoopR | Scope.Scope> =>
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
        cycleBindingId,
        recordPass: (observation) => recordAutonomousCyclePass(state, observation),
      }),
    ),
    Effect.flatMap(Effect.forkScoped({ startImmediately: true })),
  )

const startAutonomousCycle = <StartupR, LoopR>(
  runtime: AutonomousRuntime<StartupR, LoopR>,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<Fiber.Fiber<void, never> | undefined, OperationalError, StartupR | LoopR | Scope.Scope> => {
  const cycleBindingId = runtime.cycleBindingId ?? undefined
  return cycleBindingId === undefined
    ? Effect.as(Effect.void, undefined)
    : forkAutonomousCycle(runtime, state, cycleBindingId)
}

export const prepareAutonomousApplication = <StartupR, LoopR>(
  runtime: AutonomousRuntime<StartupR, LoopR>,
): Effect.Effect<PreparedAutonomousApplication<StartupR, LoopR>, OperationalError, StartupR | LoopR | Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialRuntimeState(runtime))
    const resolvedRuntime = yield* resolveRuntime(runtime, state)
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

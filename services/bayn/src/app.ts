import type { Effect } from 'effect'

import type { LoadedRuntimeConfig } from './config/model'
import type { OperationalError } from './errors'
import type { AutonomousCyclePassObservation } from './runtime-state'
import type { StrategyRuntime } from './strategy'

export type RecordAutonomousCyclePass = (observation: AutonomousCyclePassObservation) => Effect.Effect<void>

export type AutonomousCycleStartupInput = {
  readonly cycleBindingId: string
  readonly recordPass: RecordAutonomousCyclePass
}

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

export const makeApplicationPlan = (identity: ApplicationIdentity): ApplicationPlan => ({
  ...identity,
  _tag: 'AutonomousService',
})

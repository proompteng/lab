import { Context, Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { errorResponse } from '../http'

import type { AgentRunsApiDependencies } from './agent-runs'
import type { RunReadApiDependencies } from './run-read'

export class AgentsV1RuntimeConfigurationError extends Error {
  readonly _tag = 'AgentsV1RuntimeConfigurationError'
}

export type AgentsV1RuntimeDependencies = {
  agentRuns?: Partial<AgentRunsApiDependencies>
  runRead?: Partial<RunReadApiDependencies>
}

export type AgentsV1RuntimeService = {
  resolveAgentRunsDependencies: (
    overrides?: Partial<AgentRunsApiDependencies>,
  ) => Effect.Effect<AgentRunsApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveRunReadDependencies: (
    overrides?: Partial<RunReadApiDependencies>,
  ) => Effect.Effect<RunReadApiDependencies, AgentsV1RuntimeConfigurationError>
}

export class AgentsV1Runtime extends Context.Tag('AgentsV1Runtime')<AgentsV1Runtime, AgentsV1RuntimeService>() {}

type RequiredStoreFactoryDependency = {
  storeFactory?: unknown
}

type ResolvedDependencyResult<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      error: AgentsV1RuntimeConfigurationError
    }

const ensureStoreFactory = <T extends RequiredStoreFactoryDependency>(label: string, deps: T) => {
  if (typeof deps.storeFactory !== 'function') {
    return Effect.fail(
      new AgentsV1RuntimeConfigurationError(
        `${label} runtime dependencies are not configured: storeFactory is required`,
      ),
    )
  }
  return Effect.succeed(deps as T & { storeFactory: NonNullable<T['storeFactory']> })
}

export const createAgentsV1RuntimeService = (
  dependencies: AgentsV1RuntimeDependencies = {},
): AgentsV1RuntimeService => ({
  resolveAgentRunsDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.agentRuns, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('AgentRuns API', resolved)),
      Effect.map((resolved) => resolved as AgentRunsApiDependencies),
    ),
  resolveRunReadDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.runRead, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('Run read API', resolved)),
      Effect.map((resolved) => resolved as RunReadApiDependencies),
    ),
})

export const AgentsV1RuntimeLive = (dependencies: AgentsV1RuntimeDependencies = {}) =>
  Layer.succeed(AgentsV1Runtime, createAgentsV1RuntimeService(dependencies))

let configuredRuntime: ManagedRuntime.ManagedRuntime<AgentsV1Runtime, never> | null = null

export const configureAgentsV1Runtime = (dependencies: AgentsV1RuntimeDependencies) => {
  configuredRuntime = ManagedRuntime.make(AgentsV1RuntimeLive(dependencies))
}

const runWithConfiguredOrAdHocRuntime = <A, E>(
  effectFactory: (service: AgentsV1RuntimeService) => Effect.Effect<A, E>,
): Promise<A> => {
  if (configuredRuntime) {
    return configuredRuntime.runPromise(Effect.flatMap(AgentsV1Runtime, effectFactory))
  }

  return Effect.runPromise(effectFactory(createAgentsV1RuntimeService()))
}

const toResolvedDependencyResult = <T>(promise: Promise<T>): Promise<ResolvedDependencyResult<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({
      ok: false,
      error:
        error instanceof AgentsV1RuntimeConfigurationError
          ? error
          : new AgentsV1RuntimeConfigurationError(error instanceof Error ? error.message : String(error)),
    }),
  )

export const resolveAgentRunsApiDependencies = (
  overrides: Partial<AgentRunsApiDependencies> = {},
): Promise<ResolvedDependencyResult<AgentRunsApiDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveAgentRunsDependencies(overrides)),
  )

export const resolveRunReadApiDependencies = (
  overrides: Partial<RunReadApiDependencies> = {},
): Promise<ResolvedDependencyResult<RunReadApiDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveRunReadDependencies(overrides)),
  )

export const runtimeDependencyErrorResponse = (error: AgentsV1RuntimeConfigurationError) =>
  errorResponse(error.message, 503, { tag: error._tag })

export const resetAgentsV1RuntimeForTests = () => {
  configuredRuntime = null
}

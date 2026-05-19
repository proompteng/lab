import { Context, Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { errorResponse } from '../http'

import type { AgentsApiDependencies } from './agents'
import type { AgentRunsApiDependencies } from './agent-runs'
import type { MemoriesApiDependencies } from './memories'
import type { MemoryQueriesApiDependencies } from './memory-queries'
import type { OrchestrationRunsApiDependencies } from './orchestration-runs'
import type { OrchestrationsApiDependencies } from './orchestrations'
import type {
  MemoryReadDependencies,
  OrchestrationRunReadDependencies,
  ResourceReadDependencies,
} from './resource-read'
import type { RunReadApiDependencies } from './run-read'

export class AgentsV1RuntimeConfigurationError extends Error {
  readonly _tag = 'AgentsV1RuntimeConfigurationError'
}

export type AgentsV1RuntimeDependencies = {
  agents?: Partial<AgentsApiDependencies>
  agentRuns?: Partial<AgentRunsApiDependencies>
  memories?: Partial<MemoriesApiDependencies>
  memoryQueries?: Partial<MemoryQueriesApiDependencies>
  orchestrations?: Partial<OrchestrationsApiDependencies>
  orchestrationRuns?: Partial<OrchestrationRunsApiDependencies>
  resourceRead?: Partial<ResourceReadDependencies>
  orchestrationRunRead?: Partial<OrchestrationRunReadDependencies>
  memoryRead?: Partial<MemoryReadDependencies>
  runRead?: Partial<RunReadApiDependencies>
}

export type AgentsV1RuntimeService = {
  resolveAgentsDependencies: (
    overrides?: Partial<AgentsApiDependencies>,
  ) => Effect.Effect<AgentsApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveAgentRunsDependencies: (
    overrides?: Partial<AgentRunsApiDependencies>,
  ) => Effect.Effect<AgentRunsApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveMemoriesDependencies: (
    overrides?: Partial<MemoriesApiDependencies>,
  ) => Effect.Effect<MemoriesApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveMemoryQueriesDependencies: (
    overrides?: Partial<MemoryQueriesApiDependencies>,
  ) => Effect.Effect<MemoryQueriesApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveOrchestrationsDependencies: (
    overrides?: Partial<OrchestrationsApiDependencies>,
  ) => Effect.Effect<OrchestrationsApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveOrchestrationRunsDependencies: (
    overrides?: Partial<OrchestrationRunsApiDependencies>,
  ) => Effect.Effect<OrchestrationRunsApiDependencies, AgentsV1RuntimeConfigurationError>
  resolveResourceReadDependencies: (
    overrides?: Partial<ResourceReadDependencies>,
  ) => Effect.Effect<ResourceReadDependencies, AgentsV1RuntimeConfigurationError>
  resolveOrchestrationRunReadDependencies: (
    overrides?: Partial<OrchestrationRunReadDependencies>,
  ) => Effect.Effect<OrchestrationRunReadDependencies, AgentsV1RuntimeConfigurationError>
  resolveMemoryReadDependencies: (
    overrides?: Partial<MemoryReadDependencies>,
  ) => Effect.Effect<MemoryReadDependencies, AgentsV1RuntimeConfigurationError>
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
  resolveAgentsDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.agents, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('Agents API', resolved)),
      Effect.map((resolved) => resolved as AgentsApiDependencies),
    ),
  resolveAgentRunsDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.agentRuns, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('AgentRuns API', resolved)),
      Effect.map((resolved) => resolved as AgentRunsApiDependencies),
    ),
  resolveMemoriesDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.memories, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('Memories API', resolved)),
      Effect.map((resolved) => resolved as MemoriesApiDependencies),
    ),
  resolveMemoryQueriesDependencies: (overrides = {}) =>
    Effect.succeed({ ...dependencies.memoryQueries, ...overrides } as MemoryQueriesApiDependencies),
  resolveOrchestrationsDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.orchestrations, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('Orchestrations API', resolved)),
      Effect.map((resolved) => resolved as OrchestrationsApiDependencies),
    ),
  resolveOrchestrationRunsDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.orchestrationRuns, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('OrchestrationRuns API', resolved)),
      Effect.map((resolved) => resolved as OrchestrationRunsApiDependencies),
    ),
  resolveResourceReadDependencies: (overrides = {}) =>
    Effect.succeed({ ...dependencies.resourceRead, ...overrides } as ResourceReadDependencies),
  resolveOrchestrationRunReadDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.orchestrationRunRead, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('OrchestrationRun read API', resolved)),
      Effect.map((resolved) => resolved as OrchestrationRunReadDependencies),
    ),
  resolveMemoryReadDependencies: (overrides = {}) =>
    pipe(
      Effect.succeed({ ...dependencies.memoryRead, ...overrides }),
      Effect.flatMap((resolved) => ensureStoreFactory('Memory read API', resolved)),
      Effect.map((resolved) => resolved as MemoryReadDependencies),
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

export const resolveAgentsApiDependencies = (
  overrides: Partial<AgentsApiDependencies> = {},
): Promise<ResolvedDependencyResult<AgentsApiDependencies>> =>
  toResolvedDependencyResult(runWithConfiguredOrAdHocRuntime((service) => service.resolveAgentsDependencies(overrides)))

export const resolveMemoriesApiDependencies = (
  overrides: Partial<MemoriesApiDependencies> = {},
): Promise<ResolvedDependencyResult<MemoriesApiDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveMemoriesDependencies(overrides)),
  )

export const resolveMemoryQueriesApiDependencies = (
  overrides: Partial<MemoryQueriesApiDependencies> = {},
): Promise<ResolvedDependencyResult<MemoryQueriesApiDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveMemoryQueriesDependencies(overrides)),
  )

export const resolveOrchestrationsApiDependencies = (
  overrides: Partial<OrchestrationsApiDependencies> = {},
): Promise<ResolvedDependencyResult<OrchestrationsApiDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveOrchestrationsDependencies(overrides)),
  )

export const resolveOrchestrationRunsApiDependencies = (
  overrides: Partial<OrchestrationRunsApiDependencies> = {},
): Promise<ResolvedDependencyResult<OrchestrationRunsApiDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveOrchestrationRunsDependencies(overrides)),
  )

export const resolveResourceReadDependencies = (
  overrides: Partial<ResourceReadDependencies> = {},
): Promise<ResolvedDependencyResult<ResourceReadDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveResourceReadDependencies(overrides)),
  )

export const resolveOrchestrationRunReadDependencies = (
  overrides: Partial<OrchestrationRunReadDependencies> = {},
): Promise<ResolvedDependencyResult<OrchestrationRunReadDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveOrchestrationRunReadDependencies(overrides)),
  )

export const resolveMemoryReadDependencies = (
  overrides: Partial<MemoryReadDependencies> = {},
): Promise<ResolvedDependencyResult<MemoryReadDependencies>> =>
  toResolvedDependencyResult(
    runWithConfiguredOrAdHocRuntime((service) => service.resolveMemoryReadDependencies(overrides)),
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

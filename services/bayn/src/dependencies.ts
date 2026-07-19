import { Context, Effect, Layer } from 'effect'

import { DependencyUnavailableError } from './errors'

export const DEFAULT_DEPENDENCY_TIMEOUT_MS = 2_000

export interface DependencyProbe {
  readonly name: string
  readonly check: Effect.Effect<void, DependencyUnavailableError>
  readonly timeoutMs?: number
}

export interface DependencyRegistryService {
  readonly probes: ReadonlyArray<DependencyProbe>
}

export interface DependencyStatus {
  readonly name: string
  readonly status: 'ready' | 'not-ready'
}

export class DependencyRegistry extends Context.Tag('@bayn/DependencyRegistry')<
  DependencyRegistry,
  DependencyRegistryService
>() {}

export const makeDependencyRegistry = (probes: ReadonlyArray<DependencyProbe> = []): DependencyRegistryService => ({
  probes: [...probes],
})

export const checkDependencies = (
  registry: DependencyRegistryService,
): Effect.Effect<ReadonlyArray<DependencyStatus>> =>
  Effect.forEach(
    registry.probes,
    (probe) =>
      probe.check.pipe(
        Effect.timeout(probe.timeoutMs ?? DEFAULT_DEPENDENCY_TIMEOUT_MS),
        Effect.as<DependencyStatus>({ name: probe.name, status: 'ready' }),
        Effect.catchAllCause(() =>
          Effect.logWarning('Dependency readiness check failed').pipe(
            Effect.annotateLogs('dependency', probe.name),
            Effect.as<DependencyStatus>({ name: probe.name, status: 'not-ready' }),
          ),
        ),
      ),
    { concurrency: 'unbounded' },
  )

export const DependencyRegistryLive = Layer.succeed(DependencyRegistry, makeDependencyRegistry())

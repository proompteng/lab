import { Effect, Exit } from 'effect'

import { loadTemporalConfig } from '../../src/config'
import { WorkerVersioningMode } from '../../src/proto/temporal/api/enums/v1/deployment_pb'
import { VersioningBehavior } from '../../src/proto/temporal/api/enums/v1/workflow_pb'
import { WorkerRuntime } from '../../src/worker/runtime'
import { makeStickyCache } from '../../src/worker/sticky-cache'
import type { IntegrationHarness } from './harness'
import {
  createIntegrationHarness,
  findTemporalCliUnavailableError,
  TemporalCliUnavailableError,
  TemporalCliCommandError,
} from './harness'
import { integrationActivities, integrationWorkflows } from './workflows'

type RunOrSkip = <T>(name: string, scenario: () => Promise<T>) => Promise<T | undefined>

export interface IntegrationTestEnv {
  readonly harness: IntegrationHarness | null
  readonly cliConfig: typeof CLI_CONFIG
  readonly runOrSkip: RunOrSkip
  readonly stickyCacheSizeEffect: Effect.Effect<number, never, never> | null
  readonly stickyCacheClearEffect: Effect.Effect<void, never, never> | null
  readonly runtime: WorkerRuntime | null
  readonly runtimePromise: Promise<void> | null
  readonly isCliUnavailable: () => boolean
}

export const CLI_CONFIG = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'temporal-bun-integration',
}

const isLoopbackTemporalAddress = (address: string): boolean => {
  const normalized = address.trim().toLowerCase()
  return (
    normalized.startsWith('127.0.0.1:') ||
    normalized.startsWith('localhost:') ||
    normalized.startsWith('[::1]:')
  )
}

let sharedEnvPromise: Promise<IntegrationTestEnv> | null = null
let refCount = 0

export const acquireIntegrationTestEnv = async (): Promise<IntegrationTestEnv> => {
  if (!sharedEnvPromise) {
    sharedEnvPromise = setupIntegrationTestEnv()
  }
  refCount += 1
  return sharedEnvPromise
}

export const releaseIntegrationTestEnv = async (): Promise<void> => {
  refCount = Math.max(0, refCount - 1)
  if (refCount === 0 && sharedEnvPromise) {
    const env = await sharedEnvPromise
    await teardownIntegrationTestEnv(env)
    sharedEnvPromise = null
  }
}

const setupIntegrationTestEnv = async (): Promise<IntegrationTestEnv> => {
  if (process.env.TEMPORAL_ENFORCE_REMOTE_ADDRESS === '1' && isLoopbackTemporalAddress(CLI_CONFIG.address)) {
    throw new Error(
      `Integration tests are configured to require a remote Temporal endpoint, but TEMPORAL_ADDRESS is ${CLI_CONFIG.address}`,
    )
  }

  let harness: IntegrationHarness | null = null
  let cliUnavailable = false

  const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
  if (Exit.isFailure(harnessExit)) {
    const unavailable = findTemporalCliUnavailableError(harnessExit.cause)
    if (unavailable) {
      cliUnavailable = true
      console.warn(`[temporal-bun-sdk] Temporal CLI unavailable: ${unavailable.message}`)
    } else {
      throw harnessExit.cause
    }
  } else {
    harness = harnessExit.value
    const setupExit = await Effect.runPromiseExit(harness.setup)
    if (Exit.isFailure(setupExit)) {
      const unavailable = findTemporalCliUnavailableError(setupExit.cause)
      if (unavailable) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] Temporal endpoint unavailable during setup: ${unavailable.message}`)
      } else {
        throw setupExit.cause
      }
    }
  }

  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let stickyCacheSizeEffect: Effect.Effect<number, never, never> | null = null
  let stickyCacheClearEffect: Effect.Effect<void, never, never> | null = null

  if (!cliUnavailable) {
    const baseConfig = await loadTemporalConfig()
    const stickyCache = await Effect.runPromise(makeStickyCache({ maxEntries: 2, ttlMs: 60_000 }))
    stickyCacheSizeEffect = stickyCache.size
    stickyCacheClearEffect = stickyCache.clear

    const runtimeConfig = {
      ...baseConfig,
      address: CLI_CONFIG.address,
      namespace: CLI_CONFIG.namespace,
      taskQueue: CLI_CONFIG.taskQueue,
      workerWorkflowConcurrency: baseConfig.workerWorkflowConcurrency ?? 4,
      workerActivityConcurrency: baseConfig.workerActivityConcurrency ?? 4,
      workerStickyCacheSize: 2,
      workerStickyTtlMs: 60_000,
    }

    runtime = await WorkerRuntime.create({
      config: runtimeConfig,
      workflows: integrationWorkflows,
      activities: integrationActivities,
      stickyCache,
      workflowGuards: 'warn',
      deployment: {
        versioningMode: WorkerVersioningMode.UNVERSIONED,
        versioningBehavior: VersioningBehavior.UNSPECIFIED,
      },
    })

    runtimePromise = runtime.run()
  }

  const runOrSkip: RunOrSkip = async (name, scenario) => {
    if (cliUnavailable) {
      console.warn(`[temporal-bun-sdk] skipped integration scenario: ${name}`)
      return undefined
    }
    if (!harness) {
      throw new Error('Integration harness not initialized')
    }
    try {
      return await Effect.runPromise(
        harness.runScenario(name, () => Effect.tryPromise(scenario)),
      )
    } catch (error) {
      if (error instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipped integration scenario ${name}: ${error.message}`)
        return undefined
      }
      console.error(
        `[temporal-bun-sdk] integration scenario ${name} failed`,
        error instanceof Error ? error.stack ?? error.message : error,
      )
      throw error
    }
  }

  return {
    harness,
    cliConfig: CLI_CONFIG,
    runOrSkip,
    stickyCacheSizeEffect,
    stickyCacheClearEffect,
    runtime,
    runtimePromise,
    isCliUnavailable: () => cliUnavailable,
  }
}

const teardownIntegrationTestEnv = async (env: IntegrationTestEnv): Promise<void> => {
  if (env.runtime) {
    await env.runtime.shutdown()
  }
  if (env.runtimePromise) {
    await env.runtimePromise
  }
  if (env.harness) {
    try {
      await Effect.runPromise(env.harness.teardown)
    } catch (error) {
      if (error instanceof TemporalCliCommandError) {
        console.warn('[temporal-bun-sdk] failed to tear down Temporal CLI dev server', {
          command: error.command,
          exitCode: error.exitCode,
          stderr: error.stderr,
        })
      } else {
        console.warn('[temporal-bun-sdk] harness teardown failed', error)
      }
    }
  }
}

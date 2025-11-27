#!/usr/bin/env bun

import { Cause, Effect, Exit, Fiber } from 'effect'

import { runWorkerApp } from '../runtime/worker-app'
import { resolveWorkerActivities, resolveWorkerWorkflowsPath } from '../worker/defaults'
import { parseArgs } from './temporal-bun'

const main = async () => {
  const { flags } = parseArgs(process.argv.slice(2))
  const env = { ...process.env }

  const setListEnv = (flagName: string, envKey: string) => {
    const value = flags[flagName]
    if (value === undefined) return
    env[envKey] = typeof value === 'boolean' ? '' : String(value)
  }

  setListEnv('workflow-import-allow', 'TEMPORAL_WORKFLOW_IMPORT_ALLOW')
  setListEnv('workflow-import-block', 'TEMPORAL_WORKFLOW_IMPORT_BLOCK')
  setListEnv('workflow-import-ignore', 'TEMPORAL_WORKFLOW_IMPORT_IGNORE')

  if (flags['workflow-import-unsafe-ok'] !== undefined) {
    const raw = flags['workflow-import-unsafe-ok']
    env.TEMPORAL_WORKFLOW_IMPORT_UNSAFE_OK = typeof raw === 'boolean' ? '1' : String(raw)
  }

  const workerLayerOptions = {
    config: { env },
    worker: {
      activities: resolveWorkerActivities(undefined),
      workflowsPath: resolveWorkerWorkflowsPath(undefined),
    },
  }

  const appFiber = Effect.runFork(runWorkerApp(workerLayerOptions))

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down Temporal worker…`)
    void Effect.runPromise(Fiber.interrupt(appFiber))
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const exitResult = await Effect.runPromise(Fiber.await(appFiber))
  if (Exit.isFailure(exitResult) && !Cause.isInterruptedOnly(exitResult.cause)) {
    console.error('Fatal error while running Temporal worker:', Cause.pretty(exitResult.cause))
    process.exit(1)
  }
}

await main().catch((error) => {
  console.error('Fatal error while running Temporal worker:', error)
  process.exit(1)
})

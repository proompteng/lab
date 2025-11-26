#!/usr/bin/env bun

import { Cause, Effect, Exit, Fiber } from 'effect'

import { runWorkerApp } from '../runtime/worker-app'
import { resolveWorkerActivities, resolveWorkerWorkflowsPath } from '../worker/defaults'

const applyImportFlagsToEnv = (argv: string[]) => {
  const normalize = (value: string | undefined) => value?.trim()
  const flagValue = (flag: string): string | undefined => {
    const prefixed = `--${flag}`
    for (let index = 0; index < argv.length; index++) {
      const candidate = argv[index]
      if (!candidate.startsWith(prefixed)) {
        continue
      }
      const equalsIndex = candidate.indexOf('=')
      if (equalsIndex !== -1) {
        return normalize(candidate.slice(equalsIndex + 1))
      }
      const next = argv[index + 1]
      if (next && !next.startsWith('--')) {
        return normalize(next)
      }
    }
    return undefined
  }

  const allow = flagValue('workflow-import-allow')
  const block = flagValue('workflow-import-block')
  const ignore = flagValue('workflow-import-ignore')
  if (allow) {
    process.env.TEMPORAL_WORKFLOW_IMPORT_ALLOW = allow
  }
  if (block) {
    process.env.TEMPORAL_WORKFLOW_IMPORT_BLOCK = block
  }
  if (ignore) {
    process.env.TEMPORAL_WORKFLOW_IMPORT_IGNORE = ignore
  }
  if (argv.includes('--workflow-import-unsafe-ok')) {
    process.env.TEMPORAL_WORKFLOW_IMPORT_UNSAFE_OK = '1'
  }
}

const main = async () => {
  applyImportFlagsToEnv(process.argv.slice(2))

  const workerLayerOptions = {
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

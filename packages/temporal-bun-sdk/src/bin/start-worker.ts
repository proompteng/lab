#!/usr/bin/env bun

import { Cause, Effect, Exit, Fiber } from 'effect'

import { runWorkerApp } from '../runtime/worker-app'
import { resolveWorkerActivities, resolveWorkerWorkflowsPath } from '../worker/defaults'

const main = async () => {
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

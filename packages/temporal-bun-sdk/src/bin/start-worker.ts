#!/usr/bin/env bun

import { Effect } from 'effect'

import { makeConsoleLogger } from '../observability/logger.js'
import { createWorker } from '../worker.js'

const main = async () => {
  const { worker } = await createWorker()
  const logger = makeConsoleLogger()

  const shutdown = async (signal: string) => {
    await Effect.runPromise(logger.log('info', `Received ${signal}, shutting down Temporal worker…`))
    await worker.shutdown()
    await Effect.runPromise(logger.log('info', 'Temporal worker shutdown complete'))
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  await worker.run()
}

await main().catch((error) => {
  console.error('Fatal error while running Temporal worker:', error)
  process.exit(1)
})

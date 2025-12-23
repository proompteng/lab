import { fileURLToPath } from 'node:url'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'

import activities from './activities/index'

type ActivityHandler = (...args: unknown[]) => unknown | Promise<unknown>

const main = async () => {
  const { worker } = await createWorker({
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities: activities as Record<string, ActivityHandler>,
  })

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Shutting down worker…`)
    await worker.shutdown()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await worker.run()
}

await main().catch((error) => {
  console.error('Bumba worker crashed:', error)
  process.exit(1)
})

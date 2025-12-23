import { fileURLToPath } from 'node:url'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'

import activities from './activities/index.ts'

const main = async () => {
  const { worker } = await createWorker({
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities,
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

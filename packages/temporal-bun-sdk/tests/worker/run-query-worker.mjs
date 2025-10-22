import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Replaced @temporalio/worker with native implementation

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowsPath = join(__dirname, '../workflows/query-workflow.js')

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233'
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default'
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'bun-sdk-query-tests'

let worker

async function main() {
  const connection = await NativeConnection.connect({ address })
  worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath,
  })

  console.log('worker-ready')

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await worker.run()
}

async function shutdown() {
  if (!worker) {
    process.exit(0)
    return
  }
  try {
    await worker.shutdown()
  } catch (err) {
    console.error('worker shutdown failed', err)
  } finally {
    process.exit(0)
  }
}

main().catch((err) => {
  console.error('worker failed to start', err)
  process.exit(1)
})

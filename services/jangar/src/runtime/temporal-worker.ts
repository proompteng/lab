import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk/config'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from '../activities'

export type TemporalWorkerHandle = {
  runPromise: Promise<void>
  shutdown: () => Promise<void>
  taskQueue: string
  namespace: string
}

export const startTemporalWorker = async (): Promise<TemporalWorkerHandle> => {
  // Default to the tailnet load balancer for local runs; cluster deploy overrides via env
  const address = Bun.env.TEMPORAL_ADDRESS ?? 'temporal-grpc:7233'
  const namespace = Bun.env.TEMPORAL_NAMESPACE ?? 'default'
  const taskQueue = Bun.env.TEMPORAL_TASK_QUEUE ?? 'jangar'

  const config = await loadTemporalConfig({
    defaults: {
      address,
      namespace,
      taskQueue,
    },
  })

  const { worker } = await createWorker({
    activities,
    workflowsPath: new URL('../workflows/index.ts', import.meta.url).pathname,
    config,
    taskQueue,
    namespace,
  })

  const runPromise = worker.run().catch((error) => {
    console.error('Temporal worker exited', error)
    throw error
  })

  const shutdown = async () => {
    await worker.shutdown()
  }

  return { runPromise, shutdown, taskQueue, namespace }
}

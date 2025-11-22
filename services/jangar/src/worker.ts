import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk/config'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './activities'

const address = Bun.env.TEMPORAL_ADDRESS ?? 'temporal-frontend.temporal.svc.cluster.local:7233'
const namespace = Bun.env.TEMPORAL_NAMESPACE ?? 'default'
const taskQueue = Bun.env.TEMPORAL_TASK_QUEUE ?? 'jangar'

const healthPort = Number(Bun.env.PORT ?? 8080)
Bun.serve({
  port: healthPort,
  fetch: () => new Response('ok'),
})

const config = await loadTemporalConfig({
  defaults: {
    address,
    namespace,
    taskQueue,
  },
})

const { worker } = await createWorker({
  activities,
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  config,
  taskQueue,
  namespace,
})

await worker.run()

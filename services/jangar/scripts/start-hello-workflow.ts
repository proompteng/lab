#!/usr/bin/env bun

import { createTemporalClient } from '@proompteng/temporal-bun-sdk'

const name = Bun.argv[2] ?? 'Developer'
const workflowId = `hello-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
const taskQueue = Bun.env.TEMPORAL_TASK_QUEUE ?? 'jangar'
const namespace = Bun.env.TEMPORAL_NAMESPACE ?? 'default'

const { client, config } = await createTemporalClient()

const started = await client.startWorkflow({
  workflowId,
  workflowType: 'helloWorkflow',
  args: [{ name }],
  taskQueue,
  namespace,
})

console.log(
  JSON.stringify(
    {
      workflowId: started.workflowId,
      runId: started.runId,
      namespace: started.namespace,
      taskQueue,
      name,
      address: config.address,
    },
    null,
    2,
  ),
)

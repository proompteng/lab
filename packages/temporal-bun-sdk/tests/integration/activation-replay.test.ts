import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { createTemporalClient, temporalCallOptions, type TemporalClient } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import { WorkerRuntime } from '../../src/worker/runtime'
import { WorkerVersioningMode } from '../../src/proto/temporal/api/enums/v1/deployment_pb'
import { VersioningBehavior } from '../../src/proto/temporal/api/enums/v1/workflow_pb'
import type { WorkflowHandle } from '../../src/client/types'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, CLI_CONFIG, type IntegrationTestEnv } from './test-env'
import { caughtActivityWorkflow, parallelActivityWorkflow, signalBatchWorkflow } from './workflows/activations'

const taskQueue = `integration-activations-${randomUUID()}`
const callOptions = temporalCallOptions({ timeoutMs: 15_000, retryPolicy: { maxAttempts: 1 } })
let env: IntegrationTestEnv
let client: TemporalClient
let runtime: WorkerRuntime | undefined
let running: Promise<void> | undefined
let echoCalls = 0
const signalStarted = Promise.withResolvers<void>()
const signalRelease = Promise.withResolvers<void>()
const parallelRelease = Promise.withResolvers<void>()

const startWorker = async () => {
  const config = await loadTemporalConfig()
  runtime = await WorkerRuntime.create({
    config: { ...config, address: CLI_CONFIG.address, namespace: CLI_CONFIG.namespace },
    taskQueue,
    stickyScheduling: false,
    workflowGuards: 'warn',
    workflows: [caughtActivityWorkflow, parallelActivityWorkflow, signalBatchWorkflow],
    activities: {
      integrationEchoActivity: async (value: unknown) => {
        echoCalls += 1
        if (value === 'C') parallelRelease.resolve()
        return value
      },
      integrationDelayedEchoActivity: async (value: unknown) => {
        if (value === 'B') {
          await parallelRelease.promise
        } else {
          signalStarted.resolve()
          await signalRelease.promise
        }
        return value
      },
    },
    concurrency: { workflow: 2, activity: 4 },
    deployment: {
      versioningMode: WorkerVersioningMode.UNVERSIONED,
      versioningBehavior: VersioningBehavior.UNSPECIFIED,
    },
  })
  running = runtime.run()
}

beforeAll(
  async () => {
    env = await acquireIntegrationTestEnv()
    await env.runOrSkip('activation worker setup', async () => {
      const config = await loadTemporalConfig()
      client = (await createTemporalClient({ config, taskQueue, namespace: CLI_CONFIG.namespace })).client
      await startWorker()
    })
  },
  { timeout: 60_000 },
)

afterAll(
  async () => {
    signalRelease.resolve()
    parallelRelease.resolve()
    await runtime?.shutdown()
    await running
    await client?.shutdown()
    await releaseIntegrationTestEnv()
  },
  { timeout: 60_000 },
)

const history = async (handle: WorkflowHandle) => {
  const response = await client.rpc.workflow.call(
    'getWorkflowExecutionHistory',
    {
      namespace: CLI_CONFIG.namespace,
      execution: { workflowId: handle.workflowId, runId: handle.runId },
    },
    callOptions,
  )
  return response.history?.events ?? []
}

test('a cause handler does not swallow a pending activity', async () => {
  await env.runOrSkip('caught activity suspension', async () => {
    const before = echoCalls
    const handle = await client.workflow.start({
      workflowId: `${taskQueue}-caught`,
      workflowType: caughtActivityWorkflow.name,
      workflowExecutionTimeoutMs: 30_000,
    })
    const result = await client.workflow.result(handle, callOptions)
    expect(result).toBe('activity-result')
    expect(echoCalls - before).toBe(1)
    expect(
      (await history(handle)).filter((event) => event.attributes.case === 'workflowTaskFailedEventAttributes'),
    ).toHaveLength(0)
  })
}, 30_000)

test('parallel activity continuations retain their recorded command order', async () => {
  await env.runOrSkip('parallel activation replay', async () => {
    const handle = await client.workflow.start({
      workflowId: `${taskQueue}-parallel`,
      workflowType: parallelActivityWorkflow.name,
      workflowExecutionTimeoutMs: 30_000,
    })
    const result = await client.workflow.result(handle, callOptions)
    expect(result).toEqual(['C', 'B'])
    const events = await history(handle)
    expect(
      events.flatMap((event) =>
        event.attributes.case === 'activityTaskScheduledEventAttributes' ? [event.attributes.value.activityId] : [],
      ),
    ).toEqual(['A', 'B', 'C'])
    expect(events.filter((event) => event.attributes.case === 'workflowTaskFailedEventAttributes')).toHaveLength(0)
  })
}, 30_000)

test('a later signal preserves the first drain batch after the worker restarts', async () => {
  await env.runOrSkip('signal activation replay after worker restart', async () => {
    const handle = await client.workflow.start({
      workflowId: `${taskQueue}-signal`,
      workflowType: signalBatchWorkflow.name,
      workflowExecutionTimeoutMs: 45_000,
    })
    for (let attempt = 0; ; attempt += 1) {
      if ((await history(handle)).some((event) => event.attributes.case === 'workflowTaskCompletedEventAttributes'))
        break
      if (attempt === 100) throw new Error('Workflow did not reach the signal wait')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await runtime?.shutdown()
    await running
    await startWorker()
    await client.workflow.signal(handle, 'item', 'A', callOptions)
    await signalStarted.promise
    await client.workflow.signal(handle, 'item', 'B', callOptions)
    signalRelease.resolve()
    const result = await client.workflow.result(handle, callOptions)
    expect(result).toEqual(['A'])
    const events = await history(handle)
    expect(events.filter((event) => event.attributes.case === 'workflowExecutionSignaledEventAttributes')).toHaveLength(
      2,
    )
    expect(events.filter((event) => event.attributes.case === 'workflowTaskFailedEventAttributes')).toHaveLength(0)
  })
}, 60_000)

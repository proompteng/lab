import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { createTemporalClient, temporalCallOptions, type TemporalClient } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import { HistoryEventFilterType } from '../../src/proto/temporal/api/enums/v1/workflow_pb'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, CLI_CONFIG, type IntegrationTestEnv } from './test-env'
import { retryingFailureWorkflow } from './workflows'

let env: IntegrationTestEnv
let client: TemporalClient | undefined

beforeAll(
  async () => {
    env = await acquireIntegrationTestEnv()
    const config = await loadTemporalConfig()
    const connection = await createTemporalClient({
      config,
      namespace: CLI_CONFIG.namespace,
      taskQueue: CLI_CONFIG.taskQueue,
    })
    client = connection.client
    await client.updateHeaders({ 'supported-features': 'follows-next-run-id' })
  },
  { timeout: 60_000 },
)

afterAll(
  async () => {
    await client?.shutdown()
    await releaseIntegrationTestEnv()
  },
  { timeout: 60_000 },
)

test('workflow result follows a failed run to its retry successor outcome', async () => {
  await env.runOrSkip('workflow result retry chain', async () => {
    if (!client) throw new Error('Integration client is not initialized')
    const started = await client.workflow.start({
      workflowId: `integration-client-result-${randomUUID()}`,
      workflowType: retryingFailureWorkflow.name,
      retryPolicy: { maximumAttempts: 2, initialIntervalMs: 200 },
      workflowExecutionTimeoutMs: 30_000,
    })
    const history = await client.rpc.workflow.call(
      'getWorkflowExecutionHistory',
      {
        namespace: CLI_CONFIG.namespace,
        execution: { workflowId: started.workflowId, runId: started.runId },
        historyEventFilterType: HistoryEventFilterType.CLOSE_EVENT,
        waitNewEvent: true,
        skipArchival: true,
      },
      temporalCallOptions({ timeoutMs: 10_000, retryPolicy: { maxAttempts: 1 } }),
    )
    const attributes = history.history?.events[0]?.attributes
    expect(attributes?.case).toBe('workflowExecutionFailedEventAttributes')
    if (attributes?.case !== 'workflowExecutionFailedEventAttributes' || !attributes.value.newExecutionRunId) {
      throw new Error('Expected the first failed run to have a retry successor')
    }
    const finalRunId = attributes.value.newExecutionRunId
    expect(finalRunId).not.toBe(started.runId)

    // Await the RPC before asserting because Bun's promise matcher stalls this HTTP/2 call.
    const failure = await client.workflow
      .result(started, temporalCallOptions({ timeoutMs: 10_000, retryPolicy: { maxAttempts: 1 } }))
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: `failed run ${finalRunId}` })

    const finalHistory = await client.rpc.workflow.call('getWorkflowExecutionHistory', {
      namespace: CLI_CONFIG.namespace,
      execution: { workflowId: started.workflowId, runId: finalRunId },
      historyEventFilterType: HistoryEventFilterType.CLOSE_EVENT,
    })
    const finalAttributes = finalHistory.history?.events[0]?.attributes
    expect(finalAttributes?.case).toBe('workflowExecutionFailedEventAttributes')
    if (finalAttributes?.case === 'workflowExecutionFailedEventAttributes') {
      expect(finalAttributes.value.newExecutionRunId).toBe('')
      expect(finalAttributes.value.failure?.message).toBe(`failed run ${finalRunId}`)
    }
  })
}, 40_000)

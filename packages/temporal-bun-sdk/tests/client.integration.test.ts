import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { createTemporalClient } from '../src/client.ts'
import type { TemporalClient } from '../src/client.ts'
import type { TemporalConfig } from '../src/config.ts'
import { ConnectError, Code } from '@connectrpc/connect'

const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default'
const suite = shouldRun ? describe : describe.skip

const createConfig = (): TemporalConfig => ({
  host: '127.0.0.1',
  port: 7233,
  address: temporalAddress,
  namespace,
  taskQueue: 'bun-sdk-integration',
  apiKey: undefined,
  tls: undefined,
  allowInsecureTls: false,
  workerIdentity: 'bun-sdk-integration-client',
  workerIdentityPrefix: 'temporal-bun-worker',
})

suite('Temporal client integration (Connect)', () => {
  let client: TemporalClient

  beforeAll(async () => {
    const { client: created } = await createTemporalClient({
      config: createConfig(),
    })
    client = created
  })

  afterAll(async () => {
    await client.shutdown()
  })

  test('describe namespace resolves against dev server', async () => {
    const response = await client.describeNamespace(namespace)
    expect(response.namespaceInfo).toBeDefined()
  })

  test('start, signal, cancel, and terminate workflow operations succeed', async () => {
    const workflowId = `bun-integration-${Date.now()}`

    const startResult = await client.startWorkflow({
      workflowId,
      workflowType: 'noop-workflow',
      args: ['hello'],
    })

    expect(startResult.workflowId).toBe(workflowId)

    await client.workflow.signal({
      workflowId,
      namespace,
      runId: startResult.runId,
    }, 'integrationSignal', { attempt: 1 })

    await client.terminateWorkflow({ workflowId, namespace, runId: startResult.runId }, {
      reason: 'integration cleanup',
    })
  })

  test('signalWithStart returns runId', async () => {
    const workflowId = `bun-signal-start-${Date.now()}`

    const result = await client.signalWithStart({
      workflowId,
      workflowType: 'noop-workflow',
      signalName: 'initial',
      signalArgs: ['payload'],
    })

    expect(result.workflowId).toBe(workflowId)
    await client.terminateWorkflow({ workflowId, namespace, runId: result.runId }, {
      reason: 'integration cleanup',
    })
  })

  test('getWorkflowExecutionHistory fetches events', async () => {
    const workflowId = `bun-history-${Date.now()}`
    const startResult = await client.startWorkflow({ workflowId, workflowType: 'noop' })

    const history = await client.getWorkflowExecutionHistory({
      workflowId,
      namespace,
      runId: startResult.runId,
    })

    expect(history.history).toBeDefined()
    await client.terminateWorkflow({ workflowId, namespace, runId: startResult.runId }, {
      reason: 'integration cleanup',
    })
  })

  test('query workflow surfaces expected failure without workers', async () => {
    const workflowId = `bun-query-${Date.now()}`
    const startResult = await client.startWorkflow({ workflowId, workflowType: 'noop' })

    try {
      await client.workflow.query({ workflowId, namespace, runId: startResult.runId }, 'status')
      throw new Error('query unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError)
      const connectError = error as ConnectError
      expect([Code.FailedPrecondition, Code.InvalidArgument]).toContain(connectError.code)
    }

    await client.terminateWorkflow({ workflowId, namespace, runId: startResult.runId }, {
      reason: 'integration cleanup',
    })
  })
})

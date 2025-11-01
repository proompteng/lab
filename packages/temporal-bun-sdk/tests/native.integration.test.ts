import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DefaultPayloadConverter } from '@temporalio/common'
import { temporal } from '@temporalio/proto'

import { createTemporalClient } from '../src'
import { createDataConverter, createDefaultDataConverter, decodePayloadsToValues } from '../src/common/payloads'
import { importNativeBridge } from './helpers/native-bridge'
import { isTemporalServerAvailable, parseTemporalAddress } from './helpers/temporal-server'
import { withRetry, waitForWorkerReady } from './helpers/retry'

const { module: nativeBridge } = await importNativeBridge()

process.env.TEMPORAL_ALLOW_INSECURE = '0'
process.env.ALLOW_INSECURE_TLS = '0'

const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

if (!nativeBridge) {
  describe.skip('native bridge integration', () => {
    test('native bridge unavailable', () => {})
  })
} else {
  if (shouldRun && !serverAvailable) {
    console.warn(`Skipping native bridge integration tests: Temporal server unavailable at ${temporalAddress}`)
  }

  const suite = shouldRun && serverAvailable ? describe : describe.skip
  const workerAddress = (() => {
    const { host, port } = parseTemporalAddress(temporalAddress)
    return `${host}:${port}`
  })()

  const { native } = nativeBridge
  const defaultDataConverter = createDefaultDataConverter()

  async function readThreadCount(): Promise<number | null> {
    if (process.platform !== 'linux') {
      return null
    }
    try {
      const status = await Bun.file('/proc/self/status').text()
      const match = /^Threads:\s+(\d+)/m.exec(status)
      return match ? Number.parseInt(match[1] ?? '0', 10) : null
    } catch {
      return null
    }
  }

  const decodeQueryResult = async (bytes: Uint8Array): Promise<unknown> => {
    const response = temporal.api.workflowservice.v1.QueryWorkflowResponse.decode(bytes)
    const payloads = response.queryResult?.payloads ?? []
    if (!payloads.length) {
      return null
    }
    const [value] = await decodePayloadsToValues(defaultDataConverter, payloads)
    return value ?? null
  }

  const restoreEnv = (original: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(original)) {
      if (typeof value === 'string') {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    }
  }

  class PrefixingPayloadConverter extends DefaultPayloadConverter {
    static PREFIX = 'codec:'
    readonly encodedValues: unknown[] = []
    readonly decodedValues: unknown[] = []

    override toPayload(value: unknown) {
      this.encodedValues.push(value)
      const transformed = typeof value === 'string' ? `${PrefixingPayloadConverter.PREFIX}${value}` : value
      const payload = super.toPayload(transformed)
      if (!payload) {
        return payload
      }
      const metadata = payload.metadata ?? (payload.metadata = {})
      metadata['x-bun-prefix'] = new TextEncoder().encode('1')
      return payload
    }

    override fromPayload(payload: Parameters<DefaultPayloadConverter['fromPayload']>[0]) {
      const decoded = super.fromPayload(payload)
      this.decodedValues.push(decoded)
      if (typeof decoded === 'string' && decoded.startsWith(PrefixingPayloadConverter.PREFIX)) {
        return decoded.slice(PrefixingPayloadConverter.PREFIX.length)
      }
      return decoded
    }
  }

  suite('native bridge integration', () => {
    let runtime: ReturnType<typeof native.createRuntime>
    let workerProcess: ReturnType<typeof Bun.spawn> | undefined
    const taskQueue = 'bun-sdk-query-tests'
    const swsTaskQueue = taskQueue
    const decoder = new TextDecoder()

    beforeAll(async () => {
      runtime = native.createRuntime({})

      try {
        const workerScript = fileURLToPath(new URL('./worker/run-query-worker.mjs', import.meta.url))
        workerProcess = Bun.spawn(['node', workerScript], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            TEMPORAL_ADDRESS: workerAddress,
            TEMPORAL_NAMESPACE: 'default',
            TEMPORAL_TASK_QUEUE: taskQueue,
          },
        })

        await waitForWorkerReady(workerProcess)
      } catch (_error) {
        console.warn('Skipping native integration tests: worker dependencies not available')
        workerProcess = null
      }
    })

    afterAll(async () => {
      native.runtimeShutdown(runtime)
      if (workerProcess) {
        try {
          workerProcess.kill()
        } catch (error) {
          console.error('Failed to kill worker process', error)
        }
        try {
          await workerProcess.exited
        } catch {
          // ignore
        }
      }
    })

    test('describe namespace succeeds against live Temporal server', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }
      const maxAttempts = 10
      const waitMs = 500

      const client = await withRetry(
        async () => {
          return native.createClient(runtime, {
            address: temporalAddress,
            namespace: 'default',
          })
        },
        maxAttempts,
        waitMs,
      )

      try {
        const responseBytes = await withRetry(() => native.describeNamespace(client, 'default'), maxAttempts, waitMs)
        expect(responseBytes.byteLength).toBeGreaterThan(0)
      } finally {
        native.clientShutdown(client)
      }
    })

    test('signalWithStart starts and signals workflow', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }

      const maxAttempts = 10
      const waitMs = 500

      const client = await withRetry(
        async () => {
          return native.createClient(runtime, {
            address: temporalAddress,
            namespace: 'default',
            identity: 'bun-integration-client',
          })
        },
        maxAttempts,
        waitMs,
      )

      try {
        const workflowId = `sws-workflow-${Date.now()}`
        const request = {
          namespace: 'default',
          workflow_id: workflowId,
          workflow_type: 'queryWorkflowSample',
          task_queue: swsTaskQueue,
          identity: 'bun-integration-client',
          args: ['initial'],
          signal_name: 'setState',
          signal_args: ['updated'],
        }

        const resultBytes = await withRetry(() => native.signalWithStart(client, request), maxAttempts, waitMs)
        const info = JSON.parse(decoder.decode(resultBytes)) as { runId: string }
        expect(info.runId).toBeTruthy()

        const queryRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          run_id: info.runId,
          query_name: 'currentState',
          args: [],
        }
        const state = await withRetry(async () => {
          const stateBytes = await native.queryWorkflow(client, queryRequest)
          const curr = await decodeQueryResult(stateBytes)
          if (curr !== 'updated') throw new Error('state not updated yet')
          return curr as string
        }, maxAttempts, waitMs)
        expect(state).toBe('updated')
      } finally {
        native.clientShutdown(client)
      }
    })

    test('signalWorkflow routes signals through Temporal core', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }

      const maxAttempts = 10
      const waitMs = 500

      const client = await withRetry(
        async () => {
          return native.createClient(runtime, {
            address: temporalAddress,
            namespace: 'default',
            identity: 'bun-integration-client',
          })
        },
        maxAttempts,
        waitMs,
      )

      try {
        const workflowId = `signal-workflow-${Date.now()}`
        const startRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          workflow_type: 'queryWorkflowSample',
          task_queue: taskQueue,
          identity: 'bun-integration-client',
          args: ['initial-state'],
        }

        const startBytes = await withRetry(
          async () => native.startWorkflow(client, startRequest),
          maxAttempts,
          waitMs,
        )
        const startInfo = JSON.parse(decoder.decode(startBytes)) as { runId: string }

        const signalRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          run_id: startInfo.runId,
          signal_name: 'setState',
          args: ['updated-state'],
          identity: 'bun-integration-client',
          request_id: `req-${workflowId}`,
        }

        await withRetry(async () => native.signalWorkflow(client, signalRequest), maxAttempts, waitMs)

        const queryRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          run_id: startInfo.runId,
          query_name: 'currentState',
          args: [],
        }

        const state = await withRetry(async () => {
          const bytes = await native.queryWorkflow(client, queryRequest)
          const value = await decodeQueryResult(bytes)
          if (value !== 'updated-state') {
            throw new Error(`state not updated yet: ${value}`)
          }
          return value as string
        }, maxAttempts, waitMs)

        expect(state).toBe('updated-state')
      } finally {
        native.clientShutdown(client)
      }
    })

    test('cancelWorkflow cancels a running workflow', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }

      const maxAttempts = 10
      const waitMs = 500

      const client = await withRetry(
        async () => {
          return native.createClient(runtime, {
            address: temporalAddress,
            namespace: 'default',
            identity: 'bun-integration-client',
          })
        },
        maxAttempts,
        waitMs,
      )

      try {
        const workflowId = `cancel-workflow-${Date.now()}`
        const startRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          workflow_type: 'queryWorkflowSample',
          task_queue: taskQueue,
          identity: 'bun-integration-client',
          args: ['state-before-cancel'],
        }

        const startBytes = await withRetry(
          async () => native.startWorkflow(client, startRequest),
          maxAttempts,
          waitMs,
        )
        const startInfo = JSON.parse(decoder.decode(startBytes)) as { runId: string }

        const cancelRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          run_id: startInfo.runId,
        }

        await withRetry(async () => native.cancelWorkflow(client, cancelRequest), maxAttempts, waitMs)

        let connection: { close: () => Promise<void> } | undefined
        try {
          const temporalClient = await import('@temporalio/client').catch((error) => {
            console.warn('Skipping cancellation verification: @temporalio/client not available', error)
            return null
          })

          if (!temporalClient) {
            return
          }

          const {
            Connection,
            WorkflowClient,
            WorkflowExecutionCancelledError,
            WorkflowFailedError,
            CancelledFailure,
          } = temporalClient
          const cancellationErrorCtor =
            typeof WorkflowExecutionCancelledError === 'function'
              ? WorkflowExecutionCancelledError
              : (WorkflowFailedError as (new (...args: unknown[]) => Error) | undefined)
          expect(cancellationErrorCtor, 'Temporal client missing cancellation error type').toBeTruthy()

          connection = await Connection.connect({ address: workerAddress })
          const workflowClient = new WorkflowClient({ connection, namespace: 'default' })
          const handle = workflowClient.getHandle(workflowId)

          let threw = false
          try {
            await handle.result()
          } catch (err) {
            threw = true
            expect(err).toBeInstanceOf(cancellationErrorCtor!)
            if (typeof CancelledFailure === 'function' && err instanceof WorkflowFailedError) {
              expect(err.cause).toBeInstanceOf(CancelledFailure)
            }
          }

          expect(threw).toBe(true)
        } finally {
          if (connection) {
            await connection.close()
          }
        }
      } finally {
        native.clientShutdown(client)
      }
    })

    test('queryWorkflow returns payload for running workflow', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }

      const maxAttempts = 10
      const waitMs = 500

      const client = await withRetry(
        async () => {
          return native.createClient(runtime, {
            address: temporalAddress,
            namespace: 'default',
            identity: 'bun-integration-client',
          })
        },
        maxAttempts,
        waitMs,
      )

      try {
        const workflowId = `query-workflow-${Date.now()}`
        const startRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          workflow_type: 'queryWorkflowSample',
          task_queue: taskQueue,
          identity: 'bun-integration-client',
          args: ['initial-state'],
        }

        const startBytes = await native.startWorkflow(client, startRequest)
        const startInfo = JSON.parse(decoder.decode(startBytes)) as { runId: string }

        const queryRequest = {
          namespace: 'default',
          workflow_id: workflowId,
          run_id: startInfo.runId,
          query_name: 'currentState',
          args: [],
        }

        const resultBytes = await withRetry(async () => native.queryWorkflow(client, queryRequest), maxAttempts, waitMs)

        const result = await decodeQueryResult(resultBytes)
        expect(result).toBe('initial-state')
      } finally {
        native.clientShutdown(client)
      }
    })

    test('queryWorkflow surfaces errors for unknown workflow', async () => {
      const client = await native.createClient(runtime, {
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
        identity: 'bun-integration-client',
      })

      try {
        await expect(
          native.queryWorkflow(client, {
            namespace: 'default',
            workflow_id: 'missing-workflow-id',
            run_id: 'missing-run-id',
            query_name: 'currentState',
            args: [],
          }),
        ).rejects.toThrow()
      } finally {
        native.clientShutdown(client)
      }
    })

    test('custom data converter handles start, signal, query, and failure paths', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }

      const originalEnv = {
        TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
        TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE,
        TEMPORAL_TASK_QUEUE: process.env.TEMPORAL_TASK_QUEUE,
        TEMPORAL_ALLOW_INSECURE: process.env.TEMPORAL_ALLOW_INSECURE,
      }

      process.env.TEMPORAL_ADDRESS = workerAddress
      process.env.TEMPORAL_NAMESPACE = 'default'
      process.env.TEMPORAL_TASK_QUEUE = taskQueue

      const payloadConverter = new PrefixingPayloadConverter()
      let client: Awaited<ReturnType<typeof createTemporalClient>>['client'] | undefined
      let shutdown = false

      try {
        const dataConverter = createDataConverter({ payloadConverter })
        const created = await createTemporalClient({ dataConverter })
        client = created.client
        if (!client) {
          throw new Error('Failed to create Temporal client')
        }

        const workflowId = `codec-workflow-${Date.now()}`
        const start = await client.workflow.start({
          workflowId,
          workflowType: 'queryWorkflowSample',
          taskQueue,
          args: ['initial-state'],
        })
        expect(payloadConverter.encodedValues).toContain('initial-state')

        await client.workflow.signal(start.handle, 'setState', 'updated-state')
        expect(payloadConverter.encodedValues).toContain('updated-state')

        const maxAttempts = 10
        const waitMs = 500
        const state = await withRetry(async () => {
          return client.workflow.query(start.handle, 'currentState')
        }, maxAttempts, waitMs)

        expect(state).toBe('updated-state')
        expect(payloadConverter.decodedValues.some((value) => value === 'codec:updated-state')).toBe(true)

        await expect(client.workflow.query(start.handle, 'missingQuery')).rejects.toThrow()

        await client.shutdown()
        shutdown = true
      } finally {
        if (client && !shutdown) {
          try {
            await client.shutdown()
          } catch {
            // ignore shutdown errors during cleanup
          }
        }
        restoreEnv(originalEnv)
      }
    })

    test('pending handle executor reuses bounded thread pool under burst load', async () => {
      if (!workerProcess) {
        console.log('Skipping test: worker not available')
        return
      }

      const workerCount = native.pendingExecutorWorkerCount(runtime)
      const queueCapacity = native.pendingExecutorQueueCapacity(runtime)
      expect(workerCount).toBeGreaterThan(0)
      expect(queueCapacity).toBeGreaterThanOrEqual(workerCount)

      const baselineThreads = await readThreadCount()

      const maxAttempts = 10
      const waitMs = 250
      const client = await withRetry(
        async () =>
          native.createClient(runtime, {
            address: temporalAddress,
            namespace: 'default',
            identity: 'bun-integration-client-pool',
          }),
        maxAttempts,
        waitMs,
      )

      try {
        const burstSize = Math.max(workerCount * 3, 12)
        await Promise.all(
          Array.from({ length: burstSize }, () =>
            withRetry(() => native.describeNamespace(client, 'default'), maxAttempts, waitMs),
          ),
        )
      } finally {
        native.clientShutdown(client)
      }

      const afterThreads = await readThreadCount()
      if (baselineThreads !== null && afterThreads !== null) {
        const allowance = Math.max(workerCount, 4)
        expect(afterThreads).toBeLessThanOrEqual(baselineThreads + workerCount + allowance)
      }
    })
  })
}

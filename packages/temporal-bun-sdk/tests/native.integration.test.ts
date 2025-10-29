import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { importNativeBridge } from './helpers/native-bridge'
import { isTemporalServerAvailable, parseTemporalAddress } from './helpers/temporal-server'
import { withRetry, waitForWorkerReady } from './helpers/retry'

const { module: nativeBridge } = await importNativeBridge()

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
          const curr = JSON.parse(decoder.decode(stateBytes)) as string
          if (curr !== 'updated') throw new Error('state not updated yet')
          return curr
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
          const value = JSON.parse(decoder.decode(bytes)) as string
          if (value !== 'updated-state') {
            throw new Error(`state not updated yet: ${value}`)
          }
          return value
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

          const { Connection, WorkflowClient, WorkflowExecutionCancelledError } = temporalClient
          connection = await Connection.connect({ address: workerAddress })
          const workflowClient = new WorkflowClient({ connection, namespace: 'default' })
          const handle = workflowClient.getHandle(workflowId)

          let threw = false
          try {
            await handle.result()
          } catch (err) {
            threw = true
            expect(err).toBeInstanceOf(WorkflowExecutionCancelledError)
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

    test('queryWorkflow returns JSON payload for running workflow', async () => {
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

        const result = JSON.parse(decoder.decode(resultBytes)) as string
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
  })
}

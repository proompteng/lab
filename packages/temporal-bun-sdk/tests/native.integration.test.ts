import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { native } from '../src/internal/core-bridge/native.ts'

const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'

const suite = shouldRun ? describe : describe.skip

suite('native bridge integration', () => {
  let runtime: ReturnType<typeof native.createRuntime>
  let workerProcess: ReturnType<typeof Bun.spawn> | undefined
  const taskQueue = 'bun-sdk-query-tests'
  const decoder = new TextDecoder()

  beforeAll(async () => {
    runtime = native.createRuntime({})

    const workerScript = fileURLToPath(new URL('./worker/run-query-worker.mjs', import.meta.url))
    workerProcess = Bun.spawn(['node', workerScript], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TEMPORAL_ADDRESS: '127.0.0.1:7233',
        TEMPORAL_NAMESPACE: 'default',
        TEMPORAL_TASK_QUEUE: taskQueue,
      },
    })

    if (!workerProcess.stdout) {
      throw new Error('Failed to capture worker stdout')
    }

    await waitForWorkerReady(workerProcess)
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
    const maxAttempts = 10
    const waitMs = 500

    const client = await withRetry(
      async () => {
        return native.createClient(runtime, {
          address: 'http://127.0.0.1:7233',
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

  test('queryWorkflow returns JSON payload for running workflow', async () => {
    const maxAttempts = 10
    const waitMs = 500

    const client = await withRetry(
      async () => {
        return native.createClient(runtime, {
          address: 'http://127.0.0.1:7233',
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
          query_name: 'currentState',
          args: [],
        }),
      ).rejects.toThrow()
    } finally {
      native.clientShutdown(client)
    }
  })
})

async function withRetry<T>(fn: () => T | Promise<T>, attempts: number, waitMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      await Bun.sleep(waitMs)
    }
  }
  throw lastError
}

async function waitForWorkerReady(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 10_000): Promise<void> {
  const reader = proc.stdout?.getReader()
  if (!reader) {
    throw new Error('Worker stdout is not readable')
  }

  const decoder = new TextDecoder()
  const start = Date.now()
  let buffer = ''

  while (Date.now() - start < timeoutMs) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes('worker-ready')) {
      reader.releaseLock()
      return
    }
  }

  reader.releaseLock()

  throw new Error(`Worker did not become ready within ${timeoutMs}ms. stdout="${buffer}"`)
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { bridgeVariant, native } from '../src/internal/core-bridge/native.ts'
import { isTemporalServerAvailable, parseTemporalAddress } from './helpers/temporal-server'

const usingZigBridge = bridgeVariant === 'zig'
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

if (usingZigBridge) {
  console.warn(
    'Skipping native bridge integration tests: Zig bridge scaffold does not yet implement live Temporal RPCs',
  )
} else if (shouldRun && !serverAvailable) {
  console.warn(`Skipping native bridge integration tests: Temporal server unavailable at ${temporalAddress}`)
}

const suite = shouldRun && serverAvailable && !usingZigBridge ? describe : describe.skip // TODO(codex, zig-cl-02): enable once Zig bridge wires live Temporal RPCs
const workerAddress = (() => {
  const { host, port } = parseTemporalAddress(temporalAddress)
  return `${host}:${port}`
})()

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
        TEMPORAL_ADDRESS: workerAddress,
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

async function waitForWorkerReady(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 30_000): Promise<void> {
  const stdoutReader = proc.stdout?.getReader()
  if (!stdoutReader) {
    throw new Error('Worker stdout is not readable')
  }

  const stderrReader = proc.stderr?.getReader()
  const decoder = new TextDecoder()
  let stdoutBuffer = ''
  let stderrBuffer = ''
  const start = Date.now()

  let stdoutPromise = stdoutReader.read()
  let stderrPromise = stderrReader?.read()

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start
    const remaining = Math.max(0, timeoutMs - elapsed)

    const tasks: Array<Promise<{ kind: 'tick' | 'stdout' | 'stderr'; value?: Uint8Array; done?: boolean }>> = [
      Bun.sleep(Math.min(remaining, 250)).then(() => ({ kind: 'tick' as const })),
      stdoutPromise.then((result) => ({ kind: 'stdout' as const, value: result.value, done: result.done })),
    ]

    if (stderrPromise) {
      tasks.push(stderrPromise.then((result) => ({ kind: 'stderr' as const, value: result.value, done: result.done })))
    }

    const result = await Promise.race(tasks)

    if (result.kind === 'stdout') {
      if (result.done) {
        break
      }
      if (result.value) {
        stdoutBuffer += decoder.decode(result.value, { stream: true })
        if (stdoutBuffer.includes('worker-ready')) {
          stdoutReader.releaseLock()
          stderrReader?.releaseLock()
          return
        }
      }
      stdoutPromise = stdoutReader.read()
      continue
    }

    if (result.kind === 'stderr') {
      if (result.done) {
        stderrPromise = undefined
      } else if (result.value) {
        stderrBuffer += decoder.decode(result.value, { stream: true })
        stderrPromise = stderrReader?.read()
      }
      continue
    }

    if (proc.killed || proc.exitCode !== null) {
      break
    }
  }

  stdoutReader.releaseLock()
  stderrReader?.releaseLock()

  throw new Error(
    `Worker did not become ready within ${timeoutMs}ms. stdout="${stdoutBuffer.trim()}" stderr="${stderrBuffer.trim()}"`,
  )
}

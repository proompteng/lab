process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

const { afterAll, beforeAll, describe, expect, test } = await import('bun:test')
const { createTemporalClient } = await import('../src/client')
const { importNativeBridge } = await import('./helpers/native-bridge')
const { isTemporalServerAvailable, parseTemporalAddress } = await import('./helpers/temporal-server')
const { fileURLToPath } = await import('node:url')

const { module: nativeBridge, isStub } = await importNativeBridge()

const decoder = new TextDecoder()
const usingZigBridge = Boolean(nativeBridge) && nativeBridge.bridgeVariant === 'zig' && !isStub
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

if (shouldRun && !serverAvailable) {
  console.warn(`Skipping zig bridge workflow signal tests: Temporal server unavailable at ${temporalAddress}`)
}

const suite = usingZigBridge && shouldRun && serverAvailable ? describe : describe.skip

suite('zig bridge workflow signals', () => {
  const taskQueue = 'zig-signal-tests'
  const { host, port } = parseTemporalAddress(temporalAddress)
  const workerAddress = `${host}:${port}`

  let client: Awaited<ReturnType<typeof createTemporalClient>>['client'] | null = null
  let workerProcess: ReturnType<typeof Bun.spawn> | null = null

  beforeAll(async () => {
    if (!usingZigBridge) return

    const workerScript = fileURLToPath(new URL('./worker/run-query-worker.mjs', import.meta.url))

    try {
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
    } catch (error) {
      console.warn('Skipping zig signal tests: worker dependencies not available', error)
      workerProcess = null
      return
    }

    const config = {
      host,
      port,
      address: temporalAddress,
      namespace: 'default',
      taskQueue,
      apiKey: undefined,
      tls: undefined,
      allowInsecureTls: false,
      workerIdentity: 'zig-signal-client',
      workerIdentityPrefix: 'temporal-bun-worker',
    }

    const result = await createTemporalClient({ config })
    client = result.client
  })

  afterAll(async () => {
    if (client) {
      await client.shutdown()
    }

    if (workerProcess) {
      try {
        workerProcess.kill()
      } catch (error) {
        console.error('Failed to terminate worker process', error)
      }
      try {
        await workerProcess.exited
      } catch {
        // ignore
      }
    }
  })

  test('signals update workflow state via Temporal core', async () => {
    if (!client || !workerProcess) {
      console.log('Skipping test: client or worker unavailable')
      return
    }

    const workflowId = `zig-signal-${Date.now()}`
    const startResult = await client.workflow.start({
      workflowId,
      workflowType: 'queryWorkflowSample',
      taskQueue,
      args: ['initial'],
    })

    const handle = startResult.handle

    await expect(client.workflow.signal(handle, 'setState', 'updated')).resolves.toBeUndefined()

    const state = await withRetry(async () => {
      const value = await client.workflow.query(handle, 'currentState')
      if (value !== 'updated') {
        throw new Error(`state not updated yet: ${value as string}`)
      }
      return value as string
    }, 10, 500)

    expect(state).toBe('updated')
  })

  test('signalWorkflow surfaces not found errors', async () => {
    if (!client || !workerProcess) {
      console.log('Skipping test: client or worker unavailable')
      return
    }

    await expect(
      client.workflow.signal(
        {
          workflowId: 'missing-workflow',
          namespace: 'default',
        },
        'setState',
      ),
    ).rejects.toThrow('workflow not found')
  })
})

async function withRetry<T>(fn: () => Promise<T>, attempts: number, waitMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) {
        break
      }
      await Bun.sleep(waitMs)
    }
  }
  throw lastError
}

async function waitForWorkerReady(worker: ReturnType<typeof Bun.spawn>) {
  if (!worker.stdout) {
    throw new Error('Worker stdout not available')
  }

  const reader = worker.stdout.getReader()

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Worker readiness timeout after 3s')), 3000)
  })

  try {
    await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done || !value) {
            throw new Error('Worker exited before signaling readiness')
          }
          const text = decoder.decode(value)
          if (text.includes('Worker ready')) {
            break
          }
        }
      })(),
      timeout,
    ])
  } finally {
    reader.releaseLock()
  }
}

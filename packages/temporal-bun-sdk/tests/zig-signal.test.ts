process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

const { afterAll, beforeAll, describe, expect, test } = await import('bun:test')
const { createTemporalClient } = await import('../src/client')
const { importNativeBridge } = await import('./helpers/native-bridge')
const { isTemporalServerAvailable, parseTemporalAddress } = await import('./helpers/temporal-server')
const { withRetry, waitForWorkerReady } = await import('./helpers/retry')
const { fileURLToPath } = await import('node:url')

const { module: nativeBridge, isStub } = await importNativeBridge()

type TemporalClientHandle = Awaited<ReturnType<typeof createTemporalClient>>['client']
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

  let client: TemporalClientHandle | null = null
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

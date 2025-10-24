process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

const { afterAll, beforeAll, describe, expect, test } = await import('bun:test')
const { createTemporalClient } = await import('../src/client')
const { importNativeBridge } = await import('./helpers/native-bridge')

const { module: nativeBridge, isStub } = await importNativeBridge()

const usingZigBridge = Boolean(nativeBridge) && nativeBridge.bridgeVariant === 'zig' && !isStub
const zigSuite = usingZigBridge ? describe : describe.skip

zigSuite('zig bridge workflow signals', () => {
  let client: Awaited<ReturnType<typeof createTemporalClient>>['client']

  beforeAll(async () => {
    const config = {
      host: '127.0.0.1',
      port: 7233,
      address: 'http://127.0.0.1:7233',
      namespace: 'default',
      taskQueue: 'zig-signal-tests',
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
  })

  test('signalWorkflow resolves after pending handle ack', async () => {
    await expect(
      client.workflow.signal(
        {
          workflowId: 'zig-workflow',
          namespace: 'default',
        },
        'example-signal',
        { ok: true },
      ),
    ).resolves.toBeUndefined()
  })

  test('signalWorkflow surfaces not found errors', async () => {
    await expect(
      client.workflow.signal(
        {
          workflowId: 'missing-workflow',
          namespace: 'default',
        },
        'example-signal',
      ),
    ).rejects.toThrow('workflow not found')
  })
})

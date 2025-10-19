process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

const { afterAll, beforeAll, describe, expect, test } = await import('bun:test')
const { bridgeVariant, native } = await import('../src/internal/core-bridge/native.ts')

const usingZigBridge = bridgeVariant === 'zig'
const zigSuite = usingZigBridge ? describe : describe.skip

zigSuite('zig bridge worker creation', () => {
  let runtime: ReturnType<typeof native.createRuntime> | undefined
  let client: Awaited<ReturnType<typeof native.createClient>> | undefined

  beforeAll(async () => {
    runtime = native.createRuntime({})
    client = await native.createClient(runtime, {
      address: 'http://127.0.0.1:7233',
      namespace: 'default',
      identity: 'zig-worker-test',
    })
  })

  afterAll(async () => {
    if (client) {
      native.clientShutdown(client)
      client = undefined
    }
    if (runtime) {
      native.runtimeShutdown(runtime)
      runtime = undefined
    }
  })

  test('createWorker returns native handle', async () => {
    if (!runtime || !client) {
      throw new Error('native runtime/client were not initialized')
    }
    const worker = await native.createWorker(runtime, client, {
      namespace: 'default',
      taskQueue: 'zig-worker-tests',
    })
    expect(worker.handle).toBeGreaterThan(0)
    native.workerShutdown(worker)
  })

  test('createWorker rejects invalid config', async () => {
    if (!runtime || !client) {
      throw new Error('native runtime/client were not initialized')
    }
    await expect(
      native.createWorker(runtime, client, {
        taskQueue: 'zig-worker-tests',
      }),
    ).rejects.toThrow()
  })
})

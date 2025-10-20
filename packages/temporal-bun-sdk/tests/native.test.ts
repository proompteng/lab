import { describe, expect, test } from 'bun:test'
import type { Runtime } from '../src/internal/core-bridge/native.ts'
import { bridgeVariant, NativeBridgeError, native } from '../src/internal/core-bridge/native.ts'
import { isTemporalServerAvailable } from './helpers/temporal-server'

const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const wantsLiveTemporalServer = process.env.TEMPORAL_TEST_SERVER === '1'
const hasLiveTemporalServer = wantsLiveTemporalServer && (await isTemporalServerAvailable(temporalAddress))
const usingZigBridge = bridgeVariant === 'zig'
const connectivityTest = test
const zigOnlyTest = usingZigBridge ? test : test.skip

if (wantsLiveTemporalServer && !hasLiveTemporalServer) {
  console.warn(`Temporal server requested but unreachable at ${temporalAddress}; falling back to negative expectations`)
}

describe('native bridge', () => {
  test('create and shutdown runtime', () => {
    const runtime = native.createRuntime({})
    expect(runtime.type).toBe('runtime')
    expect(typeof runtime.handle).toBe('number')
    native.runtimeShutdown(runtime)
  })

  connectivityTest('client connect respects server availability', async () => {
    const runtime = native.createRuntime({})
    try {
      const connect = () =>
        native.createClient(runtime, {
          address: temporalAddress,
          namespace: 'default',
        })

      if (hasLiveTemporalServer) {
        const client = await withRetry(connect, 10, 500)
        expect(client.type).toBe('client')
        expect(typeof client.handle).toBe('number')
        native.clientShutdown(client)
      } else {
        await expect(connect()).rejects.toThrow()
      }
    } finally {
      native.runtimeShutdown(runtime)
    }
  })

  connectivityTest('client connect errors on unreachable host', async () => {
    const runtime = native.createRuntime({})
    try {
      await expect(
        native.createClient(runtime, {
          address: 'http://127.0.0.1:65535',
          namespace: 'default',
        }),
      ).rejects.toThrow()
    } finally {
      native.runtimeShutdown(runtime)
    }
  })

  zigOnlyTest('createClient surfaces structured NativeBridgeError when runtime is null', async () => {
    const invalidRuntime = { type: 'runtime', handle: 0 } as Runtime
    let caught: unknown
    try {
      await native.createClient(invalidRuntime, {
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(NativeBridgeError)
    const nativeError = caught as NativeBridgeError | undefined
    expect(nativeError?.code).toBe(3)
    expect(nativeError?.message).toContain('connectAsync received null runtime handle')
    expect(JSON.parse(nativeError?.raw ?? '{}')).toMatchObject({ code: 3 })
  })

  zigOnlyTest('queryWorkflow pending failures propagate structured NativeBridgeError', async () => {
    const runtime = native.createRuntime({})
    let client: Awaited<ReturnType<typeof native.createClient>> | undefined
    try {
      client = await native.createClient(runtime, {
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      let caught: unknown
      try {
        await native.queryWorkflow(client, {
          namespace: 'default',
          workflow_id: 'wf-missing',
          query_name: 'state',
          args: [],
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(NativeBridgeError)
      const nativeError = caught as NativeBridgeError | undefined
      expect(nativeError?.code).toBe(12)
      expect(nativeError?.message).toContain('queryWorkflow is not implemented yet')
      expect(JSON.parse(nativeError?.raw ?? '{}')).toMatchObject({ code: 12 })
    } finally {
      if (client) {
        native.clientShutdown(client)
      }
      native.runtimeShutdown(runtime)
    }
  })

  zigOnlyTest('updateClientHeaders surfaces structured NativeBridgeError', async () => {
    const runtime = native.createRuntime({})
    let client: Awaited<ReturnType<typeof native.createClient>> | undefined
    try {
      client = await native.createClient(runtime, {
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      let caught: unknown
      try {
        native.updateClientHeaders(client, { authorization: 'Bearer token' })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(NativeBridgeError)
      const nativeError = caught as NativeBridgeError | undefined
      expect(nativeError?.code).toBe(12)
      expect(nativeError?.message).toContain('updateHeaders is not implemented yet')
      expect(JSON.parse(nativeError?.raw ?? '{}')).toMatchObject({ code: 12 })
    } finally {
      if (client) {
        native.clientShutdown(client)
      }
      native.runtimeShutdown(runtime)
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

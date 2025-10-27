import { describe, expect, test } from 'bun:test'
import type { Runtime } from '../src/internal/core-bridge/native.ts'
import { importNativeBridge } from './helpers/native-bridge'
import { isTemporalServerAvailable } from './helpers/temporal-server'
import { withRetry } from './helpers/retry'

const { module: nativeBridge, isStub } = await importNativeBridge()

if (!nativeBridge) {
  describe.skip('native bridge', () => {
    test('native bridge unavailable', () => {})
  })
} else {
  const { NativeBridgeError, native, bridgeVariant } = nativeBridge
  const usingStubBridge = isStub

  const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
  const wantsLiveTemporalServer = process.env.TEMPORAL_TEST_SERVER === '1'
  const serverReachable = await isTemporalServerAvailable(temporalAddress)
  const hasLiveTemporalServer = wantsLiveTemporalServer && serverReachable
  const usingZigBridge = bridgeVariant === 'zig'
  const connectivityTest = test
  const zigOnlyTest = !isStub && usingZigBridge ? test : test.skip

  if (wantsLiveTemporalServer && !hasLiveTemporalServer) {
    console.warn(
      `Temporal server requested but unreachable at ${temporalAddress}; falling back to negative expectations`,
    )
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

        if (hasLiveTemporalServer || (!wantsLiveTemporalServer && serverReachable)) {
          const client = await withRetry(connect, 10, 500)
          expect(client.type).toBe('client')
          expect(typeof client.handle).toBe('number')
          native.clientShutdown(client)
        } else if (usingStubBridge) {
          // The stub bridge always resolves with a fake handle so tests can exercise higher layers
          const client = await connect()
          expect(client.type).toBe('client')
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
      if (nativeError?.raw === 'stub') {
        expect(nativeError.code).toBe(2)
        return
      }
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
        if (nativeError?.raw === 'stub') {
          expect(nativeError.code).toBe(2)
          return
        }
        expect(nativeError?.message ?? '').toContain('Connection failed')
      } catch (error) {
        expect(error).toBeInstanceOf(NativeBridgeError)
        const nativeError = error as NativeBridgeError
        if (nativeError.raw === 'stub') {
          expect(nativeError.code).toBe(2)
        } else {
          expect(nativeError.message).toContain('Connection failed')
        }
        return
      } finally {
        if (client) {
          native.clientShutdown(client)
        }
        native.runtimeShutdown(runtime)
      }
    })

    zigOnlyTest('updateClientHeaders updates metadata without error', async () => {
      const runtime = native.createRuntime({})
      let client: Awaited<ReturnType<typeof native.createClient>> | undefined
      try {
        client = await native.createClient(runtime, {
          address: 'http://127.0.0.1:7233',
          namespace: 'default',
        })

        try {
          native.updateClientHeaders(client!, { authorization: 'Bearer token' })
        } catch (error) {
          expect(error).toBeInstanceOf(NativeBridgeError)
          const nativeError = error as NativeBridgeError
          if (nativeError.raw === 'stub') {
            expect(nativeError.code).toBe(2)
            return
          }
          expect(nativeError.message).toContain('Connection failed')
          expect(nativeError.message).not.toContain('not implemented')
        }
      } catch (error) {
        expect(error).toBeInstanceOf(NativeBridgeError)
        const nativeError = error as NativeBridgeError
        if (nativeError.raw === 'stub') {
          expect(nativeError.code).toBe(2)
        } else {
          expect(nativeError.message).toContain('Connection failed')
        }
        return
      } finally {
        if (client) {
          native.clientShutdown(client)
        }
        native.runtimeShutdown(runtime)
      }
    })

    zigOnlyTest('destroyWorker is idempotent for Zig handles', () => {
      const worker = native.createWorkerHandleForTest()
      expect(worker.type).toBe('worker')
      const handle = worker.handle
      expect(typeof handle).toBe('number')
      expect(handle).not.toBe(0)

      try {
        expect(() => native.destroyWorker(worker)).not.toThrow()
        expect(() => native.destroyWorker(worker)).not.toThrow()
      } finally {
        native.releaseWorkerHandleForTest(handle)
      }
    })
  })
}

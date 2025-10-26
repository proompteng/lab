import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Client, __TEST__ as clientTest, createClient, normalizeTemporalAddress } from '../src/core-bridge/client.ts'
import { createRuntime, __TEST__ as runtimeTest } from '../src/core-bridge/runtime.ts'
import { importNativeBridge } from './helpers/native-bridge'
import { withRetry } from './helpers/retry'

const { module: nativeBridge } = await importNativeBridge()

if (!nativeBridge) {
  describe.skip('core bridge runtime wrapper', () => {
    test('native bridge unavailable', () => {})
  })

  describe.skip('core bridge client wrapper', () => {
    test('native bridge unavailable', () => {})
  })

  describe.skip('core bridge client integration', () => {
    test('native bridge unavailable', () => {})
  })
} else {
  const { bridgeVariant, native } = nativeBridge

  const hasLiveServer = process.env.TEMPORAL_TEST_SERVER === '1'
  const _usingZigBridge = bridgeVariant === 'zig'
  const reachabilityTest = test

  describe('core bridge runtime wrapper', () => {
    test('shutdown is idempotent and prevents reuse', async () => {
      const runtime = createRuntime()
      await runtime.shutdown()
      await runtime.shutdown()
      expect(() => runtime.nativeHandle).toThrowError('Runtime has already been shut down')
    })
  })

  const integrationSuite = hasLiveServer ? describe : describe.skip

  describe('core bridge client wrapper', () => {
    test('normalizes addresses with protocol inference', () => {
      expect(normalizeTemporalAddress('127.0.0.1:7233')).toBe('http://127.0.0.1:7233')
      expect(normalizeTemporalAddress('127.0.0.1:7233', true)).toBe('https://127.0.0.1:7233')
      expect(normalizeTemporalAddress('https://example.com:443')).toBe('https://example.com:443')
    })

    reachabilityTest('connect rejects when Temporal server is unreachable', async () => {
      const runtime = createRuntime()
      try {
        await expect(
          Client.connect(runtime, {
            address: '127.0.0.1:65532',
            namespace: 'default',
          }),
        ).rejects.toThrow()
      } finally {
        await runtime.shutdown()
      }
    })

    test('serializeTlsOptions emits camelCase payload and keeps legacy aliases', () => {
      const payload = clientTest.serializeTlsOptions({
        serverRootCACertificate: 'ca-base64',
        clientCert: 'cert-base64',
        clientPrivateKey: 'key-base64',
        serverNameOverride: 'tls.example',
      })

      expect(payload).toEqual(
        expect.objectContaining({
          serverRootCACertificate: 'ca-base64',
          server_root_ca_cert: 'ca-base64',
          serverNameOverride: 'tls.example',
          server_name_override: 'tls.example',
          clientCertPair: {
            crt: 'cert-base64',
            key: 'key-base64',
          },
          client_cert: 'cert-base64',
          client_private_key: 'key-base64',
        }),
      )
    })

    test('serializeTlsOptions handles partial TLS inputs', () => {
      expect(
        clientTest.serializeTlsOptions({
          serverRootCACertificate: 'ca-only',
          serverNameOverride: 'tls.example',
          clientCert: 'cert-only',
        }),
      ).toEqual({
        serverRootCACertificate: 'ca-only',
        server_root_ca_cert: 'ca-only',
        serverNameOverride: 'tls.example',
        server_name_override: 'tls.example',
        clientCert: 'cert-only',
        client_cert: 'cert-only',
      })

      expect(
        clientTest.serializeTlsOptions({
          serverNameOverride: 'tls.example',
          clientPrivateKey: 'key-only',
        }),
      ).toEqual({
        serverNameOverride: 'tls.example',
        server_name_override: 'tls.example',
        clientPrivateKey: 'key-only',
        client_private_key: 'key-only',
      })
    })

    test('describeNamespace proxies native calls and shutdown', async () => {
      const originalCreateRuntime = native.createRuntime
      const originalRuntimeShutdown = native.runtimeShutdown
      const originalCreateClient = native.createClient
      const originalDescribe = native.describeNamespace
      const originalClientShutdown = native.clientShutdown

      const runtimeHandle = { type: 'runtime', handle: 101 } as ReturnType<typeof native.createRuntime>
      const clientHandle = { type: 'client', handle: 202 } as Awaited<ReturnType<typeof native.createClient>>

      const runtimeShutdownMock = mock(() => {})
      const clientShutdownMock = mock(() => {})
      const describeMock = mock(async () => new Uint8Array([42]))

      native.createRuntime = mock(() => runtimeHandle)
      native.runtimeShutdown = runtimeShutdownMock
      const createClientMock = mock(async (_runtime: typeof runtimeHandle, payload: Record<string, unknown>) => {
        expect(payload.address).toBe('http://127.0.0.1:7233')
        expect(payload.namespace).toBe('default')
        expect(payload.api_key).toBeUndefined()
        expect(payload.tls).toBeUndefined()
        return clientHandle
      })
      native.createClient = createClientMock as typeof native.createClient
      native.describeNamespace = describeMock
      native.clientShutdown = clientShutdownMock

      try {
        const runtime = createRuntime()
        const client = await createClient(runtime, {
          address: '127.0.0.1:7233',
          namespace: 'default',
        })

        const result = await client.describeNamespace('custom')
        expect(Array.from(result)).toEqual([42])

        await client.shutdown()
        await runtime.shutdown()

        expect(describeMock).toHaveBeenCalledWith(clientHandle, 'custom')
        expect(clientShutdownMock).toHaveBeenCalledTimes(1)
        expect(runtimeShutdownMock).toHaveBeenCalledTimes(1)
      } finally {
        native.createRuntime = originalCreateRuntime
        native.runtimeShutdown = originalRuntimeShutdown
        native.createClient = originalCreateClient
        native.describeNamespace = originalDescribe
        native.clientShutdown = originalClientShutdown
      }
    })

    test('runtime finalizer swallows native shutdown errors', () => {
      const originalRuntimeShutdown = native.runtimeShutdown
      native.runtimeShutdown = mock(() => {
        throw new Error('finalizer-failure')
      })

      expect(() => runtimeTest.finalizeRuntime({ type: 'runtime', handle: 99 } as any)).not.toThrow()

      native.runtimeShutdown = originalRuntimeShutdown
    })

    test('client finalizer swallows native shutdown errors', () => {
      const originalClientShutdown = native.clientShutdown
      native.clientShutdown = mock(() => {
        throw new Error('finalizer-failure')
      })

      expect(() => clientTest.finalizeClient({ type: 'client', handle: 77 } as any)).not.toThrow()

      native.clientShutdown = originalClientShutdown
    })
  })

  integrationSuite('core bridge client integration', () => {
    let runtime: ReturnType<typeof createRuntime>

    beforeAll(() => {
      runtime = createRuntime()
    })

    afterAll(async () => {
      await runtime.shutdown()
    })

    test('describe namespace returns bytes from Temporal', async () => {
      const client = await createClient(runtime, {
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      try {
        const response = await withRetry(() => client.describeNamespace('default'), 10, 500)
        expect(response.byteLength).toBeGreaterThan(0)
      } finally {
        await client.shutdown()
      }
    })

    test('client shutdown is idempotent', async () => {
      const client = await createClient(runtime, {
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      await client.shutdown()
      await client.shutdown()
      await expect(client.describeNamespace('default')).rejects.toThrowError('Client has already been shut down')
    })
  })
}

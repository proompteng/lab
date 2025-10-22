import { describe, expect, mock, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { handleCheck } from '../src/bin/temporal-bun.ts'
import type { TemporalConfig } from '../src/config.ts'

type NativeBridge = typeof import('../src/internal/core-bridge/native').native

const baseConfig: TemporalConfig = {
  host: '127.0.0.1',
  port: 7233,
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'prix',
  apiKey: 'test-api-key',
  tls: {
    serverRootCACertificate: Buffer.from('CA'),
    clientCertPair: {
      crt: Buffer.from('CERT'),
      key: Buffer.from('KEY'),
    },
    serverNameOverride: 'tls.example',
  },
  allowInsecureTls: false,
  workerIdentity: 'test-worker-123',
  workerIdentityPrefix: 'test-worker',
}

const originalConsoleLog = console.log
const originalConsoleError = console.error

describe('temporal-bun check command', () => {
  test('logs success when Temporal namespace is reachable', async () => {
    const runtimeHandle = { type: 'runtime' as const, handle: 101 }
    const clientHandle = { type: 'client' as const, handle: 202 }

    const nativeBridge = {
      createRuntime: mock(() => runtimeHandle),
      runtimeShutdown: mock(() => {}),
      createClient: mock(async () => clientHandle),
      clientShutdown: mock(() => {}),
      describeNamespace: mock(async () => new Uint8Array([1, 2, 3])),
    }

    const logSpy = mock(() => {})

    console.log = logSpy

    try {
      await handleCheck(
        [],
        {},
        {
          loadConfig: async () => baseConfig,
          nativeBridge: nativeBridge as unknown as NativeBridge,
        },
      )

      expect(nativeBridge.createRuntime).toHaveBeenCalledTimes(1)
      expect(nativeBridge.createClient).toHaveBeenCalledWith(
        runtimeHandle,
        expect.objectContaining({
          address: 'https://127.0.0.1:7233',
          namespace: 'default',
          apiKey: 'test-api-key',
          allowInsecureTls: false,
          tls: {
            serverRootCACertificate: Buffer.from('CA').toString('base64'),
            serverNameOverride: 'tls.example',
            clientCertPair: {
              crt: Buffer.from('CERT').toString('base64'),
              key: Buffer.from('KEY').toString('base64'),
            },
          },
        }),
      )
      expect(nativeBridge.describeNamespace).toHaveBeenCalledWith(clientHandle, 'default')
      expect(nativeBridge.clientShutdown).toHaveBeenCalledWith(clientHandle)
      expect(nativeBridge.runtimeShutdown).toHaveBeenCalledWith(runtimeHandle)
      expect(logSpy.mock.calls[0][0]).toContain('Temporal connection successful.')
    } finally {
      console.log = originalConsoleLog
    }
  })

  test('throws contextual error when connection fails', async () => {
    const runtimeHandle = { type: 'runtime' as const, handle: 101 }

    const nativeBridge = {
      createRuntime: mock(() => runtimeHandle),
      runtimeShutdown: mock(() => {}),
      createClient: mock(async () => {
        throw new Error('boom')
      }),
      clientShutdown: mock(() => {}),
      describeNamespace: mock(async () => new Uint8Array()),
    }

    console.error = mock(() => {})

    try {
      await expect(
        handleCheck(
          [],
          {},
          {
            loadConfig: async () => baseConfig,
            nativeBridge: nativeBridge as unknown as NativeBridge,
          },
        ),
      ).rejects.toThrow('Failed to reach Temporal at 127.0.0.1:7233: boom')
      expect(nativeBridge.runtimeShutdown).toHaveBeenCalledWith(runtimeHandle)
    } finally {
      console.error = originalConsoleError
    }
  })
})

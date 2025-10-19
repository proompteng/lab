import { Buffer } from 'node:buffer'
import { describe, expect, mock, spyOn, test } from 'bun:test'
import type { TemporalConfig } from '../src/config.ts'
import * as configModule from '../src/config.ts'
import * as nativeModule from '../src/internal/core-bridge/native.ts'
import { createTemporalClient } from '../src/client.ts'

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
  allowInsecureTls: true,
  workerIdentity: 'worker-identity-123',
  workerIdentityPrefix: 'temporal-bun-worker',
}

const originalConsoleError = console.error

describe('createTemporalClient', () => {
  test('passes TLS payload and allow_insecure to native client', async () => {
    const runtimeHandle = { type: 'runtime', handle: 10 } as const
    const clientHandle = { type: 'client', handle: 20 } as const

    const createRuntimeSpy = spyOn(nativeModule.native, 'createRuntime').mockReturnValue(runtimeHandle)
    const createClientSpy = spyOn(nativeModule.native, 'createClient').mockResolvedValue(clientHandle)
    const clientShutdownSpy = spyOn(nativeModule.native, 'clientShutdown').mockImplementation(() => {})
    const runtimeShutdownSpy = spyOn(nativeModule.native, 'runtimeShutdown').mockImplementation(() => {})
    const describeNamespaceSpy = spyOn(nativeModule.native, 'describeNamespace').mockResolvedValue(
      new Uint8Array([1, 2]),
    )
    const startWorkflowSpy = spyOn(nativeModule.native, 'startWorkflow').mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ runId: 'run-123', workflowId: 'wf-123', namespace: 'default' })),
    )
    const loadConfigSpy = spyOn(configModule, 'loadTemporalConfig').mockResolvedValue({ ...baseConfig })

    try {
      const { client } = await createTemporalClient()

      expect(createRuntimeSpy).toHaveBeenCalledWith({})
      expect(createClientSpy).toHaveBeenCalledTimes(1)
      const [runtimePtr, clientPayload] = createClientSpy.mock.calls[0]
      expect(runtimePtr).toEqual(runtimeHandle)
      expect(clientPayload.address).toBe('https://127.0.0.1:7233')
      expect(clientPayload.identity).toBe('worker-identity-123')
      expect(clientPayload.allowInsecure).toBe(true)
      expect(clientPayload.tls).toMatchObject({
        server_root_ca_cert: Buffer.from('CA').toString('base64'),
        client_cert: Buffer.from('CERT').toString('base64'),
        client_private_key: Buffer.from('KEY').toString('base64'),
        server_name_override: 'tls.example',
      })

      await client.describeNamespace()
      expect(describeNamespaceSpy).toHaveBeenCalledWith(clientHandle, 'default')

      await client.shutdown()
      expect(clientShutdownSpy).toHaveBeenCalledWith(clientHandle)
      expect(runtimeShutdownSpy).toHaveBeenCalledWith(runtimeHandle)

      // Sanity check startWorkflow path delegates to native bridge.
      const result = await client.workflow.start({
        workflowId: 'wf-id',
        workflowType: 'wf-type',
      })
      expect(startWorkflowSpy).toHaveBeenCalledWith(clientHandle, expect.any(Object))
      expect(result.runId).toBe('run-123')
    } finally {
      createRuntimeSpy.mockRestore()
      createClientSpy.mockRestore()
      clientShutdownSpy.mockRestore()
      runtimeShutdownSpy.mockRestore()
      describeNamespaceSpy.mockRestore()
      startWorkflowSpy.mockRestore()
      loadConfigSpy.mockRestore()
    }
  })
})

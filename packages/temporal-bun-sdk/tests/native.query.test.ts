import { describe, expect, test } from 'bun:test'
import { importNativeBridge } from './helpers/native-bridge'

const { module: nativeBridge, isStub } = await importNativeBridge()

if (!nativeBridge) {
  describe.skip('native query', () => {
    test('skipped - native bridge unavailable', () => {})
  })
} else {
  const { native, bridgeVariant } = nativeBridge
  const usingZig = bridgeVariant === 'zig'
  const zigOnly = !isStub && usingZig ? test : test.skip

  describe('native query', () => {
    zigOnly('queryWorkflow returns JSON bytes for valid request (stubbed core)', async () => {
      const runtime = native.createRuntime({})
      let client: Awaited<ReturnType<typeof native.createClient>> | undefined
      try {
        client = await native.createClient(runtime, {
          address: 'http://127.0.0.1:7233',
          namespace: 'default',
        })

        const bytes = await native.queryWorkflow(client, {
          namespace: 'default',
          workflow_id: 'wf-123',
          query_name: 'state',
          args: [],
        })
        const text = new TextDecoder().decode(bytes)
        expect(text).toContain('ok')
      } finally {
        if (client) native.clientShutdown(client)
        native.runtimeShutdown(runtime)
      }
    })
  })
}

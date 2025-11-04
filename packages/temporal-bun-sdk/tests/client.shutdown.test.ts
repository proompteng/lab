import { describe, expect, mock, test } from 'bun:test'

describe('Temporal Connect client shutdown', () => {
  test('closes the underlying transport', async () => {
    const closeMock = mock(async () => {})

    mock.module('@connectrpc/connect-node', () => ({
      createGrpcTransport: () => ({ close: closeMock }),
    }))

    mock.module('@connectrpc/connect', () => ({
      createClient: () => ({}),
      Code: {},
      ConnectError: class extends Error {},
    }))

    const { createTemporalClient } = await import('../src/client.ts')

    const { client } = await createTemporalClient({
      config: {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'integration-tests',
        allowInsecureTls: false,
        workerIdentity: 'test-1',
        workerIdentityPrefix: 'test',
      },
      identity: 'client',
      taskQueue: 'integration-tests',
    })

    await client.shutdown()

    expect(closeMock).toHaveBeenCalledTimes(1)

    mock.restore()
  })
})

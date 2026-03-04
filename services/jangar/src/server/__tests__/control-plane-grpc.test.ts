import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveGrpcStatus } from '~/server/control-plane-grpc'

const withEnv = async <T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const backup = { ...process.env }
  Object.entries(updates).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  })

  try {
    return await fn()
  } finally {
    process.env = backup
  }
}

const createReusableTcpServer = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  return await new Promise((resolve, reject) => {
    const server = createServer(() => {})

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { address: string; port: number }
      if (typeof port !== 'number') {
        void server.close()
        reject(new Error('failed to resolve ephemeral test port'))
        return
      }

      const close = async () => {
        await new Promise<void>((done) => {
          server.close(() => {
            done()
          })
        })
      }

      resolve({ port, close })
    })
  })
}

describe('resolveGrpcStatus', () => {
  afterEach(() => {
    process.env = { ...process.env }
    delete process.env.JANGAR_GRPC_ENABLED
    delete process.env.JANGAR_GRPC_HOST
    delete process.env.JANGAR_GRPC_PORT
    delete process.env.JANGAR_GRPC_ADDRESS
    delete process.env.JANGAR_GRPC_HEALTH_TIMEOUT_MS
  })

  it('returns disabled when JANGAR_GRPC_ENABLED is off', async () => {
    const status = await withEnv({}, () => resolveGrpcStatus())
    expect(status).toMatchObject({
      enabled: false,
      status: 'disabled',
      message: 'gRPC disabled',
    })
  })

  it('returns degraded when JANGAR_GRPC_ENABLED has an invalid value', async () => {
    const status = await withEnv(
      {
        JANGAR_GRPC_ENABLED: 'bogus',
      },
      () => resolveGrpcStatus(),
    )

    expect(status).toMatchObject({
      enabled: false,
      status: 'degraded',
    })
    expect(status.message).toContain('invalid JANGAR_GRPC_ENABLED value')
  })

  it('returns degraded when JANGAR_GRPC_PORT is malformed and no address override is set', async () => {
    const status = await withEnv(
      {
        JANGAR_GRPC_ENABLED: '1',
        JANGAR_GRPC_PORT: 'abc',
      },
      () => resolveGrpcStatus(),
    )
    expect(status).toMatchObject({
      enabled: true,
      status: 'degraded',
      address: '',
    })
    expect(status.message).toContain('invalid JANGAR_GRPC_PORT')
  })

  it('marks gRPC as degraded when endpoint address is invalid', async () => {
    const status = await withEnv(
      {
        JANGAR_GRPC_ENABLED: '1',
        JANGAR_GRPC_ADDRESS: '127.0.0.1',
      },
      () => resolveGrpcStatus(),
    )
    expect(status.enabled).toBe(true)
    expect(status.status).toBe('degraded')
    expect(status.message).toContain('invalid gRPC address')
  })

  it('returns healthy when enabled endpoint is reachable', async () => {
    const server = await createReusableTcpServer()
    try {
      const status = await withEnv(
        {
          JANGAR_GRPC_ENABLED: '1',
          JANGAR_GRPC_HOST: '127.0.0.1',
          JANGAR_GRPC_PORT: String(server.port),
          JANGAR_GRPC_HEALTH_TIMEOUT_MS: '200',
        },
        () => resolveGrpcStatus(),
      )

      expect(status).toMatchObject({
        enabled: true,
        status: 'healthy',
        address: `127.0.0.1:${server.port}`,
      })
      expect(status.message).toBe('')
    } finally {
      await server.close()
    }
  })
})

import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveGrpcStatus } from '~/server/control-plane-grpc'

const grpcEnvNames = [
  'AGENTS_GRPC_ENABLED',
  'AGENTS_GRPC_HOST',
  'AGENTS_GRPC_PORT',
  'AGENTS_GRPC_ADDRESS',
  'AGENTS_GRPC_HEALTH_TIMEOUT_MS',
] as const

const withEnv = async <T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const backup = { ...process.env }
  for (const key of grpcEnvNames) {
    delete process.env[key]
  }
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
    for (const key of grpcEnvNames) {
      delete process.env[key]
    }
  })

  it('returns disabled when AGENTS_GRPC_ENABLED is absent', async () => {
    const status = await withEnv({}, () => resolveGrpcStatus())
    expect(status).toMatchObject({
      enabled: false,
      status: 'disabled',
      message: 'gRPC disabled',
    })
  })

  it('returns degraded with the canonical env name when AGENTS_GRPC_ENABLED is invalid', async () => {
    const status = await withEnv({ AGENTS_GRPC_ENABLED: 'bogus' }, () => resolveGrpcStatus())

    expect(status).toMatchObject({
      enabled: false,
      status: 'degraded',
    })
    expect(status.message).toContain('invalid AGENTS_GRPC_ENABLED value')
  })

  it('returns degraded when AGENTS_GRPC_PORT is malformed and no address override is set', async () => {
    const status = await withEnv(
      {
        AGENTS_GRPC_ENABLED: '1',
        AGENTS_GRPC_PORT: 'abc',
      },
      () => resolveGrpcStatus(),
    )

    expect(status).toMatchObject({
      enabled: true,
      status: 'degraded',
      address: '',
    })
    expect(status.message).toContain('invalid AGENTS_GRPC_PORT')
  })

  it('marks gRPC as degraded when endpoint address is invalid', async () => {
    const status = await withEnv(
      {
        AGENTS_GRPC_ENABLED: '1',
        AGENTS_GRPC_ADDRESS: '127.0.0.1',
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
          AGENTS_GRPC_ENABLED: '1',
          AGENTS_GRPC_HOST: '127.0.0.1',
          AGENTS_GRPC_PORT: String(server.port),
          AGENTS_GRPC_HEALTH_TIMEOUT_MS: '200',
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

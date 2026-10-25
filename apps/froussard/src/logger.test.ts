import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transportMock = vi.fn(() => ({}))
const multistreamMock = vi.fn((streams: unknown) => streams)
const pinoFn = Object.assign(
  vi.fn((_options: unknown, _streams: unknown) => ({ info: vi.fn(), error: vi.fn() })),
  {
    transport: transportMock,
    stdTimeFunctions: { isoTime: vi.fn() },
  },
)

vi.mock('pino', () => ({
  __esModule: true,
  default: pinoFn,
  multistream: multistreamMock,
}))

const originalEnv = { ...process.env }
delete originalEnv.LGTM_LOKI_ENDPOINT

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value
  }
}

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules()
    transportMock.mockClear()
    multistreamMock.mockClear()
    pinoFn.mockClear()
    resetEnv()
  })

  afterEach(() => {
    resetEnv()
  })

  it('normalises Loki endpoints with and without paths', async () => {
    const { normaliseLokiEndpoint } = await import('./logger')

    expect(normaliseLokiEndpoint('http://loki.example:3100')).toEqual({ host: 'http://loki.example:3100' })
    expect(normaliseLokiEndpoint('http://loki.example:3100/loki/api/v1/push')).toEqual({
      host: 'http://loki.example:3100',
      endpoint: '/loki/api/v1/push',
    })
    expect(normaliseLokiEndpoint('not-a-url')).toEqual({ host: 'not-a-url' })
  })

  it('falls back to stdout logging when LGTM endpoint is absent', async () => {
    await import('./logger')

    expect(transportMock).not.toHaveBeenCalled()
    expect(multistreamMock).toHaveBeenCalledWith(expect.arrayContaining([{ stream: process.stdout }]))
  })

  it('configures pino-loki transport when LGTM endpoint provided', async () => {
    process.env.LGTM_LOKI_ENDPOINT = 'http://loki.example:3100/loki/api/v1/push'
    process.env.OTEL_SERVICE_NAME = 'froussard'
    process.env.OTEL_SERVICE_NAMESPACE = 'froussard'
    process.env.POD_NAME = 'froussard-pod-abc123'

    await import('./logger')

    expect(transportMock).toHaveBeenCalledTimes(1)
    expect(transportMock).toHaveBeenCalledWith({
      target: 'pino-loki',
      options: expect.objectContaining({
        host: 'http://loki.example:3100',
        endpoint: '/loki/api/v1/push',
        replaceTimestamp: true,
        labels: {
          service: 'froussard',
          namespace: 'froussard',
          hostname: 'froussard-pod-abc123',
        },
      }),
    })

    expect(multistreamMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ stream: process.stdout }, { stream: expect.any(Object) }]),
    )
  })
})

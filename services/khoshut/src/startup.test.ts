import { describe, expect, it } from 'bun:test'
import { checkInngestHealth, waitForInngestHealthy } from './startup'

const asFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
  fn as typeof fetch

describe('checkInngestHealth', () => {
  it('returns success when the health endpoint responds with 200', async () => {
    const result = await checkInngestHealth(
      {
        baseUrl: 'http://inngest.example.internal:8288',
        startupRequestTimeoutMs: 1_000,
      },
      asFetch(async () => new Response(JSON.stringify({ status: 200, message: 'OK' }), { status: 200 })),
    )

    expect(result.ok).toBe(true)
    expect(result.url).toBe('http://inngest.example.internal:8288/health')
    expect(result.status).toBe(200)
  })

  it('returns failure details when the health endpoint is unavailable', async () => {
    const result = await checkInngestHealth(
      {
        baseUrl: 'http://inngest.example.internal:8288',
        startupRequestTimeoutMs: 1_000,
      },
      asFetch(async () => {
        throw new Error('connect ECONNREFUSED')
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('ECONNREFUSED')
  })
})

describe('waitForInngestHealthy', () => {
  it('retries until the health endpoint becomes available', async () => {
    let attempts = 0
    let nowValue = 0

    await waitForInngestHealthy(
      {
        baseUrl: 'http://inngest.example.internal:8288',
        startupTimeoutMs: 5_000,
        startupCheckIntervalMs: 250,
        startupRequestTimeoutMs: 1_000,
      },
      {
        fetchImpl: asFetch(async () => {
          attempts += 1
          if (attempts < 3) {
            throw new Error('connect ECONNREFUSED')
          }
          return new Response(JSON.stringify({ status: 200, message: 'OK' }), { status: 200 })
        }),
        delayImpl: async (ms) => {
          nowValue += ms
        },
        now: () => nowValue,
        logger: {
          warn() {},
        },
      },
    )

    expect(attempts).toBe(3)
  })

  it('throws when Inngest never becomes healthy before the deadline', async () => {
    let nowValue = 0

    await expect(
      waitForInngestHealthy(
        {
          baseUrl: 'http://inngest.example.internal:8288',
          startupTimeoutMs: 1_000,
          startupCheckIntervalMs: 500,
          startupRequestTimeoutMs: 250,
        },
        {
          fetchImpl: asFetch(async () => {
            throw new Error('connect ECONNREFUSED')
          }),
          delayImpl: async (ms) => {
            nowValue += ms
          },
          now: () => nowValue,
          logger: {
            warn() {},
          },
        },
      ),
    ).rejects.toThrow('Timed out waiting for Inngest health')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

const buildJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('health route', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    globalThis.fetch = vi.fn(async () =>
      buildJsonResponse({
        status: 'ok',
        service: 'agents',
        agentsController: {
          enabled: true,
          crdsReady: true,
        },
      }),
    ) as unknown as typeof globalThis.fetch
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('keeps Jangar service identity when Agents runtime env leaks into Jangar', async () => {
    process.env.AGENTS_IMAGE = 'registry.example/lab/agents-controller:abc123'

    const { Route } = await import('./health')
    const response = await Route.options.server.handlers.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'jangar',
      agentsService: {
        service: 'agents',
      },
    })
  })

  it('keeps Jangar service identity without Agents runtime env', async () => {
    const { Route } = await import('./health')
    const response = await Route.options.server.handlers.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'jangar',
      agentsController: {
        enabled: true,
        crdsReady: true,
      },
    })
  })

  it('degrades when the Agents service health endpoint is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch

    const { Route } = await import('./health')
    const response = await Route.options.server.handlers.GET()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      service: 'jangar',
      agentsService: {
        status: 'unavailable',
        error: 'connect ECONNREFUSED',
        httpStatus: 0,
      },
      agentsController: {
        enabled: true,
        crdsReady: false,
      },
    })
  })
})

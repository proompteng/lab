import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('crossws/adapters/bun', () => ({
  default: vi.fn(() => ({
    handleUpgrade: vi.fn(async () => null),
    websocket: {},
  })),
}))

import { createAgentsHttpRuntime } from './http-runtime'

const allowedBrowserOrigin = 'https://control-plane.example.test'
let previousCorsAllowedOrigins: string | undefined

beforeEach(() => {
  previousCorsAllowedOrigins = process.env.AGENTS_CORS_ALLOWED_ORIGINS
  process.env.AGENTS_CORS_ALLOWED_ORIGINS = allowedBrowserOrigin
})

afterEach(() => {
  if (previousCorsAllowedOrigins === undefined) delete process.env.AGENTS_CORS_ALLOWED_ORIGINS
  else process.env.AGENTS_CORS_ALLOWED_ORIGINS = previousCorsAllowedOrigins
})

const buildRouteRuntime = () =>
  createAgentsHttpRuntime({
    routeSources: {
      './routes/v1/agent-runs/$id.ts': "export const Route = createFileRoute('/v1/agent-runs/$id')({ server: {} })",
    },
    routeModules: {
      './routes/v1/agent-runs/$id.ts': async () => ({
        Route: {
          options: {
            server: {
              handlers: {
                GET: ({ params }: { params: Record<string, string> }) =>
                  new Response(JSON.stringify({ ok: true, id: params.id }), {
                    headers: { 'content-type': 'application/json' },
                  }),
              },
            },
          },
        },
      }),
    },
  })

describe('Agents HTTP runtime', () => {
  it('registers TanStack-style server route modules with decoded params', async () => {
    const runtime = await buildRouteRuntime()

    const response = await runtime.handleRequest(new Request('http://agents.local/v1/agent-runs/run%201'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, id: 'run 1' })
  })

  it('registers OPTIONS server route handlers', async () => {
    const runtime = await createAgentsHttpRuntime({
      routeSources: {
        './routes/api/agents/messages.ts':
          "export const Route = createFileRoute('/api/agents/messages')({ server: { handlers: { OPTIONS: handler } } })",
      },
      routeModules: {
        './routes/api/agents/messages.ts': async () => ({
          Route: {
            options: {
              server: {
                handlers: {
                  OPTIONS: () => new Response(JSON.stringify({ ok: true })),
                },
              },
            },
          },
        }),
      },
    })

    const response = await runtime.handleRequest(
      new Request('http://agents.local/api/agents/messages', { method: 'OPTIONS' }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('answers CORS preflight for explicitly allowed browser calls to Agents routes', async () => {
    const runtime = await createAgentsHttpRuntime({
      routeSources: {
        './routes/v1/agent-runs.ts':
          "export const Route = createFileRoute('/v1/agent-runs')({ server: { handlers: { POST: handler } } })",
      },
      routeModules: {
        './routes/v1/agent-runs.ts': async () => ({
          Route: {
            options: {
              server: {
                handlers: {
                  POST: () => new Response(JSON.stringify({ ok: true })),
                },
              },
            },
          },
        }),
      },
    })

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/v1/agent-runs', {
        method: 'OPTIONS',
        headers: {
          origin: allowedBrowserOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedBrowserOrigin)
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'accept, authorization, content-type, idempotency-key',
    )
  })

  it('adds CORS response headers to explicitly allowed browser Agents reads', async () => {
    const runtime = await buildRouteRuntime()

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/v1/agent-runs/run%201', {
        headers: { origin: allowedBrowserOrigin },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedBrowserOrigin)
    await expect(response.json()).resolves.toEqual({ ok: true, id: 'run 1' })
  })

  it('does not allow browser Agents reads without explicit CORS configuration', async () => {
    delete process.env.AGENTS_CORS_ALLOWED_ORIGINS
    const runtime = await buildRouteRuntime()

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/v1/agent-runs/run%201', {
        headers: { origin: allowedBrowserOrigin },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('does not add CORS headers to unrelated API routes', async () => {
    const runtime = await createAgentsHttpRuntime({
      routeSources: {
        './routes/api/internal.ts':
          "export const Route = createFileRoute('/api/internal')({ server: { handlers: { GET: handler } } })",
      },
      routeModules: {
        './routes/api/internal.ts': async () => ({
          Route: {
            options: {
              server: {
                handlers: {
                  GET: () => new Response(JSON.stringify({ ok: true })),
                },
              },
            },
          },
        }),
      },
    })

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/api/internal', {
        headers: { origin: allowedBrowserOrigin },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('adds CORS headers to AgentRun POST responses', async () => {
    const runtime = await createAgentsHttpRuntime({
      routeSources: {
        './routes/v1/agent-runs.ts':
          "export const Route = createFileRoute('/v1/agent-runs')({ server: { handlers: { POST: handler } } })",
      },
      routeModules: {
        './routes/v1/agent-runs.ts': async () => ({
          Route: {
            options: {
              server: {
                handlers: {
                  POST: () =>
                    new Response(JSON.stringify({ ok: false, error: 'Idempotency-Key header is required' }), {
                      status: 400,
                      headers: { 'content-type': 'application/json' },
                    }),
                },
              },
            },
          },
        }),
      },
    })

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/v1/agent-runs', {
        method: 'POST',
        headers: {
          origin: allowedBrowserOrigin,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedBrowserOrigin)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  })

  it('adds CORS headers to Agents SSE route responses', async () => {
    const runtime = await createAgentsHttpRuntime({
      routeSources: {
        './routes/api/agents/events.ts':
          "export const Route = createFileRoute('/api/agents/events')({ server: { handlers: { GET: handler } } })",
      },
      routeModules: {
        './routes/api/agents/events.ts': async () => ({
          Route: {
            options: {
              server: {
                handlers: {
                  GET: () =>
                    new Response('event: ready\\n\\ndata: {}\\n\\n', {
                      headers: { 'content-type': 'text/event-stream' },
                    }),
                },
              },
            },
          },
        }),
      },
    })

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/api/agents/events', {
        headers: { origin: allowedBrowserOrigin },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedBrowserOrigin)
  })

  it('serves injected Prometheus metrics before route fallback handling', async () => {
    const runtime = await createAgentsHttpRuntime({
      routeSources: {},
      routeModules: {},
      metrics: {
        enabled: () => true,
        path: () => '/metrics',
        render: vi.fn(async () => ({ ok: true as const, body: 'agents_runtime_up 1\n' })),
      },
    })

    const response = await runtime.handleRequest(new Request('http://agents.local/metrics'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    await expect(response.text()).resolves.toBe('agents_runtime_up 1\n')
  })
})

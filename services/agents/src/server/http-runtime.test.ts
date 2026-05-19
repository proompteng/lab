import { describe, expect, it, vi } from 'vitest'

vi.mock('crossws/adapters/bun', () => ({
  default: vi.fn(() => ({
    handleUpgrade: vi.fn(async () => null),
    websocket: {},
  })),
}))

import { createAgentsHttpRuntime } from './http-runtime'

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
        './routes/api/agents/codex/notify.ts':
          "export const Route = createFileRoute('/api/agents/codex/notify')({ server: { handlers: { OPTIONS: handler } } })",
      },
      routeModules: {
        './routes/api/agents/codex/notify.ts': async () => ({
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
      new Request('http://agents.local/api/agents/codex/notify', { method: 'OPTIONS' }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('answers CORS preflight for allowed Jangar browser calls to Agents routes', async () => {
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
          origin: 'https://jangar.k8s.proompteng.ai',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://jangar.k8s.proompteng.ai')
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type,idempotency-key')
  })

  it('adds CORS response headers to allowed Jangar browser Agents reads', async () => {
    const runtime = await buildRouteRuntime()

    const response = await runtime.handleRequest(
      new Request('https://agents.k8s.proompteng.ai/v1/agent-runs/run%201', {
        headers: { origin: 'https://jangar.k8s.proompteng.ai' },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://jangar.k8s.proompteng.ai')
    await expect(response.json()).resolves.toEqual({ ok: true, id: 'run 1' })
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

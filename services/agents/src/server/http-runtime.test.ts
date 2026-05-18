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

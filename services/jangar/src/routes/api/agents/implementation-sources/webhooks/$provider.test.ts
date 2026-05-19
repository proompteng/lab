import { afterEach, describe, expect, it, vi } from 'vitest'

const agentsProxyMocks = vi.hoisted(() => ({
  proxyAgentsServiceRequest: vi.fn(async () => new Response('proxied', { status: 202 })),
}))

vi.mock('~/server/agents-service-proxy', () => agentsProxyMocks)

import { Route } from './$provider'

describe('implementation source webhook route', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('proxies provider webhook POST requests to the Agents service', async () => {
    const request = new Request('http://jangar.test/api/agents/implementation-sources/webhooks/github', {
      body: '{}',
      method: 'POST',
    })
    const response = await Route.options.server.handlers.POST({ params: { provider: 'github' }, request } as never)

    expect(response.status).toBe(202)
    await expect(response.text()).resolves.toBe('proxied')
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(
      request,
      '/api/agents/implementation-sources/webhooks/github',
    )
  })
})

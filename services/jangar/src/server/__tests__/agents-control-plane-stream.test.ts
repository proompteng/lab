import { afterEach, describe, expect, it, vi } from 'vitest'

const agentsProxyMocks = vi.hoisted(() => ({
  proxyAgentsServiceRequest: vi.fn(async () => new Response('stream', { status: 200 })),
}))

vi.mock('~/server/agents-service-proxy', () => agentsProxyMocks)

import { streamControlPlaneEvents } from '~/routes/api/agents/control-plane/stream'

describe('control plane stream', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('proxies the stream to the Agents service boundary', async () => {
    const request = new Request('http://localhost/api/agents/control-plane/stream?namespace=agents')
    const response = await streamControlPlaneEvents(request)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('stream')
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/api/agents/control-plane/stream')
  })
})

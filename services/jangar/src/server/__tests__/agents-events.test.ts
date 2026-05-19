import { afterEach, describe, expect, it, vi } from 'vitest'

const agentsProxyMocks = vi.hoisted(() => ({
  proxyAgentsServiceRequest: vi.fn(async () => new Response('events', { status: 200 })),
}))

vi.mock('~/server/agents-service-proxy', () => agentsProxyMocks)

import { getAgentEvents } from '~/routes/api/control-plane/agent-events'

describe('getAgentEvents', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('proxies the event stream to the Agents service boundary', async () => {
    const request = new Request('http://localhost/api/control-plane/agent-events?channel=general&limit=1')
    const response = await getAgentEvents(request)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('events')
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/api/agents/events')
  })
})

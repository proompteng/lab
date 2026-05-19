import { afterEach, describe, expect, it, vi } from 'vitest'

const agentsProxyMocks = vi.hoisted(() => ({
  proxyAgentsServiceRequest: vi.fn(async () => new Response('status', { status: 200 })),
}))

vi.mock('~/server/agents-service-proxy', () => agentsProxyMocks)

import { getControlPlaneStatus } from './status'

describe('control-plane status route', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('proxies status requests to the Agents service boundary', async () => {
    const request = new Request('http://jangar.test/api/control-plane/status?namespace=agents&view=runner')
    const response = await getControlPlaneStatus(request)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('status')
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/api/agents/control-plane/status')
  })
})

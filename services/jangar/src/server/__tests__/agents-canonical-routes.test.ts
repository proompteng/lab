import { afterEach, describe, expect, it, vi } from 'vitest'

const agentsProxyMocks = vi.hoisted(() => ({
  proxyAgentsServiceRequest: vi.fn(async () => new Response('proxied', { status: 200 })),
}))

vi.mock('~/server/agents-service-proxy', () => agentsProxyMocks)

import { getAgentsEvents } from '~/routes/api/agents/events'
import { getAgentsControlPlaneStatus } from '~/routes/api/agents/control-plane/status'
import { streamAgentsControlPlaneEvents } from '~/routes/api/agents/control-plane/stream'
import { proxyV1AgentRuns } from '~/routes/v1/agent-runs'

describe('canonical Agents proxy routes', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('proxies status through the canonical Agents control-plane path', async () => {
    const request = new Request('http://jangar.test/api/agents/control-plane/status?namespace=agents')
    const response = await getAgentsControlPlaneStatus(request)

    expect(response.status).toBe(200)
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/api/agents/control-plane/status')
  })

  it('proxies control-plane resource streams through the canonical Agents path', async () => {
    const request = new Request('http://jangar.test/api/agents/control-plane/stream?namespace=agents')
    const response = await streamAgentsControlPlaneEvents(request)

    expect(response.status).toBe(200)
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/api/agents/control-plane/stream')
  })

  it('proxies agent event streams through the canonical Agents events path', async () => {
    const request = new Request('http://jangar.test/api/agents/events?channel=general')
    const response = await getAgentsEvents(request)

    expect(response.status).toBe(200)
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/api/agents/events')
  })

  it('proxies v1 AgentRun submissions through the canonical Agents v1 path', async () => {
    const request = new Request('http://jangar.test/v1/agent-runs?dryRun=true', {
      body: JSON.stringify({ agentRef: { name: 'codex' } }),
      method: 'POST',
    })
    const response = await proxyV1AgentRuns(request)

    expect(response.status).toBe(200)
    expect(agentsProxyMocks.proxyAgentsServiceRequest).toHaveBeenCalledWith(request, '/v1/agent-runs')
  })
})

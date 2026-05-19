import { afterEach, describe, expect, it, vi } from 'vitest'

import { postAgentRunsHandler } from '~/routes/v1/agent-runs'
import { getAgentRunHandler } from '~/routes/v1/agent-runs/$id'
import { postOrchestrationsHandler } from '~/routes/v1/orchestrations'

const withAgentsServiceBaseUrl = async (run: () => Promise<void>) => {
  const previous = process.env.AGENTS_SERVICE_BASE_URL
  process.env.AGENTS_SERVICE_BASE_URL = 'http://agents.test'
  try {
    await run()
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTS_SERVICE_BASE_URL
    } else {
      process.env.AGENTS_SERVICE_BASE_URL = previous
    }
  }
}

const stubAgentsServiceFetch = () => {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
      status: 201,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Jangar primitives endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('proxies AgentRun creation to the Agents service', async () => {
    await withAgentsServiceBaseUrl(async () => {
      const fetchMock = stubAgentsServiceFetch()
      const response = await postAgentRunsHandler(
        new Request('http://jangar.test/v1/agent-runs?dryRun=true', {
          body: JSON.stringify({ agentRef: { name: 'demo-agent' } }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      )

      expect(response.status).toBe(201)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
      expect(url.toString()).toBe('http://agents.test/v1/agent-runs?dryRun=true')
      expect(init.method).toBe('POST')
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"agentRef":{"name":"demo-agent"}}')
    })
  })

  it('proxies AgentRun reads to the Agents service with encoded names', async () => {
    await withAgentsServiceBaseUrl(async () => {
      const fetchMock = stubAgentsServiceFetch()
      const response = await getAgentRunHandler(
        'run/name with spaces',
        new Request('http://jangar.test/v1/agent-runs/run%2Fname%20with%20spaces?namespace=agents'),
      )

      expect(response.status).toBe(201)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
      expect(url.toString()).toBe('http://agents.test/v1/agent-runs/run%2Fname%20with%20spaces?namespace=agents')
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
    })
  })

  it('proxies orchestration creation to the Agents service', async () => {
    await withAgentsServiceBaseUrl(async () => {
      const fetchMock = stubAgentsServiceFetch()
      const response = await postOrchestrationsHandler(
        new Request('http://jangar.test/v1/orchestrations', {
          body: JSON.stringify({ name: 'demo-orchestration' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      )

      expect(response.status).toBe(201)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
      expect(url.toString()).toBe('http://agents.test/v1/orchestrations')
      expect(init.method).toBe('POST')
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"name":"demo-orchestration"}')
    })
  })
})

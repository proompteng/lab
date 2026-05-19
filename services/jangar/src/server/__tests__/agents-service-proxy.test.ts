import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildAgentsServiceProxyUrl,
  fetchAgentsServiceJson,
  proxyAgentsServiceRequest,
  resolveAgentsServiceBaseUrl,
} from '~/server/agents-service-proxy'

const originalFetch = globalThis.fetch

describe('agents-service-proxy', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('defaults to the in-cluster Agents service', () => {
    expect(resolveAgentsServiceBaseUrl({})).toBe('http://agents.agents.svc.cluster.local')
  })

  it('normalizes explicit Agents service base URLs', () => {
    expect(resolveAgentsServiceBaseUrl({ AGENTS_SERVICE_BASE_URL: 'http://agents.test///' })).toBe('http://agents.test')
  })

  it('preserves request query parameters when building the upstream URL', () => {
    const target = buildAgentsServiceProxyUrl(
      new Request('http://jangar.test/api/agents/control-plane/resources?kind=AgentRun&namespace=agents'),
      '/api/agents/control-plane/resources',
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(target.toString()).toBe(
      'http://agents.test/api/agents/control-plane/resources?kind=AgentRun&namespace=agents',
    )
  })

  it('proxies non-hop-by-hop headers and request bodies to Agents', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          connection: 'close',
          'content-length': '999',
          'content-type': 'application/json',
          'x-agents-result': 'ok',
        },
        status: 202,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const response = await proxyAgentsServiceRequest(
      new Request('http://jangar.test/api/agents/control-plane/resource?kind=Agent', {
        body: JSON.stringify({ metadata: { name: 'agent-a' } }),
        headers: {
          connection: 'close',
          'content-length': '41',
          'content-type': 'application/json',
          'x-request-id': 'req-1',
        },
        method: 'POST',
      }),
      '/api/agents/control-plane/resource',
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test/' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/api/agents/control-plane/resource?kind=Agent')
    expect(init.method).toBe('POST')
    expect((init.headers as Headers).get('content-type')).toBe('application/json')
    expect((init.headers as Headers).get('x-request-id')).toBe('req-1')
    expect((init.headers as Headers).get('connection')).toBeNull()
    expect((init.headers as Headers).get('content-length')).toBeNull()
    expect((init.headers as Headers).get('x-jangar-agents-proxy')).toBe('true')
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"metadata":{"name":"agent-a"}}')

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-agents-result')).toBe('ok')
    expect(response.headers.get('content-length')).toBeNull()
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('fetches Agents service JSON contracts without importing Agents runtime modules', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentsServiceJson<{ status: string }>('/health', {
      AGENTS_SERVICE_BASE_URL: 'http://agents.test',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/health')
    expect(init.method).toBe('GET')
    expect((init.headers as Headers).get('accept')).toBe('application/json')
    expect((init.headers as Headers).get('x-jangar-agents-proxy')).toBe('true')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { status: 'ok' },
    })
  })
})

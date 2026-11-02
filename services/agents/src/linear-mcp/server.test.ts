import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it, vi } from 'vitest'

import type { LinearMcpRunIdentity } from './identity'
import type { LinearMcpPolicyService } from './policy'
import { createLinearMcpGatewayHandler } from './server'

const identity: LinearMcpRunIdentity = {
  namespace: 'agents',
  podName: 'run-pod',
  podUid: 'pod-uid',
  jobName: 'run-job',
  jobUid: 'job-uid',
  agentRunName: 'linear-run',
  agentRunUid: 'run-uid',
  agentName: 'codex-linear-agent',
  providerName: 'codex-linear',
  issueIdentifier: 'PROOMPT-123',
  issueUuid: 'issue-uuid',
  issueUrl: 'https://linear.app/proompteng/issue/PROOMPT-123/test',
  phase: 'Running',
}

const makeHarness = () => {
  const verify = vi.fn(async () => identity)
  const recordPolicyDenial = vi.fn()
  const call = vi.fn<LinearMcpPolicyService['call']>(async (name) => ({
    content: [{ type: 'text', text: JSON.stringify({ tool: name, issue: identity.issueIdentifier }) }],
    structuredContent: { tool: name, issue: identity.issueIdentifier },
  }))
  const handler = createLinearMcpGatewayHandler({
    verifier: { verify },
    policy: { call },
    maxRequestBytes: 16_384,
    checkReady: async () => ({ ok: true }),
    renderMetrics: () => '# metrics\n',
    recordPolicyDenial,
  })
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input : new Request(input, init)
    const headers = new Headers(source.headers)
    headers.set('authorization', 'Bearer projected-token')
    return handler(new Request(source, { headers }))
  }
  return { handler, verify, call, fetch, recordPolicyDenial }
}

describe('Linear MCP gateway transport', () => {
  it('exposes only the fixed source-bound tools and routes valid calls through policy', async () => {
    const harness = makeHarness()
    const client = new Client({ name: 'gateway-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('http://linear-gateway.test/mcp'), {
      fetch,
    })
    async function fetch(input: string | URL | Request, init?: RequestInit) {
      return harness.fetch(input, init)
    }

    await client.connect(transport)
    const listed = await client.listTools()
    const result = await client.callTool({ name: 'get_issue', arguments: {} })

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'get_issue',
      'list_comments',
      'list_issue_statuses',
      'create_comment',
      'update_issue',
    ])
    expect(result.structuredContent).toEqual({ tool: 'get_issue', issue: 'PROOMPT-123' })
    expect(harness.verify).toHaveBeenCalledWith('projected-token')
    expect(harness.call).toHaveBeenCalledOnce()
  })

  it('rejects missing bearer authentication before parsing MCP input', async () => {
    const { handler, verify, call, recordPolicyDenial } = makeHarness()
    const response = await handler(
      new Request('http://linear-gateway.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      }),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_token' })
    expect(verify).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(recordPolicyDenial).toHaveBeenCalledWith('invalid_token', 'identity')
  })

  it('rejects caller-supplied issue identifiers without reaching policy', async () => {
    const harness = makeHarness()
    const client = new Client({ name: 'gateway-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('http://linear-gateway.test/mcp'), {
      fetch: harness.fetch,
    })

    await client.connect(transport)
    const result = await client.callTool({ name: 'get_issue', arguments: { issueId: 'PROOMPT-999' } })

    expect(result.isError).toBe(true)
    expect(harness.call).not.toHaveBeenCalled()
    expect(harness.recordPolicyDenial).toHaveBeenCalledWith('argument_denied', 'get_issue')
  })

  it('bounds streamed MCP bodies even without a content-length header', async () => {
    const { handler, call } = makeHarness()
    const response = await handler(
      new Request('http://linear-gateway.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer projected-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value: 'x'.repeat(20_000) }),
      }),
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'request_too_large' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects malformed content-length headers before MCP parsing', async () => {
    const { handler, call } = makeHarness()
    const response = await handler(
      new Request('http://linear-gateway.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer projected-token',
          'content-type': 'application/json',
          'content-length': '12bytes',
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_content_length' })
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps health and readiness independent from caller credentials', async () => {
    const { handler } = makeHarness()

    expect((await handler(new Request('http://linear-gateway.test/healthz'))).status).toBe(200)
    expect((await handler(new Request('http://linear-gateway.test/readyz'))).status).toBe(200)
    expect((await handler(new Request('http://linear-gateway.test/metrics'))).status).toBe(200)
  })
})

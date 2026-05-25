import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { handleMcpRequest } from '../mcp'
import { createInMemorySynthesisStore, setSynthesisStoreForTests } from '../store'

const token = 'test-synthesis-token'

const rpc = (method: string, params?: unknown, headers: HeadersInit = {}) => {
  const requestHeaders = new Headers(headers)
  requestHeaders.set('content-type', 'application/json')
  return new Request('http://synthesis.test/mcp', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

const callTool = (name: string, args: Record<string, unknown>, headers: HeadersInit = {}) =>
  rpc('tools/call', { name, arguments: args }, headers)

const parseToolJson = async (response: Response) => {
  const payload = await response.json()
  const text = payload.result.content[0].text
  return JSON.parse(text)
}

describe('synthesis MCP', () => {
  beforeEach(() => {
    process.env.SYNTHESIS_API_TOKEN = token
    process.env.SYNTHESIS_ENGAGEMENT_MODE = 'queue'
    setSynthesisStoreForTests(createInMemorySynthesisStore())
  })

  afterEach(() => {
    delete process.env.SYNTHESIS_API_TOKEN
    delete process.env.SYNTHESIS_ENGAGEMENT_MODE
    setSynthesisStoreForTests(null)
  })

  test('initializes with synthesis-control-plane server info', async () => {
    const response = await handleMcpRequest(rpc('initialize'))
    const payload = await response.json()

    expect(payload.result.serverInfo.name).toBe('synthesis-control-plane')
  })

  test('lists synthesis tools and config resource', async () => {
    const toolsResponse = await handleMcpRequest(rpc('tools/list'))
    const toolsPayload = await toolsResponse.json()
    const toolNames = toolsPayload.result.tools.map((tool: { name: string }) => tool.name)

    expect(toolNames).toContain('synthesis_submit_item')
    expect(toolNames).toContain('synthesis_next_engagement')

    const resourceResponse = await handleMcpRequest(rpc('resources/read', { uri: 'synthesis://config' }))
    const resourcePayload = await resourceResponse.json()
    expect(resourcePayload.result.contents[0].text).toContain('synthesis-control-plane')
  })

  test('rejects mutating tools without a bearer token', async () => {
    const response = await handleMcpRequest(callTool('synthesis_start_run', {}))
    const payload = await response.json()

    expect(payload.error.code).toBe(-32001)
  })

  test('submits an item and reads it back through the feed', async () => {
    const headers = { authorization: `Bearer ${token}` }
    const runPayload = await parseToolJson(await handleMcpRequest(callTool('synthesis_start_run', {}, headers)))

    const submitPayload = await parseToolJson(
      await handleMcpRequest(
        callTool(
          'synthesis_submit_item',
          {
            runId: runPayload.run.id,
            originalUrl: 'https://twitter.com/example/status/12345?ref=feed',
            observedText: 'semi stack integration notes with actionable edge ai packaging detail',
            mediaUrls: ['data:image/png;base64,AAAA'],
            summary: 'edge ai packaging is becoming a tighter semiconductor integration bottleneck.',
            whyValuable: 'connects packaging constraints to model deployment economics.',
            evidence: ['mentions packaging yield', 'ties inference latency to board-level integration'],
            topicTags: ['semis', 'ai agents'],
            score: 0.91,
            confidence: 0.82,
            engagementRecommendation: 'like',
          },
          headers,
        ),
      ),
    )

    expect(submitPayload.item.originalUrl).toBe('https://x.com/example/status/12345')
    expect(submitPayload.item.mediaUrls).toEqual(['data:image/png;base64,AAAA'])
    expect(submitPayload.engagementAction.action).toBe('like')

    const feedPayload = await parseToolJson(await handleMcpRequest(callTool('synthesis_list_feed', { limit: 10 })))
    expect(feedPayload.items).toHaveLength(1)
    expect(feedPayload.items[0].id).toBe(submitPayload.item.id)
  })
})

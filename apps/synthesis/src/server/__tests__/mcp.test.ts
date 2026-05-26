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
    const submitTool = toolsPayload.result.tools.find((tool: { name: string }) => tool.name === 'synthesis_submit_item')

    expect(toolNames).toContain('synthesis_submit_item')
    expect(toolNames).toContain('synthesis_next_engagement')
    expect(submitTool.inputSchema.required).toEqual([
      'title',
      'synthesis',
      'takeaways',
      'whyValuable',
      'sourcePosts',
      'dedupeKey',
      'score',
      'confidence',
    ])
    expect(submitTool.inputSchema.properties.summary).toBeUndefined()
    expect(submitTool.inputSchema.properties.originalUrl).toBeUndefined()

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
            title: 'Edge AI packaging is becoming a deployment bottleneck',
            synthesis:
              'The useful signal is that edge AI hardware economics are getting constrained by packaging and board integration, not just model size.',
            takeaways: ['packaging constraints are now part of edge AI deployment math'],
            whyValuable: 'connects packaging constraints to model deployment economics.',
            sourcePosts: [
              {
                originalUrl: 'https://twitter.com/example/status/12345?ref=feed',
                observedText: 'semi stack integration notes with actionable edge ai packaging detail',
                mediaUrls: ['data:image/png;base64,AAAA'],
              },
            ],
            dedupeKey: 'theme:edge-ai-packaging',
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

  test('rejects old submit arguments at the MCP boundary', async () => {
    const headers = { authorization: `Bearer ${token}` }
    const response = await handleMcpRequest(
      callTool(
        'synthesis_submit_item',
        {
          originalUrl: 'https://x.com/example/status/777',
          observedText: 'raw timeline post',
          summary: 'old summary field',
          score: 0.91,
        },
        headers,
      ),
    )
    const payload = await response.json()

    expect(payload.error.code).toBe(-32602)
    expect(payload.error.message).toBe('Invalid synthesis_submit_item input')
  })

  test('submits a multi-source synthesized theme through the expanded contract', async () => {
    const headers = { authorization: `Bearer ${token}` }
    const runPayload = await parseToolJson(await handleMcpRequest(callTool('synthesis_start_run', {}, headers)))
    const submitPayload = await parseToolJson(
      await handleMcpRequest(
        callTool(
          'synthesis_submit_item',
          {
            runId: runPayload.run.id,
            title: 'Browser agents are moving into real workflows',
            synthesis:
              'The useful signal is not another browser-agent demo. Multiple posts point to browser sessions becoming the control surface for authenticated SaaS work.',
            takeaways: [
              'logged-in browser context is becoming the product surface',
              'approval queues matter for risky actions',
            ],
            sourcePosts: [
              {
                originalUrl: 'https://x.com/example/status/4101',
                authorHandle: 'example',
                observedText: 'browser agent post with logged in workflow details',
              },
              {
                originalUrl: 'https://x.com/example/status/4102',
                authorHandle: 'example',
                observedText: 'second browser agent post about approval queues',
              },
            ],
            factChecks: [
              {
                claim: 'Automated engagement should stay behind approval.',
                status: 'verified',
                explanation: 'Platform automation rules restrict unsolicited automated engagement.',
                sources: [{ title: 'X automation rules', url: 'https://help.x.com/articles/76915' }],
              },
            ],
            attachments: [{ kind: 'source_image', url: 'https://pbs.twimg.com/media/browser-agent.jpg' }],
            generatedAttachments: [{ kind: 'generated_infographic', data: 'data:image/png;base64,AAAA' }],
            dedupeKey: 'theme:browser-agent-workflows',
            whyValuable: 'It converts two overlapping posts into one concrete product-design direction.',
            topicTags: ['ai agents', 'devtools'],
            score: 0.94,
            confidence: 0.87,
          },
          headers,
        ),
      ),
    )

    expect(submitPayload.item.title).toContain('Browser agents')
    expect(submitPayload.item.sourceCount).toBe(2)
    expect(submitPayload.item.takeaways).toHaveLength(2)
    expect(submitPayload.item.factChecks[0].status).toBe('verified')
    expect(submitPayload.item.attachments).toHaveLength(2)
    expect(submitPayload.item.generatedAttachments).toHaveLength(1)
  })
})

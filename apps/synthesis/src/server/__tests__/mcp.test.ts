import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { setSynthesisEmbeddingProviderForTests } from '../embeddings'
import { handleMcpRequest } from '../mcp'
import { createInMemorySynthesisStore, setSynthesisStoreForTests } from '../store'
import { createInMemoryAutotraderStore, setAutotraderStoreForTests } from '../autotrader-store'

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
    process.env.SYNTHESIS_EMBEDDING_DIMENSION = '3'
    process.env.SYNTHESIS_EMBEDDING_MODEL = 'local-test-embedding'
    setSynthesisEmbeddingProviderForTests(async ({ text, config }) => {
      const lowered = text.toLowerCase()
      if (lowered.includes('browser') || lowered.includes('agent')) {
        return { embedding: [1, 0, 0], model: config.model, dimension: config.dimension }
      }
      if (lowered.includes('packaging') || lowered.includes('semis')) {
        return { embedding: [0, 1, 0], model: config.model, dimension: config.dimension }
      }
      return { embedding: [0, 0, 1], model: config.model, dimension: config.dimension }
    })
    setSynthesisStoreForTests(createInMemorySynthesisStore())
    setAutotraderStoreForTests(createInMemoryAutotraderStore())
  })

  afterEach(() => {
    delete process.env.SYNTHESIS_API_TOKEN
    delete process.env.SYNTHESIS_EMBEDDING_DIMENSION
    delete process.env.SYNTHESIS_EMBEDDING_MODEL
    setSynthesisEmbeddingProviderForTests(null)
    setSynthesisStoreForTests(null)
    setAutotraderStoreForTests(null)
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
    expect(toolNames).toContain('synthesis_prefill_company')
    expect(toolNames).not.toContain('synthesis_next_engagement')
    expect(toolNames).not.toContain('synthesis_record_engagement_result')
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
    expect(submitTool.inputSchema.properties.engagementRecommendation).toBeUndefined()
    expect(submitTool.inputSchema.properties.replyText).toBeUndefined()
    expect(submitTool.inputSchema.properties.embedding).toBeUndefined()
    expect(submitTool.inputSchema.properties.companySymbols).toBeDefined()

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
              },
            ],
            attachments: [
              {
                kind: 'source_image',
                data: 'data:image/png;base64,AAAA',
                alt: 'screenshot labels packaging and board integration as the edge AI bottleneck',
              },
            ],
            dedupeKey: 'theme:edge-ai-packaging',
            topicTags: ['semis', 'ai agents'],
            score: 0.91,
            confidence: 0.82,
          },
          headers,
        ),
      ),
    )

    expect(submitPayload.item.originalUrl).toBe('https://x.com/example/status/12345')
    expect(submitPayload.item.attachments).toHaveLength(1)
    expect(submitPayload.item.embedding).toMatchObject({ model: 'local-test-embedding', dimension: 3 })
    expect(submitPayload.engagementAction).toBeUndefined()

    const feedPayload = await parseToolJson(await handleMcpRequest(callTool('synthesis_list_feed', { limit: 10 })))
    expect(feedPayload.items).toHaveLength(1)
    expect(feedPayload.items[0].id).toBe(submitPayload.item.id)
  })

  test('prefills a Synthesis-owned company profile through MCP', async () => {
    const headers = { authorization: `Bearer ${token}` }
    const payload = await parseToolJson(
      await handleMcpRequest(callTool('synthesis_prefill_company', { symbol: 'NVDA' }, headers)),
    )

    expect(payload.company).toMatchObject({
      symbol: 'NVDA',
      companyName: 'NVIDIA Corporation',
      industry: 'Semiconductors',
    })
    expect(payload.company.dataSources.length).toBeGreaterThan(0)
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
              'source media should be stored as rendered attachments',
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
                observedText: 'second browser agent post about saved screenshots',
              },
            ],
            factChecks: [
              {
                claim: 'Captured source images should be stored as attachments.',
                status: 'verified',
                explanation: 'The Synthesis app renders app-owned asset URLs from submitted attachments.',
                sources: [{ title: 'Synthesis asset route', url: 'https://synthesis.test/api/assets/example' }],
              },
            ],
            attachments: [
              {
                kind: 'source_image',
                url: 'https://pbs.twimg.com/media/browser-agent.jpg',
                alt: 'browser screenshot shows an authenticated agent workflow with saved source media',
              },
            ],
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
    expect(submitPayload.item.embedding.dimension).toBe(3)
  })

  test('lists feed results through semantic search', async () => {
    const headers = { authorization: `Bearer ${token}` }
    const runPayload = await parseToolJson(await handleMcpRequest(callTool('synthesis_start_run', {}, headers)))
    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'synthesis_submit_item',
          {
            runId: runPayload.run.id,
            title: 'Browser agents are becoming workflow infrastructure',
            synthesis: 'Browser sessions are turning into the authenticated execution surface for agents.',
            takeaways: ['browser context matters for agent tooling'],
            whyValuable: 'It is a concrete product direction.',
            sourcePosts: [{ originalUrl: 'https://x.com/example/status/5101', observedText: 'browser agent workflow' }],
            dedupeKey: 'theme:browser-agents',
            topicTags: ['ai-agents'],
            score: 0.91,
            confidence: 0.82,
          },
          headers,
        ),
      ),
    )
    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'synthesis_submit_item',
          {
            runId: runPayload.run.id,
            title: 'Semiconductor packaging is constraining edge AI deployment',
            synthesis: 'Packaging and board integration are becoming practical limits for edge AI hardware.',
            takeaways: ['packaging is part of deployment economics'],
            whyValuable: 'It connects semis constraints to deployment planning.',
            sourcePosts: [{ originalUrl: 'https://x.com/example/status/5102', observedText: 'semi packaging note' }],
            dedupeKey: 'theme:semi-packaging',
            topicTags: ['semis'],
            score: 0.9,
            confidence: 0.8,
          },
          headers,
        ),
      ),
    )

    const feedPayload = await parseToolJson(
      await handleMcpRequest(callTool('synthesis_list_feed', { limit: 1, query: 'authenticated browser work' })),
    )

    expect(feedPayload.items).toHaveLength(1)
    expect(feedPayload.items[0].dedupeKey).toBe('theme:browser-agents')
  })

  test('records an autotrader session and returns compounded scorecards through MCP', async () => {
    const headers = { authorization: `Bearer ${token}` }
    const toolsResponse = await handleMcpRequest(rpc('tools/list'))
    const toolsPayload = await toolsResponse.json()
    const tools = toolsPayload.result.tools as Array<{
      name: string
      inputSchema?: { properties?: Record<string, { enum?: string[] }> }
    }>
    const toolNames = tools.map((tool) => tool.name)
    const startSessionTool = tools.find((tool) => tool.name === 'autotrader_start_session')
    const finalizeSessionTool = tools.find((tool) => tool.name === 'autotrader_finalize_session')

    expect(toolNames).toEqual(expect.arrayContaining(['autotrader_start_session', 'autotrader_get_scorecard']))
    expect(startSessionTool?.inputSchema?.properties?.mode?.enum).toEqual(
      expect.arrayContaining(['market_session', 'market_open', 'dry_run', 'paper_smoke', 'scorecard_readback']),
    )
    expect(startSessionTool?.inputSchema?.properties?.openingEquity).toBeDefined()
    expect(finalizeSessionTool?.inputSchema?.properties).toEqual(
      expect.objectContaining({
        openingEquity: expect.any(Object),
        closingEquity: expect.any(Object),
        realizedPnl: expect.any(Object),
        maxDrawdown: expect.any(Object),
      }),
    )

    const sessionPayload = await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_start_session',
          {
            agentRunName: 'autonomous-trader-market-open-20260529-0930',
            mode: 'market_open',
            tradingDate: '2026-05-29',
            accountId: 'paper-account',
            goalEquity: '500000',
            openingEquity: '38400',
            marketOpenAt: '2026-05-29T13:30:00Z',
            marketCloseAt: '2026-05-29T20:00:00Z',
            analysisHead: 'b187dcf',
            analysisContextHash: 'sha256:test',
          },
          headers,
        ),
      ),
    )
    const sessionId = sessionPayload.session.id

    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_upsert_status',
          {
            sessionId,
            cycle: 1,
            phase: 'scan',
            equity: '38763.11',
            buyingPower: '51235.31',
            daytradeBuyingPower: '51235.31',
            grossExposure: '0',
            netExposure: '0',
            realizedPnl: '0',
            unrealizedPnl: '0',
            currentAction: 'ranking candidates',
            payload: { topCandidates: ['NVDA'] },
          },
          headers,
        ),
      ),
    )
    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_append_event',
          {
            sessionId,
            seq: 1,
            eventType: 'candidate_ranked',
            symbol: 'nvda',
            setupType: 'opening_range_breakout',
            setupGrade: 'A',
            payload: { relativeVolume: 4.2 },
          },
          headers,
        ),
      ),
    )
    const ticketPayload = await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_create_trade_ticket',
          {
            sessionId,
            idempotencyKey: 'cycle-1-nvda',
            symbol: 'NVDA',
            instrument: 'stock',
            side: 'buy',
            setupType: 'opening_range_breakout',
            setupGrade: 'A',
            fatPitch: true,
            regime: 'news_driven',
            timeBucket: 'open_30m',
            thesis: 'Relative strength and clean opening range break.',
            entryTrigger: 'Break and hold above opening range high.',
            invalidation: 'Loss of VWAP.',
            entryLimitPrice: '125.10',
            stopPrice: '123.80',
            targetPrice: '128.50',
            expectedR: '2.61',
            maxLossAmount: '260',
            riskDollars: '260',
            plannedQuantity: '200',
            protectionType: 'bracket',
            brokerOrderPlan: { orderClass: 'bracket' },
            status: 'validated',
          },
          headers,
        ),
      ),
    )

    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_record_risk_check',
          {
            sessionId,
            ticketId: ticketPayload.ticket.id,
            idempotencyKey: 'cycle-1-nvda-risk',
            checkType: 'expected_r',
            passed: true,
            reason: 'expected R above threshold',
            payload: { expectedR: '2.61' },
          },
          headers,
        ),
      ),
    )
    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_record_order',
          {
            sessionId,
            ticketId: ticketPayload.ticket.id,
            clientOrderId: 'atr-test-nvda-1',
            brokerOrderId: 'alpaca-order-1',
            symbol: 'NVDA',
            instrument: 'stock',
            side: 'buy',
            quantity: '200',
            orderType: 'limit',
            orderClass: 'bracket',
            limitPrice: '125.10',
            takeProfitLimitPrice: '128.50',
            stopLossStopPrice: '123.80',
            stopLossLimitPrice: '123.70',
            status: 'filled',
            brokerPayload: { source: 'alpaca' },
          },
          headers,
        ),
      ),
    )
    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_record_fill',
          {
            sessionId,
            clientOrderId: 'atr-test-nvda-1',
            brokerFillId: 'fill-1',
            symbol: 'NVDA',
            side: 'buy',
            quantity: '200',
            price: '125.04',
            filledAt: '2026-05-29T13:42:00Z',
            brokerPayload: { source: 'alpaca' },
          },
          headers,
        ),
      ),
    )
    await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_record_position_snapshot',
          {
            sessionId,
            symbol: 'NVDA',
            quantity: '200',
            marketValue: '25100',
            averageEntryPrice: '125.04',
            unrealizedPnl: '92',
            capturedAt: '2026-05-29T13:43:00Z',
            brokerPayload: { source: 'alpaca' },
          },
          headers,
        ),
      ),
    )

    const finalizedPayload = await parseToolJson(
      await handleMcpRequest(
        callTool(
          'autotrader_finalize_session',
          {
            sessionId,
            terminalReason: 'market_close',
            openingEquity: '38400',
            closingEquity: '38750',
            realizedPnl: '350',
            maxDrawdown: '75',
            summary: { realizedPnl: '350' },
            scorecardObservations: [
              {
                ticketId: ticketPayload.ticket.id,
                symbol: 'NVDA',
                setupType: 'opening_range_breakout',
                setupGrade: 'A',
                regime: 'news_driven',
                timeBucket: 'open_30m',
                outcome: 'win',
                realizedR: '1.35',
                holdSeconds: '930',
                mfeR: '1.8',
                maeR: '-0.2',
                mistakeTags: [],
                notes: 'clean break and target management',
                payload: { targetHit: true },
              },
            ],
          },
          headers,
        ),
      ),
    )
    const scorecardPayload = await parseToolJson(
      await handleMcpRequest(
        callTool('autotrader_get_scorecard', {
          symbol: 'NVDA',
          setupType: 'opening_range_breakout',
          setupGrade: 'A',
          regime: 'news_driven',
          timeBucket: 'open_30m',
        }),
      ),
    )

    expect(finalizedPayload.detail.session.terminalReason).toBe('market_close')
    expect(finalizedPayload.detail.session.openingEquity).toBe('38400')
    expect(finalizedPayload.detail.session.closingEquity).toBe('38750')
    expect(finalizedPayload.detail.session.realizedPnl).toBe('350')
    expect(finalizedPayload.detail.session.maxDrawdown).toBe('75')
    expect(finalizedPayload.detail.orders).toHaveLength(1)
    expect(finalizedPayload.detail.orders[0].stopLossLimitPrice).toBe('123.70')
    expect(finalizedPayload.detail.positionSnapshots[0].symbol).toBe('NVDA')
    expect(scorecardPayload.scorecards[0]).toMatchObject({
      symbol: 'NVDA',
      setupType: 'opening_range_breakout',
      sampleSize: 1,
      wins: 1,
      avgRealizedR: '1.35',
    })
    expect(scorecardPayload.setupExamples[0].notes).toContain('clean break')
  })
})

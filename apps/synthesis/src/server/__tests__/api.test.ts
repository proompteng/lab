import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  handleAutotraderAppendEvent,
  handleAutotraderCreateTradeTicket,
  handleAutotraderFinalizeSession,
  handleAutotraderGetScorecard,
  handleAutotraderGetSession,
  handleAutotraderListSessions,
  handleAutotraderStartSession,
  handleAutotraderUpsertStatus,
} from '../autotrader-api'
import { createInMemoryAutotraderStore, setAutotraderStoreForTests } from '../autotrader-store'
import { handleCreateRun, handleGetAsset, handleListFeed, handleSubmitItem } from '../api'
import { setSynthesisEmbeddingProviderForTests } from '../embeddings'
import { createInMemorySynthesisStore, setSynthesisStoreForTests } from '../store'

const token = 'test-synthesis-token'

const createRunRequest = (authorization?: string) =>
  new Request('http://synthesis.test/api/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ source: 'x.com/home', interests: ['semis'] }),
  })

const submitItemRequest = (runId: string, index: number) =>
  new Request('http://synthesis.test/api/items', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      runId,
      title: `Semis and devtools signal ${index}`,
      synthesis: `Semis/devtools synthesis ${index} turns the observed post into a concise curated item.`,
      takeaways: [`watch the tooling signal ${index}`],
      whyValuable: 'It is concrete enough to preserve without making the reader inspect the raw timeline.',
      sourcePosts: [
        {
          originalUrl: `https://x.com/example/status/${1000 + index}`,
          observedText: `observed post ${index} about semis and devtools`,
        },
      ],
      attachments: [
        {
          kind: 'source_image',
          url: `https://pbs.twimg.com/media/example-${index}.jpg`,
          sourceUrl: `https://x.com/example/status/${1000 + index}`,
          mimeType: 'image/jpeg',
          alt: `timeline chart ${index} shows the semis/devtools signal captured for synthesis`,
        },
      ],
      dedupeKey: `theme:semis-devtools-${index}`,
      topicTags: ['semis', 'devtools'],
      score: 0.8 + index * 0.01,
      confidence: 0.75,
    }),
  })

describe('synthesis REST auth', () => {
  beforeEach(() => {
    process.env.SYNTHESIS_API_TOKEN = token
    process.env.SYNTHESIS_EMBEDDING_DIMENSION = '3'
    process.env.SYNTHESIS_EMBEDDING_MODEL = 'local-test-embedding'
    setSynthesisEmbeddingProviderForTests(async ({ text, config }) => {
      const lowered = text.toLowerCase()
      if (lowered.includes('memory') || lowered.includes('hbm') || lowered.includes('packaging')) {
        return { embedding: [0, 1, 0], model: config.model, dimension: config.dimension }
      }
      if (lowered.includes('browser') || lowered.includes('agent')) {
        return { embedding: [1, 0, 0], model: config.model, dimension: config.dimension }
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

  test('rejects missing bearer token for mutating routes', async () => {
    const response = await handleCreateRun(createRunRequest())

    expect(response.status).toBe(401)
  })

  test('accepts a valid bearer token for mutating routes', async () => {
    const response = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const payload = await response.json()

    expect(response.status).toBe(201)
    expect(payload.run.source).toBe('x.com/home')
  })

  test('rejects old single-post submit payloads', async () => {
    const runResponse = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const runPayload = await runResponse.json()
    const response = await handleSubmitItem(
      new Request('http://synthesis.test/api/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: runPayload.run.id,
          originalUrl: 'https://x.com/example/status/999',
          observedText: 'raw timeline post',
          summary: 'old summary field',
          score: 0.91,
        }),
      }),
    )
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(JSON.stringify(payload.details)).toContain('Unrecognized')
  })

  test('paginates the feed with a cursor', async () => {
    const runResponse = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const runPayload = await runResponse.json()

    for (let index = 0; index < 5; index += 1) {
      const submitResponse = await handleSubmitItem(submitItemRequest(runPayload.run.id, index))
      expect(submitResponse.status).toBe(201)
    }

    const firstResponse = await handleListFeed(new Request('http://synthesis.test/api/feed?limit=2&minScore=0'))
    const firstPage = await firstResponse.json()
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.items[0].attachments[0].assetUrl).toMatch(/^\/api\/assets\//)
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const secondResponse = await handleListFeed(
      new Request(`http://synthesis.test/api/feed?limit=2&minScore=0&cursor=${firstPage.nextCursor}`),
    )
    const secondPage = await secondResponse.json()
    expect(secondPage.items).toHaveLength(2)

    const firstIds = new Set(firstPage.items.map((item: { id: string }) => item.id))
    expect(secondPage.items.some((item: { id: string }) => firstIds.has(item.id))).toBe(false)
  })

  test('derives non-empty topic tags for submitted items when content has enough signal', async () => {
    const runResponse = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const runPayload = await runResponse.json()
    const submitResponse = await handleSubmitItem(
      new Request('http://synthesis.test/api/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: runPayload.run.id,
          title: 'NVDA HBM packaging is tightening around inference demand',
          synthesis:
            'Semiconductor supply-chain posts point to HBM packaging becoming a concrete inference deployment bottleneck.',
          takeaways: ['watch HBM allocation for model deployment'],
          whyValuable: 'It turns scattered chip supply commentary into a useful supply-chain watch item.',
          sourcePosts: [
            {
              originalUrl: 'https://x.com/example/status/2101',
              observedText: 'hbm packaging notes for semis and inference systems',
            },
          ],
          dedupeKey: 'theme:hbm-tag-derivation',
          score: 0.91,
          confidence: 0.82,
        }),
      }),
    )
    const payload = await submitResponse.json()

    expect(submitResponse.status).toBe(201)
    expect(payload.item.topicTags).toEqual(expect.arrayContaining(['semis', 'machine-learning']))
  })

  test('stores one synthesized theme with multiple sources and app-owned attachments', async () => {
    const runResponse = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const runPayload = await runResponse.json()
    const submitResponse = await handleSubmitItem(
      new Request('http://synthesis.test/api/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: runPayload.run.id,
          title: 'HBM capacity is tightening around inference demand',
          synthesis:
            'Multiple posts point to the same useful signal: HBM supply is moving from a headline constraint into a packaging and allocation constraint for inference clusters.',
          takeaways: ['capacity is allocation-limited', 'packaging is the bottleneck to watch'],
          sourcePosts: [
            {
              originalUrl: 'https://x.com/example/status/2001',
              authorHandle: 'example',
              observedText: 'hbm allocation notes with packaging detail',
            },
            {
              originalUrl: 'https://x.com/another/status/2002',
              authorHandle: 'another',
              observedText: 'second post describing the same hbm packaging constraint',
            },
          ],
          factChecks: [
            {
              claim: 'HBM demand is pressuring advanced packaging capacity.',
              status: 'verified',
              explanation: 'Company capacity commentary and reputable reporting both support this direction.',
              sources: [{ title: 'Company earnings transcript', url: 'https://example.com/hbm-transcript' }],
            },
          ],
          attachments: [
            {
              kind: 'source_image',
              url: 'https://pbs.twimg.com/media/hbm-1.jpg',
              sourceUrl: 'https://x.com/example/status/2001',
              mimeType: 'image/jpeg',
              alt: 'chart text highlights HBM allocation pressure moving into packaging capacity',
            },
          ],
          generatedAttachments: [
            {
              kind: 'generated_infographic',
              data: 'data:image/png;base64,AAAA',
              label: 'HBM bottleneck map',
            },
          ],
          whyValuable: 'It turns scattered timeline chatter into a concrete semiconductor supply-chain watch item.',
          topicTags: ['semis', 'ai agents'],
          dedupeKey: 'theme:hbm-capacity',
          score: 0.93,
          confidence: 0.86,
        }),
      }),
    )
    const payload = await submitResponse.json()

    expect(submitResponse.status).toBe(201)
    expect(payload.item.title).toContain('HBM capacity')
    expect(payload.item.sourceCount).toBe(2)
    expect(payload.item.sourcePosts).toHaveLength(2)
    expect(payload.item.factChecks[0].status).toBe('verified')
    expect(payload.item.attachments).toHaveLength(2)
    expect(payload.item.attachments[0].assetUrl).toMatch(/^\/api\/assets\//)
    expect(payload.item.embedding).toMatchObject({
      model: 'local-test-embedding',
      dimension: 3,
    })

    const assetResponse = await handleGetAsset(
      new Request(`http://synthesis.test${payload.item.attachments[0].assetUrl}`),
      payload.item.attachments[0].id,
    )
    expect(assetResponse.status).toBe(302)
    expect(assetResponse.headers.get('location')).toBe('https://pbs.twimg.com/media/hbm-1.jpg')
  })

  test('merges duplicate theme submissions instead of creating raw-post duplicates', async () => {
    const runResponse = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const runPayload = await runResponse.json()
    const submit = (statusId: number) =>
      handleSubmitItem(
        new Request('http://synthesis.test/api/items', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            runId: runPayload.run.id,
            title: 'Agent browser tooling is consolidating',
            synthesis: 'Two posts describe the same shift toward browser-native agent tooling.',
            takeaways: ['browser-native agent tooling is clustering into one workflow pattern'],
            whyValuable: 'It combines overlapping timeline items into one clear product signal.',
            sourcePosts: [
              {
                originalUrl: `https://x.com/example/status/${statusId}`,
                observedText: `agent browser tooling source ${statusId}`,
              },
            ],
            topicTags: ['devtools'],
            dedupeKey: 'theme:agent-browser-tooling',
            score: 0.88,
            confidence: 0.8,
          }),
        }),
      )

    await submit(3001)
    const secondResponse = await submit(3002)
    const secondPayload = await secondResponse.json()
    const feedResponse = await handleListFeed(new Request('http://synthesis.test/api/feed?limit=10&minScore=0'))
    const feedPayload = await feedResponse.json()

    expect(secondPayload.item.sourceCount).toBe(2)
    expect(secondPayload.item.embedding.dimension).toBe(3)
    expect(feedPayload.items).toHaveLength(1)
    expect(feedPayload.items[0].dedupeKey).toBe('theme:agent-browser-tooling')
  })

  test('uses semantic query embeddings for feed search instead of local text filtering', async () => {
    const runResponse = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const runPayload = await runResponse.json()
    await handleSubmitItem(
      new Request('http://synthesis.test/api/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: runPayload.run.id,
          title: 'Browser control surfaces are becoming agent infrastructure',
          synthesis: 'Browser sessions are turning into the authenticated control layer for SaaS agents.',
          takeaways: ['browser context matters for agent workflows'],
          whyValuable: 'It is a product workflow signal.',
          sourcePosts: [{ originalUrl: 'https://x.com/example/status/5001', observedText: 'browser agent workflow' }],
          dedupeKey: 'theme:browser-control-surfaces',
          topicTags: ['ai-agents'],
          score: 0.92,
          confidence: 0.8,
        }),
      }),
    )
    await handleSubmitItem(
      new Request('http://synthesis.test/api/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: runPayload.run.id,
          title: 'Advanced memory stacks are becoming the capacity constraint',
          synthesis: 'Supply-chain chatter points at HBM allocation as the practical limit for inference builds.',
          takeaways: ['capacity planning depends on memory allocation'],
          whyValuable: 'It turns scattered semiconductor posts into a watch item.',
          sourcePosts: [{ originalUrl: 'https://x.com/example/status/5002', observedText: 'hbm supply note' }],
          dedupeKey: 'theme:hbm-memory-capacity',
          topicTags: ['semis'],
          score: 0.93,
          confidence: 0.8,
        }),
      }),
    )

    const response = await handleListFeed(
      new Request('http://synthesis.test/api/feed?limit=1&minScore=0&query=gpu%20packaging'),
    )
    const payload = await response.json()

    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].dedupeKey).toBe('theme:hbm-memory-capacity')
    expect(payload.nextCursor).toBeNull()
  })

  test('serves canonical autotrader state and scorecards through REST handlers', async () => {
    const authedHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }
    const startResponse = await handleAutotraderStartSession(
      new Request('http://synthesis.test/api/autotrader/sessions', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({
          agentRunName: 'autonomous-trader-market-open-api-test',
          mode: 'dry_run',
          tradingDate: '2026-05-29',
          accountId: 'paper-account',
          goalEquity: '500000',
          marketOpenAt: '2026-05-29T13:30:00Z',
          marketCloseAt: '2026-05-29T20:00:00Z',
        }),
      }),
    )
    const startPayload = await startResponse.json()
    const sessionId = startPayload.session.id

    await handleAutotraderUpsertStatus(
      new Request('http://synthesis.test/api/autotrader/status', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({
          sessionId,
          cycle: 3,
          phase: 'scan',
          currentAction: 'standing down on weak candidates',
          blocker: null,
          payload: { noTradeReason: 'no A setup' },
        }),
      }),
    )
    await handleAutotraderAppendEvent(
      new Request('http://synthesis.test/api/autotrader/events', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({
          sessionId,
          seq: 3,
          eventType: 'no_trade_decision',
          symbol: 'AMD',
          setupType: 'vwap_reclaim',
          setupGrade: 'C',
          payload: { reason: 'wide spread' },
        }),
      }),
    )
    const ticketResponse = await handleAutotraderCreateTradeTicket(
      new Request('http://synthesis.test/api/autotrader/trade-tickets', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({
          sessionId,
          idempotencyKey: 'amd-c-setup',
          symbol: 'AMD',
          instrument: 'stock',
          side: 'buy',
          setupType: 'vwap_reclaim',
          setupGrade: 'C',
          regime: 'range_bound',
          timeBucket: 'midday',
          thesis: 'Rejected because setup grade was too weak.',
          entryTrigger: 'Not applicable.',
          invalidation: 'Not applicable.',
          protectionType: 'none',
          status: 'blocked',
          noTradeReason: 'C setup blocked',
        }),
      }),
    )
    const ticketPayload = await ticketResponse.json()
    await handleAutotraderFinalizeSession(
      new Request('http://synthesis.test/api/autotrader/finalize', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({
          sessionId,
          terminalReason: 'dry_run_complete',
          summary: { noTrade: true },
          scorecardObservations: [
            {
              ticketId: ticketPayload.ticket.id,
              symbol: 'AMD',
              setupType: 'vwap_reclaim',
              setupGrade: 'C',
              regime: 'range_bound',
              timeBucket: 'midday',
              outcome: 'rejected_invalid',
              realizedR: '0',
              notes: 'C setup correctly blocked',
            },
          ],
        }),
      }),
    )

    const listResponse = await handleAutotraderListSessions(
      new Request('http://synthesis.test/api/autotrader/sessions?limit=5'),
    )
    const detailResponse = await handleAutotraderGetSession(
      new Request(`http://synthesis.test/api/autotrader/sessions/${sessionId}`),
      sessionId,
    )
    const scorecardResponse = await handleAutotraderGetScorecard(
      new Request('http://synthesis.test/api/autotrader/scorecards?symbol=AMD&setupType=vwap_reclaim&limit=5'),
    )
    const listPayload = await listResponse.json()
    const detailPayload = await detailResponse.json()
    const scorecardPayload = await scorecardResponse.json()

    expect(listPayload.sessions[0].agentRunName).toBe('autonomous-trader-market-open-api-test')
    expect(detailPayload.status.currentAction).toContain('standing down')
    expect(detailPayload.events[0].eventType).toBe('no_trade_decision')
    expect(detailPayload.tradeTickets[0].noTradeReason).toBe('C setup blocked')
    expect(scorecardPayload.scorecards[0]).toMatchObject({
      symbol: 'AMD',
      setupType: 'vwap_reclaim',
      rejectedInvalid: 1,
    })
  })
})

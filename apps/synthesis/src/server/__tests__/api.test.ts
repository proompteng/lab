import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { handleCreateRun, handleGetAsset, handleListFeed, handleSubmitItem } from '../api'
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
          mediaUrls: [`https://pbs.twimg.com/media/example-${index}.jpg`],
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
    setSynthesisStoreForTests(createInMemorySynthesisStore())
  })

  afterEach(() => {
    delete process.env.SYNTHESIS_API_TOKEN
    setSynthesisStoreForTests(null)
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
    expect(firstPage.items[0].mediaUrls[0]).toContain('pbs.twimg.com/media')
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const secondResponse = await handleListFeed(
      new Request(`http://synthesis.test/api/feed?limit=2&minScore=0&cursor=${firstPage.nextCursor}`),
    )
    const secondPage = await secondResponse.json()
    expect(secondPage.items).toHaveLength(2)

    const firstIds = new Set(firstPage.items.map((item: { id: string }) => item.id))
    expect(secondPage.items.some((item: { id: string }) => firstIds.has(item.id))).toBe(false)
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
              mediaUrls: ['https://pbs.twimg.com/media/hbm-1.jpg'],
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
    expect(feedPayload.items).toHaveLength(1)
    expect(feedPayload.items[0].dedupeKey).toBe('theme:agent-browser-tooling')
  })
})

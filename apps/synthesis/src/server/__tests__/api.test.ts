import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { handleCreateRun, handleListFeed, handleSubmitItem } from '../api'
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
      originalUrl: `https://x.com/example/status/${1000 + index}`,
      observedText: `observed post ${index} about semis and devtools`,
      summary: `semis/devtools summary ${index}`,
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
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const secondResponse = await handleListFeed(
      new Request(`http://synthesis.test/api/feed?limit=2&minScore=0&cursor=${firstPage.nextCursor}`),
    )
    const secondPage = await secondResponse.json()
    expect(secondPage.items).toHaveLength(2)

    const firstIds = new Set(firstPage.items.map((item: { id: string }) => item.id))
    expect(secondPage.items.some((item: { id: string }) => firstIds.has(item.id))).toBe(false)
  })
})

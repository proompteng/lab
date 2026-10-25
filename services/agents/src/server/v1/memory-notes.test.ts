import { describe, expect, it, vi } from 'vitest'

import {
  getMemoryNotesCountHandler,
  getMemoryNotesHandler,
  getMemoryNotesStatsHandler,
  postMemoryNotesHandler,
} from './memory-notes'

const makeStore = () => {
  const saved: {
    id: string
    namespace: string
    content: string
    summary: string | null
    tags: string[]
    metadata: Record<string, unknown>
    createdAt: string
    distance?: number
  }[] = []
  const close = vi.fn(async () => undefined)
  const store = {
    persist: vi.fn(async ({ namespace = 'default', content, summary, tags = [], metadata = {} }) => {
      const record = {
        id: `mem-${saved.length + 1}`,
        namespace,
        content,
        summary: summary ?? null,
        tags,
        metadata,
        createdAt: '2026-05-20T00:00:00.000Z',
      }
      saved.push(record)
      return record
    }),
    retrieve: vi.fn(async ({ namespace, query, limit = 10 }) =>
      saved
        .filter((record) => (!namespace ? true : record.namespace === namespace))
        .filter((record) => record.content.includes(query) || (record.summary ?? '').includes(query))
        .slice(0, limit),
    ),
    count: vi.fn(
      async ({ namespace } = {}) =>
        saved.filter((record) => (namespace ? record.namespace === namespace : true)).length,
    ),
    stats: vi.fn(async ({ days = 30 } = {}) => ({
      range: { days, from: '2026-05-20', to: '2026-05-20' },
      byDay: [{ day: '2026-05-20', count: saved.length }],
      topNamespaces: [{ namespace: 'demo', count: saved.length }],
    })),
    close,
  }
  return { store, saved }
}

describe('memory notes v1 handlers', () => {
  it('persists and retrieves memory notes through the Agents-owned store', async () => {
    const { store } = makeStore()
    const deps = { storeFactory: () => store }

    const postResponse = await postMemoryNotesHandler(
      new Request('http://agents.local/v1/memory-notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: 'demo', content: 'hello world', summary: 'hello', tags: ['a'] }),
      }),
      deps,
    )
    expect(postResponse.status).toBe(201)
    await expect(postResponse.json()).resolves.toMatchObject({
      ok: true,
      memory: { namespace: 'demo', content: 'hello world', summary: 'hello' },
    })

    const getResponse = await getMemoryNotesHandler(
      new Request('http://agents.local/v1/memory-notes?query=hello&namespace=demo&limit=5'),
      deps,
    )
    expect(getResponse.status).toBe(200)
    await expect(getResponse.json()).resolves.toMatchObject({
      ok: true,
      memories: [{ namespace: 'demo', content: 'hello world' }],
    })
  })

  it('rejects invalid requests before hitting the store', async () => {
    const { store } = makeStore()

    const postResponse = await postMemoryNotesHandler(
      new Request('http://agents.local/v1/memory-notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      { storeFactory: () => store },
    )
    expect(postResponse.status).toBe(400)
    await expect(postResponse.json()).resolves.toMatchObject({ error: 'invalid JSON body' })

    const getResponse = await getMemoryNotesHandler(new Request('http://agents.local/v1/memory-notes?namespace=demo'), {
      storeFactory: () => store,
    })
    expect(getResponse.status).toBe(400)
    await expect(getResponse.json()).resolves.toMatchObject({ error: 'Query is required.' })
    expect(store.persist).not.toHaveBeenCalled()
    expect(store.retrieve).not.toHaveBeenCalled()
  })

  it('serves memory note count and stats', async () => {
    const { store } = makeStore()
    await store.persist({ namespace: 'demo', content: 'hello', summary: null })
    const deps = { storeFactory: () => store }

    const countResponse = await getMemoryNotesCountHandler(
      new Request('http://agents.local/v1/memory-notes/count?namespace=demo'),
      deps,
    )
    expect(countResponse.status).toBe(200)
    await expect(countResponse.json()).resolves.toEqual({ ok: true, count: 1 })

    const statsResponse = await getMemoryNotesStatsHandler(
      new Request('http://agents.local/v1/memory-notes/stats?days=7&topNamespaces=2'),
      deps,
    )
    expect(statsResponse.status).toBe(200)
    await expect(statsResponse.json()).resolves.toMatchObject({
      ok: true,
      range: { days: 7 },
      topNamespaces: [{ namespace: 'demo', count: 1 }],
    })
  })
})

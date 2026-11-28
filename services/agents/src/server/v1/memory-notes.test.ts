import { describe, expect, it, vi } from 'vitest'
import { summarizeMemoryNote } from '@proompteng/agent-contracts'

import {
  getMemoryNotesCountHandler,
  getMemoryNotesHandler,
  getMemoryNoteHandler,
  getMemoryNotesStatsHandler,
  postMemoryNotesHandler,
  postRetireMemoryNoteHandler,
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
    retiredAt: string | null
    retirementReason: string | null
    replacementId: string | null
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
        retiredAt: null,
        retirementReason: null,
        replacementId: null,
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
    list: vi.fn(async () => ({ ok: true as const, memories: saved.map(summarizeMemoryNote), nextCursor: null })),
    get: vi.fn(async (id: string) => saved.find((note) => note.id === id) ?? null),
    retire: vi.fn(async () => {
      const note = saved[0]
      if (!note) throw new Error('Memory note not found.')
      return note
    }),
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
  it('reports unavailable storage when opening an exact note', async () => {
    const response = await getMemoryNoteHandler(
      new Request('http://agents.test/v1/memory-notes/id'),
      '11111111-1111-4111-8111-111111111111',
      {
        storeFactory: () => {
          throw new Error('DATABASE_URL is required')
        },
      },
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toHaveProperty('error', 'DATABASE_URL is required')
  })
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
    expect(postResponse.status).toBe(200)
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

  it('lists latest notes with filters without requiring semantic retrieval', async () => {
    const { store } = makeStore()
    const response = await getMemoryNotesHandler(
      new Request(
        'http://agents.local/v1/memory-notes?mode=latest&repository=proompteng/lab&tag=bayn&model=qwen38-flamingo&createdAfter=2026-11-01&limit=3',
      ),
      { storeFactory: () => store },
    )
    expect(response.status).toBe(200)
    expect(store.retrieve).not.toHaveBeenCalled()
    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'proompteng/lab',
        tags: ['bayn'],
        model: 'qwen38-flamingo',
        createdAfter: '2026-11-01T00:00:00.000Z',
        limit: 3,
      }),
    )
  })

  it('validates retirement and reports missing notes', async () => {
    const { store } = makeStore()
    const request = (body: unknown) =>
      new Request('http://agents.local/v1/memory-notes/retire', { method: 'POST', body: JSON.stringify(body) })
    const invalid = await postRetireMemoryNoteHandler(request({ id: 'invalid', reason: 'obsolete' }), {
      storeFactory: () => store,
    })
    expect(invalid.status).toBe(400)
    expect(store.retire).not.toHaveBeenCalled()
    const missing = await postRetireMemoryNoteHandler(
      request({ id: '00000000-0000-0000-0000-000000000001', reason: 'replaced by current source' }),
      { storeFactory: () => store },
    )
    expect(missing.status).toBe(404)
    expect(store.close).toHaveBeenCalledOnce()
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

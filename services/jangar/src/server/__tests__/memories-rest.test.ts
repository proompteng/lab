import { Effect, pipe } from 'effect'
import { describe, expect, it } from 'vitest'

import { getMemoriesHandlerEffect, postMemoriesHandlerEffect } from '~/routes/api/memories'
import { Memories, type MemoriesService } from '~/server/memories'
import type { MemoryRecord } from '~/server/memories-store'

const makeService = (): { service: MemoriesService; saved: MemoryRecord[] } => {
  const saved: MemoryRecord[] = []

  const service: MemoriesService = {
    persist: ({ namespace, content, summary, tags }) =>
      Effect.sync(() => {
        const record: MemoryRecord = {
          id: `mem-${saved.length + 1}`,
          namespace: namespace ?? 'default',
          content,
          summary: summary ?? null,
          tags: tags ?? [],
          metadata: {},
          createdAt: new Date().toISOString(),
        }
        saved.push(record)
        return record
      }),
    retrieve: ({ namespace, query, limit }) =>
      Effect.sync(() =>
        saved
          .filter((mem) => (!namespace ? true : mem.namespace === namespace))
          .filter((mem) => mem.content.includes(query) || (mem.summary ?? '').includes(query))
          .slice(0, limit ?? 10),
      ),
    count: ({ namespace } = {}) =>
      Effect.sync(() => saved.filter((mem) => (namespace ? mem.namespace === namespace : true)).length),
    stats: ({ days } = {}) =>
      Effect.sync(() => {
        const resolvedDays = days ?? 30
        const today = new Date().toISOString().slice(0, 10)
        return {
          range: { days: resolvedDays, from: today, to: today },
          byDay: [],
          topNamespaces: [],
        }
      }),
  }

  return { service, saved }
}

const run = <T>(effect: Effect.Effect<T, unknown, Memories>, service: MemoriesService) =>
  Effect.runPromise(pipe(effect, Effect.provideService(Memories, service)))

describe('memories REST handlers', () => {
  it('persists memories via POST', async () => {
    const { service, saved } = makeService()

    const request = new Request('http://localhost/api/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'demo', content: 'hello world', summary: 'hello', tags: ['a'] }),
    })

    const response = await run(postMemoriesHandlerEffect(request), service)
    expect(response.status).toBe(201)

    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(json.memory.namespace).toBe('demo')
    expect(saved).toHaveLength(1)
  })

  it('rejects invalid JSON bodies', async () => {
    const { service } = makeService()

    const request = new Request('http://localhost/api/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })

    const response = await run(postMemoriesHandlerEffect(request), service)
    expect(response.status).toBe(400)

    const json = await response.json()
    expect(json.error).toBe('invalid JSON body')
  })

  it('retrieves memories via GET', async () => {
    const { service } = makeService()

    const seed = new Request('http://localhost/api/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'demo', content: 'find me please', summary: 'find' }),
    })
    await run(postMemoriesHandlerEffect(seed), service)

    const request = new Request('http://localhost/api/memories?query=find&namespace=demo&limit=5')
    const response = await run(getMemoriesHandlerEffect(request), service)
    expect(response.status).toBe(200)

    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(json.memories).toHaveLength(1)
  })

  it('returns 400 for missing query', async () => {
    const { service } = makeService()

    const request = new Request('http://localhost/api/memories?namespace=demo')
    const response = await run(getMemoriesHandlerEffect(request), service)
    expect(response.status).toBe(400)

    const json = await response.json()
    expect(json.error).toBe('Query is required.')
  })

  it('returns 503 when the memories service fails with missing DATABASE_URL', async () => {
    const failing: MemoriesService = {
      persist: () => Effect.fail(new Error('DATABASE_URL is required for MCP memories storage')),
      retrieve: () => Effect.fail(new Error('DATABASE_URL is required for MCP memories storage')),
      count: () => Effect.fail(new Error('DATABASE_URL is required for MCP memories storage')),
      stats: () => Effect.fail(new Error('DATABASE_URL is required for MCP memories storage')),
    }

    const request = new Request('http://localhost/api/memories?query=test')
    const response = await run(getMemoriesHandlerEffect(request), failing)
    expect(response.status).toBe(503)

    const json = await response.json()
    expect(json.error).toContain('DATABASE_URL is required')
  })
})

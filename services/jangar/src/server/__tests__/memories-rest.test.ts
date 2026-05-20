import { Effect, pipe } from 'effect'
import { describe, expect, it } from 'vitest'

import { getMemoriesHandlerEffect, postMemoriesHandlerEffect } from '~/routes/api/memories'
import { MemoryNotes, type MemoryNotesService } from '~/server/memory-notes'
import type { AgentsMemoryNoteRecord } from '@proompteng/agent-contracts/memory-client'

const makeService = (): { service: MemoryNotesService; saved: AgentsMemoryNoteRecord[] } => {
  const saved: AgentsMemoryNoteRecord[] = []

  const service: MemoryNotesService = {
    persist: ({ namespace, content, summary, tags }) =>
      Effect.sync(() => {
        const record: AgentsMemoryNoteRecord = {
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

const run = <T>(effect: Effect.Effect<T, unknown, MemoryNotes>, service: MemoryNotesService) =>
  Effect.runPromise(pipe(effect, Effect.provideService(MemoryNotes, service)))

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

  it('returns 503 when the Agents memory service is unavailable', async () => {
    const failing: MemoryNotesService = {
      persist: () => Effect.fail(new Error('Agents service unavailable')),
      retrieve: () => Effect.fail(new Error('Agents service unavailable')),
      count: () => Effect.fail(new Error('Agents service unavailable')),
      stats: () => Effect.fail(new Error('Agents service unavailable')),
    }

    const request = new Request('http://localhost/api/memories?query=test')
    const response = await run(getMemoriesHandlerEffect(request), failing)
    expect(response.status).toBe(500)

    const json = await response.json()
    expect(json.error).toContain('Agents service unavailable')
  })
})

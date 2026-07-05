import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __test__, queryMemory, writeMemoryEmbedding, writeMemoryEvent } from './memory-provider'
import type { MemoryProviderQueryable } from './memory-provider-schema'

const connection = {
  dataset: 'agent-memory',
  schema: 'public',
  embeddingDimension: 3,
  connectionString: 'postgresql://provider-db',
}

const makePool = () => {
  const calls: { sql: string; params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    const normalized = sql.toLowerCase()
    if (normalized.includes('select extname from pg_extension')) {
      return { rows: [{ extname: 'vector' }, { extname: 'pgcrypto' }] }
    }
    if (normalized.includes('from "public"."memory_embeddings"') && normalized.includes('embedding <=>')) {
      return { rows: [{ key: 'note-1', score: 0.9, metadata: { source: 'test' } }] }
    }
    return { rows: [] }
  })

  return { calls, pool: { query } as unknown as MemoryProviderQueryable }
}

describe('memory provider operations', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of [
      'NODE_ENV',
      'OPENAI_API_KEY',
      'OPENAI_EMBEDDING_API_BASE_URL',
      'OPENAI_API_BASE_URL',
      'OPENAI_API_BASE',
      'OPENAI_EMBEDDING_DIMENSION',
    ]) {
      previousEnv[key] = process.env[key]
    }
    process.env.NODE_ENV = 'test'
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_EMBEDDING_API_BASE_URL
    delete process.env.OPENAI_API_BASE_URL
    delete process.env.OPENAI_API_BASE
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
  })

  afterEach(() => {
    __test__.resetMemoryProviderState()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('bootstraps the resolved provider database before writing events', async () => {
    const { calls, pool } = makePool()
    __test__.setMemoryProviderPoolFactory(() => pool)

    await writeMemoryEvent(connection, 'sync-started', { ok: true })

    const createTableIndex = calls.findIndex((call) => call.sql.toLowerCase().includes('create table if not exists'))
    const insertIndex = calls.findIndex((call) =>
      call.sql.toLowerCase().includes('insert into "public"."memory_events"'),
    )
    expect(createTableIndex).toBeGreaterThanOrEqual(0)
    expect(insertIndex).toBeGreaterThan(createTableIndex)
    expect(calls[insertIndex]?.params).toEqual(['agent-memory', 'sync-started', { ok: true }])
  })

  it('does not create the IVFFlat index in the embedding write path', async () => {
    const { calls, pool } = makePool()
    __test__.setMemoryProviderPoolFactory(() => pool)

    await writeMemoryEmbedding(connection, 'note-1', 'hello world', { source: 'test' })

    const insertIndex = calls.findIndex((call) =>
      call.sql.toLowerCase().includes('insert into "public"."memory_embeddings"'),
    )
    expect(insertIndex).toBeGreaterThanOrEqual(0)
    expect(calls.some((call) => call.sql.toLowerCase().includes('using ivfflat'))).toBe(false)
  })

  it('queries memory without creating an online IVFFlat index', async () => {
    const { calls, pool } = makePool()
    __test__.setMemoryProviderPoolFactory(() => pool)

    await expect(queryMemory(connection, 'hello', 1)).resolves.toEqual([
      { key: 'note-1', score: 0.9, metadata: { source: 'test' } },
    ])

    const queryIndex = calls.findIndex(
      (call) =>
        call.sql.toLowerCase().includes('from "public"."memory_embeddings"') &&
        call.sql.toLowerCase().includes('embedding <=>'),
    )
    expect(queryIndex).toBeGreaterThanOrEqual(0)
    expect(calls.some((call) => call.sql.toLowerCase().includes('using ivfflat'))).toBe(false)
  })
})

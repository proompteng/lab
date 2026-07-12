import { describe, expect, it, vi } from 'vitest'

import {
  createMemoryProviderAnnIndexIfReady,
  ensureMemoryProviderSchema,
  getMemoryProviderSchemaStatements,
  type MemoryProviderQueryable,
} from './memory-provider-schema'

const makeQueryable = (options: { embeddingRows?: number; extensions?: string[] } = {}) => {
  const calls: { sql: string; params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    const normalized = sql.toLowerCase()
    if (normalized.includes('select extname from pg_extension')) {
      return { rows: (options.extensions ?? ['vector', 'pgcrypto']).map((extname) => ({ extname })) }
    }
    if (normalized.includes('select count(*)') && normalized.includes('memory_embeddings')) {
      return { rows: [{ row_count: options.embeddingRows ?? 0 }] }
    }
    return { rows: [] }
  })

  return { calls, db: { query } as unknown as MemoryProviderQueryable }
}

describe('memory provider schema bootstrap', () => {
  it('creates provider tables and base indexes without creating an IVFFlat index', async () => {
    const { calls, db } = makeQueryable()

    await ensureMemoryProviderSchema(db, { schema: 'public', embeddingDimension: 3 })

    const sqlText = calls.map((call) => call.sql.toLowerCase()).join('\n')
    expect(sqlText).toContain('create table if not exists "public"."memory_events"')
    expect(sqlText).toContain('create table if not exists "public"."memory_kv"')
    expect(sqlText).toContain('create table if not exists "public"."memory_embeddings"')
    expect(sqlText).not.toContain('using ivfflat')
  })

  it('keeps the migration statement set free of the deferred ANN index', () => {
    const sqlText = getMemoryProviderSchemaStatements(3, 'public').join('\n').toLowerCase()

    expect(sqlText).toContain('memory_embeddings')
    expect(sqlText).not.toContain('using ivfflat')
  })

  it('does not create the ANN index before enough embeddings exist', async () => {
    const { calls, db } = makeQueryable({ embeddingRows: 99_999 })

    await expect(createMemoryProviderAnnIndexIfReady(db, { schema: 'public', embeddingDimension: 3 })).resolves.toBe(
      false,
    )

    expect(calls.some((call) => call.sql.toLowerCase().includes('using ivfflat'))).toBe(false)
  })

  it('creates the ANN index after there are enough embeddings to train it', async () => {
    const { calls, db } = makeQueryable({ embeddingRows: 100_000 })
    await expect(createMemoryProviderAnnIndexIfReady(db, { schema: 'public', embeddingDimension: 3 })).resolves.toBe(
      true,
    )

    expect(calls.some((call) => call.sql.toLowerCase().includes('using ivfflat'))).toBe(true)
    expect(calls.some((call) => call.sql.toLowerCase().includes('with (lists = 100)'))).toBe(true)
  })

  it('fails fast when the provider database is missing required extensions', async () => {
    const { db } = makeQueryable({ extensions: [] })

    await expect(ensureMemoryProviderSchema(db, { schema: 'public', embeddingDimension: 3 })).rejects.toThrow(
      /missing required Postgres extensions in Memory provider database/i,
    )
  })
})

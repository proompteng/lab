import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => {
  const end = vi.fn(async () => undefined)
  const query = vi.fn(async () => ({ rows: [] }))
  const construct = vi.fn()
  class Pool {
    constructor() {
      construct()
    }
    query = query
    end = end
  }
  return { Pool, construct, query, end }
})

vi.mock('pg', () => ({
  Pool: pgMocks.Pool,
}))

import { closeMemoryProviderPools, writeMemoryEmbedding, writeMemoryEvent } from '~/server/memory-provider'

const connection = {
  dataset: 'test-memory',
  schema: 'public',
  embeddingDimension: 3,
  connectionString: 'postgresql://memory-provider-test',
}

describe('memory-provider', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    await closeMemoryProviderPools()
    vi.unstubAllGlobals()
  })

  it('uses fallback embeddings only in development when no embedding endpoint is configured', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_EMBEDDING_API_BASE_URL
    delete process.env.OPENAI_API_BASE_URL
    delete process.env.OPENAI_API_BASE

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await writeMemoryEmbedding(connection, 'key-1', 'hello world')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(pgMocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO public.memory_embeddings'), [
      'test-memory',
      'key-1',
      expect.stringMatching(/^\[[^\]]+\]$/),
      {},
    ])
  })

  it('fails closed in production when hosted embeddings are misconfigured', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_EMBEDDING_API_BASE_URL
    delete process.env.OPENAI_API_BASE_URL
    delete process.env.OPENAI_API_BASE

    await expect(writeMemoryEmbedding(connection, 'key-1', 'hello world')).rejects.toThrow(/missing OPENAI_API_KEY/i)
  })

  it('fails when the embedding input exceeds the configured maximum length', async () => {
    process.env.NODE_ENV = 'production'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    process.env.OPENAI_EMBEDDING_MAX_INPUT_CHARS = '5'

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(writeMemoryEmbedding(connection, 'key-1', 'hello world')).rejects.toThrow(/input too large/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails when the embedding request exceeds the configured timeout', async () => {
    process.env.NODE_ENV = 'production'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    process.env.OPENAI_EMBEDDING_TIMEOUT_MS = '5'

    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }),
    )

    await expect(writeMemoryEmbedding(connection, 'key-1', 'hello world')).rejects.toThrow(/timed out/i)
  })

  it('reuses pooled postgres clients across repeated writes', async () => {
    process.env.NODE_ENV = 'development'

    await writeMemoryEvent(connection, 'sync-started', { ok: true })
    await writeMemoryEvent(connection, 'sync-finished', { ok: true })

    expect(pgMocks.construct).toHaveBeenCalledTimes(1)
    expect(pgMocks.query).toHaveBeenCalledTimes(2)

    await closeMemoryProviderPools()

    expect(pgMocks.end).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it } from 'bun:test'
import { Language, type Tree } from 'web-tree-sitter'

import productionActivities, { __test__ } from './index'

it('registers only the full-main writer and its required operational activities', () => {
  expect(Object.keys(productionActivities).sort()).toEqual([
    'publishMainMergeMemoryNote',
    'reconcileAtlasRepository',
    'upsertIngestion',
  ])
})

describe('Atlas chunk coverage', () => {
  it('indexes exported arrow functions and covers every nonblank source line', async () => {
    const source = [
      "import { sql } from 'kysely'",
      '',
      '// Repository-wide code search handler.',
      'export const createAtlasCodeSearchHandlers = ({ db }: { db: unknown }) => {',
      "  const mode = 'ready'",
      '  return { db, mode }',
      '}',
      '',
      'const trailingConfiguration = { enabled: true }',
    ].join('\n')

    const chunks = await __test__.extractFileChunks(source, 'services/jangar/src/server/atlas-code-search.ts')

    expect(
      chunks.some(
        (chunk) => chunk.metadata.chunkType === 'ast_node' && chunk.content.includes('createAtlasCodeSearchHandlers'),
      ),
    ).toBe(true)
    expect(chunks.every((chunk) => chunk.metadata.chunkerVersion === __test__.ATLAS_CHUNKER_VERSION)).toBe(true)
    expect(() => __test__.assertChunkCoverage(source, chunks)).not.toThrow()
  })

  it('uses line chunks for Markdown', async () => {
    const source = '# Title\n\nBody'
    const chunks = await __test__.extractFileChunks(source, 'README.md')

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ content: source, metadata: { chunkType: 'fixed_lines' } })
  })
})

describe('tree-sitter resource lifecycle', () => {
  const language = {} as Language

  it('deletes the syntax tree and parser after reading a tree', () => {
    let treeDeletes = 0
    let parserDeletes = 0
    const tree = { delete: () => (treeDeletes += 1) } as unknown as Tree
    const parser = {
      setLanguage: () => parser,
      parse: () => tree,
      delete: () => (parserDeletes += 1),
    }

    expect(
      __test__.withParsedTree(
        language,
        'const value = 1',
        () => 'read',
        () => parser,
      ),
    ).toBe('read')
    expect(treeDeletes).toBe(1)
    expect(parserDeletes).toBe(1)
  })

  it('deletes the syntax tree and parser when reading throws', () => {
    let treeDeletes = 0
    let parserDeletes = 0
    const tree = { delete: () => (treeDeletes += 1) } as unknown as Tree
    const parser = {
      setLanguage: () => parser,
      parse: () => tree,
      delete: () => (parserDeletes += 1),
    }

    expect(() =>
      __test__.withParsedTree(
        language,
        'const value = 1',
        () => {
          throw new Error('read failed')
        },
        () => parser,
      ),
    ).toThrow('read failed')
    expect(treeDeletes).toBe(1)
    expect(parserDeletes).toBe(1)
  })

  it('deletes the parser when parsing returns no tree', () => {
    let parserDeletes = 0
    const parser = {
      setLanguage: () => parser,
      parse: () => null,
      delete: () => (parserDeletes += 1),
    }

    expect(
      __test__.withParsedTree(
        language,
        'const value = 1',
        () => 'unreachable',
        () => parser,
      ),
    ).toBeNull()
    expect(parserDeletes).toBe(1)
  })
})

describe('bumba embeddings', () => {
  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  it('batches Atlas inputs for the Ollama embed API', async () => {
    const previousFetch = globalThis.fetch
    const previousEnv = {
      OPENAI_API_BASE_URL: process.env.OPENAI_API_BASE_URL,
      OPENAI_EMBEDDING_API_BASE_URL: process.env.OPENAI_EMBEDDING_API_BASE_URL,
      ATLAS_CODE_SEARCH_EMBEDDING_MODEL: process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL,
      ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION: process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION,
      OPENAI_EMBEDDING_BATCH_SIZE: process.env.OPENAI_EMBEDDING_BATCH_SIZE,
      OPENAI_EMBEDDING_MAX_BATCH_CHARS: process.env.OPENAI_EMBEDDING_MAX_BATCH_CHARS,
      OPENAI_EMBEDDING_TIMEOUT_MS: process.env.OPENAI_EMBEDDING_TIMEOUT_MS,
      OPENAI_EMBEDDING_TRUNCATE: process.env.OPENAI_EMBEDDING_TRUNCATE,
      OPENAI_EMBEDDING_KEEP_ALIVE: process.env.OPENAI_EMBEDDING_KEEP_ALIVE,
    }

    process.env.OPENAI_API_BASE_URL = 'http://127.0.0.1:11434/v1'
    process.env.OPENAI_EMBEDDING_API_BASE_URL = 'http://127.0.0.1:11434/api'
    process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL = 'atlas-test-model'
    process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION = '3'
    process.env.OPENAI_EMBEDDING_BATCH_SIZE = '2'
    delete process.env.OPENAI_EMBEDDING_MAX_BATCH_CHARS
    process.env.OPENAI_EMBEDDING_TIMEOUT_MS = '5000'
    process.env.OPENAI_EMBEDDING_TRUNCATE = 'false'
    process.env.OPENAI_EMBEDDING_KEEP_ALIVE = '30m'

    const requests: Array<{ url: string; body: Record<string, unknown> }> = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : ''
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      requests.push({ url, body })

      return new Response(
        JSON.stringify({
          embeddings: [
            [0, 1, 2],
            [3, 4, 5],
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    try {
      expect(await __test__.embedTexts(['alpha', 'beta'])).toEqual([
        [0, 1, 2],
        [3, 4, 5],
      ])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('http://127.0.0.1:11434/api/embed')
      expect(requests[0]?.body.model).toBe('atlas-test-model')
      expect(requests[0]?.body.input).toEqual(['alpha', 'beta'])
      expect(requests[0]?.body.dimensions).toBe(3)
      expect(requests[0]?.body.truncate).toBe(false)
      expect(requests[0]?.body.keep_alive).toBe('30m')
    } finally {
      globalThis.fetch = previousFetch
      for (const [key, value] of Object.entries(previousEnv)) {
        restoreEnv(key, value)
      }
    }
  })

  it('uses the embeddings endpoint for OpenAI-compatible bases', async () => {
    const previousFetch = globalThis.fetch
    const previousEnv = {
      OPENAI_API_BASE_URL: process.env.OPENAI_API_BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_EMBEDDING_API_BASE_URL: process.env.OPENAI_EMBEDDING_API_BASE_URL,
      ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION: process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION,
      OPENAI_EMBEDDING_BATCH_SIZE: process.env.OPENAI_EMBEDDING_BATCH_SIZE,
    }

    process.env.OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    delete process.env.OPENAI_EMBEDDING_API_BASE_URL
    process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION = '4'
    process.env.OPENAI_EMBEDDING_BATCH_SIZE = '1'

    let requestUrl = ''
    let requestBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : ''
      requestBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null

      return new Response(JSON.stringify({ data: [{ embedding: [1, 1, 1, 1] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      expect(await __test__.embedTexts(['hello'])).toEqual([[1, 1, 1, 1]])
      expect(requestUrl).toBe('https://api.openai.com/v1/embeddings')
      if (!requestBody) {
        throw new Error('expected embedding request body')
      }
      const body = requestBody as { input?: unknown; dimensions?: unknown }
      expect(body.input).toEqual(['hello'])
      expect(body.dimensions).toBe(4)
    } finally {
      globalThis.fetch = previousFetch
      for (const [key, value] of Object.entries(previousEnv)) {
        restoreEnv(key, value)
      }
    }
  })
})

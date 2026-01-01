import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Language } from 'web-tree-sitter'

import { activities, parseCompletionOutput } from './index'

const runGit = (args: string[], cwd: string) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'git command failed')
  }
  return result.stdout.toString().trim()
}

const runExtract = async (extension: string, content: string) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
  const filename = `sample${extension}`
  const filePath = join(repoRoot, filename)

  try {
    await writeFile(filePath, content, 'utf8')
    return await activities.extractAstSummary({ repoRoot, filePath: filename })
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

describe('bumba ast extraction', () => {
  it('parses tree-sitter kotlin files', async () => {
    const result = await runExtract('.kt', 'class Foo {}')
    expect(result.metadata.language).toBe('kotlin')
  })

  it('parses tree-sitter terraform files', async () => {
    const result = await runExtract('.tf', 'resource "test" "example" {}')
    expect(result.metadata.language).toBe('terraform')
  })

  it('parses tree-sitter bash files', async () => {
    const result = await runExtract('.sh', 'echo "hello"')
    expect(result.metadata.language).toBe('bash')
  })

  it('falls back to text facts when tree-sitter yields no facts', async () => {
    const result = await runExtract('.json', '{ "foo": "bar" }')
    expect(result.metadata.language).toBe('json')
    expect(result.metadata.factsFallback).toBe('text')
    expect(result.facts.length).toBeGreaterThan(0)
  })

  it('parses embedded template files', async () => {
    const result = await runExtract('.erb', '<%= user.name %>')
    expect(result.metadata.language).toBe('embedded-template')
  })

  it('parses markdown with a custom parser', async () => {
    const result = await runExtract('.md', '# Title\n\nBody')
    expect(result.metadata.parser).toBe('markdown')
  })

  it('parses proto files with a custom parser', async () => {
    const result = await runExtract('.proto', 'message Foo { string bar = 1; }')
    expect(result.metadata.parser).toBe('proto')
  })

  it('parses ini files with a custom parser', async () => {
    const result = await runExtract('.ini', '[section]\nkey=value')
    expect(result.metadata.parser).toBe('ini')
  })

  it('falls back to plain text when no parser exists', async () => {
    const result = await runExtract('.txt', 'Hello world')
    expect(result.metadata.parser).toBe('text')
    expect(result.metadata.language).toBe('text')
  })

  it('falls back to plain text when tree-sitter language load fails', async () => {
    const loader = Language as unknown as { load: typeof Language.load }
    const originalLoad = loader.load
    loader.load = async () => {
      throw new Error('load failed')
    }

    try {
      const result = await runExtract('.ts', 'const example = 1')
      expect(result.metadata.parser).toBe('text')
      expect(result.metadata.language).toBe('typescript')
      expect(result.metadata.skipped).toBe(true)
      expect(result.metadata.reason).toBe('language_load_failed')
    } finally {
      loader.load = originalLoad
    }
  })
})

describe('bumba readRepoFile', () => {
  it('reads file content from git objects when commit is available', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'README.md'
    const content = 'hello from git\n'
    const previousFetch = globalThis.fetch

    try {
      runGit(['init', '-b', 'main'], repoRoot)
      runGit(['config', 'user.email', 'bumba-tests@example.com'], repoRoot)
      runGit(['config', 'user.name', 'Bumba Tests'], repoRoot)
      runGit(['config', 'commit.gpgsign', 'false'], repoRoot)
      await writeFile(join(repoRoot, filePath), content, 'utf8')
      runGit(['add', '.'], repoRoot)
      runGit(['commit', '-m', 'init'], repoRoot)
      const commit = runGit(['rev-parse', 'HEAD'], repoRoot)

      const fetchStub = (async () => {
        throw new Error('unexpected fetch')
      }) as unknown as typeof fetch
      globalThis.fetch = fetchStub

      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        repository: 'proompteng/lab',
        commit,
      })

      expect(result.content).toBe(content)
      expect(result.metadata.repoCommit).toBe(commit)
      expect(result.metadata.metadata.source).toBe('git')
    } finally {
      globalThis.fetch = previousFetch
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('normalizes refs/heads/* to branch name in metadata', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'README.md'
    const content = 'hello ref\n'

    try {
      runGit(['init', '-b', 'main'], repoRoot)
      runGit(['config', 'user.email', 'bumba-tests@example.com'], repoRoot)
      runGit(['config', 'user.name', 'Bumba Tests'], repoRoot)
      runGit(['config', 'commit.gpgsign', 'false'], repoRoot)
      await writeFile(join(repoRoot, filePath), content, 'utf8')
      runGit(['add', '.'], repoRoot)
      runGit(['commit', '-m', 'init'], repoRoot)

      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        ref: 'refs/heads/main',
      })

      expect(result.metadata.repoRef).toBe('main')
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('fetches from GitHub when local file is missing', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'services/bumba/src/workflows/index.test.ts'
    const commit = 'deadbeef'
    const content = 'console.log("hello")'
    const encoded = Buffer.from(content, 'utf8').toString('base64')

    const previousToken = process.env.GITHUB_TOKEN
    const previousFetch = globalThis.fetch
    let requestedUrl: string | null = null

    process.env.GITHUB_TOKEN = 'token'
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : null
      return new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: encoded,
          size: content.length,
          download_url: 'https://raw.githubusercontent.com/proompteng/lab/deadbeef/file.ts',
          url: 'https://api.github.com/repos/proompteng/lab/contents/file.ts',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        repository: 'proompteng/lab',
        commit,
      })

      expect(result.content).toBe(content)
      expect(result.metadata.repoCommit).toBe(commit)
      expect(result.metadata.metadata.source).toBe('github')
      expect(requestedUrl).not.toBeNull()
      expect(String(requestedUrl)).toContain(`/repos/proompteng/lab/contents/${filePath}`)
      expect(String(requestedUrl)).toContain(`ref=${commit}`)
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN
      } else {
        process.env.GITHUB_TOKEN = previousToken
      }
      globalThis.fetch = previousFetch
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('throws DirectoryError when file path is a directory', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'some-dir'

    try {
      await mkdir(join(repoRoot, filePath), { recursive: true })
      await writeFile(join(repoRoot, filePath, '.gitkeep'), '', 'utf8')
      await expect(
        activities.readRepoFile({
          repoRoot,
          filePath,
        }),
      ).rejects.toMatchObject({ name: 'DirectoryError' })
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('handles empty gitkeep files from GitHub contents API', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'apps/discourse/cids/.gitkeep'
    const commit = 'deadbeef'

    const previousToken = process.env.GITHUB_TOKEN
    const previousFetch = globalThis.fetch
    let calls = 0

    process.env.GITHUB_TOKEN = 'token'
    globalThis.fetch = (async () => {
      calls += 1
      if (calls > 1) {
        throw new Error('unexpected fetch')
      }
      return new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'none',
          content: '',
          size: 0,
          download_url: 'https://raw.githubusercontent.com/proompteng/lab/deadbeef/.gitkeep',
          url: 'https://api.github.com/repos/proompteng/lab/contents/.gitkeep',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        repository: 'proompteng/lab',
        commit,
      })

      expect(result.content).toBe('')
      expect(result.metadata.metadata.source).toBe('github')
      expect(calls).toBe(1)
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN
      } else {
        process.env.GITHUB_TOKEN = previousToken
      }
      globalThis.fetch = previousFetch
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('falls back to download_url when encoding is unsupported', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-'))
    const filePath = 'README.md'
    const commit = 'deadbeef'

    const previousToken = process.env.GITHUB_TOKEN
    const previousFetch = globalThis.fetch
    const rawContent = 'raw file contents'
    let apiCalls = 0
    let rawCalls = 0

    process.env.GITHUB_TOKEN = 'token'
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : ''
      if (url.includes('api.github.com')) {
        apiCalls += 1
        return new Response(
          JSON.stringify({
            type: 'file',
            encoding: 'none',
            content: null,
            size: rawContent.length,
            download_url: 'https://raw.githubusercontent.com/proompteng/lab/deadbeef/README.md',
            url: 'https://api.github.com/repos/proompteng/lab/contents/README.md',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('raw.githubusercontent.com')) {
        rawCalls += 1
        return new Response(rawContent, { status: 200 })
      }
      throw new Error(`unexpected fetch url: ${url}`)
    }) as unknown as typeof fetch

    try {
      const result = await activities.readRepoFile({
        repoRoot,
        filePath,
        repository: 'proompteng/lab',
        commit,
      })

      expect(result.content).toBe(rawContent)
      expect(result.metadata.metadata.source).toBe('github')
      expect(apiCalls).toBe(1)
      expect(rawCalls).toBe(1)
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN
      } else {
        process.env.GITHUB_TOKEN = previousToken
      }
      globalThis.fetch = previousFetch
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('bumba completion parsing', () => {
  it('normalizes enriched arrays into bullet strings', () => {
    const output = parseCompletionOutput(
      JSON.stringify({
        summary: 'One line summary.',
        enriched: ['first bullet', '- second bullet'],
      }),
    )

    expect(output.summary).toBe('One line summary.')
    expect(output.enriched).toBe('- first bullet\n- second bullet')
    expect(output.metadata.parsedJson).toBe(true)
  })

  it('fails fast on error payloads', () => {
    expect(() =>
      parseCompletionOutput(
        JSON.stringify({
          error: {
            message: 'The response was filtered due to the prompt violating the content policy.',
          },
        }),
      ),
    ).toThrow('completion error: The response was filtered due to the prompt violating the content policy.')
  })

  it('rejects JSON without summary or enriched fields', () => {
    expect(() => parseCompletionOutput(JSON.stringify({ foo: 'bar' }))).toThrow(
      'completion response missing summary/enriched',
    )
  })

  it('rejects non-JSON responses', () => {
    expect(() => parseCompletionOutput('plain text response')).toThrow('completion response was not valid JSON')
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

  it('batches embedding requests for Ollama embed API', async () => {
    const previousFetch = globalThis.fetch
    const previousEnv = {
      OPENAI_API_BASE_URL: process.env.OPENAI_API_BASE_URL,
      OPENAI_EMBEDDING_API_BASE_URL: process.env.OPENAI_EMBEDDING_API_BASE_URL,
      OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
      OPENAI_EMBEDDING_DIMENSION: process.env.OPENAI_EMBEDDING_DIMENSION,
      OPENAI_EMBEDDING_BATCH_SIZE: process.env.OPENAI_EMBEDDING_BATCH_SIZE,
      OPENAI_EMBEDDING_TIMEOUT_MS: process.env.OPENAI_EMBEDDING_TIMEOUT_MS,
      OPENAI_EMBEDDING_TRUNCATE: process.env.OPENAI_EMBEDDING_TRUNCATE,
      OPENAI_EMBEDDING_KEEP_ALIVE: process.env.OPENAI_EMBEDDING_KEEP_ALIVE,
    }

    process.env.OPENAI_API_BASE_URL = 'http://127.0.0.1:11434/v1'
    process.env.OPENAI_EMBEDDING_API_BASE_URL = 'http://127.0.0.1:11434/api'
    process.env.OPENAI_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    process.env.OPENAI_EMBEDDING_BATCH_SIZE = '2'
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
      const first = activities.createEmbedding({ text: 'alpha' })
      const second = activities.createEmbedding({ text: 'beta' })
      const [resultA, resultB] = await Promise.all([first, second])

      expect(resultA.embedding).toEqual([0, 1, 2])
      expect(resultB.embedding).toEqual([3, 4, 5])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('http://127.0.0.1:11434/api/embed')
      expect(requests[0]?.body.model).toBe('qwen3-embedding:0.6b')
      expect(requests[0]?.body.input).toEqual(['alpha', 'beta'])
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
      OPENAI_EMBEDDING_DIMENSION: process.env.OPENAI_EMBEDDING_DIMENSION,
      OPENAI_EMBEDDING_BATCH_SIZE: process.env.OPENAI_EMBEDDING_BATCH_SIZE,
    }

    process.env.OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    delete process.env.OPENAI_EMBEDDING_API_BASE_URL
    process.env.OPENAI_EMBEDDING_DIMENSION = '4'
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
      const result = await activities.createEmbedding({ text: 'hello' })
      expect(result.embedding).toEqual([1, 1, 1, 1])
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

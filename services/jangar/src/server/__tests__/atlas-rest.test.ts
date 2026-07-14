import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getAtlasIndexedHandler } from '~/routes/api/atlas/indexed'
import { getAtlasPathsHandler } from '~/routes/api/atlas/paths'
import { postEnrichHandler } from '~/routes/api/enrich'
import { getAtlasSearchHandler } from '~/routes/api/search'

const runGit = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()

const initRepo = (cwd: string) => {
  try {
    runGit(['init', '-b', 'main'], cwd)
  } catch {
    runGit(['init'], cwd)
    runGit(['checkout', '-b', 'main'], cwd)
  }
  runGit(['config', 'user.email', 'atlas-tests@example.com'], cwd)
  runGit(['config', 'user.name', 'Atlas Tests'], cwd)
  runGit(['config', 'commit.gpgsign', 'false'], cwd)
}

describe('atlas REST handlers', () => {
  const previousEnv: Partial<Record<'CODEX_CWD' | 'DATABASE_URL', string | undefined>> = {}
  let repoRoot: string | null = null

  beforeEach(async () => {
    previousEnv.CODEX_CWD = process.env.CODEX_CWD
    previousEnv.DATABASE_URL = process.env.DATABASE_URL

    repoRoot = await mkdtemp(join(tmpdir(), 'jangar-atlas-'))
    initRepo(repoRoot)

    await writeFile(join(repoRoot, 'README.md'), 'hello world\n')
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src/demo.txt'), 'atlas sample\n')
    runGit(['add', '.'], repoRoot)
    runGit(['commit', '-m', 'init'], repoRoot)

    process.env.CODEX_CWD = repoRoot
    delete process.env.DATABASE_URL
  })

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = null
    }

    if (previousEnv.CODEX_CWD === undefined) {
      delete process.env.CODEX_CWD
    } else {
      process.env.CODEX_CWD = previousEnv.CODEX_CWD
    }

    if (previousEnv.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousEnv.DATABASE_URL
    }
  })

  it('requires a query for search', async () => {
    const request = new Request('http://localhost/api/search?limit=5')
    const response = await getAtlasSearchHandler(request)
    expect(response.status).toBe(400)

    const json = await response.json()
    expect(json.message).toContain('Query')
  })

  it('returns 503 when Atlas storage is unavailable', async () => {
    const request = new Request('http://localhost/api/search?query=hello&limit=5&repository=proompteng/lab&ref=main')
    const response = await getAtlasSearchHandler(request)
    expect(response.status).toBe(503)

    const json = await response.json()
    expect(json.message).toContain('DATABASE_URL')
  })

  it('rejects direct file writes', async () => {
    const request = new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'abc123' },
      body: JSON.stringify({ repository: 'proompteng/lab', ref: 'main', path: 'README.md' }),
    })

    const response = await postEnrichHandler(request)
    expect(response.status).toBe(409)

    const json = await response.json()
    expect(json.ok).toBe(false)
    expect(json.message).toContain('Direct Atlas file writes are disabled')
  })

  it('does not pretend to queue reconciliation without configured services', async () => {
    const request = new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'repository', repository: 'proompteng/lab', ref: 'main' }),
    })

    const response = await postEnrichHandler(request)
    expect(response.status).toBe(503)

    const json = await response.json()
    expect(json.message).toContain('configured Postgres and Temporal')
  })

  it('rejects non-main repository reconciliation', async () => {
    const request = new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'repository', repository: 'proompteng/lab', ref: 'feature' }),
    })

    const response = await postEnrichHandler(request)
    expect(response.status).toBe(409)
  })

  it('returns path suggestions', async () => {
    const request = new Request('http://localhost/api/atlas/paths?query=src&repository=proompteng/lab&ref=main')
    const response = await getAtlasPathsHandler(request)
    expect(response.status).toBe(200)

    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(json.paths).toContain('src/demo.txt')
  })

  it('returns empty paths when query is missing', async () => {
    const request = new Request('http://localhost/api/atlas/paths?repository=proompteng/lab&ref=main')
    const response = await getAtlasPathsHandler(request)
    expect(response.status).toBe(200)

    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(json.paths).toEqual([])
  })

  it('returns 503 when indexed files are unavailable', async () => {
    const request = new Request('http://localhost/api/atlas/indexed?limit=5')
    const response = await getAtlasIndexedHandler(request)
    expect(response.status).toBe(503)

    const json = await response.json()
    expect(json.message).toContain('DATABASE_URL')
  })
})

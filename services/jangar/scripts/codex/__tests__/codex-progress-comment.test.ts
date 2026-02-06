import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCodexProgressComment } from '../codex-progress-comment'

const bunMocks = vi.hoisted(() => {
  const execMock = vi.fn((_command: string) => undefined)
  const whichMock = vi.fn(async () => 'gh')
  const isTemplateStringsArray = (value: unknown): value is TemplateStringsArray =>
    Array.isArray(value) && Object.hasOwn(value, 'raw')
  const makeTagged =
    () =>
    (strings: TemplateStringsArray, ...exprs: unknown[]) => {
      const command = strings.reduce((acc, part, index) => acc + part + (exprs[index] ?? ''), '').trim()
      execMock(command)
      return {
        text: async () =>
          JSON.stringify({
            id: 100,
            html_url: 'https://github.com/owner/repo/comments/100',
            body: '<!-- codex:progress --> body',
          }),
      }
    }
  const dollar = (...args: unknown[]) => {
    const first = args[0]
    if (isTemplateStringsArray(first)) {
      return makeTagged()(first, ...(args.slice(1) as unknown[]))
    }
    if (typeof first === 'object' && first !== null) {
      return makeTagged()
    }
    throw new Error('Invalid $ invocation')
  }

  return { execMock, whichMock, dollar }
})

vi.mock('bun', () => ({
  $: bunMocks.dollar,
  which: bunMocks.whichMock,
}))

const execMock = bunMocks.execMock
const whichMock = bunMocks.whichMock

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_FETCH = global.fetch

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe('runCodexProgressComment', () => {
  beforeEach(() => {
    process.env.ISSUE_REPO = 'owner/repo'
    process.env.ISSUE_NUMBER = '42'
    process.env.GH_TOKEN = 'token'
    execMock.mockClear()
    whichMock.mockClear()
  })

  afterEach(() => {
    resetEnv()
    if (ORIGINAL_FETCH) {
      global.fetch = ORIGINAL_FETCH
    }
  })

  it('creates a new comment when none exists', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
      text: async () => '[]',
      status: 200,
      statusText: 'OK',
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    const result = await runCodexProgressComment({ body: '<!-- codex:progress --> hello' })

    expect(fetchMock).toHaveBeenCalled()
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('repos/owner/repo/issues/42/comments --method POST'))
    expect(result.action).toBe('create')
    expect(result.commentId).toBe(100)
    expect(result.commentUrl).toBe('https://github.com/owner/repo/comments/100')
    expect(result.markerPresent).toBe(1)
  })

  it('updates an existing comment when the marker is found', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          id: 55,
          html_url: 'https://github.com/owner/repo/comments/55',
          body: '<!-- codex:progress --> previous',
        },
      ],
      text: async () => '[]',
      status: 200,
      statusText: 'OK',
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    const result = await runCodexProgressComment({ body: '<!-- codex:progress --> update' })

    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('repos/owner/repo/issues/comments/55 --method PATCH'))
    expect(result.action).toBe('update')
    expect(result.commentId).toBe(100)
  })

  it('throws when the marker is missing', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
      text: async () => '[]',
      status: 200,
      statusText: 'OK',
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    await expect(runCodexProgressComment({ body: 'no marker' })).rejects.toThrow(
      "Comment body must include the marker '<!-- codex:progress -->'",
    )
  })

  it('throws when ISSUE_REPO is unavailable', async () => {
    delete process.env.ISSUE_REPO
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
      text: async () => '[]',
      status: 200,
      statusText: 'OK',
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    await expect(runCodexProgressComment({ body: '<!-- codex:progress --> hi' })).rejects.toThrow(
      'ISSUE_REPO and ISSUE_NUMBER must be provided via flags or environment variables',
    )
  })

  it('supports dry-run mode and writes logs when configured', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
      text: async () => '[]',
      status: 200,
      statusText: 'OK',
    }))
    global.fetch = fetchMock as unknown as typeof global.fetch

    const logDir = await mkdtemp(join(tmpdir(), 'codex-progress-log-'))
    const logPath = join(logDir, 'progress.log')
    process.env.CODEX_PROGRESS_COMMENT_LOG_PATH = logPath

    const result = await runCodexProgressComment({ args: ['--dry-run'], body: '<!-- codex:progress --> log' })

    const logContents = await readFile(logPath, 'utf8')
    expect(logContents).toContain('dry_run=true')
    expect(result.action).toBe('create')

    await rm(logDir, { recursive: true, force: true })
  })

  it('returns help metadata when invoked with --help', async () => {
    const result = await runCodexProgressComment({ args: ['--help'] })
    expect(result.action).toBe('help')
    expect(result.commentId).toBe('')
  })
})

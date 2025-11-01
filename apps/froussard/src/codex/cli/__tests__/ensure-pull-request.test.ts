import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensurePullRequestExists } from '../codex-implement'
import type { CodexLogger } from '../lib/logger'

const spawnMock = vi.hoisted(() =>
  vi.fn<(command: string, args?: ReadonlyArray<string>, options?: SpawnOptions) => ChildProcess>(),
)
const bunUtils = vi.hoisted(() => ({
  which: vi.fn(async () => 'bun') as (command: string) => Promise<string>,
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('bun', () => bunUtils)

const ORIGINAL_ENV = { ...process.env }

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe('ensurePullRequestExists', () => {
  let logger: CodexLogger

  beforeEach(() => {
    process.env.CODEX_SKIP_PR_CHECK = '0'
    delete process.env.CODEX_PR_CHECK_ATTEMPTS
    delete process.env.CODEX_PR_CHECK_RETRY_MS

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      flush: async () => {},
    }

    spawnMock.mockImplementation((command: string, args: ReadonlyArray<string> = [], _options?: SpawnOptions) => {
      if (command !== 'gh') {
        throw new Error(`Unexpected command invocation: ${command}`)
      }

      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ChildProcess & {
        stdout: PassThrough
        stderr: PassThrough
      }
      child.stdout = stdout
      child.stderr = stderr

      const headIndex = args.indexOf('--head')
      const headValue = headIndex === -1 ? '' : (args[headIndex + 1] ?? '')

      setImmediate(() => {
        if (headValue === 'proompteng:codex/issue-1649-cbfe6480') {
          stdout.end('[]')
        } else if (headValue === 'codex/issue-1649-cbfe6480') {
          stdout.end('[{"number":1,"url":"https://example.test/pr/1","state":"OPEN"}]')
        } else {
          stdout.end('[]')
        }
        stderr.end('')
        child.emit('close', 0)
      })

      return child
    })
  })

  afterEach(() => {
    spawnMock.mockReset()
    restoreEnv()
  })

  it('falls back to checking the plain head branch selector when owner-qualified lookup misses', async () => {
    await expect(
      ensurePullRequestExists('proompteng/lab', 'codex/issue-1649-cbfe6480', logger),
    ).resolves.toBeUndefined()

    expect(spawnMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--head', 'proompteng:codex/issue-1649-cbfe6480']),
      expect.any(Object),
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--head', 'codex/issue-1649-cbfe6480']),
      expect.any(Object),
    )
  })
})

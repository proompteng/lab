import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexRunner } from './runner'
import { spawn } from 'node:child_process'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const spawnMock = vi.mocked(spawn)

type MockProcess = EventEmitter & {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: () => void
}

const createMockProcess = (lines: string[], exitCode = 0) => {
  const stdinChunks: string[] = []
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinChunks.push(chunk.toString())
      callback()
    },
  })

  const stdout = Readable.from(lines.map((line) => `${line}\n`))
  const stderr = new Readable({ read() {} })
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
  }) as MockProcess

  stdout.on('end', () => proc.emit('exit', exitCode))

  return { proc, stdinChunks }
}

describe('CodexRunner', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('streams agent messages and captures session id', async () => {
    const { proc, stdinChunks } = createMockProcess([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }),
    ])

    spawnMock.mockReturnValue(proc as never)

    const workdir = await mkdtemp(join(tmpdir(), 'codex-runner-test-'))
    const runner = new CodexRunner({ codexPathOverride: 'codex' })
    const result = await runner.run({
      input: 'prompt',
      lastMessagePath: join(workdir, 'last.txt'),
    })

    expect(result.agentMessages).toEqual(['hello'])
    expect(result.sessionId).toBe('thread-1')
    expect(stdinChunks.join('')).toBe('prompt')

    await rm(workdir, { recursive: true, force: true })
  })

  it('adds --output-last-message and --json to command args', async () => {
    const { proc } = createMockProcess([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    ])
    spawnMock.mockReturnValue(proc as never)

    const workdir = await mkdtemp(join(tmpdir(), 'codex-runner-test-'))
    const runner = new CodexRunner({ codexPathOverride: 'codex' })

    await runner.run({
      input: 'prompt',
      lastMessagePath: join(workdir, 'last.txt'),
    })

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined
    expect(args).toEqual(expect.arrayContaining(['exec', '--json']))
    const idx = args?.indexOf('--output-last-message') ?? -1
    expect(idx).toBeGreaterThan(-1)
    expect(args?.[idx + 1]).toContain('last.txt')

    await rm(workdir, { recursive: true, force: true })
  })

  it('uses resume --last without stdin dash', async () => {
    const { proc } = createMockProcess([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    ])
    spawnMock.mockReturnValue(proc as never)

    const workdir = await mkdtemp(join(tmpdir(), 'codex-runner-test-'))
    const runner = new CodexRunner({ codexPathOverride: 'codex' })

    await runner.run({
      input: 'prompt',
      lastMessagePath: join(workdir, 'last.txt'),
      resumeSessionId: 'last',
    })

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined
    expect(args).toContain('resume')
    expect(args).toContain('--last')
    expect(args).not.toContain('-')

    await rm(workdir, { recursive: true, force: true })
  })

  it('rejects promptly when spawn emits an error', async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(),
    }) as MockProcess

    spawnMock.mockImplementation(() => {
      setImmediate(() => proc.emit('error', new Error('spawn failed')))
      return proc as never
    })

    const runner = new CodexRunner({ codexPathOverride: 'codex' })

    await expect(
      runner.run({
        input: 'prompt',
        lastMessagePath: join(await mkdtemp(join(tmpdir(), 'codex-runner-test-')), 'last.txt'),
      }),
    ).rejects.toThrow('spawn failed')
  })
})

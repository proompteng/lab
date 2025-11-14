import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const whichMock = vi.hoisted(() => vi.fn(async () => '/usr/local/bin/bun'))

vi.mock('bun', () => ({
  which: whichMock,
}))

import {
  buildDiscordChannelCommand,
  copyAgentLogIfNeeded,
  parseBoolean,
  pathExists,
  randomRunId,
  timestampUtc,
} from '../codex-utils'

describe('codex-utils', () => {
  let workdir: string

  beforeEach(async () => {
    whichMock.mockResolvedValue('/usr/local/bin/bun')
    workdir = await mkdtemp(join(tmpdir(), 'codex-utils-test-'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('checks whether a path exists', async () => {
    const filePath = join(workdir, 'present.txt')
    await writeFile(filePath, 'hello', 'utf8')

    expect(await pathExists(filePath)).toBe(true)
    expect(await pathExists(join(workdir, 'missing.txt'))).toBe(false)
  })

  it('parses boolean-like environment values', () => {
    expect(parseBoolean('true', false)).toBe(true)
    expect(parseBoolean('0', true)).toBe(false)
    expect(parseBoolean(undefined, true)).toBe(true)
    expect(parseBoolean('maybe', false)).toBe(false)
  })

  it('generates random run identifiers of the requested length', () => {
    const id = randomRunId(8)
    expect(id).toHaveLength(8)
    expect(/^[a-z0-9]+$/u.test(id)).toBe(true)
  })

  it('produces a UTC timestamp without fractional seconds', () => {
    const timestamp = timestampUtc()
    expect(timestamp.endsWith('Z')).toBe(true)
    expect(timestamp).not.toMatch(/\./)
  })

  it('copies the agent log when the output is empty', async () => {
    const outputPath = join(workdir, 'output.log')
    const agentPath = join(workdir, 'agent.log')
    await writeFile(agentPath, 'agent contents', 'utf8')

    await copyAgentLogIfNeeded(outputPath, agentPath)

    const copied = await readFile(outputPath, 'utf8')
    expect(copied).toBe('agent contents')
  })

  it('builds a bun channel command using the resolved binary', async () => {
    const command = await buildDiscordChannelCommand('channel.ts', ['--stage', 'plan'])
    expect(command).toEqual(['/usr/local/bin/bun', 'run', 'channel.ts', '--stage', 'plan'])
  })

  it('throws when bun cannot be resolved', async () => {
    whichMock.mockResolvedValueOnce('')
    await expect(buildDiscordChannelCommand('channel.ts', [])).rejects.toThrow('bun not available in PATH')
  })
})

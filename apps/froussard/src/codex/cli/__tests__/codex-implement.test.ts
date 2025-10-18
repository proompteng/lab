import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCodexImplementation } from '../codex-implement'

const utilMocks = vi.hoisted(() => ({
  pathExists: vi.fn(async (path: string) => !path.includes('missing')),
  parseBoolean: vi.fn((value: string | undefined, fallback: boolean) => {
    if (value === undefined) {
      return fallback
    }
    return ['1', 'true', 'yes'].includes(value.toLowerCase())
  }),
  randomRunId: vi.fn(() => 'random123'),
  timestampUtc: vi.fn(() => '2025-10-11T00:00:00Z'),
  copyAgentLogIfNeeded: vi.fn(async () => undefined),
  buildDiscordRelayCommand: vi.fn(async () => ['bun', 'run', 'relay.ts']),
}))

vi.mock('../lib/codex-utils', () => utilMocks)

const bunUtils = vi.hoisted(() => ({
  which: vi.fn(async () => 'bun') as (command: string) => Promise<string>,
}))

vi.mock('bun', () => bunUtils)

const runnerMocks = vi.hoisted(() => ({
  runCodexSession: vi.fn(async () => ({ agentMessages: [] })),
  pushCodexEventsToLoki: vi.fn(async () => {}),
}))

vi.mock('../lib/codex-runner', () => runnerMocks)

const runCodexSessionMock = runnerMocks.runCodexSession
const pushCodexEventsToLokiMock = runnerMocks.pushCodexEventsToLoki
const buildDiscordRelayCommandMock = utilMocks.buildDiscordRelayCommand

const ORIGINAL_ENV = { ...process.env }

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

describe('runCodexImplementation', () => {
  let workdir: string
  let eventPath: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'codex-impl-test-'))
    eventPath = join(workdir, 'event.json')
    delete process.env.OUTPUT_PATH
    delete process.env.JSON_OUTPUT_PATH
    delete process.env.AGENT_OUTPUT_PATH
    process.env.WORKTREE = workdir
    process.env.LGTM_LOKI_ENDPOINT = 'http://localhost/loki'
    process.env.RELAY_SCRIPT = ''

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      planCommentId: 123,
      planCommentUrl: 'http://example.com',
      planCommentBody: '<!-- codex:plan -->',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    runCodexSessionMock.mockClear()
    pushCodexEventsToLokiMock.mockClear()
    buildDiscordRelayCommandMock.mockClear()
    utilMocks.pathExists.mockImplementation(async (path: string) => !path.includes('missing'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    resetEnv()
  })

  it('runs the implementation session and pushes events', async () => {
    await runCodexImplementation(eventPath)

    expect(runCodexSessionMock).toHaveBeenCalledTimes(1)
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.stage).toBe('implementation')
    expect(invocation?.outputPath).toBe(join(workdir, '.codex-implementation.log'))
    expect(invocation?.logger).toBeDefined()
    expect(pushCodexEventsToLokiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'implementation',
        endpoint: 'http://localhost/loki',
        jsonPath: join(workdir, '.codex-implementation-events.jsonl'),
        agentLogPath: join(workdir, '.codex-implementation-agent.log'),
        runtimeLogPath: join(workdir, '.codex-implementation-runtime.log'),
      }),
    )
  })

  it('throws when the event file is missing', async () => {
    await expect(runCodexImplementation(join(workdir, 'missing.json'))).rejects.toThrow(/Event payload file not found/)
  })

  it('configures a Discord relay when credentials are provided', async () => {
    process.env.DISCORD_BOT_TOKEN = 'token'
    process.env.DISCORD_GUILD_ID = 'guild'
    process.env.RELAY_SCRIPT = 'apps/froussard/scripts/discord-relay.ts'
    utilMocks.pathExists.mockResolvedValue(true)

    await runCodexImplementation(eventPath)

    expect(buildDiscordRelayCommandMock).toHaveBeenCalledWith(
      'apps/froussard/scripts/discord-relay.ts',
      expect.any(Array),
    )
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.discordRelay?.command).toEqual(['bun', 'run', 'relay.ts'])
  })

  it('throws when repository is missing in the payload', async () => {
    await writeFile(eventPath, JSON.stringify({ prompt: 'hi', repository: '', issueNumber: 3 }), 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('Missing repository metadata in event payload')
  })

  it('throws when issue number is missing in the payload', async () => {
    await writeFile(eventPath, JSON.stringify({ prompt: 'hi', repository: 'owner/repo', issueNumber: '' }), 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('Missing issue number metadata in event payload')
  })
})

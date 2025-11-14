import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  pathExistsMock,
  copyAgentLogIfNeededMock,
  randomRunIdMock,
  timestampUtcMock,
  buildDiscordChannelCommandMock,
  runCodexSessionMock,
  pushCodexEventsToLokiMock,
  buildCodexPromptMock,
} = vi.hoisted(() => ({
  pathExistsMock: vi.fn(async (path: string) => !path.includes('missing')),
  copyAgentLogIfNeededMock: vi.fn(async () => undefined),
  randomRunIdMock: vi.fn(() => 'random456'),
  timestampUtcMock: vi.fn(() => '2025-10-18T00:00:00Z'),
  buildDiscordChannelCommandMock: vi.fn(async () => ['bun', 'run', 'channel.ts']),
  runCodexSessionMock: vi.fn(async () => ({ agentMessages: [] })),
  pushCodexEventsToLokiMock: vi.fn(async () => {}),
  buildCodexPromptMock: vi.fn(() => 'REVIEW PROMPT'),
}))

vi.mock('../lib/codex-utils', () => ({
  pathExists: pathExistsMock,
  copyAgentLogIfNeeded: copyAgentLogIfNeededMock,
  randomRunId: randomRunIdMock,
  timestampUtc: timestampUtcMock,
  buildDiscordChannelCommand: buildDiscordChannelCommandMock,
}))

vi.mock('../lib/codex-runner', () => ({
  runCodexSession: runCodexSessionMock,
  pushCodexEventsToLoki: pushCodexEventsToLokiMock,
}))

vi.mock('@/codex', () => ({
  buildCodexPrompt: buildCodexPromptMock,
}))

import { runCodexReview } from '../codex-review'

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

describe('runCodexReview', () => {
  let workdir: string
  let eventPath: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'codex-review-test-'))
    eventPath = join(workdir, 'event.json')
    delete process.env.OUTPUT_PATH
    delete process.env.JSON_OUTPUT_PATH
    delete process.env.AGENT_OUTPUT_PATH
    process.env.WORKTREE = workdir
    process.env.LGTM_LOKI_ENDPOINT = 'http://localhost/loki'
    process.env.CHANNEL_SCRIPT = ''

    const payload = {
      repository: 'owner/repo',
      issueNumber: 7,
      issueTitle: 'Review behaviour',
      issueBody: 'Address reviewer feedback.',
      issueUrl: 'https://github.com/owner/repo/pull/7',
      base: 'main',
      head: 'codex/issue-7-feedback',
      reviewContext: {
        summary: 'One unresolved thread and failing check remain.',
        reviewThreads: [
          {
            summary: 'Update integration tests with new fixture',
            url: 'https://github.com/owner/repo/pull/5#discussion-1',
            author: 'octocat',
          },
        ],
        failingChecks: [
          {
            name: 'ci / test',
            conclusion: 'failure',
            url: 'https://ci.example.com/run/42',
            details: 'Integration suite is red',
          },
        ],
        additionalNotes: ['Merge gate is waiting on approvals.'],
      },
    }

    await writeFile(eventPath, JSON.stringify(payload))

    runCodexSessionMock.mockReset()
    runCodexSessionMock.mockResolvedValue({ agentMessages: [] })
    pushCodexEventsToLokiMock.mockReset()
    pushCodexEventsToLokiMock.mockResolvedValue(undefined)
    buildCodexPromptMock.mockReset()
    buildCodexPromptMock.mockReturnValue('REVIEW PROMPT')
    buildDiscordChannelCommandMock.mockReset()
    buildDiscordChannelCommandMock.mockResolvedValue(['bun', 'run', 'channel.ts'])
    pathExistsMock.mockReset()
    pathExistsMock.mockImplementation(async (path: string) => !path.includes('missing'))
    copyAgentLogIfNeededMock.mockReset()
    copyAgentLogIfNeededMock.mockResolvedValue(undefined)
    randomRunIdMock.mockReset()
    randomRunIdMock.mockReturnValue('random456')
    timestampUtcMock.mockReset()
    timestampUtcMock.mockReturnValue('2025-10-18T00:00:00Z')
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    resetEnv()
  })

  it('runs the review session with synthesized prompt', async () => {
    await runCodexReview(eventPath)

    expect(buildCodexPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'review',
        reviewContext: expect.objectContaining({
          reviewThreads: [expect.objectContaining({ summary: 'Update integration tests with new fixture' })],
          failingChecks: [expect.objectContaining({ name: 'ci / test' })],
        }),
      }),
    )

    expect(runCodexSessionMock).toHaveBeenCalledTimes(1)
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.stage).toBe('review')
    expect(invocation?.prompt).toBe('REVIEW PROMPT')
    expect(invocation?.outputPath).toBe(join(workdir, '.codex-review.log'))
    expect(pushCodexEventsToLokiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'review',
        jsonPath: join(workdir, '.codex-review-events.jsonl'),
      }),
    )
  })

  it('throws when the event file is missing', async () => {
    await expect(runCodexReview(join(workdir, 'missing.json'))).rejects.toThrow(/Event payload file not found/)
  })

  it('throws when repository is missing', async () => {
    await writeFile(eventPath, JSON.stringify({ issueNumber: 7, head: 'branch', base: 'main' }))
    await expect(runCodexReview(eventPath)).rejects.toThrow('Missing repository metadata in event payload')
  })

  it('throws when issue number is missing', async () => {
    await writeFile(eventPath, JSON.stringify({ repository: 'owner/repo', head: 'branch', base: 'main' }))
    await expect(runCodexReview(eventPath)).rejects.toThrow('Missing issue number metadata in event payload')
  })

  it('throws when head branch metadata is missing', async () => {
    await writeFile(eventPath, JSON.stringify({ repository: 'owner/repo', issueNumber: 9, base: 'main' }))
    await expect(runCodexReview(eventPath)).rejects.toThrow('Missing Codex branch metadata in event payload')
  })

  it('configures Discord channel streaming when credentials are set', async () => {
    process.env.DISCORD_BOT_TOKEN = 'token'
    process.env.DISCORD_GUILD_ID = 'guild'
    process.env.CHANNEL_SCRIPT = 'apps/froussard/scripts/discord-channel.ts'
    pathExistsMock.mockResolvedValue(true)

    await runCodexReview(eventPath)

    expect(buildDiscordChannelCommandMock).toHaveBeenCalledWith(
      'apps/froussard/scripts/discord-channel.ts',
      expect.arrayContaining([
        '--stage',
        'review',
        '--repo',
        'owner/repo',
        '--issue',
        '7',
        '--title',
        'Review behaviour',
        '--url',
        'https://github.com/owner/repo/pull/7',
        '--summary',
        'One unresolved thread and failing check remain.',
      ]),
    )
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.discordChannel?.command).toEqual(['bun', 'run', 'channel.ts'])
  })
})

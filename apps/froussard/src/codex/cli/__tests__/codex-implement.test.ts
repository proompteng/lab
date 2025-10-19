import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  runCodexSession: vi.fn(async () => ({ agentMessages: [], sessionId: 'session-xyz' })),
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

    const runGit = async (args: string[]) =>
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', args, { cwd: workdir })
        let stderr = ''
        proc.stderr?.on('data', (chunk) => {
          stderr += chunk.toString()
        })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`git ${args.join(' ')} exited with ${code}: ${stderr}`))
          }
        })
      })

    await runGit(['init'])
    await runGit(['config', 'user.email', 'codex@example.com'])
    await runGit(['config', 'user.name', 'Codex Tester'])
    await writeFile(join(workdir, '.gitkeep'), '', 'utf8')
    await runGit(['add', '.gitkeep'])
    await runGit(['commit', '-m', 'chore: initial'])

    runCodexSessionMock.mockReset()
    runCodexSessionMock.mockImplementation(async () => ({ agentMessages: [], sessionId: 'session-xyz' }))
    pushCodexEventsToLokiMock.mockReset()
    pushCodexEventsToLokiMock.mockImplementation(async () => {})
    buildDiscordRelayCommandMock.mockClear()
    utilMocks.pathExists.mockImplementation(async (path: string) => !path.includes('missing'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    resetEnv()
  })

  it('runs the implementation session and pushes events', async () => {
    const result = await runCodexImplementation(eventPath)

    expect(runCodexSessionMock).toHaveBeenCalledTimes(1)
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.stage).toBe('implementation')
    expect(invocation?.outputPath).toBe(join(workdir, '.codex-implementation.log'))
    expect(invocation?.resumeSessionId).toBeUndefined()
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
    expect(result.patchPath).toBe(join(workdir, '.codex-implementation.patch'))
    expect(result.statusPath).toBe(join(workdir, '.codex-implementation-status.txt'))
    expect(result.archivePath).toBe(join(workdir, '.codex-implementation-changes.tar.gz'))
    expect(result.sessionId).toBe('session-xyz')
    await expect(stat(result.patchPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(result.statusPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(result.archivePath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    const resumeMetadataPath = join(workdir, '.codex', 'implementation-resume.json')
    await expect(stat(resumeMetadataPath)).rejects.toThrow()
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

  it('resumes a previous implementation session when resume metadata is present', async () => {
    const resumeSourceDir = await mkdtemp(join(tmpdir(), 'codex-impl-resume-src-'))
    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      worktree: workdir,
      repository: 'owner/repo',
      issueNumber: '42',
      prompt: 'Implementation prompt',
      sessionId: 'resume-session-1',
      trackedFiles: ['src/real.ts', 'src/example.ts'],
      deletedFiles: [] as string[],
    }

    await mkdir(join(resumeSourceDir, 'metadata'), { recursive: true })
    const filesSrcDir = join(resumeSourceDir, 'files', 'src')
    await mkdir(filesSrcDir, { recursive: true })
    await writeFile(join(resumeSourceDir, 'metadata', 'manifest.json'), JSON.stringify(manifest), 'utf8')
    const resumeRealContent = 'console.log("from resume");\n'
    await writeFile(join(filesSrcDir, 'real.ts'), resumeRealContent, 'utf8')
    await symlink('./real.ts', join(filesSrcDir, 'example.ts'))

    const archivePath = join(workdir, '.codex-implementation-changes.tar.gz')
    await new Promise<void>((resolve, reject) => {
      const tarProcess = spawn('tar', ['-czf', archivePath, '-C', resumeSourceDir, '.'])
      tarProcess.on('error', reject)
      tarProcess.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`tar exited with status ${code}`))
        }
      })
    })

    await mkdir(join(workdir, '.codex'), { recursive: true })
    const resumeMetadataPath = join(workdir, '.codex', 'implementation-resume.json')
    const resumeMetadata = {
      ...manifest,
      archivePath,
      patchPath: join(workdir, '.codex-implementation.patch'),
      statusPath: join(workdir, '.codex-implementation-status.txt'),
      state: 'pending' as const,
    }
    await writeFile(resumeMetadataPath, JSON.stringify(resumeMetadata), 'utf8')

    runCodexSessionMock.mockImplementationOnce(async (options) => {
      expect(options.resumeSessionId).toBe('resume-session-1')
      return { agentMessages: [], sessionId: 'resumed-session' }
    })

    try {
      const result = await runCodexImplementation(eventPath)

      expect(result.sessionId).toBe('resumed-session')
      const invocation = runCodexSessionMock.mock.calls[0]?.[0]
      expect(invocation?.resumeSessionId).toBe('resume-session-1')
      const restoredLink = join(workdir, 'src', 'example.ts')
      const restoredFile = join(workdir, 'src', 'real.ts')
      const linkStats = await lstat(restoredLink)
      expect(linkStats.isSymbolicLink()).toBe(true)
      expect(await readlink(restoredLink)).toBe('./real.ts')
      await expect(readFile(restoredFile, 'utf8')).resolves.toBe(resumeRealContent)
      await expect(stat(resumeMetadataPath)).rejects.toThrow()
    } finally {
      await rm(resumeSourceDir, { recursive: true, force: true })
    }
  })

  it('still writes artifact placeholders when implementation fails', async () => {
    const linkTargetPath = join(workdir, 'linked.txt')
    await writeFile(linkTargetPath, 'linked\n', 'utf8')
    const linkPath = join(workdir, 'link.txt')
    await symlink('linked.txt', linkPath)

    runCodexSessionMock.mockRejectedValueOnce(new Error('codex failure'))

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('codex failure')

    const patchPath = join(workdir, '.codex-implementation.patch')
    const statusPath = join(workdir, '.codex-implementation-status.txt')
    const archivePath = join(workdir, '.codex-implementation-changes.tar.gz')

    await expect(stat(patchPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(statusPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(archivePath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    const resumeMetadataPath = join(workdir, '.codex', 'implementation-resume.json')
    const resumeMetadataRaw = await readFile(resumeMetadataPath, 'utf8')
    const resumeMetadata = JSON.parse(resumeMetadataRaw) as Record<string, unknown>
    expect(resumeMetadata.state).toBe('pending')
    expect(resumeMetadata.repository).toBe('owner/repo')
    expect(resumeMetadata.issueNumber).toBe('42')

    const extractionDir = await mkdtemp(join(tmpdir(), 'codex-impl-archive-'))
    try {
      await new Promise<void>((resolve, reject) => {
        const tarProcess = spawn('tar', ['-xzf', archivePath, '-C', extractionDir])
        tarProcess.on('error', reject)
        tarProcess.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`tar exited with status ${code}`))
          }
        })
      })
      const extractedLinkPath = join(extractionDir, 'files', 'link.txt')
      const linkStats = await lstat(extractedLinkPath)
      expect(linkStats.isSymbolicLink()).toBe(true)
      expect(await readlink(extractedLinkPath)).toBe('linked.txt')
    } finally {
      await rm(extractionDir, { recursive: true, force: true })
    }
  })
})

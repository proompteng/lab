import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCodexImplementation } from '../codex-implement'
import type { PushCodexEventsToLokiOptions, RunCodexSessionOptions, RunCodexSessionResult } from '../lib/codex-runner'

const utilMocks = vi.hoisted(() => ({
  pathExists: vi.fn<(path: string) => Promise<boolean>>(async (path) => !path.includes('missing')),
  parseBoolean: vi.fn<(value: string | undefined, fallback: boolean) => boolean>((value, fallback) => {
    if (value === undefined) {
      return fallback
    }
    return ['1', 'true', 'yes'].includes(value.toLowerCase())
  }),
  randomRunId: vi.fn<() => string>(() => 'random123'),
  timestampUtc: vi.fn<() => string>(() => '2025-10-11T00:00:00Z'),
  copyAgentLogIfNeeded: vi.fn<(outputPath: string, agentPath: string) => Promise<void>>(async () => undefined),
  buildDiscordChannelCommand: vi.fn<(scriptPath: string, args: string[]) => Promise<string[]>>(async () => [
    'bun',
    'run',
    'channel.ts',
  ]),
}))

vi.mock('../lib/codex-utils', () => utilMocks)

const bunUtils = vi.hoisted(() => ({
  which: vi.fn(async () => 'bun') as (command: string) => Promise<string>,
}))

vi.mock('bun', () => bunUtils)

const runnerMocks = vi.hoisted(() => ({
  runCodexSession: vi.fn<(options: RunCodexSessionOptions) => Promise<RunCodexSessionResult>>(async () => ({
    agentMessages: [],
    sessionId: 'session-xyz',
  })),
  pushCodexEventsToLoki: vi.fn<(options: PushCodexEventsToLokiOptions) => Promise<void>>(async () => {}),
}))

vi.mock('../lib/codex-runner', () => runnerMocks)

const runCodexSessionMock = runnerMocks.runCodexSession
const pushCodexEventsToLokiMock = runnerMocks.pushCodexEventsToLoki
const buildDiscordChannelCommandMock = utilMocks.buildDiscordChannelCommand

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
  let remoteDir: string
  let eventPath: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'codex-impl-test-'))
    remoteDir = await mkdtemp(join(tmpdir(), 'codex-impl-remote-'))
    eventPath = join(workdir, 'event.json')
    delete process.env.OUTPUT_PATH
    delete process.env.JSON_OUTPUT_PATH
    delete process.env.AGENT_OUTPUT_PATH
    delete process.env.IMPLEMENTATION_PATCH_PATH
    delete process.env.IMPLEMENTATION_STATUS_PATH
    delete process.env.IMPLEMENTATION_CHANGES_ARCHIVE_PATH
    delete process.env.CODEX_RUNTIME_LOG_PATH
    process.env.WORKTREE = workdir
    process.env.LGTM_LOKI_ENDPOINT = 'http://localhost/loki'
    process.env.CHANNEL_SCRIPT = ''
    process.env.CODEX_SKIP_PR_CHECK = '1'

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

    const runGit = async (args: string[], cwd = workdir) =>
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', args, { cwd })
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

    // Create bare remote and push both base and head branches so branch sync succeeds.
    await runGit(['init', '--bare', remoteDir], remoteDir)
    await runGit(['remote', 'add', 'origin', remoteDir])
    await runGit(['checkout', '-B', 'main'])
    await runGit(['push', '-u', 'origin', 'main'])
    await runGit(['checkout', '-B', 'codex/issue-42'])
    await runGit(['push', '-u', 'origin', 'codex/issue-42'])
    await runGit(['checkout', 'main'])

    runCodexSessionMock.mockReset()
    runCodexSessionMock.mockImplementation(async () => ({ agentMessages: [], sessionId: 'session-xyz' }))
    pushCodexEventsToLokiMock.mockReset()
    pushCodexEventsToLokiMock.mockImplementation(async () => {})
    buildDiscordChannelCommandMock.mockClear()
    utilMocks.pathExists.mockImplementation(async (path: string) => !path.includes('missing'))
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    if (remoteDir) {
      await rm(remoteDir, { recursive: true, force: true })
    }
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
    const resumeMetadataRaw = await readFile(resumeMetadataPath, 'utf8')
    const resumeMetadata = JSON.parse(resumeMetadataRaw) as Record<string, unknown>
    expect(resumeMetadata.state).toBe('cleared')
  })

  it('throws when the event file is missing', async () => {
    await expect(runCodexImplementation(join(workdir, 'missing.json'))).rejects.toThrow(/Event payload file not found/)
  })

  it('configures Discord channel streaming when credentials are provided', async () => {
    process.env.DISCORD_BOT_TOKEN = 'token'
    process.env.DISCORD_GUILD_ID = 'guild'
    process.env.CHANNEL_SCRIPT = 'apps/froussard/scripts/discord-channel.ts'
    utilMocks.pathExists.mockResolvedValue(true)

    await runCodexImplementation(eventPath)

    expect(buildDiscordChannelCommandMock).toHaveBeenCalledWith(
      'apps/froussard/scripts/discord-channel.ts',
      expect.any(Array),
    )
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.discordChannel?.command).toEqual(['bun', 'run', 'channel.ts'])
  })

  it('prefers the image discord-channel script when available', async () => {
    process.env.DISCORD_BOT_TOKEN = 'token'
    process.env.DISCORD_GUILD_ID = 'guild'
    process.env.CHANNEL_SCRIPT = ''
    utilMocks.pathExists.mockImplementation(async (path: string) => {
      if (path === '/usr/local/bin/discord-channel.ts') {
        return true
      }
      return !path.includes('missing')
    })

    await runCodexImplementation(eventPath)

    expect(buildDiscordChannelCommandMock).toHaveBeenCalledWith('/usr/local/bin/discord-channel.ts', expect.any(Array))
  })

  it('throws when repository is missing in the payload', async () => {
    await writeFile(eventPath, JSON.stringify({ prompt: 'hi', repository: '', issueNumber: 3 }), 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('Missing repository metadata in event payload')
  })

  it('throws when issue number is missing in the payload', async () => {
    await writeFile(eventPath, JSON.stringify({ prompt: 'hi', repository: 'owner/repo', issueNumber: '' }), 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('Missing issue number metadata in event payload')
  })

  it('falls back to base when the head branch does not exist on the remote', async () => {
    // Remove head from remote and local to simulate new branches that are not yet pushed.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', ['push', 'origin', '--delete', 'codex/issue-42'], { cwd: workdir })
      proc.on('close', (code) => (code === 0 ? resolve() : resolve())) // ignore failure if branch already missing
      proc.on('error', reject)
    })
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', ['branch', '-D', 'codex/issue-42'], { cwd: workdir })
      proc.on('close', () => resolve())
      proc.on('error', reject)
    })
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', ['remote', 'prune', 'origin'], { cwd: workdir })
      proc.on('close', () => resolve())
      proc.on('error', reject)
    })

    await expect(runCodexImplementation(eventPath)).resolves.not.toThrow()

    // Verify the worktree ended up on the head branch created from base.
    const currentBranch = await readFile(join(workdir, '.git', 'HEAD'), 'utf8')
    expect(currentBranch.trim()).toContain('codex/issue-42')
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
      const resumeMetadataRaw = await readFile(resumeMetadataPath, 'utf8')
      const resumeMetadata = JSON.parse(resumeMetadataRaw) as Record<string, unknown>
      expect(resumeMetadata.state).toBe('cleared')
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
    const outputLogPath = join(workdir, '.codex-implementation.log')
    const agentLogPath = join(workdir, '.codex-implementation-agent.log')
    const runtimeLogPath = join(workdir, '.codex-implementation-runtime.log')
    const notifyLogPath = join(workdir, '.codex-implementation-notify.json')
    await expect(stat(outputLogPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(agentLogPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(runtimeLogPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(stat(notifyLogPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
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

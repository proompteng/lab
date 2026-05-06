import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCodexImplementation } from '../codex-implement'
import type { PushCodexEventsToLokiOptions, RunCodexSessionOptions, RunCodexSessionResult } from '../lib/codex-runner'

const defaultAssistantMessage = [
  'Summary:',
  '- implementation completed via Codex run.',
  '',
  'Tests:',
  '- bun run lint:argocd',
].join('\n')

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

const progressCommentMocks = vi.hoisted(() => ({
  runCodexProgressComment: vi.fn<
    (options?: { args?: string[]; body?: string; stdin?: NodeJS.ReadableStream }) => Promise<{
      action: 'help' | 'updated' | 'created'
      commentId: string
    }>
  >(async () => ({
    action: 'updated',
    commentId: '123',
  })),
}))

vi.mock('../codex-progress-comment', () => progressCommentMocks)

const runnerMocks = vi.hoisted(() => ({
  runCodexSession: vi.fn<(options: RunCodexSessionOptions) => Promise<RunCodexSessionResult>>(async () => ({
    agentMessages: [defaultAssistantMessage],
    sessionId: 'session-xyz',
    exitCode: 0,
    forcedTermination: false,
  })),
  pushCodexEventsToLoki: vi.fn<(options: PushCodexEventsToLokiOptions) => Promise<void>>(async () => {}),
}))

vi.mock('../lib/codex-runner', () => runnerMocks)

const runCodexSessionMock = runnerMocks.runCodexSession
const pushCodexEventsToLokiMock = runnerMocks.pushCodexEventsToLoki
const buildDiscordChannelCommandMock = utilMocks.buildDiscordChannelCommand
const runCodexProgressCommentMock = progressCommentMocks.runCodexProgressComment

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

const installNatsPublishCapture = async (workdir: string, fileName = 'nats-publish-capture.jsonl') => {
  const binDir = join(workdir, 'bin')
  await mkdir(binDir, { recursive: true })
  const capturePath = join(workdir, fileName)
  process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH = capturePath
  process.env.NATS_URL = 'nats://example'
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

  const publishScriptPath = join(binDir, 'codex-nats-publish')
  await writeFile(
    publishScriptPath,
    [
      '#!/usr/bin/env node',
      'const { appendFileSync } = require("node:fs");',
      'const path = process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH;',
      'if (path) { appendFileSync(path, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8"); }',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8',
  )
  await chmod(publishScriptPath, 0o755)

  const soakScriptPath = join(binDir, 'codex-nats-soak')
  await writeFile(
    soakScriptPath,
    [
      '#!/usr/bin/env node',
      'const { writeFileSync } = require("node:fs");',
      'const path = process.env.NATS_CONTEXT_PATH;',
      'if (path) { writeFileSync(path, JSON.stringify({ fetched: 0, filtered: 0, messages: [] }) + "\\n", "utf8"); }',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8',
  )
  await chmod(soakScriptPath, 0o755)
  return capturePath
}

const readCapturedNatsPublishes = async (capturePath: string) =>
  (await readFile(capturePath, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])

const findCapturedNatsPublish = (captured: string[][], kind: string) =>
  captured.find((args) => {
    const kindIndex = args.indexOf('--kind')
    return kindIndex >= 0 && args[kindIndex + 1] === kind
  })

const attrsFromCapturedNatsPublish = (args: string[]) => {
  const attrsIndex = args.indexOf('--attrs-json')
  expect(attrsIndex).toBeGreaterThan(-1)
  const attrsRaw = args[attrsIndex + 1]
  expect(typeof attrsRaw).toBe('string')
  return JSON.parse(attrsRaw ?? '{}') as Record<string, unknown>
}

const contentFromCapturedNatsPublish = (args: string[]) => {
  const contentIndex = args.indexOf('--content')
  expect(contentIndex).toBeGreaterThan(-1)
  return args[contentIndex + 1] ?? ''
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
    delete process.env.IMPLEMENTATION_NOTIFY_PATH
    delete process.env.IMPLEMENTATION_CHANGES_MANIFEST_PATH
    delete process.env.CODEX_SYSTEM_PROMPT_PATH
    delete process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH
    delete process.env.CODEX_SYSTEM_PROMPT_REQUIRED
    delete process.env.PR_NUMBER_PATH
    delete process.env.PR_URL_PATH
    delete process.env.CODEX_PR_DISCOVERY_ENABLED
    delete process.env.CODEX_RUNTIME_LOG_PATH
    delete process.env.CODEX_SYSTEM_PROMPT_PATH
    delete process.env.PR_NUMBER_PATH
    delete process.env.PR_URL_PATH
    delete process.env.CODEX_MODEL
    delete process.env.CODEX_MODEL_FALLBACKS
    delete process.env.CODEX_REQUIRE_PULL_REQUEST
    delete process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH
    delete process.env.CODEX_VERIFY_MERGE_WITH_GH
    delete process.env.CODEX_VERIFY_RELEASE_ROLLOUT_WITH_CLUSTER
    delete process.env.CODEX_STRICT_ROLE_EVIDENCE
    delete process.env.CODEX_ALLOW_HEURISTIC_EVIDENCE
    delete process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH
    delete process.env.NATS_URL
    delete process.env.NATS_CHANNEL
    delete process.env.NATS_SUBJECT_PREFIX
    delete process.env.natsChannel
    delete process.env.NATS_CONTEXT_SUBJECT
    delete process.env.VCS_PULL_REQUESTS_ENABLED
    process.env.WORKTREE = workdir
    process.env.LGTM_LOKI_ENDPOINT = 'http://localhost/loki'
    process.env.CHANNEL_SCRIPT = ''
    process.env.CODEX_SKIP_PR_CHECK = '1'
    process.env.CODEX_NATS_SOAK_REQUIRED = 'false'

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
    await runGit(['config', 'commit.gpgsign', 'false'])
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
    runCodexSessionMock.mockImplementation(async () => ({
      agentMessages: [defaultAssistantMessage],
      sessionId: 'session-xyz',
      exitCode: 0,
      forcedTermination: false,
    }))
    runCodexProgressCommentMock.mockReset()
    pushCodexEventsToLokiMock.mockReset()
    pushCodexEventsToLokiMock.mockImplementation(async () => {})
    buildDiscordChannelCommandMock.mockClear()
    utilMocks.pathExists.mockImplementation(async (path: string) => !path.includes('missing'))
  }, 30_000)

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
  }, 40_000)

  it('posts progress comments at start and completion', async () => {
    await runCodexImplementation(eventPath)

    expect(runCodexProgressCommentMock).toHaveBeenCalledTimes(2)
    const startBody = runCodexProgressCommentMock.mock.calls[0]?.[0]?.body
    const completedBody = runCodexProgressCommentMock.mock.calls.at(-1)?.[0]?.body
    expect(startBody).toContain('<!-- codex:progress -->')
    expect(startBody).toContain('Phase: started')
    expect(startBody).toContain('- Issue: #42')
    expect(completedBody).toContain('Phase: completed')
    expect(completedBody).toContain('### Last assistant message')
    expect(completedBody).toContain('implementation completed via Codex run.')
  }, 40_000)

  it('includes cross-swarm provenance in progress comments', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm dispatch and implementation handoff',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gcj8mu',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmAgentWorkerId: 'worker-0027jshz',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027jshz',
      swarmRequirementDescription: 'End-to-end validation requirement from torghut swarm to jangar swarm.',
      swarmRequirementPayload:
        '{"acceptance":["run includes requirement provenance labels and parameters"],"priority":"high"}',
      swarmRequirementPayloadBytes: 142,
      swarmRequirementPayloadTruncated: false,
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const completedBody = runCodexProgressCommentMock.mock.calls.at(-1)?.[0]?.body
    expect(completedBody).toContain('### Cross-swarm requirement')
    expect(completedBody).toContain('- Requirement ID: 00gcj8mu')
    expect(completedBody).toContain('- Signal: torghut-to-jangar-e2e-1772426902')
    expect(completedBody).toContain('- Source: torghut-quant')
    expect(completedBody).toContain('- Target: jangar-control-plane')
    expect(completedBody).toContain('- Channel: workflow.general.requirement')
    expect(completedBody).toContain('### Requirement description')
    expect(completedBody).toContain('End-to-end validation requirement from torghut swarm to jangar swarm.')
    expect(completedBody).toContain('### Swarm executor')
    expect(completedBody).toContain('- Worker ID: worker-0027jshz')
    expect(completedBody).toContain('- Worker Identity: vw-jangar-control-plane-implement-worker-0027jshz')
  }, 40_000)

  it('does not publish progress comments when issue number is non-numeric', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 'swarm-jangar-control-plane',
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    expect(runCodexProgressCommentMock).not.toHaveBeenCalled()
  }, 40_000)

  it('exports scalar event parameters as shell environment variables', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      symbol: 'NVDA',
      domain: 'news',
      asOfUtc: '2026-03-03T04:19:58.221Z',
      reason: 'stale_snapshot',
      callbackUrl: 'http://jangar.jangar.svc.cluster.local/api/torghut/market-context/ingest',
      requestId: '6831f7d5-fef6-4eb5-b325-ad2d8eef56e9',
    }
    await writeFile(eventPath, JSON.stringify(payload), 'utf8')

    await runCodexImplementation(eventPath)

    expect(process.env.symbol).toBe('NVDA')
    expect(process.env.SYMBOL).toBe('NVDA')
    expect(process.env.CODEX_PARAM_SYMBOL).toBe('NVDA')
    expect(process.env.domain).toBe('news')
    expect(process.env.DOMAIN).toBe('news')
    expect(process.env.asOfUtc).toBe('2026-03-03T04:19:58.221Z')
    expect(process.env.AS_OF_UTC).toBe('2026-03-03T04:19:58.221Z')
    expect(process.env.reason).toBe('stale_snapshot')
    expect(process.env.REASON).toBe('stale_snapshot')
    expect(process.env.callbackUrl).toBe('http://jangar.jangar.svc.cluster.local/api/torghut/market-context/ingest')
    expect(process.env.CALLBACK_URL).toBe('http://jangar.jangar.svc.cluster.local/api/torghut/market-context/ingest')
    expect(process.env.requestId).toBe('6831f7d5-fef6-4eb5-b325-ad2d8eef56e9')
    expect(process.env.REQUEST_ID).toBe('6831f7d5-fef6-4eb5-b325-ad2d8eef56e9')
  }, 40_000)

  it('bootstraps the worktree checkout when the repository is missing', async () => {
    const bootstrappedWorktree = join(workdir, 'fresh-worktree')
    process.env.WORKTREE = bootstrappedWorktree
    process.env.VCS_REPOSITORY_URL = remoteDir
    utilMocks.pathExists.mockImplementation(async (path: string) => {
      try {
        await stat(path)
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false
        }
        throw error
      }
    })

    const result = await runCodexImplementation(eventPath)

    const gitDirStats = await stat(join(bootstrappedWorktree, '.git'))
    expect(gitDirStats.isDirectory()).toBe(true)
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.outputPath).toBe(join(bootstrappedWorktree, '.codex-implementation.log'))
    expect(result.patchPath).toBe(join(bootstrappedWorktree, '.codex-implementation.patch'))
  }, 40_000)

  it('does not inject runner git/PR workflow contracts into the prompt', async () => {
    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).not.toContain('IMPORTANT git + PR contract')
  }, 40_000)

  it('uses cross-swarm requirement scope when channel is NATS', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm dispatch and implementation handoff',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gcj8mu',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmAgentWorkerId: 'worker-0027jshz',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027jshz',
      swarmRequirementDescription: 'End-to-end validation requirement from torghut swarm to jangar swarm.',
      swarmRequirementPayload:
        '{"acceptance":["run includes requirement provenance labels and parameters"],"priority":"high"}',
      swarmRequirementPayloadBytes: '142',
      swarmRequirementPayloadTruncated: false,
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).toContain('Cross-swarm implementation requirement (primary scope):')
    expect(invocation?.prompt).toContain('Requirement ID: 00gcj8mu')
    expect(invocation?.prompt).toContain('Signal: torghut-to-jangar-e2e-1772426902')
    expect(invocation?.prompt).toContain('Source: torghut-quant')
    expect(invocation?.prompt).toContain('Target: jangar-control-plane')
    expect(invocation?.prompt).toContain(
      'Description:\nEnd-to-end validation requirement from torghut swarm to jangar swarm.',
    )
    expect(invocation?.prompt).toContain(
      'Payload:\n{\n  "acceptance": [\n    "run includes requirement provenance labels and parameters"\n  ],\n  "priority": "high"\n}',
    )
    expect(invocation?.prompt).toContain(
      'Executor: Worker ID: worker-0027jshz | Worker Identity: vw-jangar-control-plane-implement-worker-0027jshz',
    )
    expect(invocation?.prompt).toContain('Objective: validate cross-swarm dispatch and implementation handoff')
    expect(invocation?.prompt).toContain('Original request context:')
  }, 40_000)

  it('uses swarmRequirementObjective fallback when objective is omitted', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gcj8mx',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772430502',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmRequirementDescription: 'Acceptance-only scope for swarm requirement alias fallback.',
      swarmRequirementObjective: 'Objective from swarmRequirementObjective alias',
    }
    await writeFile(eventPath, JSON.stringify(payload), 'utf8')

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls.at(-1)?.[0]
    expect(invocation?.prompt).toContain('Cross-swarm implementation requirement (primary scope):')
    expect(invocation?.prompt).toContain('Objective: Objective from swarmRequirementObjective alias')
    expect(invocation?.prompt).toContain('Description:\nAcceptance-only scope for swarm requirement alias fallback.')

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as {
      swarmRequirementObjective?: string | null
    }
    expect(notify.swarmRequirementObjective).toBe('Objective from swarmRequirementObjective alias')
  }, 40_000)
  it('uses payload objective as cross-swarm primary objective', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'ignore this objective',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementDescription: 'End-to-end validation requirement from torghut swarm to jangar swarm.',
      swarmRequirementPayload:
        '{"objective":"Payload objective should dominate","acceptance":["run uses requirement payload objective"]}',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).toContain('Objective: Payload objective should dominate')
    expect(invocation?.prompt).not.toContain('ignore this objective')
    expect(invocation?.prompt).toContain(
      'Description:\nEnd-to-end validation requirement from torghut swarm to jangar swarm.',
    )
  }, 40_000)

  it('uses cross-swarm requirement scope when channel is an HTTPS NATS URL', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm dispatch with full URL channel',
      swarmRequirementChannel: 'nats://nats.nats.svc.cluster.local:4222/workflow/general/requirement',
      swarmRequirementId: '00gcj8mv',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmAgentWorkerId: 'worker-0027jshz',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027jshz',
      swarmRequirementDescription: 'Validate NATS URL-based requirement handoff in jangar control plane.',
      swarmRequirementPayload: '{"acceptance":["URL channels are treated as NATS requirements"],"priority":"high"}',
      swarmRequirementPayloadBytes: '150',
      swarmRequirementPayloadTruncated: false,
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).toContain('Cross-swarm implementation requirement (primary scope):')
    expect(invocation?.prompt).toContain(
      'Channel: nats://nats.nats.svc.cluster.local:4222/workflow/general/requirement',
    )
  }, 40_000)

  it('adds cross-swarm provenance fields to notify payload for NATS requirements', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm dispatch and implementation handoff',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gcj8mu',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmAgentWorkerId: 'worker-0027jshz',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027jshz',
      swarmRequirementDescription: 'End-to-end validation requirement from torghut swarm to jangar swarm.',
      swarmRequirementPayload:
        '{"acceptance":["run includes requirement provenance labels and parameters"],"priority":"high"}',
      swarmRequirementPayloadBytes: 142,
      swarmRequirementPayloadTruncated: false,
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as {
      cross_swarm_requirement?: boolean
      swarm_requirement?: Record<string, unknown>
      swarmRequirementId?: string | null
      swarmRequirementSignal?: string | null
      swarmRequirementSource?: string | null
      swarmRequirementTarget?: string | null
      swarmRequirementChannel?: string | null
      swarmRequirementObjective?: string | null
      swarmRequirementPayload?: string | null
      swarmAgentWorkerId?: string | null
      swarmAgentIdentity?: string | null
      swarmAgentRole?: string | null
    }
    expect(notify.cross_swarm_requirement).toBe(true)
    expect(notify.swarm_requirement).toMatchObject({
      id: '00gcj8mu',
      signal: 'torghut-to-jangar-e2e-1772426902',
      source: 'torghut-quant',
      target: 'jangar-control-plane',
      channel: 'workflow.general.requirement',
      objective: 'validate cross-swarm dispatch and implementation handoff',
      description: 'End-to-end validation requirement from torghut swarm to jangar swarm.',
      payload: '{"acceptance":["run includes requirement provenance labels and parameters"],"priority":"high"}',
      payloadBytes: '142',
      payloadTruncated: false,
    })
    expect(notify.swarmRequirementId).toBe('00gcj8mu')
    expect(notify.swarmRequirementSignal).toBe('torghut-to-jangar-e2e-1772426902')
    expect(notify.swarmRequirementSource).toBe('torghut-quant')
    expect(notify.swarmRequirementTarget).toBe('jangar-control-plane')
    expect(notify.swarmRequirementChannel).toBe('workflow.general.requirement')
    expect(notify.swarmRequirementObjective).toBe('validate cross-swarm dispatch and implementation handoff')
    expect(notify.swarmRequirementPayload).toContain('"acceptance"')
    expect(notify.swarmAgentWorkerId).toBe('worker-0027jshz')
    expect(notify.swarmAgentIdentity).toBe('vw-jangar-control-plane-implement-worker-0027jshz')
    expect(notify.swarmAgentRole).toBeNull()
  }, 40_000)

  it('uses environment fallback channel resolution for NATS handoff', async () => {
    delete process.env.natsChannel
    delete process.env.NATS_CHANNEL
    process.env.natsChannel = 'workflow.general.requirement'

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'Validate NATS env fallback channel',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as { swarmCommsArtifacts?: { channel?: string } }
    expect(notify.swarmCommsArtifacts?.channel).toBe('workflow.general.requirement')
  }, 40_000)

  it('accepts plain NATS channel names from NATS_CHANNEL fallback', async () => {
    process.env.NATS_CHANNEL = 'general'

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'Validate plain NATS_CHANNEL fallback',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as { swarmCommsArtifacts?: { channel?: string } }
    expect(notify.swarmCommsArtifacts?.channel).toBe('general')
  }, 40_000)

  it('uses scheduled swarm natsChannel from event parameters for NATS handoff', async () => {
    delete process.env.natsChannel
    delete process.env.NATS_CHANNEL

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'Validate scheduled swarm NATS parameter fallback',
      parameters: {
        natsChannel: 'general',
        swarmAgentWorkerId: 'worker-jangar-implement',
        swarmAgentIdentity: 'elise-novak-jangar-engineer',
        swarmAgentRole: 'engineer',
      },
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as {
      swarmCommsArtifacts?: { channel?: string }
      swarmAgentWorkerId?: string | null
      swarmAgentIdentity?: string | null
      swarmAgentRole?: string | null
    }
    expect(notify.swarmCommsArtifacts?.channel).toBe('general')
    expect(notify.swarmAgentWorkerId).toBe('worker-jangar-implement')
    expect(notify.swarmAgentIdentity).toBe('elise-novak-jangar-engineer')
    expect(notify.swarmAgentRole).toBe('engineer')
  }, 40_000)

  it('exports scheduled swarm NATS connection details from event parameters', async () => {
    delete process.env.NATS_URL
    delete process.env.NATS_CHANNEL
    delete process.env.NATS_SUBJECT_PREFIX
    delete process.env.NATS_CONTEXT_SUBJECT
    const capturePath = await installNatsPublishCapture(workdir, 'nats-publish-custom-prefix.jsonl')

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'Validate scheduled swarm NATS connection export',
      parameters: {
        natsUrl: 'nats://custom-nats.nats.svc.cluster.local:4222',
        natsSubjectPrefix: 'agents.workflow',
        natsChannel: 'ops',
      },
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    expect(process.env.NATS_URL).toBe('nats://custom-nats.nats.svc.cluster.local:4222')
    expect(process.env.NATS_SUBJECT_PREFIX).toBe('agents.workflow')
    expect(process.env.NATS_CONTEXT_SUBJECT).toBe('agents.workflow.general.>')
    expect(process.env.NATS_CHANNEL).toBe('ops')
    const captured = await readCapturedNatsPublishes(capturePath)
    expect(findCapturedNatsPublish(captured, 'run-started')).toBeTruthy()
  }, 40_000)

  it('prefers explicit requirement channels over NATS_CHANNEL fallbacks', async () => {
    process.env.NATS_CHANNEL = 'general'

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'Validate explicit NATS requirement channel precedence',
      swarmRequirementChannel: 'workflow.general.requirement',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as { swarmCommsArtifacts?: { channel?: string } }
    expect(notify.swarmCommsArtifacts?.channel).toBe('workflow.general.requirement')
  }, 40_000)

  it('publishes NATS owner update and release-note artifacts for completed cross-swarm runs', async () => {
    const capturePath = await installNatsPublishCapture(workdir, 'nats-publish-handoff.jsonl')
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm handoff artifacts',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gc1i45',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772433239',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmRequirementDescription: 'Post-merge validation from torghut to jangar.',
      swarmAgentWorkerId: 'worker-0027ilba',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027ilba',
      swarmAgentRole: 'implement',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const captured = await readCapturedNatsPublishes(capturePath)
    const handoff = findCapturedNatsPublish(captured, 'swarm-handoff')
    expect(handoff).toBeDefined()
    if (!handoff) throw new Error('Expected a swarm-handoff publish call')
    expect(contentFromCapturedNatsPublish(handoff)).toContain('I finished implementation for owner/repo#42.')
    const handoffAttrs = attrsFromCapturedNatsPublish(handoff)
    expect(handoffAttrs).toMatchObject({
      stage: 'implementation',
      decision: 'pass',
      swarmRequirementId: '00gc1i45',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmAgentWorkerId: 'worker-0027ilba',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027ilba',
      swarmAgentRole: 'implement',
    })
    expect(handoffAttrs.releaseNote).toContain('Rollback path:')
    expect(handoffAttrs.releaseNote).toContain('Owner-facing status: merge-ready')

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as {
      swarmCommsArtifacts?: {
        ownerUpdateMessage?: string
        releaseNote?: string
      }
    }
    expect(notify.swarmCommsArtifacts?.ownerUpdateMessage).toContain('I finished implementation for owner/repo#42.')
    expect(notify.swarmCommsArtifacts?.releaseNote).toContain('Rollback path:')
    expect(notify.swarmCommsArtifacts?.releaseNote).toContain('Owner-facing status: merge-ready')
  }, 40_000)

  it('captures acceptance criteria from cross-swarm payload and includes release-note fields in owner update', async () => {
    const capturePath = await installNatsPublishCapture(workdir, 'nats-publish-acceptance.jsonl')
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm handoff with acceptance',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gc1i45',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772433239',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmRequirementDescription: 'Post-merge validation requires artifacts and rollback visibility.',
      swarmRequirementPayload:
        '{"acceptance":["create issue/chat/doc artifacts","complete handoff"],"objective":"Post-merge requirement validation"}',
      swarmAgentWorkerId: 'worker-0027ilba',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027ilba',
      swarmAgentRole: 'implement',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).toContain('Acceptance criteria:')
    expect(invocation?.prompt).toContain('- create issue/chat/doc artifacts')

    const captured = await readCapturedNatsPublishes(capturePath)
    const handoff = findCapturedNatsPublish(captured, 'swarm-handoff')
    expect(handoff).toBeDefined()
    if (!handoff) throw new Error('Expected a swarm-handoff publish call')
    const content = contentFromCapturedNatsPublish(handoff)
    expect(content).toContain('I finished implementation for owner/repo#42.')
    expect(content).toContain('finished')
    expect(content).toContain('Validation results:')
    expect(content).toContain('Acceptance criteria: create issue/chat/doc artifacts; complete handoff.')
    const attrs = attrsFromCapturedNatsPublish(handoff)
    expect(attrs.releaseNote).toContain('Design document:')
    expect(attrs.releaseNote).toContain('Rollback path:')
    expect(attrs.releaseNote).toContain('Owner-facing status: merge-ready pending deployer rollout verification.')
  }, 40_000)

  it('posts failure NATS mission handoff artifacts when implementation fails', async () => {
    const capturePath = await installNatsPublishCapture(workdir, 'nats-publish-failed-handoff.jsonl')
    runCodexSessionMock.mockRejectedValueOnce(new Error('session failed'))

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm failure handoff',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gc1i45',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772433239',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmRequirementDescription: 'Post-merge validation with run failure.',
      swarmAgentWorkerId: 'worker-0027ilba',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027ilba',
      swarmAgentRole: 'implement',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('session failed')

    const captured = await readCapturedNatsPublishes(capturePath)
    const handoff = findCapturedNatsPublish(captured, 'swarm-handoff')
    expect(handoff).toBeDefined()
    if (!handoff) throw new Error('Expected a failed swarm-handoff publish call')
    expect(contentFromCapturedNatsPublish(handoff)).toContain('I am blocked on implementation for owner/repo#42.')
    expect(attrsFromCapturedNatsPublish(handoff)).toMatchObject({
      stage: 'implementation',
      decision: 'fail',
      swarmRequirementId: '00gc1i45',
      swarmRequirementChannel: 'workflow.general.requirement',
    })

    const runGaps = findCapturedNatsPublish(captured, 'run-gaps')
    expect(runGaps).toBeDefined()
    if (!runGaps) throw new Error('Expected a failed run-gaps publish call')
    const runGapContent = contentFromCapturedNatsPublish(runGaps)
    expect(runGapContent).toContain('Failure reason: session failed')
    expect(runGapContent).toContain('Artifacts:')
    expect(runGapContent).not.toContain('Run failed before emitting gaps')
    expect(attrsFromCapturedNatsPublish(runGaps)).toMatchObject({
      stage: 'implementation',
      failureReason: 'session failed',
      missingItems: expect.arrayContaining(['Failure reason: session failed']),
    })
  }, 40_000)

  it('accepts worker identity metadata from parameters map', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      swarmRequirementChannel: 'workflow.general.requirement',
      parameters: {
        swarmRequirementId: '00gcj8mu',
        swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
        swarmRequirementSource: 'torghut-quant',
        swarmRequirementTarget: 'jangar-control-plane',
        swarmRequirementDescription:
          'Parameter-fed requirement payload should still be surfaced to run prompt and notifications.',
        swarmAgentWorkerId: 'worker-params-0027jshz',
        swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-params-0027jshz',
      },
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const completedBody = runCodexProgressCommentMock.mock.calls.at(-1)?.[0]?.body
    expect(completedBody).toContain('### Swarm executor')
    expect(completedBody).toContain('- Worker ID: worker-params-0027jshz')
    expect(completedBody).toContain('- Worker Identity: vw-jangar-control-plane-implement-worker-params-0027jshz')

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).toContain(
      'Executor: Worker ID: worker-params-0027jshz | Worker Identity: vw-jangar-control-plane-implement-worker-params-0027jshz',
    )

    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as {
      swarmRequirementId?: string | null
      swarmAgentWorkerId?: string | null
      swarmAgentIdentity?: string | null
    }
    expect(notify.swarmRequirementId).toBe('00gcj8mu')
    expect(notify.swarmAgentWorkerId).toBe('worker-params-0027jshz')
    expect(notify.swarmAgentIdentity).toBe('vw-jangar-control-plane-implement-worker-params-0027jshz')
  }, 40_000)

  it('does not apply cross-swarm prompt wrapping for non-NATS channels', async () => {
    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      swarmRequirementChannel: 'slack://channel-id',
      swarmRequirementDescription: 'No NATS wrapping should occur.',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.prompt).toBe('Implementation prompt')
  }, 40_000)

  it('forwards systemPrompt from the payload into runCodexSession', async () => {
    const systemPrompt = 'You are a strict system prompt.'
    const payload = {
      prompt: 'Implementation prompt',
      systemPrompt,
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      planCommentId: 123,
      planCommentUrl: 'http://example.com',
      planCommentBody: '<!-- codex:plan -->',
    }
    await writeFile(eventPath, JSON.stringify(payload), 'utf8')

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.systemPrompt).toBe(systemPrompt)
  }, 40_000)

  it('prefers CODEX_SYSTEM_PROMPT_PATH over the payload and does not log system prompt contents', async () => {
    const systemPromptPath = join(workdir, 'system-prompt.txt')
    const systemPromptFromFile = 'FROM FILE ONLY'
    await writeFile(systemPromptPath, systemPromptFromFile, 'utf8')
    process.env.CODEX_SYSTEM_PROMPT_PATH = systemPromptPath

    const payload = {
      prompt: 'Implementation prompt',
      systemPrompt: 'FROM PAYLOAD SHOULD NOT BE USED',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      planCommentId: 123,
      planCommentUrl: 'http://example.com',
      planCommentBody: '<!-- codex:plan -->',
    }
    await writeFile(eventPath, JSON.stringify(payload), 'utf8')

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.systemPrompt).toBe(systemPromptFromFile)

    const runtimeLogPath = join(workdir, '.codex-implementation-runtime.log')
    const runtimeLog = await readFile(runtimeLogPath, 'utf8')
    expect(runtimeLog).not.toContain(systemPromptFromFile)
  }, 40_000)

  it('fails when system prompt is required but unavailable', async () => {
    process.env.CODEX_SYSTEM_PROMPT_REQUIRED = 'true'
    const missingSystemPromptPath = join(workdir, 'missing-system-prompt.txt')
    process.env.CODEX_SYSTEM_PROMPT_PATH = missingSystemPromptPath
    utilMocks.pathExists.mockImplementation(async (path: string) => path !== missingSystemPromptPath)

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('System prompt is required but was not loaded')
  }, 40_000)

  it('fails when loaded system prompt hash does not match expected hash', async () => {
    const systemPromptPath = join(workdir, 'system-prompt.txt')
    await writeFile(systemPromptPath, 'FROM FILE', 'utf8')
    process.env.CODEX_SYSTEM_PROMPT_PATH = systemPromptPath
    process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH = createHash('sha256').update('DIFFERENT', 'utf8').digest('hex')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('System prompt hash mismatch')
  }, 40_000)

  it('accepts loaded system prompt when expected hash matches', async () => {
    const systemPromptFromFile = 'FROM FILE'
    const systemPromptPath = join(workdir, 'system-prompt.txt')
    await writeFile(systemPromptPath, systemPromptFromFile, 'utf8')
    process.env.CODEX_SYSTEM_PROMPT_PATH = systemPromptPath
    process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH = createHash('sha256')
      .update(systemPromptFromFile, 'utf8')
      .digest('hex')
      .toUpperCase()

    await runCodexImplementation(eventPath)

    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.systemPrompt).toBe(systemPromptFromFile)
  }, 40_000)

  it('includes systemPromptHash in NATS run-started attrs when available', async () => {
    const binDir = join(workdir, 'bin')
    await mkdir(binDir, { recursive: true })

    const capturePath = join(workdir, 'nats-publish-capture.jsonl')
    process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH = capturePath
    process.env.NATS_URL = 'nats://example'
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const publishScriptPath = join(binDir, 'codex-nats-publish')
    await writeFile(
      publishScriptPath,
      [
        '#!/usr/bin/env node',
        'const { appendFileSync } = require("node:fs");',
        'const path = process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH;',
        'if (path) { appendFileSync(path, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8"); }',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf8',
    )
    await chmod(publishScriptPath, 0o755)

    // Avoid `${...}` sequences directly in JS string literals (lint false-positive),
    // while still generating a bash script that uses parameter expansion.
    const natsContextPathExpansion = '$' + '{NATS_CONTEXT_PATH:-}'
    const natsContextPathVariable = '$' + '{NATS_CONTEXT_PATH}'

    const soakScriptPath = join(binDir, 'codex-nats-soak')
    await writeFile(
      soakScriptPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `if [ -n "${natsContextPathExpansion}" ]; then`,
        `  printf '{"fetched":0,"filtered":0,"messages":[]}\\n' > "${natsContextPathVariable}"`,
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      'utf8',
    )
    await chmod(soakScriptPath, 0o755)

    const systemPrompt = 'hash me'
    const payload = {
      prompt: 'Implementation prompt',
      systemPrompt,
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      planCommentId: 123,
      planCommentUrl: 'http://example.com',
      planCommentBody: '<!-- codex:plan -->',
    }
    await writeFile(eventPath, JSON.stringify(payload), 'utf8')

    await runCodexImplementation(eventPath)

    const captured = (await readFile(capturePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])

    const runStarted = captured.find((args) => {
      const kindIndex = args.indexOf('--kind')
      return kindIndex >= 0 && args[kindIndex + 1] === 'run-started'
    })
    expect(runStarted).toBeDefined()
    if (!runStarted) {
      throw new Error('Expected at least one run-started publish call')
    }

    const attrsIndex = runStarted.indexOf('--attrs-json')
    expect(attrsIndex).toBeGreaterThan(-1)
    const attrsRaw = runStarted[attrsIndex + 1]
    expect(typeof attrsRaw).toBe('string')
    const attrs = JSON.parse(attrsRaw ?? '{}') as Record<string, unknown>

    const expectedHash = createHash('sha256').update(systemPrompt, 'utf8').digest('hex')
    expect(attrs.systemPromptHash).toBe(expectedHash)
    expect(attrs.systemPrompt).toBeUndefined()
  }, 40_000)

  it('includes swarm agent identity in NATS run-started attrs', async () => {
    const binDir = join(workdir, 'bin')
    await mkdir(binDir, { recursive: true })

    const capturePath = join(workdir, 'nats-publish-run-started-identity.jsonl')
    process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH = capturePath
    process.env.NATS_URL = 'nats://example'
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const publishScriptPath = join(binDir, 'codex-nats-publish')
    await writeFile(
      publishScriptPath,
      [
        '#!/usr/bin/env node',
        'const { appendFileSync } = require("node:fs");',
        'const path = process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH;',
        'if (path) { appendFileSync(path, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8"); }',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf8',
    )
    await chmod(publishScriptPath, 0o755)

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gcj8mu',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmAgentWorkerId: 'worker-0027jshz',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027jshz',
      swarmAgentRole: 'engineer',
      swarmHumanName: 'Elise Novak',
      swarmRequirementPayload:
        '{"acceptance":["run includes requirement provenance labels and parameters"],"priority":"high"}',
      swarmRequirementPayloadBytes: 142,
      swarmRequirementPayloadTruncated: false,
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const captured = (await readFile(capturePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])

    const runStarted = captured.find((args) => {
      const kindIndex = args.indexOf('--kind')
      return kindIndex >= 0 && args[kindIndex + 1] === 'run-started'
    })
    expect(runStarted).toBeDefined()
    if (!runStarted) {
      throw new Error('Expected at least one run-started publish call')
    }

    const attrsIndex = runStarted.indexOf('--attrs-json')
    expect(attrsIndex).toBeGreaterThan(-1)
    const attrsRaw = runStarted[attrsIndex + 1]
    expect(typeof attrsRaw).toBe('string')
    const attrs = JSON.parse(attrsRaw ?? '{}') as Record<string, unknown>

    expect(attrs.swarmAgentWorkerId).toBe('worker-0027jshz')
    expect(attrs.swarmAgentIdentity).toBe('vw-jangar-control-plane-implement-worker-0027jshz')
    expect(attrs.swarmAgentRole).toBe('engineer')
    expect(attrs.swarmHumanName).toBe('Elise Novak')
  }, 40_000)

  it('includes cross-swarm requirement metadata in NATS run-started attrs', async () => {
    const binDir = join(workdir, 'bin')
    await mkdir(binDir, { recursive: true })

    const capturePath = join(workdir, 'nats-publish-run-started-requirement.jsonl')
    process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH = capturePath
    process.env.NATS_URL = 'nats://example'
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const publishScriptPath = join(binDir, 'codex-nats-publish')
    await writeFile(
      publishScriptPath,
      [
        '#!/usr/bin/env node',
        'const { appendFileSync } = require("node:fs");',
        'const path = process.env.CODEX_NATS_PUBLISH_CAPTURE_PATH;',
        'if (path) { appendFileSync(path, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8"); }',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf8',
    )
    await chmod(publishScriptPath, 0o755)

    const payload = {
      prompt: 'Implementation prompt',
      repository: 'owner/repo',
      issueNumber: 42,
      base: 'main',
      head: 'codex/issue-42',
      issueTitle: 'Title',
      objective: 'validate cross-swarm handoff visibility',
      swarmRequirementChannel: 'workflow.general.requirement',
      swarmRequirementId: '00gcj8mu',
      swarmRequirementSignal: 'torghut-to-jangar-e2e-1772426902',
      swarmRequirementSource: 'torghut-quant',
      swarmRequirementTarget: 'jangar-control-plane',
      swarmRequirementDescription: 'End-to-end requirement handoff validation.',
      swarmRequirementPayload:
        '{"acceptance":["publish swarm requirement metadata on all run events"],"priority":"high"}',
      swarmRequirementPayloadBytes: '142',
      swarmRequirementPayloadTruncated: false,
      swarmRequirementObjective: 'validate cross-swarm handoff visibility',
      swarmAgentWorkerId: 'worker-0027jshz',
      swarmAgentIdentity: 'vw-jangar-control-plane-implement-worker-0027jshz',
      swarmAgentRole: 'implement',
    }
    await writeFile(eventPath, JSON.stringify(payload))

    await runCodexImplementation(eventPath)

    const captured = (await readFile(capturePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])

    const runStarted = captured.find((args) => {
      const kindIndex = args.indexOf('--kind')
      return kindIndex >= 0 && args[kindIndex + 1] === 'run-started'
    })
    expect(runStarted).toBeDefined()
    if (!runStarted) {
      throw new Error('Expected at least one run-started publish call')
    }

    const attrsIndex = runStarted.indexOf('--attrs-json')
    expect(attrsIndex).toBeGreaterThan(-1)
    const attrsRaw = runStarted[attrsIndex + 1]
    expect(typeof attrsRaw).toBe('string')
    const attrs = JSON.parse(attrsRaw ?? '{}') as Record<string, unknown>

    expect(attrs.swarmAgentWorkerId).toBe('worker-0027jshz')
    expect(attrs.swarmAgentIdentity).toBe('vw-jangar-control-plane-implement-worker-0027jshz')
    expect(attrs.swarmAgentRole).toBe('implement')
    expect(attrs.swarmRequirementId).toBe('00gcj8mu')
    expect(attrs.swarmRequirementSignal).toBe('torghut-to-jangar-e2e-1772426902')
    expect(attrs.swarmRequirementSource).toBe('torghut-quant')
    expect(attrs.swarmRequirementTarget).toBe('jangar-control-plane')
    expect(attrs.swarmRequirementChannel).toBe('workflow.general.requirement')
    expect(attrs.swarmRequirementDescription).toBe('End-to-end requirement handoff validation.')
    expect(attrs.swarmRequirementObjective).toBe('validate cross-swarm handoff visibility')
    expect(attrs.swarmRequirementPayload).toContain('"acceptance"')
    expect(attrs.swarmRequirementPayloadBytes).toBe('142')
    expect(attrs.swarmRequirementPayloadTruncated).toBe(false)
  }, 40_000)

  it('includes PR metadata from artifact files and does not overwrite them', async () => {
    process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH = 'false'
    const prNumberPath = join(workdir, '.codex-pr-number.txt')
    const prUrlPath = join(workdir, '.codex-pr-url.txt')
    await writeFile(prNumberPath, '456\n', 'utf8')
    await writeFile(prUrlPath, 'https://example.test/pull/456\n', 'utf8')
    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Implementation prompt',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        parameters: {
          checksGreen: true,
        },
      }),
      'utf8',
    )

    await runCodexImplementation(eventPath)

    await expect(readFile(prNumberPath, 'utf8')).resolves.toBe('456\n')
    await expect(readFile(prUrlPath, 'utf8')).resolves.toBe('https://example.test/pull/456\n')

    const notifyLogPath = join(workdir, '.codex-implementation-notify.json')
    const notifyRaw = await readFile(notifyLogPath, 'utf8')
    const notify = JSON.parse(notifyRaw) as Record<string, unknown>
    expect(notify.prNumber).toBe(456)
    expect(notify.prUrl).toBe('https://example.test/pull/456')
    expect(notify.pr_number).toBe(456)
    expect(notify.pr_url).toBe('https://example.test/pull/456')
  }, 40_000)

  it('fails implementation runs when pull requests are required and PR_URL is missing', async () => {
    process.env.VCS_PULL_REQUESTS_ENABLED = 'true'
    delete process.env.CODEX_REQUIRE_PULL_REQUEST
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'false'

    await expect(runCodexImplementation(eventPath)).rejects.toThrow(
      'Implementation run completed without creating a pull request (missing PR_URL output)',
    )
  }, 40_000)

  it('recovers missing PR artifact files by discovering PR metadata from GitHub', async () => {
    process.env.VCS_PULL_REQUESTS_ENABLED = 'true'
    delete process.env.CODEX_REQUIRE_PULL_REQUEST
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'true'
    process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH = 'false'
    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Implementation prompt',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        parameters: {
          checksGreen: true,
        },
      }),
      'utf8',
    )

    const binDir = join(workdir, '.bin')
    await mkdir(binDir, { recursive: true })
    const ghPath = join(binDir, 'gh')
    await writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  echo '[{"number":4005,"url":"https://github.com/owner/repo/pull/4005"}]'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(ghPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()

    await expect(readFile(join(workdir, '.codex-pr-number.txt'), 'utf8')).resolves.toContain('4005')
    await expect(readFile(join(workdir, '.codex-pr-url.txt'), 'utf8')).resolves.toContain(
      'https://github.com/owner/repo/pull/4005',
    )

    const notifyLogPath = join(workdir, '.codex-implementation-notify.json')
    const notifyRaw = await readFile(notifyLogPath, 'utf8')
    const notify = JSON.parse(notifyRaw) as Record<string, unknown>
    expect(notify.prNumber).toBe(4005)
    expect(notify.prUrl).toBe('https://github.com/owner/repo/pull/4005')
  }, 40_000)

  it('uses the PR number from URL tail when verifying engineer checks', async () => {
    process.env.CODEX_VERIFY_MERGE_WITH_GH = 'false'
    process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH = 'true'
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'false'
    const prUrlPath = join(workdir, '.codex-pr-url.txt')
    await writeFile(prUrlPath, 'https://github.com/owner/repo2/pull/123\n', 'utf8')

    const binDir = join(workdir, '.bin-gh-pr-checks-url-tail')
    await mkdir(binDir, { recursive: true })
    const ghPath = join(binDir, 'gh')
    await writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  if [[ "$3" == "123" ]]; then
    echo '[{"name":"ci","state":"SUCCESS"}]'
    exit 0
  fi
  if [[ "$3" == "2" ]]; then
    echo '[{"name":"ci","state":"FAILURE"}]'
    exit 0
  fi
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(ghPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('allows implementation runs without PR_URL when CODEX_REQUIRE_PULL_REQUEST is false', async () => {
    process.env.VCS_PULL_REQUESTS_ENABLED = 'true'
    process.env.CODEX_REQUIRE_PULL_REQUEST = 'false'

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('does not require PR_URL for release-manager/deployer runs', async () => {
    process.env.VCS_PULL_REQUESTS_ENABLED = 'true'
    process.env.CODEX_REQUIRE_PULL_REQUEST = 'true'
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'false'

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Implementation prompt',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        issueTitle: 'Release Manager Mission',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
        parameters: {
          merged: true,
          rolloutHealthy: true,
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('passes release lane when ArgoCD app health verification is healthy', async () => {
    const binDir = join(workdir, '.bin-kubectl-ok')
    await mkdir(binDir, { recursive: true })
    const kubectlPath = join(binDir, 'kubectl')
    await writeFile(
      kubectlPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "get" && "$2" == "applications.argoproj.io" ]]; then
  echo '{"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}'
  exit 0
fi
echo "unexpected kubectl invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(kubectlPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Release verification run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
        parameters: {
          merged: true,
          argocdAppName: 'jangar-control-plane',
          argocdAppNamespace: 'argocd',
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('passes release lane with verified merged PR from final summary and swarm Argo fallback', async () => {
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'false'
    const binDir = join(workdir, '.bin-release-summary-evidence')
    await mkdir(binDir, { recursive: true })
    const ghPath = join(binDir, 'gh')
    await writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "view" && "$3" == "7007" ]]; then
  echo '{"state":"MERGED","mergedAt":"2026-05-05T18:00:00Z","mergeCommit":{"oid":"abcdef1234567890"}}'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(ghPath, 0o755)
    const kubectlPath = join(binDir, 'kubectl')
    await writeFile(
      kubectlPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "get" && "$2" == "applications.argoproj.io" && ( "$3" == "agents" || "$3" == "jangar" ) ]]; then
  echo '{"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}'
  exit 0
fi
echo "unexpected kubectl invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(kubectlPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    runCodexSessionMock.mockImplementationOnce(async () => ({
      agentMessages: [
        [
          'Summary:',
          '- Squash-merged #7007 at commit `abcdef1234567890`.',
          '- #5454 remains no-go; do not merge until the required review posts.',
          '- Argo is Synced/Healthy for agents and jangar.',
        ].join('\n'),
      ],
      sessionId: 'session-xyz',
      exitCode: 0,
      forcedTermination: false,
    }))

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Release verification run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
        parameters: {
          swarmName: 'jangar-control-plane',
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('passes read-only verify lane with healthy rollout evidence and no merge evidence', async () => {
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'false'
    process.env.VCS_PULL_REQUESTS_ENABLED = 'false'
    process.env.VCS_WRITE_ENABLED = 'false'

    const binDir = join(workdir, '.bin-readonly-verify')
    await mkdir(binDir, { recursive: true })
    const kubectlPath = join(binDir, 'kubectl')
    await writeFile(
      kubectlPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "get" && "$2" == "applications.argoproj.io" && ( "$3" == "agents" || "$3" == "jangar" ) ]]; then
  echo '{"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}'
  exit 0
fi
echo "unexpected kubectl invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(kubectlPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    runCodexSessionMock.mockImplementationOnce(async () => ({
      agentMessages: [
        [
          'Summary:',
          '- GO: rollout verification passed.',
          '- Argo is Synced/Healthy for agents and jangar.',
          '- No PR was opened or merged because this is a read-only verification lane.',
        ].join('\n'),
      ],
      sessionId: 'session-readonly-verify',
      exitCode: 0,
      forcedTermination: false,
    }))

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Read-only rollout verification run',
        repository: 'owner/repo',
        issueNumber: 'swarm-jangar-control-plane-verify',
        base: 'main',
        head: 'main',
        stage: 'verify',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-verifier',
        swarmName: 'jangar-control-plane',
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('passes release lane with a documented no-go gate decision and no merge', async () => {
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'false'
    process.env.CODEX_VERIFY_RELEASE_ROLLOUT_WITH_CLUSTER = 'false'

    runCodexSessionMock.mockImplementationOnce(async () => ({
      agentMessages: [
        [
          'Summary:',
          '- Decision: NO-GO for merge.',
          '- Blocker: required Codex large-diff review gate did not post because connector usage-limit errors.',
          '- Evidence: PR #5412 is CLEAN/MERGEABLE and visible checks are passing.',
          '- No squash merge and no production rollout were performed.',
          '- Audit artifact: /workspace/.agentrun/swarm/torghut-quant-verify.md.',
          '- Rollback path: no rollback is required because no merge happened.',
        ].join('\n'),
      ],
      sessionId: 'session-no-go',
      exitCode: 0,
      forcedTermination: false,
    }))

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Release verification run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('fails release lane when ArgoCD app health verification is unhealthy', async () => {
    const binDir = join(workdir, '.bin-kubectl-bad')
    await mkdir(binDir, { recursive: true })
    const kubectlPath = join(binDir, 'kubectl')
    await writeFile(
      kubectlPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "get" && "$2" == "applications.argoproj.io" ]]; then
  echo '{"status":{"sync":{"status":"OutOfSync"},"health":{"status":"Degraded"}}}'
  exit 0
fi
echo "unexpected kubectl invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(kubectlPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Release verification run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
        parameters: {
          merged: true,
          rolloutHealthy: true,
          argocdAppName: 'jangar-control-plane',
          argocdAppNamespace: 'argocd',
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).rejects.toThrow(
      'Release run completed without healthy rollout evidence',
    )
  }, 40_000)

  it('fails release lane when GH merge verification shows PR is not merged', async () => {
    process.env.CODEX_VERIFY_RELEASE_ROLLOUT_WITH_CLUSTER = 'false'
    const prNumberPath = join(workdir, '.codex-pr-number.txt')
    const prUrlPath = join(workdir, '.codex-pr-url.txt')
    await writeFile(prNumberPath, '5010\n', 'utf8')
    await writeFile(prUrlPath, 'https://github.com/owner/repo/pull/5010\n', 'utf8')

    const binDir = join(workdir, '.bin-gh-merge')
    await mkdir(binDir, { recursive: true })
    const ghPath = join(binDir, 'gh')
    await writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  echo '{"state":"OPEN","mergedAt":null,"mergeCommit":null}'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(ghPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Release verification run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
        parameters: {
          merged: true,
          rolloutHealthy: true,
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).rejects.toThrow(
      'Release run completed without merge evidence (merged PR/commit required)',
    )
  }, 40_000)

  it('refreshes release PR metadata from GitHub before merge verification', async () => {
    process.env.CODEX_VERIFY_RELEASE_ROLLOUT_WITH_CLUSTER = 'false'
    process.env.CODEX_PR_DISCOVERY_ENABLED = 'true'
    const prNumberPath = join(workdir, '.codex-pr-number.txt')
    const prUrlPath = join(workdir, '.codex-pr-url.txt')
    await writeFile(prNumberPath, '5010\n', 'utf8')
    await writeFile(prUrlPath, 'https://github.com/owner/repo/pull/5010\n', 'utf8')

    const binDir = join(workdir, '.bin-gh-release-refresh')
    await mkdir(binDir, { recursive: true })
    const ghPath = join(binDir, 'gh')
    await writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  echo '[{"number":6006,"url":"https://github.com/owner/repo/pull/6006"}]'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  echo '[{"name":"ci","state":"SUCCESS"}]'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$3" == "6006" ]]; then
    echo '{"state":"OPEN","mergedAt":null,"mergeCommit":null}'
    exit 0
  fi
  if [[ "$3" == "5010" ]]; then
    echo '{"state":"MERGED","mergedAt":"2026-03-05T00:00:00Z","mergeCommit":{"oid":"abc123"}}'
    exit 0
  fi
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(ghPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Release verification run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'deployer',
        swarmHumanName: 'release-manager',
        parameters: {
          rolloutHealthy: true,
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).rejects.toThrow(
      'Release run completed without merge evidence (merged PR/commit required)',
    )
    await expect(readFile(prNumberPath, 'utf8')).resolves.toContain('6006')
    await expect(readFile(prUrlPath, 'utf8')).resolves.toContain('https://github.com/owner/repo/pull/6006')
  }, 40_000)

  it('fails architect lane when repository changes exist without merge evidence', async () => {
    await mkdir(join(workdir, 'docs', 'agents', 'designs'), { recursive: true })
    await writeFile(
      join(workdir, 'docs', 'agents', 'designs', 'architectural-change.md'),
      '# draft architecture change\n',
      'utf8',
    )

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Architect planning run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'planning',
        swarmAgentRole: 'architector',
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).rejects.toThrow(
      'Architect run changed repository files but did not provide merged PR/commit evidence',
    )
  }, 40_000)

  it('passes architect lane merge-evidence gate when merged evidence is explicit', async () => {
    await mkdir(join(workdir, 'docs', 'agents', 'designs'), { recursive: true })
    await writeFile(
      join(workdir, 'docs', 'agents', 'designs', 'architectural-change.md'),
      '# draft architecture change\n',
      'utf8',
    )

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Architect planning run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'planning',
        swarmAgentRole: 'architector',
        parameters: {
          merged: true,
          mergedCommitSha: 'abc1234',
          mergedPrUrl: 'https://github.com/owner/repo/pull/4001',
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('recovers merged PR metadata for architect planning lanes before merge verification', async () => {
    await mkdir(join(workdir, 'docs', 'agents', 'designs'), { recursive: true })
    await writeFile(
      join(workdir, 'docs', 'agents', 'designs', 'architectural-change.md'),
      '# merged architecture change\n',
      'utf8',
    )

    process.env.CODEX_PR_DISCOVERY_ENABLED = 'true'
    process.env.CODEX_VERIFY_MERGE_WITH_GH = 'true'
    const binDir = join(workdir, '.bin-gh-architect-pr-discovery')
    await mkdir(binDir, { recursive: true })
    const ghPath = join(binDir, 'gh')
    await writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  echo '[{"number":5560,"url":"https://github.com/owner/repo/pull/5560"}]'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "view" && "$3" == "5560" ]]; then
  echo '{"state":"MERGED","mergedAt":"2026-05-05T20:50:20Z","mergeCommit":{"oid":"76db50ff50e19e698c73a2c9ca1d54bc05f4ef23"}}'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      'utf8',
    )
    await chmod(ghPath, 0o755)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? process.env.PATH ?? ''}`

    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Architect planning run',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'planning',
        swarmAgentRole: 'architector',
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
    await expect(readFile(join(workdir, '.codex-pr-number.txt'), 'utf8')).resolves.toContain('5560')
    await expect(readFile(join(workdir, '.codex-pr-url.txt'), 'utf8')).resolves.toContain(
      'https://github.com/owner/repo/pull/5560',
    )
  }, 40_000)

  it('fails engineer lane when PR checks are not verified green', async () => {
    process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH = 'false'
    await writeFile(join(workdir, '.codex-pr-number.txt'), '4010\n', 'utf8')
    await writeFile(join(workdir, '.codex-pr-url.txt'), 'https://github.com/owner/repo/pull/4010\n', 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow(
      'Engineer run completed without verified green required checks for the active pull request',
    )
  }, 40_000)

  it('passes engineer lane when explicit green checks evidence is provided', async () => {
    process.env.CODEX_VERIFY_PR_CHECKS_WITH_GH = 'false'
    await writeFile(join(workdir, '.codex-pr-number.txt'), '4011\n', 'utf8')
    await writeFile(join(workdir, '.codex-pr-url.txt'), 'https://github.com/owner/repo/pull/4011\n', 'utf8')
    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Implementation prompt',
        repository: 'owner/repo',
        issueNumber: 42,
        base: 'main',
        head: 'codex/issue-42',
        stage: 'implementation',
        swarmAgentRole: 'engineer',
        parameters: {
          checksGreen: true,
        },
      }),
      'utf8',
    )

    await expect(runCodexImplementation(eventPath)).resolves.toBeDefined()
  }, 40_000)

  it('throws when the event file is missing', async () => {
    await expect(runCodexImplementation(join(workdir, 'missing.json'))).rejects.toThrow(/Event payload file not found/)
  }, 40_000)

  it('configures Discord channel streaming when credentials are provided', async () => {
    process.env.DISCORD_BOT_TOKEN = 'token'
    process.env.DISCORD_GUILD_ID = 'guild'
    process.env.CHANNEL_SCRIPT = 'services/jangar/scripts/discord-channel.ts'
    utilMocks.pathExists.mockResolvedValue(true)

    await runCodexImplementation(eventPath)

    expect(buildDiscordChannelCommandMock).toHaveBeenCalledWith(
      'services/jangar/scripts/discord-channel.ts',
      expect.any(Array),
    )
    const invocation = runCodexSessionMock.mock.calls[0]?.[0]
    expect(invocation?.discordChannel?.command).toEqual(['bun', 'run', 'channel.ts'])
  }, 40_000)

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
  }, 30_000)

  it('throws when repository is missing in the payload', async () => {
    await writeFile(eventPath, JSON.stringify({ prompt: 'hi', repository: '', issueNumber: 3 }), 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('Missing repository metadata in event payload')
  }, 40_000)

  it('throws when issue number is missing in the payload', async () => {
    await writeFile(eventPath, JSON.stringify({ prompt: 'hi', repository: 'owner/repo', issueNumber: '' }), 'utf8')

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('Missing issue number metadata in event payload')
  }, 40_000)

  it('allows batch_task execution without repository, issue number, or head branch metadata', async () => {
    await writeFile(
      eventPath,
      JSON.stringify({
        prompt: 'Batch prompt',
        executionMode: 'batch_task',
        stage: 'implementation',
      }),
      'utf8',
    )

    const result = await runCodexImplementation(eventPath)

    expect(result.repository).toBe('batch-task')
    expect(result.issueNumber).toBe('0')
    expect(runCodexProgressCommentMock).not.toHaveBeenCalled()
  }, 40_000)

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
  }, 40_000)

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
      return { agentMessages: ['resumed'], sessionId: 'resumed-session', exitCode: 0, forcedTermination: false }
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
  }, 40_000)

  it('skips resume state when CODEX_DISABLE_RESUME is enabled', async () => {
    process.env.CODEX_DISABLE_RESUME = '1'
    const resumeSourceDir = await mkdtemp(join(tmpdir(), 'codex-impl-no-resume-src-'))
    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      worktree: workdir,
      repository: 'owner/repo',
      issueNumber: '42',
      prompt: 'Implementation prompt',
      sessionId: 'resume-session-disabled',
      trackedFiles: ['src/real.ts'],
      deletedFiles: [] as string[],
    }

    await mkdir(join(resumeSourceDir, 'metadata'), { recursive: true })
    await mkdir(join(resumeSourceDir, 'files', 'src'), { recursive: true })
    await writeFile(join(resumeSourceDir, 'metadata', 'manifest.json'), JSON.stringify(manifest), 'utf8')
    await writeFile(join(resumeSourceDir, 'files', 'src', 'real.ts'), 'console.log("resume");\n', 'utf8')

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
    await writeFile(
      join(workdir, '.codex', 'implementation-resume.json'),
      JSON.stringify({
        ...manifest,
        archivePath,
        patchPath: join(workdir, '.codex-implementation.patch'),
        statusPath: join(workdir, '.codex-implementation-status.txt'),
        state: 'pending' as const,
      }),
      'utf8',
    )

    runCodexSessionMock.mockImplementationOnce(async (options) => {
      expect(options.resumeSessionId).toBeUndefined()
      return { agentMessages: ['fresh run'], sessionId: 'fresh-session', exitCode: 0, forcedTermination: false }
    })

    try {
      const result = await runCodexImplementation(eventPath)
      expect(result.sessionId).toBe('fresh-session')
      const invocation = runCodexSessionMock.mock.calls[0]?.[0]
      expect(invocation?.resumeSessionId).toBeUndefined()
    } finally {
      delete process.env.CODEX_DISABLE_RESUME
      await rm(resumeSourceDir, { recursive: true, force: true })
    }
  }, 40_000)

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
  }, 40_000)

  it('resumes the Codex session when the first attempt ends incompletely', async () => {
    process.env.CODEX_MAX_SESSION_ATTEMPTS = '2'
    runCodexSessionMock
      .mockImplementationOnce(async () => ({
        agentMessages: [],
        sessionId: 'resume-session-xyz',
        exitCode: 0,
        forcedTermination: true,
      }))
      .mockImplementationOnce(async (options) => {
        expect(options.resumeSessionId).toBe('resume-session-xyz')
        return {
          agentMessages: ['final response'],
          sessionId: 'resume-session-xyz',
          exitCode: 0,
          forcedTermination: false,
        }
      })

    const result = await runCodexImplementation(eventPath)
    expect(result.sessionId).toBe('resume-session-xyz')
    expect(runCodexSessionMock).toHaveBeenCalledTimes(2)
  }, 40_000)

  it('restarts with a fresh prompt when Codex reports context-window exhaustion', async () => {
    process.env.CODEX_MAX_SESSION_ATTEMPTS = '2'
    process.env.CODEX_MAX_PROMPT_CHARS = '320'
    runCodexSessionMock
      .mockImplementationOnce(async () => ({
        agentMessages: [],
        sessionId: 'context-session-1',
        exitCode: 1,
        forcedTermination: false,
        contextWindowExceeded: true,
      }))
      .mockImplementationOnce(async (options) => {
        expect(options.resumeSessionId).toBeUndefined()
        expect(options.prompt).toContain('Previous attempt failed because the model context window was exceeded.')
        expect(options.prompt.length).toBeLessThanOrEqual(320)
        return {
          agentMessages: ['final response'],
          sessionId: 'context-session-2',
          exitCode: 0,
          forcedTermination: false,
        }
      })

    const result = await runCodexImplementation(eventPath)
    expect(result.sessionId).toBe('context-session-2')
    expect(runCodexSessionMock).toHaveBeenCalledTimes(2)
  }, 40_000)

  it('falls back to secondary model on transient provider quota/rate-limit failures', async () => {
    process.env.CODEX_MODEL = 'primary-throttled-model'
    process.env.CODEX_MODEL_FALLBACKS = 'fallback-capacity-model'
    process.env.CODEX_MAX_SESSION_ATTEMPTS = '2'

    runCodexSessionMock
      .mockRejectedValueOnce(new Error('429 rate limit exceeded for primary-throttled-model'))
      .mockImplementationOnce(async (options) => {
        expect(options.resumeSessionId).toBeUndefined()
        expect(options.prompt).toContain('transient provider throttling/quota constraints')
        return {
          agentMessages: ['final response'],
          sessionId: 'fallback-session',
          exitCode: 0,
          forcedTermination: false,
        }
      })

    const result = await runCodexImplementation(eventPath)
    expect(result.sessionId).toBe('fallback-session')
    expect(runCodexSessionMock).toHaveBeenCalledTimes(2)
    expect(process.env.CODEX_MODEL).toBe('fallback-capacity-model')
    const notifyRaw = await readFile(join(workdir, '.codex-implementation-notify.json'), 'utf8')
    const notify = JSON.parse(notifyRaw) as {
      modelRequested?: string | null
      modelUsed?: string | null
      fallbackUsed?: boolean | null
      attemptCount?: number | null
    }
    expect(notify.modelRequested).toBe('primary-throttled-model')
    expect(notify.modelUsed).toBe('fallback-capacity-model')
    expect(notify.fallbackUsed).toBe(true)
    expect(notify.attemptCount).toBe(2)
  }, 40_000)

  it('does not inject a default CODEX_MODEL when provider config is the source of truth', async () => {
    delete process.env.CODEX_MODEL
    delete process.env.CODEX_MODEL_FALLBACKS

    runCodexSessionMock.mockImplementationOnce(async () => {
      expect(process.env.CODEX_MODEL).toBeUndefined()
      return {
        agentMessages: ['done'],
        sessionId: 'provider-model-session',
        exitCode: 0,
        forcedTermination: false,
      }
    })

    const result = await runCodexImplementation(eventPath)
    expect(result.sessionId).toBe('provider-model-session')
    expect(process.env.CODEX_MODEL).toBeUndefined()
  })

  it('does not enable implicit fallback models when CODEX_MODEL_FALLBACKS is unset', async () => {
    process.env.CODEX_MODEL = 'gpt-5.5'
    delete process.env.CODEX_MODEL_FALLBACKS
    process.env.CODEX_MAX_SESSION_ATTEMPTS = '2'

    runCodexSessionMock.mockRejectedValueOnce(new Error('429 rate limit exceeded for gpt-5.5'))

    await expect(runCodexImplementation(eventPath)).rejects.toThrow('429 rate limit exceeded for gpt-5.5')
    expect(runCodexSessionMock).toHaveBeenCalledTimes(1)
    expect(process.env.CODEX_MODEL).toBe('gpt-5.5')
  })
})

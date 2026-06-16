import { describe, expect, test } from 'vitest'

import type { AgentRunSpecPayload, AnypiStatus, CiCheck, CiWaitResult, ValidationResult } from './types'
import type { GitContext } from './git'
import type { AnypiConfig } from './config'
import {
  buildPullRequestBody,
  normalizeConventionalSummary,
  renderPullRequestBody,
  baseStatus,
  buildCommitMessage,
  buildPullRequestTitle,
} from './run'
import { buildAgentPrompt, buildSystemPrompt, resolveValidationPlan, resolvePromptVariant } from './prompt'

describe('Anypi status metadata', () => {
  const makeConfig = (overrides?: Partial<AnypiConfig>): AnypiConfig => ({
    workspace: '/workspace',
    worktree: '/workspace/lab',
    agentDir: '/tmp/.anypi/agent',
    sessionDir: '/tmp/.anypi/sessions',
    authPath: '/tmp/anypi-auth.json',
    modelsPath: '/tmp/anypi-models.json',
    runSpecPath: '/tmp/run.json',
    runnerSpecPath: '/tmp/runner.json',
    statusPath: '/tmp/anypi-status.json',
    logPath: '/tmp/anypi.log',
    provider: 'flamingo',
    model: 'qwen3-coder-flamingo',
    baseUrl: 'http://localhost:8080/v1',
    apiKey: 'test-key',
    modelReadyTimeoutSeconds: 1800,
    promptVariant: 'minimal',
    allowSystemPromptOverride: false,
    thinkingLevel: 'off',
    contextWindow: 32768,
    maxTokens: 4096,
    tools: ['bash', 'edit'],
    allowNoVcs: false,
    validationCommands: [],
    validationPolicy: 'append' as const,
    noChangeRepairAttempts: 2,
    validationRepairAttempts: 2,
    ciCheckTimeoutSeconds: 300,
    ciCheckIntervalSeconds: 15,
    ciRepairAttempts: 1,
    ciRequiredOnly: true,
    ...overrides,
  })

  test('baseStatus includes prompt variant and hash', () => {
    const config = makeConfig({ promptVariant: 'finish-gated' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Add new feature' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Add new feature for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const status = baseStatus(config, runSpec, git, validationPlan)

    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toMatch(/^[a-f0-9]{16}$/)
    expect(status.provider).toBe('anypi')
    expect(status.status).toBe('running')
    expect(status.startedAt).toBeDefined()
    expect(status.repository).toBe('proompteng/lab')
    expect(status.baseBranch).toBe('main')
    expect(status.headBranch).toBe('codex/anypi')
    expect(status.validationPlan).toEqual(validationPlan)
  })

  test('status includes validation plan sources and commands', () => {
    const config = makeConfig({ promptVariant: 'repair-loop' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { text: 'Improve services/anypi prompt handling.' },
      parameters: { validationCommands: 'bun run --filter @proompteng/anypi test' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(runSpec, ['bun run --filter @proompteng/anypi lint'], 'append')

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const status = baseStatus(config, runSpec, git, validationPlan)

    expect(status.validationPlan.sources).toContain('inferred')
    expect(status.validationPlan.sources).toContain('run-spec')
    expect(status.validationPlan.sources).toContain('env')
    expect(status.validationPlan.commands).toContain('bun run --filter @proompteng/anypi test')
    expect(status.validationPlan.commands).toContain('bun run --filter @proompteng/anypi lint')
  })

  test('status tracks validation attempts and results', () => {
    const config = makeConfig({ promptVariant: 'minimal' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Fix bug' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    // Use validation plan with service-aware commands to avoid validation error
    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Fix bug in torghut service' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    let status = baseStatus(config, runSpec, git, validationPlan)

    // Simulate validation attempts
    const validationResults: ValidationResult[] = [
      {
        command: 'bash',
        args: ['-lc', 'bun test'],
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 42,
        ok: true,
      },
    ]

    status.validations = validationResults
    status.validationAttempts = 1
    status.agentAttempts = 1

    expect(status.validationAttempts).toBe(1)
    expect(status.validations.length).toBe(1)
    expect(status.validations[0].ok).toBe(true)
    expect(status.validations[0].command).toBe('bash')
    expect(status.validations[0].args).toEqual(['-lc', 'bun test'])

    // Simulate failed validation with repair
    const failedResult: ValidationResult = {
      command: 'bash',
      args: ['-lc', 'bun test'],
      exitCode: 1,
      stdout: '',
      stderr: 'Error: test failed',
      durationMs: 150,
      ok: false,
    }

    status.validations = [failedResult]
    status.validationAttempts = 2

    expect(status.validationAttempts).toBe(2)
    expect(status.validations[0].ok).toBe(false)
    expect(status.validations[0].stderr).toContain('Error: test failed')
  })

  test('status tracks CI attempts and checks', () => {
    const config = makeConfig({ promptVariant: 'finish-gated' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Add CI checks' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Add CI checks for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    let status = baseStatus(config, runSpec, git, validationPlan)

    // CI wait result with checks
    const ciResult: CiWaitResult = {
      ok: true,
      status: 'passed',
      requiredOnly: true,
      attempts: 3,
      durationMs: 45000,
      checks: [
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'pyright', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
      ],
      summary: '3 passed/skipped, 0 pending, 0 failed/cancelled',
    }

    status.ci = ciResult
    status.ciAttempts = 3

    expect(status.ciAttempts).toBe(3)
    expect(status.ci?.ok).toBe(true)
    expect(status.ci?.status).toBe('passed')
    expect(status.ci?.attempts).toBe(3)
    expect(status.ci?.durationMs).toBe(45000)
    expect(status.ci?.requiredOnly).toBe(true)
    expect(status.ci?.checks.length).toBe(3)
    expect(status.ci?.summary).toContain('passed/skipped')
  })

  test('status tracks session artifacts and commit', () => {
    const config = makeConfig({ promptVariant: 'strict-repo' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Add session tracking' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Add session tracking for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    let status = baseStatus(config, runSpec, git, validationPlan)

    // Session files
    const sessionFiles = [
      '/tmp/.anypi/sessions/initial/session.json',
      '/tmp/.anypi/sessions/validation-repair-1/session.json',
      '/tmp/.anypi/sessions/ci-repair-1/session.json',
    ]

    status.sessionFile = sessionFiles[0]
    status.sessionFiles = sessionFiles

    // Commit info
    status.commit = 'abc123def456'

    expect(status.sessionFile).toBe(sessionFiles[0])
    expect(status.sessionFiles).toEqual(sessionFiles)
    expect(status.commit).toBe('abc123def456')
  })

  test('status tracks PR metadata', () => {
    const config = makeConfig({ promptVariant: 'minimal' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Create PR' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Create PR for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    let status = baseStatus(config, runSpec, git, validationPlan)

    const prResult = {
      enabled: true,
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    }

    status.pullRequest = prResult

    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/123')
    expect(status.pullRequest?.created).toBe(true)
  })

  test('status includes agent and validation attempt counts', () => {
    const config = makeConfig({ promptVariant: 'repair-loop' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Test attempts tracking' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Test attempts tracking for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    let status = baseStatus(config, runSpec, git, validationPlan)

    // Simulate multiple attempts
    status.agentAttempts = 4
    status.validationAttempts = 3
    status.ciAttempts = 2
    status.promptChars = 1500

    expect(status.agentAttempts).toBe(4)
    expect(status.validationAttempts).toBe(3)
    expect(status.ciAttempts).toBe(2)
    expect(status.promptChars).toBe(1500)
  })

  test('status includes provider and model info', () => {
    const config = makeConfig({ promptVariant: 'finish-gated' })

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Model info test' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Model info test for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const status = baseStatus(config, runSpec, git, validationPlan)

    expect(status.provider).toBe('anypi')
    expect(status.model).toBe('qwen3-coder-flamingo')
    expect(status.providerModel).toBe('flamingo/qwen3-coder-flamingo')
    expect(status.promptVariant).toBe('finish-gated')
  })

  test('status includes run metadata and worktree path', () => {
    const config = makeConfig({ promptVariant: 'minimal' })

    const runSpec: AgentRunSpecPayload = {
      agentRun: { name: 'anypi-run-20260616', namespace: 'agents' },
      implementation: { summary: 'Run metadata test' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const validationPlan = resolveValidationPlan(
      { ...runSpec, implementation: { summary: 'Run metadata test for torghut' } },
      ['bun test'],
      'append',
    )

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const status = baseStatus(config, runSpec, git, validationPlan)

    expect(status.runName).toBe('anypi-run-20260616')
    expect(status.namespace).toBe('agents')
    expect(status.worktree).toBe('/workspace/lab')
    expect(status.repository).toBe('proompteng/lab')
  })
})

describe('Anypi status auditability - PR body rendering', () => {
  test('PR body includes prompt variant and hash for auditing', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner-repair',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-eval/runner',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: 'a1b2c3d4e5f6g7h8',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'abc123def456',
      ciAttempts: 1,
      validationAttempts: 1,
      agentAttempts: 2,
      promptChars: 1200,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/123', created: true },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Improve PR body rendering' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-eval/runner',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented changes',
    })

    expect(body).toContain(`Prompt variant: \`${status.promptVariant}\` (\`${status.promptHash}\`)`)
  })

  test('PR body includes validation results for auditing', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-run-1',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: '1234567890abcdef',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'abc123',
      ciAttempts: 0,
      validationAttempts: 1,
      agentAttempts: 1,
      promptChars: 800,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 100,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec'],
        commands: ['bun test'],
      },
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/1', created: true },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Add validation plan sources' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented',
    })

    // Validation summary should include command output
    expect(body).toContain('bash -lc bun test')
    expect(body).toContain('exit 0')
  })

  test('PR body includes validation and CI attempts for auditing', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-run-2',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'fedcba0987654321',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'def456',
      ciAttempts: 3,
      validationAttempts: 2,
      agentAttempts: 4,
      promptChars: 950,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 3,
        durationMs: 60000,
        checks: [{ name: 'ci', workflow: 'CI', bucket: 'pass' }],
        summary: '1 passed/skipped, 0 pending, 0 failed/cancelled',
      },
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/2', created: true },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Test attempts in PR' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented',
    })

    // CI summary should show status
    expect(body).toContain('CI: passed')
  })

  test('PR body includes session artifact paths for debugging', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-run-3',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'strict-repo',
      promptHash: 'abcdef1234567890',
      tools: ['bash', 'edit', 'read'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/validation-repair-1/session.json',
        '/workspace/.anypi/sessions/ci-repair-1/session.json',
      ],
      commit: 'ghi789',
      ciAttempts: 1,
      validationAttempts: 1,
      agentAttempts: 3,
      promptChars: 1100,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec'],
        commands: ['bun test'],
      },
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/3', created: true },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Session paths test' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented',
    })

    expect(body).toContain('Session artifact:')
    expect(body).toContain('/workspace/.anypi/sessions/initial/session.json')
  })

  test('PR body includes run metadata for tracking', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-run-4',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: '0987654321abcdef',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'jkl012',
      ciAttempts: 0,
      validationAttempts: 1,
      agentAttempts: 1,
      promptChars: 750,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/4',
        created: true,
      },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'PR metadata test' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented',
    })

    // PR body includes agent run metadata for tracking
    expect(body).toContain('agents/anypi-run-4')
    expect(body).toContain('Prompt variant: `repair-loop`')
    expect(body).toContain('Session artifact:')
    // Repository is available in status but not rendered in PR body summary section
  })

  test('PR body includes ci status with check details for auditing', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-run-5',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'f00d123456789abc',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'mno345',
      ciAttempts: 2,
      validationAttempts: 1,
      agentAttempts: 2,
      promptChars: 900,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 2,
        durationMs: 45000,
        checks: [
          { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
          { name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
          { name: 'pyright', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        ],
        summary: '3 passed/skipped, 0 pending, 0 failed/cancelled',
      },
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/5',
        created: true,
      },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'CI status audit' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented',
    })

    expect(body).toContain('CI: passed')
    expect(body).toContain('3 passed/skipped')
    expect(body).toContain('0 pending')
    expect(body).toContain('0 failed/cancelled')
  })

  test('PR body handles failed CI status', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-run-6',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: 'cafe1234abcd5678',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'pqr678',
      ciAttempts: 1,
      validationAttempts: 1,
      agentAttempts: 1,
      promptChars: 800,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      ci: {
        ok: false,
        status: 'failed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 30000,
        checks: [
          { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
          { name: 'test', workflow: 'CI', bucket: 'fail', state: 'FAILURE' },
        ],
        summary: '1 passed/skipped, 0 pending, 1 failed/cancelled',
      },
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/6',
        created: true,
      },
    }

    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Failed CI status' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
    }

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }

    const body = renderPullRequestBody({
      runSpec,
      status,
      git,
      piText: 'implemented',
    })

    expect(body).toContain('CI: failed')
    expect(body).toContain('1 passed/skipped')
    expect(body).toContain('1 failed/cancelled')
  })
})

describe('Anypi status normalizers', () => {
  test('normalizeConventionalSummary handles various input formats', () => {
    expect(normalizeConventionalSummary('Improve Anypi status.', 'fallback')).toBe('improve anypi status')
    expect(normalizeConventionalSummary('  Multiple   spaces   ', 'fallback')).toBe('multiple spaces')
    expect(normalizeConventionalSummary('Period at end.', 'fallback')).toBe('period at end')
    expect(normalizeConventionalSummary('Multiple periods...', 'fallback')).toBe('multiple periods')
    expect(normalizeConventionalSummary('CJRLF line\nbreak', 'fallback')).toBe('cjrlf line break')
    expect(normalizeConventionalSummary(undefined, 'fallback')).toBe('fallback')
    expect(normalizeConventionalSummary('', 'fallback')).toBe('fallback')
  })

  test('buildCommitMessage uses implementation summary or issue title', () => {
    expect(
      buildCommitMessage({
        implementation: { summary: 'Fix typo in README' },
      }),
    ).toBe('feat(anypi): fix typo in readme')

    expect(
      buildCommitMessage({
        issueTitle: 'Fix bug in parser',
      }),
    ).toBe('feat(anypi): fix bug in parser')

    expect(
      buildCommitMessage({
        agentRun: { name: 'anypi-run' },
      }),
    ).toBe('feat(anypi): anypi-run')
  })

  test('buildPullRequestTitle uses implementation summary or issue title', () => {
    expect(
      buildPullRequestTitle({
        implementation: { summary: 'Add validation plan sources' },
      }),
    ).toBe('feat(anypi): add validation plan sources')

    expect(
      buildPullRequestTitle({
        issueTitle: 'Fix CI failures',
      }),
    ).toBe('feat(anypi): fix ci failures')
  })
})

describe('Anypi status prompt contract', () => {
  test('buildAgentPrompt excludes runtime internals', () => {
    const prompt = buildAgentPrompt(
      {
        implementation: { text: 'Implement a new feature.' },
        vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
      },
      '/workspace/lab',
    )

    expect(prompt).not.toMatch(/Anypi|YOLO|Kubernetes|provider|Flamingo/)
    expect(prompt).not.toMatch(/statusPath|logPath|sessionDir|agentDir/)
    expect(prompt).not.toMatch(/noChangeRepairAttempts|validationRepairAttempts|ciRepairAttempts/)
  })

  test('buildSystemPrompt variants exclude runtime internals', () => {
    for (const variant of ['minimal', 'finish-gated', 'repair-loop', 'strict-repo'] as const) {
      const systemPrompt = buildSystemPrompt(variant)
      expect(systemPrompt).not.toMatch(/Anypi|YOLO|Kubernetes|provider|Flamingo/)
      expect(systemPrompt).not.toMatch(/statusPath|logPath|sessionDir|agentDir/)
      expect(systemPrompt).not.toMatch(/noChangeRepairAttempts|validationRepairAttempts|ciRepairAttempts/)
    }
  })
})

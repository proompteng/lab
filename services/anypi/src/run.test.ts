import { describe, expect, test, vi } from 'vitest'

import type { AgentRunSpecPayload, AnypiStatus, CiWaitResult } from './types'
import type { AnypiConfig } from './config'
import { resolveConfig } from './config'
import { runAnypi } from './run'

// Mock modules at top level (required by Vitest)
vi.mock('./config')
vi.mock('./logger')
vi.mock('./git')
vi.mock('./pi-session')

// Import real prompt module with mocked functions
vi.mock('./prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompt')>()
  return {
    ...actual,
    // Mock only these functions
    buildAgentPrompt: vi.fn().mockReturnValue('test prompt'),
    hashSystemPrompt: vi.fn().mockImplementation((v) => `hash-${v}`),
    resolveValidationPlan: vi.fn().mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }),
  }
})

// Import real resolvePromptVariant before mocking
import type { resolvePromptVariant as resolvePromptVariantType } from './prompt'
const realPromptModule = await vi.importActual<typeof import('./prompt')>('./prompt')
import * as configModule from './config'
import * as loggerModule from './logger'
import * as promptModule from './prompt'
import * as gitModule from './git'
import * as piSessionModule from './pi-session'

// Helper to create a mock run spec
const createRunSpec = (overrides: Partial<AgentRunSpecPayload> = {}): AgentRunSpecPayload => ({
  implementation: { summary: 'Test feature' },
  vcs: {
    repository: 'proompteng/lab',
    baseBranch: 'main',
    headBranch: 'codex/anypi-test',
  },
  ...overrides,
})

// Create a mock fetch function that can be stubbed globally
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  statusText: 'OK',
} as unknown as Response)

describe('Anypi status evidence', () => {
  const baseEnv: Partial<NodeJS.ProcessEnv> = {
    ANYPI_WORKSPACE: '/workspace',
    ANYPI_WORKTREE: '/workspace/lab',
    ANYPI_PROVIDER: 'flamingo',
    ANYPI_MODEL: 'qwen3-coder-flamingo',
    ANYPI_BASE_URL: 'http://localhost:8000/v1',
    ANYPI_API_KEY: 'test-key',
    VCS_REPOSITORY: 'proompteng/lab',
    VCS_BASE_BRANCH: 'main',
    VCS_HEAD_BRANCH: 'codex/anypi-test',
    VCS_WRITE_ENABLED: 'true',
    VCS_PULL_REQUESTS_ENABLED: 'true',
  }

  test('includes prompt variant and hash in status metadata', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv, ANYPI_PROMPT_VARIANT: 'finish-gated' } as NodeJS.ProcessEnv
    const runSpec = createRunSpec()

    // Stub fetch globally before running
    global.fetch = mockFetch as unknown as typeof fetch

    // Setup mocks
    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toBe('hash-finish-gated')
    expect(status.promptHash).toBeDefined()
  })

  test('includes validation plan sources in status metadata', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv } as NodeJS.ProcessEnv
    const runSpec = createRunSpec({
      parameters: { validationCommands: 'bun test' },
    })

    global.fetch = mockFetch as unknown as typeof fetch

    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred', 'run-spec'],
      commands: ['bun test'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status.validationPlan).toBeDefined()
    expect(status.validationPlan.sources).toBeDefined()
    expect(Array.isArray(status.validationPlan.sources)).toBe(true)
    expect(status.validationPlan.sources.length).toBeGreaterThan(0)
  })

  test('includes validation attempts count in status metadata', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv } as NodeJS.ProcessEnv
    const runSpec = createRunSpec()

    global.fetch = mockFetch as unknown as typeof fetch

    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([
      {
        command: 'bash',
        args: ['-lc', 'git diff --check'],
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 100,
      },
    ])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status.validationAttempts).toBe(1)
    expect(typeof status.validationAttempts).toBe('number')
  })

  test('includes ci attempts count in status metadata', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv, VCS_PULL_REQUESTS_ENABLED: 'true' } as NodeJS.ProcessEnv
    const runSpec = createRunSpec()

    global.fetch = mockFetch as unknown as typeof fetch

    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status.ciAttempts).toBe(1)
    expect(typeof status.ciAttempts).toBe('number')
  })

  test('includes session artifact paths in status metadata', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv } as NodeJS.ProcessEnv
    const runSpec = createRunSpec()

    global.fetch = mockFetch as unknown as typeof fetch

    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status.sessionFile).toBeDefined()
    expect(typeof status.sessionFile).toBe('string')
    expect(status.sessionFile).toContain('.json')

    expect(status.sessionFiles).toBeDefined()
    expect(Array.isArray(status.sessionFiles)).toBe(true)
    expect(status.sessionFiles?.length).toBeGreaterThanOrEqual(1)
  })

  test('includes pr metadata in status metadata', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv, VCS_PULL_REQUESTS_ENABLED: 'true' } as NodeJS.ProcessEnv
    const runSpec = createRunSpec()

    global.fetch = mockFetch as unknown as typeof fetch

    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status.pullRequest).toBeDefined()
    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.created).toBe(true)
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/123')
  })

  test('includes all required status fields for audit trail', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv } as NodeJS.ProcessEnv
    const runSpec = createRunSpec()

    global.fetch = mockFetch as unknown as typeof fetch

    const config: AnypiConfig = {
      workspace: '/workspace',
      worktree: '/workspace/lab',
      agentDir: '/workspace/.anypi',
      sessionDir: '/workspace/.anypi/sessions',
      authPath: '/workspace/.anypi/auth.json',
      modelsPath: '/workspace/.anypi/models.json',
      runSpecPath: '/workspace/run.json',
      runnerSpecPath: '/workspace/agent-runner.json',
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      provider: 'flamingo',
      model: 'qwen3-coder-flamingo',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      modelReadyTimeoutSeconds: 1,
      promptVariant: realPromptModule.resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
      allowSystemPromptOverride: false,
      thinkingLevel: 'off' as const,
      contextWindow: 32768,
      maxTokens: 4096,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      allowNoVcs: false,
      validationCommands: [],
      validationPolicy: 'append' as const,
      noChangeRepairAttempts: 0,
      validationRepairAttempts: 0,
      ciCheckTimeoutSeconds: 30,
      ciCheckIntervalSeconds: 1,
      ciRepairAttempts: 0,
      ciRequiredOnly: true,
    }

    vi.mocked(configModule.resolveConfig).mockReturnValue(config)
    vi.mocked(configModule.loadRunnerSpec).mockResolvedValue(null)
    vi.mocked(configModule.loadRunSpec).mockResolvedValue(runSpec)
    vi.mocked(configModule.applyRunnerArtifacts).mockImplementation((c) => c)
    vi.mocked(configModule.writeModelsFile).mockResolvedValue(undefined)

    vi.mocked(loggerModule.createLogger).mockResolvedValue({
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    })

    vi.mocked(promptModule.buildAgentPrompt).mockReturnValue('test prompt')
    vi.mocked(promptModule.hashSystemPrompt).mockImplementation((v) => `hash-${v}`)
    vi.mocked(promptModule.resolveValidationPlan).mockReturnValue({
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    })

    vi.mocked(gitModule.resolveGitContext).mockResolvedValue({
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
    })
    vi.mocked(gitModule.prepareRepository).mockResolvedValue(undefined)
    vi.mocked(gitModule.gitStatusShort).mockResolvedValue('')
    vi.mocked(gitModule.countCommitsAhead).mockResolvedValue(1)
    vi.mocked(gitModule.commitIfNeeded).mockResolvedValue('abc123')
    vi.mocked(gitModule.pushBranch).mockResolvedValue(undefined)
    vi.mocked(gitModule.createOrUpdatePullRequest).mockResolvedValue({
      enabled: env.VCS_PULL_REQUESTS_ENABLED === 'true',
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    vi.mocked(gitModule.runValidationCommands).mockResolvedValue([])
    vi.mocked(gitModule.waitForPullRequestChecks).mockResolvedValue({
      ok: true,
      status: 'passed' as const,
      requiredOnly: true,
      attempts: 1,
      durationMs: 5000,
      checks: [],
      summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
    })

    vi.mocked(piSessionModule.runPiAgent).mockResolvedValue({
      text: 'test implementation',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/test-session/session.json',
    })

    const status = await runAnypi(env)

    expect(status).toMatchObject({
      provider: 'anypi',
      status: 'succeeded',
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      runName: undefined,
      namespace: undefined,
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: expect.any(String),
      tools: expect.any(Array),
      sessionFile: expect.any(String),
      sessionFiles: expect.any(Array),
      commit: expect.any(String),
      validations: expect.any(Array),
      validationPlan: expect.any(Object),
      agentAttempts: expect.any(Number),
      validationAttempts: expect.any(Number),
      ciAttempts: expect.any(Number),
      promptChars: expect.any(Number),
    })

    expect(status.pullRequest).toBeDefined()
    expect(status.ci).toBeDefined()
  })
})

describe('Anypi status metadata audit fields', () => {
  test('status metadata is complete for post-AgentRun auditing', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T10:00:00.000Z',
      finishedAt: '2026-06-16T10:05:00.000Z',
      runName: 'anypi-run-123',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-test',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'a1b2c3d4e5f6g7h8',
      tools: ['bash', 'edit', 'read'],
      sessionFile: '/workspace/.anypi/sessions/final/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/final/session.json',
      ],
      commit: 'abc123def456',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/456',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed' as const,
        requiredOnly: true,
        attempts: 2,
        durationMs: 10000,
        checks: [{ name: 'ci', workflow: 'Continuous Integration', bucket: 'pass' }],
        summary: '1 passed/skipped',
      },
      ciAttempts: 2,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'PASS',
          stderr: '',
          durationMs: 2000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec'],
        commands: ['git diff --check', 'bun test'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1234,
    }

    // Verify all required audit fields are present
    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toBe('a1b2c3d4e5f6g7h8')
    expect(status.validationPlan.sources).toEqual(['inferred', 'run-spec'])
    expect(status.validationAttempts).toBe(1)
    expect(status.ciAttempts).toBe(2)
    expect(status.sessionFile).toBe('/workspace/.anypi/sessions/final/session.json')
    expect(status.sessionFiles).toHaveLength(2)
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/456')
    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.created).toBe(true)
  })

  test('status metadata includes validation plan sources for audit trail', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T10:00:00.000Z',
      finishedAt: '2026-06-16T10:05:00.000Z',
      repository: 'proompteng/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'abcdef1234567890',
      tools: [],
      sessionFile: undefined,
      sessionFiles: [],
      commit: undefined,
      pullRequest: undefined,
      ci: undefined,
      ciAttempts: 0,
      validations: [],
      validationPlan: {
        policy: 'override',
        sources: ['env', 'run-spec'],
        commands: ['npm test'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 500,
    }

    // Verify validation plan sources are included
    expect(status.validationPlan.sources).toEqual(['env', 'run-spec'])
    expect(status.validationPlan.policy).toBe('override')
    expect(status.validationPlan.commands).toEqual(['npm test'])
  })

  test('status metadata includes validation attempts and results', () => {
    const validations = [
      {
        command: 'bash',
        args: ['-lc', 'bun run --filter @proompteng/anypi test'],
        exitCode: 0,
        stdout: 'PASS 5 tests',
        stderr: '',
        durationMs: 3000,
        ok: true,
      },
      {
        command: 'bash',
        args: ['-lc', 'bun run --filter @proompteng/anypi tsc'],
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 5000,
        ok: true,
      },
    ]

    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T10:00:00.000Z',
      finishedAt: '2026-06-16T10:05:00.000Z',
      repository: 'proompteng/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: '1234567890abcdef',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/repair-1/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/repair-1/session.json'],
      commit: 'xyz789',
      pullRequest: undefined,
      ci: undefined,
      ciAttempts: 0,
      validations,
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test', 'tsc'],
      },
      agentAttempts: 2,
      validationAttempts: 2,
      promptChars: 2000,
    }

    expect(status.validationAttempts).toBe(2)
    expect(status.validations).toHaveLength(2)
    expect(status.validations[0].command).toBe('bash')
    expect(status.validations[0].args).toEqual(['-lc', 'bun run --filter @proompteng/anypi test'])
    expect(status.validations[0].ok).toBe(true)
  })

  test('status metadata includes ci attempts and check details', () => {
    const ci: CiWaitResult = {
      ok: true,
      status: 'passed',
      requiredOnly: false,
      attempts: 3,
      durationMs: 45000,
      checks: [
        { name: 'lint', workflow: 'CI', bucket: 'pass' },
        { name: 'build', workflow: 'CI', bucket: 'pass' },
        { name: 'e2e', workflow: 'CI', bucket: 'pass' },
      ],
      summary: '3 passed/skipped, 0 pending, 0 failed/cancelled',
    }

    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T10:00:00.000Z',
      finishedAt: '2026-06-16T10:10:00.000Z',
      repository: 'proompteng/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'strict-repo',
      promptHash: 'fedcba9876543210',
      tools: ['bash', 'edit', 'read', 'write'],
      sessionFile: '/workspace/.anypi/sessions/ci-repair-1/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/ci-repair-1/session.json',
      ],
      commit: 'pr-commit-123',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/789',
        created: false,
      },
      ci,
      ciAttempts: 3,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['git diff --check'],
      },
      agentAttempts: 3,
      validationAttempts: 1,
      promptChars: 3000,
    }

    expect(status.ciAttempts).toBe(3)
    expect(status.ci?.attempts).toBe(3)
    expect(status.ci?.durationMs).toBe(45000)
    expect(status.ci?.checks).toHaveLength(3)
    expect(status.ci?.summary).toContain('3 passed')
  })

  test('status metadata includes session artifact paths for debugging', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T10:00:00.000Z',
      finishedAt: '2026-06-16T10:05:00.000Z',
      repository: 'proompteng/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'aaaaaaaaaaaaaaaa',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/final/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/repair-1/session.json',
        '/workspace/.anypi/sessions/final/session.json',
      ],
      commit: 'abc123',
      pullRequest: undefined,
      ci: undefined,
      ciAttempts: 0,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['git diff --check'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1000,
    }

    expect(status.sessionFiles).toHaveLength(3)
    expect(status.sessionFiles?.[0]).toContain('initial')
    expect(status.sessionFiles?.[1]).toContain('repair-1')
    expect(status.sessionFiles?.[2]).toContain('final')
  })

  test('status metadata includes pr metadata for audit trail', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T10:00:00.000Z',
      finishedAt: '2026-06-16T10:05:00.000Z',
      repository: 'proompteng/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'bbbbbbbbbbbbbbbb',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/final/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/final/session.json'],
      commit: 'pr-commit-456',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/456',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed' as const,
        requiredOnly: true,
        attempts: 1,
        durationMs: 5000,
        checks: [],
        summary: '2 passed',
      },
      ciAttempts: 1,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['git diff --check'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1500,
    }

    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.created).toBe(true)
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/456')
  })
})

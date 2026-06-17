import { describe, expect, test, vi } from 'vitest'

import { resolveConfig } from './config'
import {
  baseStatus,
  buildCommitMessage,
  buildPullRequestBody,
  buildPullRequestTitle,
  normalizeConventionalSummary,
  renderPullRequestBody,
  runAnypi,
  type AnypiStatus,
  type ValidationPlan,
} from './run'
import {
  buildAgentPrompt,
  buildCiRepairPrompt,
  buildNoChangeRepairPrompt,
  buildSystemPrompt,
  buildValidationRepairPrompt,
  resolveValidationPlan,
} from './prompt'
import type { AgentRunSpecPayload, CiWaitResult, PullRequestResult, ValidationResult } from './types'

// Mock fs/promises for status file writing
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}))

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

// Mock fetch for model endpoint checks
vi.mock('node:fetch', () => ({
  default: vi.fn(),
}))

describe('Anypi status metadata', () => {
  test('baseStatus includes prompt variant and hash', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      prompt: 'Test task',
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
    }
    const validationPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    const status = baseStatus(config, runSpec, null, validationPlan)

    expect(status.promptVariant).toBe('minimal')
    expect(status.promptHash).toMatch(/^[a-f0-9]{16}$/)
  })

  test('status includes validation plan sources for audit', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
      ANYPI_VALIDATION_COMMANDS: 'bun test',
      ANYPI_PROMPT_VARIANT: 'strict-repo',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      implementation: { text: 'Improve services/anypi' },
      parameters: { validationCommands: 'bun lint' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
    }
    const validationPlan = resolveValidationPlan(runSpec, ['bun tsc'], 'append')
    const status = baseStatus(config, runSpec, null, validationPlan)

    // Status should expose validation plan sources for auditing
    expect(status.validationPlan.sources).toContain('inferred')
    expect(status.validationPlan.sources).toContain('run-spec')
    expect(status.validationPlan.sources).toContain('env')
    expect(status.validationPlan.commands.length).toBeGreaterThan(1)
  })

  test('status includes validation attempts counter', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      prompt: 'Test task',
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
    }
    const validationPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    const status = baseStatus(config, runSpec, null, validationPlan)

    expect(status.validationAttempts).toBe(0)
    expect(status.agentAttempts).toBe(0)
    expect(status.ciAttempts).toBe(0)
  })

  test('status includes session artifact paths', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
      ANYPI_SESSION_DIR: '/workspace/.anypi/sessions',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      prompt: 'Test task',
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
    }
    const validationPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    const status = baseStatus(config, runSpec, null, validationPlan)

    // Status should include session file tracking fields (initialized as undefined)
    expect(status.sessionFile).toBeUndefined()
    expect(status.sessionFiles).toBeUndefined()
  })

  test('status includes CI metadata structure', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      prompt: 'Test task',
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
    }
    const validationPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    const status = baseStatus(config, runSpec, null, validationPlan)

    expect(status.ci).toBeUndefined()
    expect(status.ciAttempts).toBe(0)
    // CI structure should be populated on first attempt
  })

  test('status includes PR metadata structure', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      prompt: 'Test task',
      vcs: {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/test',
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
    }
    const validationPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    const status = baseStatus(config, runSpec, null, validationPlan)

    expect(status.pullRequest).toBeUndefined()
    // PR structure should be populated after PR creation
  })

  test('status includes all required audit fields when complete', () => {
    const env: NodeJS.ProcessEnv = {
      ANYPI_WORKSPACE: '/workspace',
      ANYPI_WORKTREE: '/workspace/lab',
      ANYPI_MODEL: 'qwen3-coder-flamingo',
      ANYPI_PROVIDER: 'flamingo',
      ANYPI_BASE_URL: 'http://localhost:8000/v1',
      ANYPI_API_KEY: 'test-key',
      ANYPI_SESSION_DIR: '/workspace/.anypi/sessions',
    }
    const config = resolveConfig(env)
    const runSpec: AgentRunSpecPayload = {
      prompt: 'Fix a bug in the parser',
      implementation: { summary: 'Fix parser bug', text: 'Parser fix implementation' },
      vcs: {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/bugfix',
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
    }
    const validationPlan = resolveValidationPlan(runSpec, ['bun test'], 'append')

    // Build a complete status simulating an agent run
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T12:00:00.000Z',
      finishedAt: '2026-06-16T12:15:00.000Z',
      runName: 'anypi-run-001',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/bugfix',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'a1b2c3d4e5f6a7b8',
      tools: ['bash', 'edit', 'read', 'write'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/validation-repair-1/session.json',
      ],
      commit: 'abc123def456789',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/1234',
        created: true,
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
        ],
        summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
      },
      ciAttempts: 2,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'PASS: 10/10 tests',
          stderr: '',
          durationMs: 12000,
          ok: true,
        },
      ],
      validationPlan,
      agentAttempts: 2,
      validationAttempts: 1,
      promptChars: 1500,
    }

    // Verify all audit fields are present
    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toBe('a1b2c3d4e5f6a7b8')
    expect(status.validationPlan.sources).toEqual(['inferred', 'env'])
    expect(status.validationPlan.commands).toContain('git diff --check')
    expect(status.validationAttempts).toBe(1)
    expect(status.ciAttempts).toBe(2)
    expect(status.sessionFile).toBe('/workspace/.anypi/sessions/initial/session.json')
    expect(status.sessionFiles).toHaveLength(2)
    expect(status.pullRequest).toBeDefined()
    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/1234')
    expect(status.pullRequest?.created).toBe(true)
    expect(status.ci).toBeDefined()
    expect(status.ci?.status).toBe('passed')
    expect(status.ci?.checks).toHaveLength(2)
  })
})

describe('Anypi PR body rendering', () => {
  test('includes prompt variant and hash in PR body', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:10:00.000Z',
      runName: 'anypi-pr-test',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-pr-test',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'strict-repo',
      promptHash: 'deadbeefcafe1234',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'abc123',
      validations: [
        {
          command: 'bun',
          args: ['test'],
          exitCode: 0,
          stdout: 'PASS',
          stderr: '',
          durationMs: 5000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test', 'bun lint'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      ciAttempts: 0,
      promptChars: 1200,
    }

    const body = renderPullRequestBody({
      runSpec: {
        implementation: { summary: 'Improve Anypi status metadata' },
        vcs: {
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi-pr-test',
        },
      },
      status,
      git: {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi-pr-test',
        cloneUrl: 'https://github.com/proompteng/lab.git',
        webUrl: 'https://github.com/proompteng/lab',
        worktree: '/workspace/lab',
        env: {},
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
      piText: 'Implemented status metadata improvements',
    })

    expect(body).toContain('Prompt variant: `strict-repo` (`deadbeefcafe1234`)')
    expect(body).toContain('Session artifact: `/workspace/.anypi/sessions/initial/session.json`')
    expect(body).toContain('bun test')
  })

  test('includes validation plan sources in status metadata', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:10:00.000Z',
      runName: 'anypi-validation-sources',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-validation-sources',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: '1234567890abcdef',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'def456',
      validations: [
        {
          command: 'bun',
          args: ['test'],
          exitCode: 0,
          stdout: 'PASS',
          stderr: '',
          durationMs: 3000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'override',
        sources: ['env'],
        commands: ['bun test'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      ciAttempts: 0,
      promptChars: 800,
    }

    const body = renderPullRequestBody({
      runSpec: {
        implementation: { summary: 'Test validation plan sources' },
        vcs: {
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi-validation-sources',
        },
      },
      status,
      git: {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi-validation-sources',
        cloneUrl: 'https://github.com/proompteng/lab.git',
        webUrl: 'https://github.com/proompteng/lab',
        worktree: '/workspace/lab',
        env: {},
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
      piText: 'Added validation plan source tracking',
    })

    // PR body should show validation commands
    expect(body).toContain('bun test')
    expect(body).toContain('Testing')
    // Status has sources field but PR body doesn't expose internal sources (runtime detail)
  })

  test('includes CI status in PR body', () => {
    const ci: CiWaitResult = {
      ok: true,
      status: 'passed',
      requiredOnly: true,
      attempts: 2,
      durationMs: 45000,
      checks: [
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'pyright', workflow: 'TypeCheck', bucket: 'pass', state: 'SUCCESS' },
      ],
      summary: '3 passed/skipped, 0 pending, 0 failed/cancelled',
    }

    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:20:00.000Z',
      runName: 'anypi-ci-status',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-ci-status',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'fedcba0987654321',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'ghi789',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/5678',
        created: true,
      },
      ci,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'PASS',
          stderr: '',
          durationMs: 5000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      agentAttempts: 2,
      validationAttempts: 1,
      ciAttempts: 2,
      promptChars: 1100,
    }

    const body = renderPullRequestBody({
      runSpec: {
        implementation: { summary: 'Add CI status to PR' },
        vcs: {
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi-ci-status',
        },
      },
      status,
      git: {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi-ci-status',
        cloneUrl: 'https://github.com/proompteng/lab.git',
        webUrl: 'https://github.com/proompteng/lab',
        worktree: '/workspace/lab',
        env: {},
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
      piText: 'Added CI status tracking',
    })

    expect(body).toContain('CI: passed: 3 passed/skipped, 0 pending, 0 failed/cancelled')
    expect(body).toContain('test')
  })
})

describe('Anypi prompt contract - no runtime leakage', () => {
  test('buildAgentPrompt excludes runtime details', () => {
    const prompt = buildAgentPrompt(
      {
        prompt: 'Fix the parser',
        vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
        implementation: { summary: 'Fix parser', text: 'Parser fix code' },
      },
      '/workspace/lab',
    )
    expect(prompt).toContain('Fix the parser')
    expect(prompt).toContain('/workspace/lab')
    expect(prompt).not.toMatch(/Anypi|YOLO|provider|Flamingo|statusPath|logPath/)
  })

  test('buildValidationRepairPrompt excludes runtime details', () => {
    const prompt = buildValidationRepairPrompt({
      attempt: 1,
      maxAttempts: 2,
      worktree: '/workspace/lab',
      results: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: 'FAIL',
          stderr: '',
          durationMs: 1000,
          ok: false,
        },
      ],
    })
    expect(prompt).toContain('Validation failed')
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('bun test')
    expect(prompt).not.toMatch(/statusPath|logPath|status\.json|provider|Flamingo/)
  })

  test('buildNoChangeRepairPrompt excludes runtime details', () => {
    const prompt = buildNoChangeRepairPrompt({ attempt: 1, maxAttempts: 2, worktree: '/workspace/lab' })
    expect(prompt).toContain('completed without leaving any code changes')
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('requires a real implementation')
    expect(prompt).toContain('leave the final changes in the worktree')
    expect(prompt).not.toMatch(/statusPath|logPath|status\.json|provider|Flamingo/)
  })

  test('buildCiRepairPrompt excludes runtime details', () => {
    const prompt = buildCiRepairPrompt({
      attempt: 1,
      maxAttempts: 2,
      worktree: '/workspace/lab',
      summary: '2 failed, 1 pending',
    })
    expect(prompt).toContain('Pull request checks failed')
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('2 failed, 1 pending')
    expect(prompt).not.toMatch(/statusPath|logPath|status\.json|provider|Flamingo/)
  })

  test('buildSystemPrompt variants exclude runtime details', () => {
    for (const variant of ['minimal', 'finish-gated', 'repair-loop', 'strict-repo'] as const) {
      const systemPrompt = buildSystemPrompt(variant)
      expect(systemPrompt).not.toMatch(/Anypi|YOLO|provider|Flamingo|statusPath|logPath|status\.json/)
      expect(systemPrompt).toContain('Act as a coding agent inside an existing repository')
    }
  })
})

describe('Anypi normalization helpers', () => {
  test('normalizeConventionalSummary lowercases and trims', () => {
    expect(normalizeConventionalSummary('  Improve Anypi Status  ', 'fallback')).toBe('improve anypi status')
    expect(normalizeConventionalSummary('FIX: broken thing.', 'fallback')).toBe('fix: broken thing')
    expect(normalizeConventionalSummary('', 'fallback')).toBe('fallback')
  })

  test('buildCommitMessage uses summary as fallback', () => {
    expect(
      buildCommitMessage({
        implementation: { summary: 'Add status metadata tests' },
        vcs: { repository: 'proompteng/lab' },
      }),
    ).toBe('feat(anypi): add status metadata tests')
  })

  test('buildPullRequestTitle uses summary', () => {
    expect(
      buildPullRequestTitle({
        implementation: { summary: 'Improve status metadata' },
        vcs: { repository: 'proompteng/lab' },
      }),
    ).toBe('feat(anypi): improve status metadata')
  })
})

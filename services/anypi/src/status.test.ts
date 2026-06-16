import { describe, expect, test } from 'vitest'

import type { AnypiStatus, PullRequestResult } from './types'

describe('Anypi status metadata', () => {
  test('AnypiStatus type includes prompt variant and hash', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 123,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/123',
        webUrl: 'https://github.com/proompteng/lab/pull/123',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 2,
        durationMs: 15000,
        checks: [{ name: 'lint', workflow: 'CI', bucket: 'pass' }],
        summary: '1 passed, 0 failed',
      },
      ciAttempts: 2,
      validations: [],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['git diff --check'] },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
    }

    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toBe('abc123def4567890')
  })

  test('AnypiStatus type includes validation plan sources', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 123,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/123',
        webUrl: 'https://github.com/proompteng/lab/pull/123',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [],
        summary: '0 passed, 0 failed',
      },
      ciAttempts: 1,
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec', 'env'],
        commands: ['git diff --check', 'bun test'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
    }

    expect(status.validationPlan.sources).toEqual(['inferred', 'run-spec', 'env'])
    expect(status.validationPlan.sources).toContain('inferred')
    expect(status.validationPlan.sources).toContain('run-spec')
    expect(status.validationPlan.sources).toContain('env')
  })

  test('AnypiStatus type includes validation attempts count', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 123,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/123',
        webUrl: 'https://github.com/proompteng/lab/pull/123',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [],
        summary: '0 passed, 0 failed',
      },
      ciAttempts: 1,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 5000,
          ok: true,
        },
      ],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['bun test'] },
      agentAttempts: 1,
      validationAttempts: 3,
      promptChars: 1200,
    }

    expect(status.validationAttempts).toBe(3)
    expect(status.validations.length).toBe(1)
  })

  test('AnypiStatus type includes CI attempts count', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'strict-repo',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 123,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/123',
        webUrl: 'https://github.com/proompteng/lab/pull/123',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 3,
        durationMs: 45000,
        checks: [{ name: 'lint', workflow: 'CI', bucket: 'pass' }],
        summary: '1 passed, 0 failed',
      },
      ciAttempts: 3,
      validations: [],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['git diff --check'] },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
    }

    expect(status.ciAttempts).toBe(3)
    expect(status.ci?.attempts).toBe(3)
  })

  test('AnypiStatus type includes session artifact paths', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/validation-repair-1/session.json',
        '/workspace/.anypi/sessions/validation-repair-2/session.json',
      ],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 123,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/123',
        webUrl: 'https://github.com/proompteng/lab/pull/123',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [],
        summary: '0 passed, 0 failed',
      },
      ciAttempts: 1,
      validations: [],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['git diff --check'] },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
    }

    expect(status.sessionFile).toBe('/workspace/.anypi/sessions/initial/session.json')
    expect(status.sessionFiles).toHaveLength(3)
    expect(status.sessionFiles).toContain('/workspace/.anypi/sessions/initial/session.json')
    expect(status.sessionFiles).toContain('/workspace/.anypi/sessions/validation-repair-1/session.json')
    expect(status.sessionFiles).toContain('/workspace/.anypi/sessions/validation-repair-2/session.json')
  })

  test('AnypiStatus type includes PR metadata with number and webUrl', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 123,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/123',
        webUrl: 'https://github.com/proompteng/lab/pull/123',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [],
        summary: '0 passed, 0 failed',
      },
      ciAttempts: 1,
      validations: [],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['git diff --check'] },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
    }

    expect(status.pullRequest).toMatchObject({
      enabled: true,
      number: 123,
      webUrl: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    })
    expect(status.pullRequest?.url).toBe('https://api.github.com/repos/proompteng/lab/pulls/123')
  })

  test('AnypiStatus type includes failed PR metadata when pull requests are disabled', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: { enabled: false, number: 0 },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [],
        summary: '0 passed, 0 failed',
      },
      ciAttempts: 1,
      validations: [],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['git diff --check'] },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
    }

    expect(status.pullRequest?.enabled).toBe(false)
    expect(status.pullRequest?.number).toBe(0)
  })

  test('AnypiStatus type includes failed PR metadata when PR creation fails', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'failed',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:01:00.000Z',
      runName: 'anypi-eval-runner',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: { enabled: true, number: 0, created: false },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [],
        summary: '0 passed, 0 failed',
      },
      ciAttempts: 1,
      validations: [],
      validationPlan: { policy: 'append', sources: ['inferred'], commands: ['git diff --check'] },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1200,
      error: 'Pull request creation failed',
    }

    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.number).toBe(0)
    expect(status.error).toBe('Pull request creation failed')
  })

  test('PullRequestResult includes number as required field', () => {
    const pr: PullRequestResult = {
      enabled: true,
      number: 456,
      url: 'https://api.github.com/repos/test/repo/pulls/456',
      webUrl: 'https://github.com/test/repo/pull/456',
      created: true,
    }

    expect(pr.number).toBe(456)
    expect(pr.webUrl).toBe('https://github.com/test/repo/pull/456')
    expect(pr.url).toBe('https://api.github.com/repos/test/repo/pulls/456')
  })

  test('AnypiStatus structure is complete with all audit fields', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:01:30.000Z',
      runName: 'anypi-eval-runner-audit-test',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/anypi-eval/audit',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'abc123def4567890',
      tools: ['bash', 'edit', 'read'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/no-change-repair-1/session.json',
      ],
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      pullRequest: {
        enabled: true,
        number: 789,
        url: 'https://api.github.com/repos/proompteng/lab/pulls/789',
        webUrl: 'https://github.com/proompteng/lab/pull/789',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 2,
        durationMs: 25000,
        checks: [
          { name: 'lint', workflow: 'CI', bucket: 'pass' },
          { name: 'test', workflow: 'CI', bucket: 'pass' },
        ],
        summary: '2 passed, 0 failed',
      },
      ciAttempts: 2,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun run --filter @proompteng/anypi test'],
          exitCode: 0,
          stdout: 'PASS  src/test.js\nTest Suites: 1 passed, 1 total',
          stderr: '',
          durationMs: 15000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec'],
        commands: ['git diff --check', 'bun run --filter @proompteng/anypi test'],
      },
      agentAttempts: 2,
      validationAttempts: 1,
      promptChars: 2400,
    }

    // Verify all audit fields are present and correct
    expect(status.provider).toBe('anypi')
    expect(status.status).toBe('succeeded')
    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toMatch(/^[a-f0-9]{16}$/)
    expect(status.validationPlan.sources).toEqual(['inferred', 'run-spec'])
    expect(status.validationAttempts).toBe(1)
    expect(status.ciAttempts).toBe(2)
    expect(status.sessionFiles).toHaveLength(2)
    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.number).toBe(789)
    expect(status.pullRequest?.webUrl).toBe('https://github.com/proompteng/lab/pull/789')
    expect(status.pullRequest?.created).toBe(true)
    expect(status.ci?.status).toBe('passed')
    expect(status.ci?.attempts).toBe(2)
  })
})

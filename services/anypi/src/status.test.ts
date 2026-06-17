import { describe, expect, test } from 'vitest'

import {
  buildAgentPrompt,
  buildNoChangeRepairPrompt,
  buildSystemPrompt,
  buildValidationRepairPrompt,
  resolveValidationPlan,
} from './prompt'
import type { AnypiStatus, ValidationPlan, CiCheck, CiWaitResult, ValidationResult, PullRequestResult } from './types'

describe('Anypi status metadata', () => {
  describe('prompt variant and hash', () => {
    test('includes promptVariant in status', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: 'a1b2c3d4e5f67890',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 0,
        validationAttempts: 0,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.promptVariant).toBe('finish-gated')
      expect(status.promptHash).toMatch(/^[a-f0-9]{16}$/)
    })

    test('includes correct prompt hash for each variant', () => {
      const variants: Array<'minimal' | 'finish-gated' | 'repair-loop' | 'strict-repo'> = [
        'minimal',
        'finish-gated',
        'repair-loop',
        'strict-repo',
      ]
      for (const variant of variants) {
        const status: AnypiStatus = {
          provider: 'anypi',
          status: 'running',
          startedAt: '2026-06-16T00:00:00.000Z',
          model: 'qwen3-coder-flamingo',
          providerModel: 'flamingo/qwen3-coder-flamingo',
          promptVariant: variant,
          promptHash: 'd4c8e2a1b6f59437',
          tools: [],
          validations: [],
          validationPlan: {
            policy: 'append',
            sources: ['inferred'],
            commands: ['git diff --check'],
          },
          agentAttempts: 0,
          validationAttempts: 0,
          ciAttempts: 0,
          promptChars: 1000,
        }
        expect(status.promptVariant).toBe(variant)
        expect(status.promptHash).toHaveLength(16)
      }
    })
  })

  describe('validation plan sources', () => {
    test('includes validationPlan.sources in status', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'repair-loop',
        promptHash: '1234567890abcdef',
        tools: [],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred', 'run-spec', 'env'],
          commands: ['bun test', 'bun lint'],
        },
        agentAttempts: 0,
        validationAttempts: 0,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.validationPlan.sources).toHaveLength(3)
      expect(status.validationPlan.sources).toContain('inferred')
      expect(status.validationPlan.sources).toContain('run-spec')
      expect(status.validationPlan.sources).toContain('env')
    })

    test('validationPlan.sources reflects the policy and source precedence', () => {
      const runSpec = {
        implementation: { text: 'Improve services/anypi prompt handling.' },
        parameters: {
          validationCommands: 'bun run --filter @proompteng/anypi test',
        },
      }

      // append policy: inferred + run-spec + env
      const appendPlan = resolveValidationPlan(runSpec, ['bun run --filter @proompteng/anypi lint'], 'append')
      expect(appendPlan.sources).toEqual(['inferred', 'run-spec', 'env'])

      // override policy: env takes precedence
      const overridePlan = resolveValidationPlan(runSpec, ['bun run --filter @proompteng/anypi lint'], 'override')
      expect(overridePlan.sources).toEqual(['env'])
      expect(overridePlan.commands).toEqual(['bun run --filter @proompteng/anypi lint'])
    })

    test('status.validationPlan is correctly populated in baseStatus', () => {
      const validationPlan: ValidationPlan = {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun run --filter @proompteng/anypi test'],
      }
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: [],
        validations: [],
        validationPlan,
        agentAttempts: 0,
        validationAttempts: 0,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.validationPlan.policy).toBe('append')
      expect(status.validationPlan.sources).toStrictEqual(['inferred'])
      expect(status.validationPlan.commands).toStrictEqual(['bun run --filter @proompteng/anypi test'])
    })
  })

  describe('validation attempts', () => {
    test('includes validationAttempts counter in status', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'repair-loop',
        promptHash: 'fedcba9876543210',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 3,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.validationAttempts).toBe(3)
    })

    test('validations array tracks each attempt results', () => {
      const validations: ValidationResult[] = [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: '',
          stderr: 'FAIL: test.js',
          durationMs: 1200,
          ok: false,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'PASS: 42 tests',
          stderr: '',
          durationMs: 800,
          ok: true,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun lint'],
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 400,
          ok: true,
        },
      ]
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: '0123456789abcdef',
        tools: ['bash', 'edit'],
        validations,
        validationPlan: {
          policy: 'append',
          sources: ['inferred', 'run-spec'],
          commands: ['bun test', 'bun lint'],
        },
        agentAttempts: 2,
        validationAttempts: 3,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.validations).toHaveLength(3)
      expect(status.validations[0].exitCode).toBe(1)
      expect(status.validations[0].ok).toBe(false)
      expect(status.validations[1].exitCode).toBe(0)
      expect(status.validations[1].ok).toBe(true)
      expect(status.validations[2].exitCode).toBe(0)
      expect(status.validations[2].ok).toBe(true)
    })

    test('validations array persists command details for audit', () => {
      const validations: ValidationResult[] = [
        {
          command: 'cd',
          args: ['services/torghut', '&&', 'uv', 'run', '--frozen', 'ruff', 'format', '--check', 'app'],
          exitCode: 2,
          stdout: '',
          stderr: 'error: cannot format',
          durationMs: 5000,
          ok: false,
        },
      ]
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:10:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'strict-repo',
        promptHash: 'abcdef0123456789',
        tools: ['bash', 'edit'],
        validations,
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['cd services/torghut && uv run --frozen ruff format --check app'],
        },
        agentAttempts: 3,
        validationAttempts: 1,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.validations[0].command).toBe('cd')
      expect(status.validations[0].args).toContain('services/torghut')
      expect(status.validations[0].stderr).toContain('error: cannot format')
      expect(status.validations[0].durationMs).toBe(5000)
    })
  })

  describe('CI attempts', () => {
    test('includes ciAttempts counter in status', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:15:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: '9876543210fedcba',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 2,
        validationAttempts: 1,
        ciAttempts: 3,
        promptChars: 1000,
      }
      expect(status.ciAttempts).toBe(3)
    })

    test('includes complete ciWaitResult in status', () => {
      const ci: CiWaitResult = {
        ok: false,
        status: 'failed',
        requiredOnly: true,
        attempts: 5,
        durationMs: 180000,
        checks: [
          { name: 'lint', workflow: 'CI', bucket: 'pass' },
          { name: 'pyright', workflow: 'Typecheck', bucket: 'fail' },
          { name: 'test', workflow: 'CI', bucket: 'pass' },
        ],
        summary: '2 passed/skipped, 0 pending, 1 failed/cancelled',
      }
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:15:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'repair-loop',
        promptHash: '1234abcd5678ef90',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 4,
        validationAttempts: 1,
        ciAttempts: 5,
        promptChars: 1000,
        ci,
        error: 'ci checks failed: pyright failed',
      }
      expect(status.ci?.ok).toBe(false)
      expect(status.ci?.status).toBe('failed')
      expect(status.ci?.requiredOnly).toBe(true)
      expect(status.ci?.attempts).toBe(5)
      expect(status.ci?.durationMs).toBe(180000)
      expect(status.ci?.checks).toHaveLength(3)
      expect(status.ci?.summary).toContain('2 passed')
      expect(status.ci?.summary).toContain('1 failed')
    })

    test('ci checks include workflow, state, bucket, and link for audit', () => {
      const checks: CiCheck[] = [
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'pyright', workflow: 'Typecheck', bucket: 'fail', state: 'FAILURE' },
        { name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: 'https://ci.example.com/run/123' },
        { name: 'deploy', workflow: 'CD', bucket: 'pending', state: 'PENDING' },
      ]
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:15:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: 'abcdef1234567890',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 3,
        validationAttempts: 1,
        ciAttempts: 1,
        promptChars: 1000,
        ci: {
          ok: false,
          status: 'failed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 120000,
          checks,
          summary: '2 passed/skipped, 1 pending, 1 failed/cancelled',
        },
      }
      expect(status.ci?.checks).toHaveLength(4)
      expect(status.ci?.checks[0]).toMatchObject({ name: 'lint', workflow: 'CI', bucket: 'pass' })
      expect(status.ci?.checks[1]).toMatchObject({ name: 'pyright', workflow: 'Typecheck', bucket: 'fail' })
      expect(status.ci?.checks[2]).toMatchObject({
        name: 'test',
        workflow: 'CI',
        bucket: 'pass',
        link: 'https://ci.example.com/run/123',
      })
      expect(status.ci?.checks[3]).toMatchObject({ name: 'deploy', workflow: 'CD', bucket: 'pending' })
    })

    test('ci attempts reflect retry behavior for repairs', () => {
      // Initial PR creation with CI failure
      const status1: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'repair-loop',
        promptHash: '1234567890abcdef',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 1,
        promptChars: 1000,
        ci: {
          ok: false,
          status: 'failed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 60000,
          checks: [{ name: 'lint', workflow: 'CI', bucket: 'pass' }],
          summary: '1 passed/skipped, 0 pending, 0 failed/cancelled',
        },
      }
      expect(status1.ciAttempts).toBe(1)

      // After CI repair attempt
      const status2: AnypiStatus = {
        ...status1,
        agentAttempts: 2,
        ciAttempts: 2,
        ci: {
          ok: false,
          status: 'timed-out',
          requiredOnly: true,
          attempts: 2,
          durationMs: 120000,
          checks: [{ name: 'deploy', workflow: 'CD', bucket: 'pending' }],
          summary: '0 passed/skipped, 1 pending, 0 failed/cancelled',
        },
      }
      expect(status2.ciAttempts).toBe(2)
    })
  })

  describe('session artifact paths', () => {
    test('includes sessionFile and sessionFiles in status', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef0123456789',
        tools: ['bash', 'edit'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        sessionFiles: [
          '/workspace/.anypi/sessions/initial/session.json',
          '/workspace/.anypi/sessions/validation-repair-1/session.json',
        ],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 2,
        validationAttempts: 1,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.sessionFile).toBeDefined()
      expect(status.sessionFile).toBe('/workspace/.anypi/sessions/initial/session.json')
      expect(status.sessionFiles).toHaveLength(2)
      expect(status.sessionFiles?.[0]).toContain('/sessions/initial/')
      expect(status.sessionFiles?.[1]).toContain('/sessions/validation-repair-1/')
    })

    test('sessionFiles array tracks all agent attempts', () => {
      const sessionFiles = [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/no-change-repair-1/session.json',
        '/workspace/.anypi/sessions/validation-repair-1/session.json',
        '/workspace/.anypi/sessions/validation-repair-2/session.json',
      ]
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: '1234567890abcdef',
        tools: ['bash', 'edit', 'read'],
        sessionFile: sessionFiles[3],
        sessionFiles,
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred', 'run-spec'],
          commands: ['bun test'],
        },
        agentAttempts: 4,
        validationAttempts: 2,
        ciAttempts: 0,
        promptChars: 1000,
      }
      expect(status.sessionFiles).toHaveLength(4)
      expect(status.sessionFiles?.[0]).toContain('/sessions/initial/')
      expect(status.sessionFiles?.[1]).toContain('/sessions/no-change-repair-1/')
      expect(status.sessionFiles?.[2]).toContain('/sessions/validation-repair-1/')
      expect(status.sessionFiles?.[3]).toContain('/sessions/validation-repair-2/')
    })

    test('session paths are persisted across repair attempts', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:10:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'repair-loop',
        promptHash: 'fedcba9876543210',
        tools: ['bash', 'edit'],
        sessionFile: '/workspace/.anypi/sessions/ci-repair-1/session.json',
        sessionFiles: [
          '/workspace/.anypi/sessions/initial/session.json',
          '/workspace/.anypi/sessions/ci-repair-1/session.json',
        ],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 3,
        validationAttempts: 1,
        ciAttempts: 2,
        promptChars: 1000,
        error: 'ci checks timed out',
      }
      expect(status.sessionFiles).toHaveLength(2)
      expect(status.sessionFiles?.[0]).toContain('initial')
      expect(status.sessionFiles?.[1]).toContain('ci-repair-1')
    })
  })

  describe('PR metadata', () => {
    test('includes pullRequest result in status', () => {
      const pullRequest: PullRequestResult = {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/1234',
        created: true,
      }
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 0,
        promptChars: 1000,
        pullRequest,
        commit: 'abc123def456',
      }
      expect(status.pullRequest?.enabled).toBe(true)
      expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/1234')
      expect(status.pullRequest?.created).toBe(true)
    })

    test('includes commit hash in status', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: '1234567890abcdef',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 0,
        promptChars: 1000,
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/5678',
          created: false,
        },
        commit: 'fedcba9876543210',
      }
      expect(status.commit).toBe('fedcba9876543210')
      expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/5678')
      expect(status.pullRequest?.created).toBe(false)
    })

    test('pullRequest includes created flag for audit trail', () => {
      // First PR creation
      const status1: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'repair-loop',
        promptHash: 'abcdef0123456789',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 0,
        promptChars: 1000,
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/9012',
          created: true,
        },
        commit: 'aaa111bbb222',
      }
      expect(status1.pullRequest?.created).toBe(true)

      // Updated PR (no new commit, just update body)
      const status2: AnypiStatus = {
        ...status1,
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/9012',
          created: false,
        },
        commit: 'aaa111bbb222',
      }
      expect(status2.pullRequest?.created).toBe(false)
    })

    test('pullRequest includes enabled flag for PR-disabled runs', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'fedcba9876543210',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 0,
        promptChars: 1000,
        pullRequest: {
          enabled: false,
        },
        commit: '1234567890abcdef',
      }
      expect(status.pullRequest?.enabled).toBe(false)
      expect(status.pullRequest?.url).toBeUndefined()
    })
  })

  describe('comprehensive status audit', () => {
    test('status includes all fields for full audit trail', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:15:00.000Z',
        runName: 'anypi-eval-runner-repair-20260616',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi-eval/runner',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: '0123456789abcdef',
        tools: ['bash', 'edit', 'read', 'write'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
        commit: 'abc123def456',
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/1234',
          created: true,
        },
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 3,
          durationMs: 120000,
          checks: [
            { name: 'lint', workflow: 'CI', bucket: 'pass' },
            { name: 'test', workflow: 'CI', bucket: 'pass', link: 'https://ci.example.com/123' },
          ],
          summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
        },
        ciAttempts: 3,
        validations: [
          {
            command: 'bash',
            args: ['-lc', 'bun run --filter @proompteng/anypi test'],
            exitCode: 0,
            stdout: 'PASS: 42 tests',
            stderr: '',
            durationMs: 800,
            ok: true,
          },
        ],
        validationPlan: {
          policy: 'append',
          sources: ['inferred', 'run-spec'],
          commands: ['bun run --filter @proompteng/anypi test'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        promptChars: 1200,
      }

      // Verify all required fields are present
      expect(status.provider).toBe('anypi')
      expect(status.status).toBe('succeeded')
      expect(status.runName).toBe('anypi-eval-runner-repair-20260616')
      expect(status.namespace).toBe('agents')
      expect(status.repository).toBe('proompteng/lab')
      expect(status.baseBranch).toBe('main')
      expect(status.headBranch).toBe('codex/anypi-eval/runner')
      expect(status.worktree).toBe('/workspace/lab')
      expect(status.model).toBe('qwen3-coder-flamingo')
      expect(status.providerModel).toBe('flamingo/qwen3-coder-flamingo')
      expect(status.promptVariant).toBe('finish-gated')
      expect(status.promptHash).toBe('0123456789abcdef')
      expect(status.tools).toStrictEqual(['bash', 'edit', 'read', 'write'])
      expect(status.sessionFile).toBeDefined()
      expect(status.sessionFiles).toStrictEqual(['/workspace/.anypi/sessions/initial/session.json'])
      expect(status.commit).toBe('abc123def456')
      expect(status.pullRequest?.enabled).toBe(true)
      expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/1234')
      expect(status.pullRequest?.created).toBe(true)
      expect(status.ci?.ok).toBe(true)
      expect(status.ci?.status).toBe('passed')
      expect(status.ci?.requiredOnly).toBe(true)
      expect(status.ci?.attempts).toBe(3)
      expect(status.ci?.durationMs).toBe(120000)
      expect(status.ci?.checks).toHaveLength(2)
      expect(status.ci?.summary).toBe('2 passed/skipped, 0 pending, 0 failed/cancelled')
      expect(status.ciAttempts).toBe(3)
      expect(status.validations).toHaveLength(1)
      expect(status.validations[0].ok).toBe(true)
      expect(status.validationPlan.policy).toBe('append')
      expect(status.validationPlan.sources).toStrictEqual(['inferred', 'run-spec'])
      expect(status.validationPlan.commands).toStrictEqual(['bun run --filter @proompteng/anypi test'])
      expect(status.agentAttempts).toBe(1)
      expect(status.validationAttempts).toBe(1)
      expect(status.promptChars).toBe(1200)
      expect(status.error).toBeUndefined()
    })

    test('status includes error field for failed runs', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:10:00.000Z',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'strict-repo',
        promptHash: 'fedcba9876543210',
        tools: ['bash', 'edit'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 5,
        validationAttempts: 2,
        ciAttempts: 1,
        promptChars: 1000,
        error: 'Anypi completed without leaving code changes in the worktree',
      }
      expect(status.status).toBe('failed')
      expect(status.error).toBeDefined()
      expect(status.error).toBe('Anypi completed without leaving code changes in the worktree')
    })
  })
})

describe('Anypi status metadata - runtime details exclusion', () => {
  test('buildAgentPrompt does not include runtime details like Anypi, YOLO, Kubernetes, Pi SDK', () => {
    const prompt = buildAgentPrompt(
      {
        prompt: 'Refactor code and add tests.',
        vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
      },
      '/workspace/lab',
    )
    expect(prompt).not.toMatch(/Anypi/)
    expect(prompt).not.toMatch(/YOLO/)
    expect(prompt).not.toMatch(/Kubernetes/)
    expect(prompt).not.toMatch(/Pi SDK/)
    expect(prompt).not.toMatch(/provider|Flamingo|qwen3-coder/)
    expect(prompt).not.toMatch(/shell, read, edit, write/)
  })

  test('buildSystemPrompt variants do not include runtime details', () => {
    for (const variant of ['minimal', 'finish-gated', 'repair-loop', 'strict-repo'] as const) {
      const sysPrompt = buildSystemPrompt(variant)
      expect(sysPrompt).not.toMatch(/Anypi/)
      expect(sysPrompt).not.toMatch(/YOLO/)
      expect(sysPrompt).not.toMatch(/Kubernetes/)
      expect(sysPrompt).not.toMatch(/Pi SDK/)
      expect(sysPrompt).not.toMatch(/provider|Flamingo/)
      expect(sysPrompt).not.toMatch(/vLLM|OpenAI/)
    }
  })

  test('buildValidationRepairPrompt does not include runtime details', () => {
    const prompt = buildValidationRepairPrompt({
      attempt: 1,
      maxAttempts: 2,
      worktree: '/workspace/lab',
      results: [{ command: 'bash', args: [], exitCode: 1, stdout: '', stderr: 'error', durationMs: 100, ok: false }],
    })
    expect(prompt).not.toMatch(/Anypi/)
    expect(prompt).not.toMatch(/YOLO/)
    expect(prompt).not.toMatch(/Kubernetes/)
    expect(prompt).not.toMatch(/Pi SDK/)
    expect(prompt).not.toMatch(/provider|Flamingo/)
  })

  test('buildNoChangeRepairPrompt does not include runtime details', () => {
    const prompt = buildNoChangeRepairPrompt({ attempt: 1, maxAttempts: 2, worktree: '/workspace/lab' })
    expect(prompt).not.toMatch(/Anypi/)
    expect(prompt).not.toMatch(/YOLO/)
    expect(prompt).not.toMatch(/Kubernetes/)
    expect(prompt).not.toMatch(/Pi SDK/)
    expect(prompt).not.toMatch(/provider|Flamingo/)
  })
})

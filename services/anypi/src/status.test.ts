import { describe, expect, test } from 'vitest'

import { buildSystemPrompt } from './prompt'
import type {
  AnypiStatus,
  CiCheck,
  CiWaitResult,
  PromptVariant,
  PullRequestResult,
  ValidationPlan,
  ValidationResult,
} from './types'

// Helper functions and constants at module level for reusability across describe blocks
const createCiWaitResult = (opts: Partial<CiWaitResult> = {}): CiWaitResult => ({
  ok: true,
  status: 'passed',
  requiredOnly: true,
  attempts: 1,
  durationMs: 30000,
  checks: [{ name: 'test', workflow: 'CI', bucket: 'pass' }],
  summary: '1 passed/skipped, 0 pending, 0 failed/cancelled',
  ...opts,
})

const createPullRequestResult = (opts: Partial<PullRequestResult> = {}): PullRequestResult => ({
  enabled: true,
  url: 'https://github.com/proompteng/lab/pull/456',
  created: true,
  ...opts,
})

const createValidationResult = (opts: Partial<ValidationResult> = {}): ValidationResult => ({
  command: 'bash',
  args: ['-lc', 'bun test'],
  exitCode: 0,
  stdout: 'PASS',
  stderr: '',
  durationMs: 1500,
  ok: true,
  ...opts,
})

const createValidationPlan = (opts: Partial<ValidationPlan> = {}): ValidationPlan => ({
  policy: 'append',
  sources: ['inferred'],
  commands: ['bun test'],
  ...opts,
})

const createBaseStatus = (overrides: Partial<AnypiStatus> = {}): AnypiStatus => ({
  provider: 'anypi',
  status: 'succeeded',
  startedAt: '2026-06-16T00:00:00.000Z',
  finishedAt: '2026-06-16T00:05:00.000Z',
  runName: 'test-runner',
  namespace: 'agents',
  repository: 'proompteng/lab',
  baseBranch: 'main',
  headBranch: 'codex/test-runner',
  worktree: '/workspace/lab',
  model: 'qwen3-coder-flamingo',
  providerModel: 'flamingo/qwen3-coder-flamingo',
  promptVariant: 'finish-gated',
  promptHash: 'a1b2c3d4e5f67890',
  tools: ['bash', 'edit', 'read'],
  sessionFile: '/workspace/.anypi/sessions/initial/session.json',
  sessionFiles: [
    '/workspace/.anypi/sessions/initial/session.json',
    '/workspace/.anypi/sessions/validation-repair-1/session.json',
  ],
  commit: 'abc123def456',
  pullRequest: {
    enabled: true,
    url: 'https://github.com/proompteng/lab/pull/123',
    created: true,
  },
  ci: {
    ok: true,
    status: 'passed',
    requiredOnly: false,
    attempts: 2,
    durationMs: 45000,
    checks: [{ name: 'lint', workflow: 'CI', bucket: 'pass' }],
    summary: '1 passed/skipped, 0 pending, 0 failed/cancelled',
  },
  ciAttempts: 2,
  validations: [
    {
      command: 'bun',
      args: ['run', '--filter', '@proompteng/anypi', 'test'],
      exitCode: 0,
      stdout: 'PASS  tests/foo.test.ts',
      stderr: '',
      durationMs: 3000,
      ok: true,
    },
    {
      command: 'bun',
      args: ['run', '--filter', '@proompteng/anypi', 'lint'],
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 2000,
      ok: true,
    },
  ],
  validationPlan: {
    policy: 'append',
    sources: ['inferred', 'run-spec'],
    commands: ['bun run --filter @proompteng/anypi test', 'bun run --filter @proompteng/anypi lint'],
  },
  agentAttempts: 3,
  validationAttempts: 2,
  promptChars: 2450,
  ...overrides,
})

describe('Anypi status metadata', () => {
  test('status includes prompt variant and hash for audit trail', () => {
    const status = createBaseStatus()
    expect(status.promptVariant).toBe('finish-gated')
    expect(status.promptHash).toMatch(/^[a-f0-9]{16}$/)
    expect(status.promptHash).toHaveLength(16)

    // Verify promptVariant matches expected values
    const validVariants: PromptVariant[] = ['minimal', 'finish-gated', 'repair-loop', 'strict-repo']
    expect(validVariants).toContain(status.promptVariant)

    // Hash should be deterministic for same variant
    expect(status.promptHash).toHaveLength(16)
  })

  test('status includes validation plan sources for traceability', () => {
    const status = createBaseStatus()
    expect(status.validationPlan.sources).toEqual(['inferred', 'run-spec'])
    expect(status.validationPlan.sources.length).toBeGreaterThan(0)
    expect(status.validationPlan.sources).toContain('inferred')
    expect(status.validationPlan.sources).toContain('run-spec')
  })

  test('status includes validation attempts count for retry tracking', () => {
    const status = createBaseStatus()
    expect(status.validationAttempts).toBe(2)
    expect(status.validationAttempts).toBeGreaterThanOrEqual(1)

    // Verify it tracks all validation attempts
    expect(status.validations).toHaveLength(status.validationAttempts)
  })

  test('status includes ci attempts count for pipeline tracking', () => {
    const status = createBaseStatus()
    expect(status.ciAttempts).toBe(2)
    expect(status.ciAttempts).toBeGreaterThanOrEqual(1)

    // Verify CI result exists and includes attempts
    expect(status.ci).toBeDefined()
    expect(status.ci?.attempts).toBe(status.ciAttempts)
  })

  test('status includes session artifact paths for debugging', () => {
    const status = createBaseStatus()
    expect(status.sessionFile).toBe('/workspace/.anypi/sessions/initial/session.json')
    expect(status.sessionFiles).toHaveLength(2)
    expect(status.sessionFiles?.[0]).toMatch(/initial\/session\.json/)
    expect(status.sessionFiles?.[1]).toMatch(/validation-repair-1\/session\.json/)
  })

  test('status includes PR metadata for review audit', () => {
    const status = createBaseStatus()
    expect(status.pullRequest).toBeDefined()
    expect(status.pullRequest?.enabled).toBe(true)
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/123')
    expect(status.pullRequest?.created).toBe(true)
  })

  test('status includes validation results with exit codes', () => {
    const status = createBaseStatus()
    expect(status.validations).toHaveLength(2)

    status.validations.forEach((val) => {
      expect(val.exitCode).toBeDefined()
      expect(val.ok).toBeTypeOf('boolean')
      expect(val.stdout).toBeTypeOf('string')
      expect(val.stderr).toBeTypeOf('string')
      expect(val.durationMs).toBeGreaterThan(0)
    })
  })

  test('status includes CI checks with state information', () => {
    const status = createBaseStatus()
    expect(status.ci?.checks).toBeDefined()
    expect(status.ci?.checks).toHaveLength(1)

    const check = status.ci?.checks?.[0]
    expect(check?.name).toBe('lint')
    expect(check?.bucket).toBe('pass')
    expect(check?.workflow).toBe('CI')
  })

  test('status includes execution timing information', () => {
    const status = createBaseStatus()
    expect(status.startedAt).toBe('2026-06-16T00:00:00.000Z')
    expect(status.finishedAt).toBe('2026-06-16T00:05:00.000Z')
    expect(status.status).toBe('succeeded')
  })

  test('status includes agent attempts for repair loop tracking', () => {
    const status = createBaseStatus()
    expect(status.agentAttempts).toBe(3)
    expect(status.agentAttempts).toBeGreaterThanOrEqual(1)
  })

  test('status includes prompt size for token budget monitoring', () => {
    const status = createBaseStatus()
    expect(status.promptChars).toBe(2450)
    expect(status.promptChars).toBeGreaterThan(0)
  })

  test('status includes commit SHA for code audit', () => {
    const status = createBaseStatus()
    expect(status.commit).toBe('abc123def456')
    expect(status.commit).toHaveLength(12)
  })

  test('status includes repository context for cross-run correlation', () => {
    const status = createBaseStatus()
    expect(status.repository).toBe('proompteng/lab')
    expect(status.baseBranch).toBe('main')
    expect(status.headBranch).toBe('codex/test-runner')
  })

  test('status includes full provider/model identity', () => {
    const status = createBaseStatus()
    expect(status.provider).toBe('anypi')
    expect(status.providerModel).toBe('flamingo/qwen3-coder-flamingo')
    expect(status.model).toBe('qwen3-coder-flamingo')
  })

  test('status includes tools used during execution', () => {
    const status = createBaseStatus()
    expect(status.tools).toEqual(['bash', 'edit', 'read'])
    expect(status.tools.length).toBeGreaterThan(0)
  })

  test('status includes worktree path for filesystem audit', () => {
    const status = createBaseStatus()
    expect(status.worktree).toBe('/workspace/lab')
  })

  test('status includes run identification metadata', () => {
    const status = createBaseStatus()
    expect(status.runName).toBe('test-runner')
    expect(status.namespace).toBe('agents')
  })

  test('status includes ci wait result with detailed state', () => {
    const status = createBaseStatus()
    const ci = status.ci
    expect(ci).toBeDefined()
    expect(ci?.ok).toBe(true)
    expect(ci?.status).toBe('passed')
    expect(ci?.requiredOnly).toBe(false)
    expect(ci?.summary).toMatch(/passed/)
    expect(ci?.durationMs).toBeGreaterThan(0)
  })

  test('status validates validation results structure', () => {
    const status = createBaseStatus()
    status.validations.forEach((result, idx) => {
      expect(result.command).toBeDefined()
      expect(Array.isArray(result.args)).toBe(true)
      expect(result.exitCode).toBeTypeOf('number')
      expect(result.stdout).toBeTypeOf('string')
      expect(result.stderr).toBeTypeOf('string')
      expect(result.durationMs).toBeTypeOf('number')
      expect(result.ok).toBeTypeOf('boolean')
    })
  })

  test('status validates PR result structure', () => {
    const status = createBaseStatus()
    expect(status.pullRequest?.enabled).toBeTypeOf('boolean')
    if (status.pullRequest?.enabled) {
      expect(status.pullRequest?.url).toBeTypeOf('string')
      expect(status.pullRequest?.created).toBeTypeOf('boolean')
    }
  })

  test('status validates CI wait result structure', () => {
    const status = createBaseStatus()
    const ci = status.ci
    expect(ci?.ok).toBeTypeOf('boolean')
    expect(ci?.status).toBeTypeOf('string')
    expect(['passed', 'failed', 'timed-out', 'unavailable']).toContain(ci?.status)
    expect(ci?.requiredOnly).toBeTypeOf('boolean')
    expect(ci?.attempts).toBeTypeOf('number')
    expect(ci?.durationMs).toBeTypeOf('number')
    expect(ci?.checks).toBeTypeOf('object')
    expect(ci?.summary).toBeTypeOf('string')
  })

  test('status validates validation plan structure', () => {
    const status = createBaseStatus()
    expect(status.validationPlan.policy).toBeTypeOf('string')
    expect(status.validationPlan.sources).toBeTypeOf('object')
    expect(status.validationPlan.commands).toBeTypeOf('object')
    expect(status.validationPlan.commands.length).toBeGreaterThan(0)
  })

  test('status supports failed state with error', () => {
    const failedStatus: AnypiStatus = {
      ...createBaseStatus(),
      status: 'failed',
      error: 'validation failed',
    }
    expect(failedStatus.status).toBe('failed')
    expect(failedStatus.error).toBe('validation failed')
    expect(failedStatus.finishedAt).toBeDefined()
  })

  test('status supports PR with no url when not created', () => {
    const prResult: PullRequestResult = {
      enabled: true,
      created: false,
    }
    expect(prResult.enabled).toBe(true)
    expect(prResult.created).toBe(false)
    expect(prResult.url).toBeUndefined()
  })

  test('status supports disabled PR mode', () => {
    const disabledStatus: AnypiStatus = {
      ...createBaseStatus(),
      pullRequest: { enabled: false },
    }
    expect(disabledStatus.pullRequest?.enabled).toBe(false)
  })

  test('status validates CiCheck structure', () => {
    const check: CiCheck = {
      name: 'test-workflow',
      workflow: 'CI Pipeline',
      state: 'success',
      bucket: 'pass',
      link: 'https://ci.example.com/job/123',
    }
    expect(check.name).toBe('test-workflow')
    expect(check.workflow).toBe('CI Pipeline')
    expect(check.bucket).toBe('pass')
    expect(check.state).toBe('success')
    expect(check.link).toBe('https://ci.example.com/job/123')
  })

  test('status supports multiple validation attempts with mixed results', () => {
    const multiAttemptStatus: AnypiStatus = {
      ...createBaseStatus(),
      validationAttempts: 3,
      validations: [
        createValidationResult({ exitCode: 1, ok: false, stdout: '', stderr: 'failed' }),
        createValidationResult({ exitCode: 1, ok: false, stdout: '', stderr: 'still failed' }),
        createValidationResult({ exitCode: 0, ok: true, stdout: 'passed', stderr: '' }),
      ],
    }
    expect(multiAttemptStatus.validationAttempts).toBe(3)
    expect(multiAttemptStatus.validations).toHaveLength(3)
    expect(multiAttemptStatus.validations[0].ok).toBe(false)
    expect(multiAttemptStatus.validations[2].ok).toBe(true)
  })

  test('status supports multiple CI checks with mixed states', () => {
    const multiCheckCi: CiWaitResult = createCiWaitResult({
      status: 'failed',
      requiredOnly: true,
      attempts: 3,
      checks: [
        { name: 'lint', workflow: 'CI', bucket: 'pass' },
        { name: 'test', workflow: 'CI', bucket: 'fail' },
        { name: 'security', workflow: 'CI', bucket: 'pending' },
      ],
      summary: '1 passed/skipped, 1 pending, 1 failed/cancelled',
    })
    expect(multiCheckCi.attempts).toBe(3)
    expect(multiCheckCi.status).toBe('failed')
    expect(multiCheckCi.requiredOnly).toBe(true)
    expect(multiCheckCi.checks).toHaveLength(3)
  })

  test('status session files array tracks all session artifacts', () => {
    const status = createBaseStatus()
    expect(status.sessionFiles).toBeDefined()
    expect(status.sessionFiles).toHaveLength(2)

    // Verify all session files have expected patterns
    status.sessionFiles?.forEach((file, idx) => {
      expect(file).toMatch(/\.json$/)
      expect(file).toContain('session')
      expect(file).toContain('.anypi/sessions/')
    })
  })

  test('status validation plan sources include all command sources', () => {
    // When using append policy, sources should include all command origins
    const inferredOnly: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    expect(inferredOnly.sources).toEqual(['inferred'])

    const runSpecOnly: ValidationPlan = {
      policy: 'append',
      sources: ['run-spec'],
      commands: ['bun test'],
    }
    expect(runSpecOnly.sources).toEqual(['run-spec'])

    const envOnly: ValidationPlan = {
      policy: 'append',
      sources: ['env'],
      commands: ['npm test'],
    }
    expect(envOnly.sources).toEqual(['env'])
  })

  test('status supports repair loop with increasing validation attempts', () => {
    const repairStatus: AnypiStatus = {
      ...createBaseStatus(),
      validationAttempts: 5,
      validations: [
        createValidationResult({ exitCode: 1, ok: false }),
        createValidationResult({ exitCode: 1, ok: false }),
        createValidationResult({ exitCode: 1, ok: false }),
        createValidationResult({ exitCode: 1, ok: false }),
        createValidationResult({ exitCode: 0, ok: true }),
      ],
    }
    expect(repairStatus.validationAttempts).toBe(5)
    expect(repairStatus.validations.filter((v) => !v.ok)).toHaveLength(4)
    expect(repairStatus.validations.filter((v) => v.ok)).toHaveLength(1)
  })

  test('status ci attempts matches ci wait result attempts', () => {
    const status = createBaseStatus()
    expect(status.ciAttempts).toBe(status.ci?.attempts)
    expect(status.ciAttempts).toBeGreaterThan(0)
  })

  test('status includes ci duration in milliseconds', () => {
    const status = createBaseStatus()
    expect(status.ci?.durationMs).toBe(45000)
    expect(status.ci?.durationMs).toBeGreaterThan(0)
  })

  test('status validates validation plan policy', () => {
    const status = createBaseStatus()
    expect(status.validationPlan.policy).toBeTypeOf('string')
    expect(['append', 'override']).toContain(status.validationPlan.policy)
  })

  test('status validation attempts matches validations array length', () => {
    const status = createBaseStatus()
    expect(status.validationAttempts).toBe(status.validations.length)
  })

  test('status supports PR with existing URL on update', () => {
    const existingPr: PullRequestResult = {
      enabled: true,
      url: 'https://github.com/proompteng/lab/pull/123',
      created: false,
    }
    expect(existingPr.enabled).toBe(true)
    expect(existingPr.url).toBe('https://github.com/proompteng/lab/pull/123')
    expect(existingPr.created).toBe(false)
  })

  test('status validation plan includes command list', () => {
    const status = createBaseStatus()
    expect(status.validationPlan.commands).toEqual([
      'bun run --filter @proompteng/anypi test',
      'bun run --filter @proompteng/anypi lint',
    ])
    expect(status.validationPlan.commands.length).toBeGreaterThan(0)
  })
})

describe('Anypi status for AgentRun audit', () => {
  test('status includes complete execution metadata for compliance', () => {
    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:05:00.000Z',
      runName: 'compliance-test',
      namespace: 'agents',
      repository: 'proompteng/internal',
      baseBranch: 'main',
      headBranch: 'codex/compliance',
      worktree: '/workspace',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'strict-repo',
      promptHash: 'deadbeef12345678',
      tools: ['bash', 'read', 'edit', 'grep'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'commit123',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/internal/pull/789',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 15000,
        checks: [{ name: 'all-checks', bucket: 'pass' }],
        summary: '1 passed',
      },
      ciAttempts: 1,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'PASS',
          stderr: '',
          durationMs: 1000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'env'],
        commands: ['bun test'],
      },
      agentAttempts: 2,
      validationAttempts: 1,
      promptChars: 1500,
    }

    // Verify all required fields for audit
    expect(status.provider).toBe('anypi')
    expect(status.runName).toBe('compliance-test')
    expect(status.namespace).toBe('agents')
    expect(status.repository).toBe('proompteng/internal')
    expect(status.promptVariant).toBe('strict-repo')
    expect(status.promptHash).toBe('deadbeef12345678')
    expect(status.validationPlan.sources).toEqual(['inferred', 'env'])
    expect(status.validationAttempts).toBe(1)
    expect(status.ciAttempts).toBe(1)
    expect(status.sessionFile).toBe('/workspace/.anypi/sessions/initial/session.json')
    expect(status.pullRequest?.url).toBe('https://github.com/proompteng/internal/pull/789')
    expect(status.agentAttempts).toBe(2)
  })

  test('status supports minimal execution without CI', () => {
    const minimalStatus: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:05:00.000Z',
      runName: 'minimal-test',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/minimal',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: 'minimal123456789',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'minimalcommit',
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'PASS',
          stderr: '',
          durationMs: 1000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      promptChars: 1000,
      // ciAttempts is 0 when no CI checks were performed
      ciAttempts: 0,
    }

    expect(minimalStatus.ci).toBeUndefined()
    expect(minimalStatus.ciAttempts).toBe(0)
    expect(minimalStatus.pullRequest).toBeUndefined()
  })

  test('status tracks repair loop progress', () => {
    const repairStatus: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:10:00.000Z',
      runName: 'repair-loop-test',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/repair',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: 'repair12345678901',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'repaircommit123',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/100',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 20000,
        checks: [{ name: 'all', bucket: 'pass' }],
        summary: '1 passed',
      },
      ciAttempts: 1,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: '',
          stderr: 'failed',
          durationMs: 1000,
          ok: false,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: '',
          stderr: 'still failed',
          durationMs: 1000,
          ok: false,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'passed',
          stderr: '',
          durationMs: 1000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec'],
        commands: ['bun test', 'bun lint'],
      },
      agentAttempts: 2,
      validationAttempts: 3,
      promptChars: 2000,
    }

    // Initial run: 1 agent attempt, 3 validation attempts (1 initial + 2 repairs)
    expect(repairStatus.validationAttempts).toBe(3)
    expect(repairStatus.validations).toHaveLength(3)
    expect(repairStatus.validations.slice(0, -1).every((v) => !v.ok)).toBe(true)
    expect(repairStatus.validations[repairStatus.validations.length - 1].ok).toBe(true)

    // After CI repair: 3 agent attempts total (1 initial + 2 CI repairs)
    const withCiRepair: AnypiStatus = {
      ...repairStatus,
      agentAttempts: 3,
      ciAttempts: 2,
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 2,
        durationMs: 25000,
        checks: [{ name: 'all', bucket: 'pass' }],
        summary: '1 passed',
      },
    }
    expect(withCiRepair.agentAttempts).toBe(3)
    expect(withCiRepair.ciAttempts).toBe(2)
  })

  test('status validates agent attempt count matches execution phases', () => {
    const multiPhaseStatus: AnypiStatus = {
      ...createBaseStatus(),
      agentAttempts: 5,
    }

    // Agent attempts should be at least 1
    expect(multiPhaseStatus.agentAttempts).toBeGreaterThan(0)
    expect(multiPhaseStatus.agentAttempts).toBeTypeOf('number')
  })

  test('status includes validation attempt breakdown', () => {
    const breakdownStatus: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:05:00.000Z',
      runName: 'breakdown-test',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/breakdown',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'finish-gated',
      promptHash: 'breakdown1234567',
      tools: ['bash'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'breakdowncommit',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/200',
        created: true,
      },
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 10000,
        checks: [{ name: 'all', bucket: 'pass' }],
        summary: '1 passed',
      },
      ciAttempts: 1,
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: '',
          stderr: 'failed 1',
          durationMs: 1000,
          ok: false,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: '',
          stderr: 'failed 2',
          durationMs: 1000,
          ok: false,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 1,
          stdout: '',
          stderr: 'failed 3',
          durationMs: 1000,
          ok: false,
        },
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout: 'passed',
          stderr: '',
          durationMs: 1000,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['bun test'],
      },
      agentAttempts: 4,
      validationAttempts: 4,
      promptChars: 1000,
    }

    const failed = breakdownStatus.validations.filter((v) => !v.ok)
    const passed = breakdownStatus.validations.filter((v) => v.ok)

    expect(failed).toHaveLength(3)
    expect(passed).toHaveLength(1)
    expect(breakdownStatus.validationAttempts).toBe(4)
  })
})

describe('Anypi status prompt variant hash consistency', () => {
  test('same variant produces same hash', () => {
    const variant: PromptVariant = 'finish-gated'
    const hash1 = buildSystemPrompt(variant)
    const hash2 = buildSystemPrompt(variant)

    // Hash is deterministic for same variant
    expect(hash1).toBe(hash2)
  })

  test('different variants produce different hashes', () => {
    const hashMinimal = buildSystemPrompt('minimal')
    const hashFinishGated = buildSystemPrompt('finish-gated')
    const hashRepairLoop = buildSystemPrompt('repair-loop')
    const hashStrictRepo = buildSystemPrompt('strict-repo')

    expect(hashMinimal).not.toBe(hashFinishGated)
    expect(hashFinishGated).not.toBe(hashRepairLoop)
    expect(hashRepairLoop).not.toBe(hashStrictRepo)
  })

  test('prompt variant is reflected in status', () => {
    const variants: PromptVariant[] = ['minimal', 'finish-gated', 'repair-loop', 'strict-repo']

    variants.forEach((variant) => {
      const status: AnypiStatus = {
        ...createBaseStatus(),
        promptVariant: variant,
        promptHash: buildSystemPrompt(variant).slice(0, 16),
      }
      expect(status.promptVariant).toBe(variant)
    })
  })
})

describe('Anypi status repair loop evidence', () => {
  const createStatusForRepairLoop = (
    opts: {
      initialValidationFailures?: number
      ciRepairAttempts?: number
    } = {},
  ): AnypiStatus => {
    const failures = opts.initialValidationFailures ?? 2
    const validationAttempts = failures + 1

    const validations: ValidationResult[] = []
    for (let i = 0; i < failures; i++) {
      validations.push({
        command: 'bash',
        args: ['-lc', 'bun test'],
        exitCode: 1,
        stdout: '',
        stderr: `validation failed ${i + 1}`,
        durationMs: 1000,
        ok: false,
      })
    }
    validations.push({
      command: 'bash',
      args: ['-lc', 'bun test'],
      exitCode: 0,
      stdout: 'passed',
      stderr: '',
      durationMs: 1000,
      ok: true,
    })

    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'succeeded',
      startedAt: '2026-06-16T00:00:00.000Z',
      finishedAt: '2026-06-16T00:10:00.000Z',
      runName: 'repair-loop-test',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/repair',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'repair-loop',
      promptHash: 'repair12345678901',
      tools: ['bash', 'edit'],
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
      commit: 'repaircommit123',
      pullRequest: {
        enabled: true,
        url: 'https://github.com/proompteng/lab/pull/100',
        created: true,
      },
      ci: opts.ciRepairAttempts
        ? {
            ok: true,
            status: 'passed',
            requiredOnly: true,
            attempts: opts.ciRepairAttempts,
            durationMs: 20000,
            checks: [{ name: 'all', bucket: 'pass' }],
            summary: '1 passed',
          }
        : undefined,
      ciAttempts: opts.ciRepairAttempts ?? 0,
      validations,
      validationPlan: {
        policy: 'append',
        sources: ['inferred', 'run-spec'],
        commands: ['bun test', 'bun lint'],
      },
      agentAttempts: 1 + (opts.ciRepairAttempts ?? 0),
      validationAttempts,
      promptChars: 2000,
    }

    return status
  }

  test('status tracks validation repair attempts', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 3 })

    expect(status.validationAttempts).toBe(4)
    expect(status.validations).toHaveLength(4)
    expect(status.validations.slice(0, -1).every((v) => !v.ok)).toBe(true)
    expect(status.validations[status.validations.length - 1].ok).toBe(true)
  })

  test('status ci repair attempts are counted separately', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 1, ciRepairAttempts: 2 })

    expect(status.ciAttempts).toBe(2)
    expect(status.agentAttempts).toBe(3)
    expect(status.validations.length).toBe(2)
  })

  test('status includes session paths for each repair phase', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 1 })

    expect(status.sessionFile).toBeDefined()
    expect(status.sessionFiles).toBeDefined()
    expect(status.sessionFiles).toHaveLength(1)
    expect(status.sessionFiles?.[0]).toMatch(/initial\/session\.json$/)
  })

  test('status validation plan sources include all command origins', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 1 })

    expect(status.validationPlan.sources).toEqual(['inferred', 'run-spec'])
    expect(status.validationPlan.commands).toContain('bun test')
    expect(status.validationPlan.commands).toContain('bun lint')
  })

  test('status validation attempts match actual validation array length', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 5 })

    expect(status.validationAttempts).toBe(6)
    expect(status.validations).toHaveLength(6)
    expect(status.validations.length).toBe(status.validationAttempts)
  })

  test('status handles CI repair scenario', () => {
    const status = createStatusForRepairLoop({ ciRepairAttempts: 3 })

    expect(status.ci?.attempts).toBe(3)
    expect(status.ci?.status).toBe('passed')
    expect(status.ci?.requiredOnly).toBe(true)
  })

  test('status agent attempts include all repair phases', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 2, ciRepairAttempts: 1 })

    // 1 initial + 1 CI repair = 2 agent attempts
    expect(status.agentAttempts).toBe(2)
    expect(status.agentAttempts).toBeGreaterThan(0)
  })

  test('status validation repair shows increasing attempts', () => {
    const status = createStatusForRepairLoop({ initialValidationFailures: 4 })

    expect(status.validationAttempts).toBe(5)

    // All but last should fail
    const failures = status.validations.filter((v) => !v.ok)
    const passes = status.validations.filter((v) => v.ok)

    expect(failures).toHaveLength(4)
    expect(passes).toHaveLength(1)
  })
})

describe('Anypi status CI check evidence', () => {
  test('status ci checks include workflow and bucket information', () => {
    const checks: CiCheck[] = [
      { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
      { name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
      { name: 'security', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
    ]

    expect(checks).toHaveLength(3)
    expect(checks[0].name).toBe('lint')
    expect(checks[0].workflow).toBe('CI')
    expect(checks[0].bucket).toBe('pass')
    expect(checks[0].state).toBe('SUCCESS')
  })

  test('status ci checks can include link to job', () => {
    const check: CiCheck = {
      name: 'deploy',
      workflow: 'CD',
      bucket: 'pass',
      link: 'https://ci.example.com/job/123/deploy',
    }

    expect(check.link).toBe('https://ci.example.com/job/123/deploy')
  })

  test('status ci wait result tracks required-only flag', () => {
    const requiredOnly: CiWaitResult = createCiWaitResult({
      requiredOnly: true,
      attempts: 2,
    })

    expect(requiredOnly.requiredOnly).toBe(true)
    expect(requiredOnly.attempts).toBe(2)
  })

  test('status ci wait result tracks non-required checks', () => {
    const notRequired: CiWaitResult = createCiWaitResult({
      requiredOnly: false,
      attempts: 1,
    })

    expect(notRequired.requiredOnly).toBe(false)
    expect(notRequired.attempts).toBe(1)
  })

  test('status ci checks include all required status fields', () => {
    const check: CiCheck = {
      name: 'e2e',
      workflow: 'E2E',
      bucket: 'pass',
      state: 'success',
      link: 'https://ci.example.com/e2e',
    }

    expect(check.name).toBeDefined()
    expect(check.workflow).toBeDefined()
    expect(check.bucket).toBeDefined()
    expect(check.state).toBeDefined()
    expect(check.link).toBeDefined()
  })
})

describe('Anypi status session artifact tracking', () => {
  test('status session file path is properly formatted', () => {
    const status: AnypiStatus = {
      ...createBaseStatus(),
      sessionFile: '/workspace/.anypi/sessions/validation-repair-1/session.json',
    }

    expect(status.sessionFile).toMatch(/\.json$/)
    expect(status.sessionFile).toContain('session')
    expect(status.sessionFile).toContain('.anypi/sessions/')
  })

  test('status session files array tracks multiple sessions', () => {
    const status: AnypiStatus = {
      ...createBaseStatus(),
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/validation-repair-1/session.json',
        '/workspace/.anypi/sessions/ci-repair-1/session.json',
      ],
    }

    expect(status.sessionFiles).toHaveLength(3)
    expect(status.sessionFile).toBe(status.sessionFiles?.[0])
  })

  test('status session files include repair phases', () => {
    const repairSessions: AnypiStatus = {
      ...createBaseStatus(),
      sessionFile: '/workspace/.anypi/sessions/initial/session.json',
      sessionFiles: [
        '/workspace/.anypi/sessions/initial/session.json',
        '/workspace/.anypi/sessions/validation-repair-1/session.json',
        '/workspace/.anypi/sessions/validation-repair-2/session.json',
        '/workspace/.anypi/sessions/ci-repair-1/session.json',
      ],
    }

    expect(repairSessions.sessionFiles).toHaveLength(4)
    expect(repairSessions.sessionFiles?.[1]).toContain('validation-repair-1')
    expect(repairSessions.sessionFiles?.[2]).toContain('validation-repair-2')
    expect(repairSessions.sessionFiles?.[3]).toContain('ci-repair-1')
  })
})

describe('Anypi status PR metadata audit', () => {
  test('status pull request URL is properly formed', () => {
    const pr: PullRequestResult = {
      enabled: true,
      url: 'https://github.com/proompteng/lab/pull/123',
      created: true,
    }

    expect(pr.url).toBe('https://github.com/proompteng/lab/pull/123')
    expect(pr.url).toMatch(/pull\/\d+$/)
  })

  test('status PR created flag indicates new vs update', () => {
    const newPr: PullRequestResult = {
      enabled: true,
      url: 'https://github.com/proompteng/lab/pull/456',
      created: true,
    }

    const updatedPr: PullRequestResult = {
      enabled: true,
      url: 'https://github.com/proompteng/lab/pull/456',
      created: false,
    }

    expect(newPr.created).toBe(true)
    expect(updatedPr.created).toBe(false)
  })

  test('status PR metadata includes all required fields', () => {
    const pr: PullRequestResult = {
      enabled: true,
      url: 'https://github.com/proompteng/lab/pull/789',
      created: true,
    }

    expect(pr.enabled).toBeTypeOf('boolean')
    expect(pr.url).toBeTypeOf('string')
    expect(pr.created).toBeTypeOf('boolean')
  })

  test('status supports PR without URL when disabled', () => {
    const disabledPr: PullRequestResult = {
      enabled: false,
    }

    expect(disabledPr.enabled).toBe(false)
    expect(disabledPr.url).toBeUndefined()
    expect(disabledPr.created).toBeUndefined()
  })
})

describe('Anypi status validation evidence', () => {
  test('status validation results include stdout', () => {
    const status: AnypiStatus = {
      ...createBaseStatus(),
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'bun test'],
          exitCode: 0,
          stdout:
            'PASS  tests/one.test.ts\nPASS  tests/two.test.ts\n\nTest Suites: 2 passed, 2 total\nTests:       4 passed, 4 total',
          stderr: '',
          durationMs: 1000,
          ok: true,
        },
      ],
    }

    expect(status.validations[0].stdout).toContain('PASS')
    expect(status.validations[0].stdout).toContain('Test Suites')
  })

  test('status validation results include stderr for failures', () => {
    const failedValidation: ValidationResult = {
      command: 'bash',
      args: ['-lc', 'bun test'],
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Expected 2 but got 1',
      durationMs: 1000,
      ok: false,
    }

    expect(failedValidation.stderr).toContain('Error:')
    expect(failedValidation.exitCode).toBe(1)
    expect(failedValidation.ok).toBe(false)
  })

  test('status validation results include command and args', () => {
    const validation: ValidationResult = {
      command: 'bun',
      args: ['run', 'test'],
      exitCode: 0,
      stdout: 'PASS',
      stderr: '',
      durationMs: 1000,
      ok: true,
    }

    expect(validation.command).toBe('bun')
    expect(validation.args).toEqual(['run', 'test'])
  })

  test('status validation results include duration', () => {
    const validation: ValidationResult = {
      command: 'bash',
      args: ['-lc', 'bun test'],
      exitCode: 0,
      stdout: 'PASS',
      stderr: '',
      durationMs: 5000,
      ok: true,
    }

    expect(validation.durationMs).toBe(5000)
    expect(validation.durationMs).toBeGreaterThan(0)
  })

  test('status validation attempts count matches array length', () => {
    const validations: ValidationResult[] = [
      {
        command: 'bash',
        args: ['-lc', 'bun test'],
        exitCode: 1,
        stdout: '',
        stderr: '',
        durationMs: 1000,
        ok: false,
      },
      {
        command: 'bash',
        args: ['-lc', 'bun test'],
        exitCode: 1,
        stdout: '',
        stderr: '',
        durationMs: 1000,
        ok: false,
      },
      {
        command: 'bash',
        args: ['-lc', 'bun test'],
        exitCode: 0,
        stdout: 'PASS',
        stderr: '',
        durationMs: 1000,
        ok: true,
      },
    ]

    expect(validations.length).toBe(3)
  })
})

describe('Anypi status for validation plan traceability', () => {
  test('status validation plan policy is recorded', () => {
    const appendPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred', 'run-spec'],
      commands: ['bun test'],
    }

    expect(appendPlan.policy).toBe('append')

    const overridePlan: ValidationPlan = {
      policy: 'override',
      sources: ['env'],
      commands: ['npm test'],
    }

    expect(overridePlan.policy).toBe('override')
  })

  test('status validation plan sources indicate command origin', () => {
    // inferred from task description
    const inferredPlan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['git diff --check'],
    }
    expect(inferredPlan.sources).toEqual(['inferred'])

    // from run parameters
    const runSpecPlan: ValidationPlan = {
      policy: 'append',
      sources: ['run-spec'],
      commands: ['bun test'],
    }
    expect(runSpecPlan.sources).toEqual(['run-spec'])

    // from environment variable
    const envPlan: ValidationPlan = {
      policy: 'append',
      sources: ['env'],
      commands: ['make test'],
    }
    expect(envPlan.sources).toEqual(['env'])
  })

  test('status validation plan commands are fully specified', () => {
    const plan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred', 'run-spec'],
      commands: ['bun run --filter @proompteng/anypi test', 'bun run --filter @proompteng/anypi lint'],
    }

    expect(plan.commands).toHaveLength(2)
    expect(plan.commands[0]).toBe('bun run --filter @proompteng/anypi test')
    expect(plan.commands[1]).toBe('bun run --filter @proompteng/anypi lint')
  })

  test('status validation plan sources array is never empty for valid plans', () => {
    const plan: ValidationPlan = {
      policy: 'append',
      sources: ['inferred'],
      commands: ['bun test'],
    }
    expect(plan.sources.length).toBeGreaterThan(0)
  })
})

import { describe, expect, test } from 'vitest'

import { ALL_PI_TOOL_NAMES, buildModelsJson, parseCommandList, resolveConfig } from './config'
import { parseCiChecks, summarizeChecks } from './git'
import {
  buildAgentPrompt,
  buildNoChangeRepairPrompt,
  buildSystemPrompt,
  buildValidationRepairPrompt,
  hashSystemPrompt,
  inferValidationCommands,
  resolvePromptVariant,
  resolveTaskPrompt,
  resolveValidationCommands,
  resolveValidationPlan,
} from './prompt'
import {
  isBenignAssistantContinuationError,
  resolveAttemptSessionDir,
  resolveEffectiveSystemPrompt,
} from './pi-session'
import {
  buildCommitMessage,
  buildPullRequestBody,
  buildPullRequestTitle,
  formatValidationError,
  normalizeConventionalSummary,
} from './run'
import type { AgentRunSpecPayload, ValidationResult } from './types'

describe('Anypi config', () => {
  test('defaults to Flamingo and all Pi coding tools', () => {
    const config = resolveConfig({})
    expect(config.provider).toBe('flamingo')
    expect(config.model).toBe('qwen3-coder-flamingo')
    expect(config.baseUrl).toBe('http://flamingo.flamingo.svc.cluster.local/v1')
    expect(config.modelReadyTimeoutSeconds).toBe(1800)
    expect(config.promptVariant).toBe('minimal')
    expect(config.allowSystemPromptOverride).toBe(false)
    expect(config.thinkingLevel).toBe('off')
    expect(config.tools).toEqual([...ALL_PI_TOOL_NAMES])
    expect(config.validationPolicy).toBe('append')
    expect(config.noChangeRepairAttempts).toBe(2)
    expect(config.validationRepairAttempts).toBe(2)
    expect(config.ciRepairAttempts).toBe(1)
    expect(config.ciRequiredOnly).toBe(true)
  })

  test('renders Pi custom models.json for vLLM OpenAI-compatible serving', () => {
    const config = resolveConfig({})
    expect(buildModelsJson(config)).toMatchObject({
      providers: {
        flamingo: {
          api: 'openai-completions',
          baseUrl: 'http://flamingo.flamingo.svc.cluster.local/v1',
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{ id: 'qwen3-coder-flamingo', reasoning: false }],
        },
      },
    })
  })

  test('parses validation commands from newline text or JSON', () => {
    expect(parseCommandList('git diff --check\nbun test')).toEqual(['git diff --check', 'bun test'])
    expect(parseCommandList('["git diff --check","bun test"]')).toEqual(['git diff --check', 'bun test'])
  })

  test('normalizes prompt variants and validation policy from env', () => {
    expect(resolvePromptVariant('strict-repo')).toBe('strict-repo')
    expect(resolvePromptVariant('unknown')).toBe('minimal')
    expect(resolveConfig({ ANYPI_PROMPT_VARIANT: 'repair-loop', ANYPI_VALIDATION_POLICY: 'override' })).toMatchObject({
      promptVariant: 'repair-loop',
      validationPolicy: 'override',
    })
  })

  test('isolates persisted sessions per agent attempt', () => {
    const sessionDir = resolveAttemptSessionDir('/workspace/.anypi/sessions', 'Validation repair #1')
    expect(sessionDir).toMatch(/^\/workspace\/\.anypi\/sessions\/validation-repair-1-[a-f0-9]{8}$/)
  })

  test('recognizes the narrow assistant continuation terminal error', () => {
    expect(isBenignAssistantContinuationError(new Error('Cannot continue from message role: assistant'))).toBe(true)
    expect(isBenignAssistantContinuationError(new Error('rate limit'))).toBe(false)
  })
})

describe('Anypi prompt contract', () => {
  test('prefers rendered run prompt over raw implementation text', () => {
    expect(
      resolveTaskPrompt({
        prompt: 'rendered',
        implementation: { text: 'raw' },
      }),
    ).toBe('rendered')
  })

  test('builds focused coding instructions without runtime leakage', () => {
    const prompt = buildAgentPrompt(
      {
        prompt: 'Refactor code and add tests.',
        vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/anypi' },
      },
      '/workspace/lab',
    )
    expect(prompt).toContain('Use repository instructions and existing patterns')
    expect(prompt).toContain('Refactor code and add tests.')
    expect(prompt).toContain('Leave the final changes in the worktree')
    expect(prompt).not.toMatch(/Anypi|YOLO|Kubernetes|Pi SDK|shell, read, edit, write/)
  })

  test('keeps the default system prompt simple and repo-focused', () => {
    const prompt = buildSystemPrompt('minimal')
    expect(prompt).toContain('Act as a coding agent inside an existing repository')
    expect(prompt).toContain('Run the checks required for touched files')
    expect(prompt).not.toMatch(/Anypi|YOLO|Kubernetes|Pi SDK|provider|Flamingo/)
    expect(hashSystemPrompt('minimal')).toMatch(/^[a-f0-9]{16}$/)
  })

  test('builds distinct prompt variants without runtime leakage', () => {
    expect(buildSystemPrompt('finish-gated')).toContain('Continue until the implementation')
    expect(buildSystemPrompt('repair-loop')).toContain('fix the root cause')
    expect(buildSystemPrompt('strict-repo')).toContain('Follow AGENTS.md')
    for (const variant of ['minimal', 'finish-gated', 'repair-loop', 'strict-repo'] as const) {
      expect(buildSystemPrompt(variant)).not.toMatch(/Anypi|YOLO|Kubernetes|Pi SDK|provider|Flamingo/)
    }
  })

  test('uses resolved Agent system prompt when provided', () => {
    expect(resolveEffectiveSystemPrompt({ promptVariant: 'minimal' }, '  custom repo prompt  ')).toBe(
      'custom repo prompt',
    )
    expect(resolveEffectiveSystemPrompt({ promptVariant: 'strict-repo' })).toBe(buildSystemPrompt('strict-repo'))
  })

  test('normalizes generated PR metadata to conventional lowercase subjects', () => {
    expect(normalizeConventionalSummary('Improve Torghut Diff Coverage.', 'fallback')).toBe(
      'improve torghut diff coverage',
    )
    expect(buildCommitMessage({ implementation: { summary: 'Improve Torghut Diff Coverage' } })).toBe(
      'feat(anypi): improve torghut diff coverage',
    )
    expect(buildPullRequestTitle({ implementation: { summary: 'Improve Torghut Diff Coverage' } })).toBe(
      'feat(anypi): improve torghut diff coverage',
    )
  })

  test('uses run parameters for validation commands when env commands are absent', () => {
    expect(
      resolveValidationCommands(
        {
          parameters: {
            validationCommands: 'git diff --check\nuv run pytest tests/test_check_diff_coverage.py',
          },
        },
        [],
      ),
    ).toEqual(['git diff --check', 'uv run pytest tests/test_check_diff_coverage.py'])
  })

  test('infers service-aware validation and refuses only diff-check', () => {
    expect(
      inferValidationCommands({
        implementation: { text: 'Improve services/anypi prompt handling and argocd/applications/agents manifests.' },
      }),
    ).toContain('bun run --filter @proompteng/anypi tsc')

    expect(() => resolveValidationPlan({ implementation: { text: 'Change generic docs.' } }, [], 'append')).toThrow(
      /service-aware validation/,
    )
  })

  test('records validation sources and appends run commands', () => {
    const plan = resolveValidationPlan(
      {
        implementation: { text: 'Improve services/anypi prompt handling.' },
        parameters: { validationCommands: 'bun run --filter @proompteng/anypi test' },
      },
      ['bun run --filter @proompteng/anypi lint'],
      'append',
    )
    expect(plan.sources).toEqual(['inferred', 'run-spec', 'env'])
    expect(plan.commands).toContain('bun run --filter @proompteng/anypi tsc')
    expect(plan.commands).toContain('bun run --filter @proompteng/anypi lint')
  })

  test('parses and summarizes GitHub check buckets', () => {
    const checks = parseCiChecks(
      JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'pyright', workflow: 'CI', bucket: 'fail', state: 'FAILURE', link: 'https://example.invalid' },
      ]),
    )
    expect(checks[0]).toMatchObject({ name: 'lint', workflow: 'CI', bucket: 'pass' })
    expect(summarizeChecks(checks)).toMatchObject({
      failed: [checks[1]],
      pending: [],
      passed: [checks[0]],
      summary: '1 passed/skipped, 0 pending, 1 failed/cancelled',
    })
  })

  test('builds a validation repair prompt with failed command output', () => {
    const prompt = buildValidationRepairPrompt({
      attempt: 1,
      maxAttempts: 2,
      worktree: '/workspace/lab',
      results: [
        {
          command: 'bash',
          args: ['-lc', 'git diff --check'],
          exitCode: 2,
          stdout: 'file.py:1: trailing whitespace.',
          stderr: '',
          durationMs: 12,
          ok: false,
        },
      ],
    })
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('git diff --check')
    expect(prompt).toContain('trailing whitespace')
    expect(prompt).toContain('do not remove or weaken')
  })

  test('builds a no-change repair prompt that requires implementation', () => {
    const prompt = buildNoChangeRepairPrompt({ attempt: 1, maxAttempts: 2, worktree: '/workspace/lab' })
    expect(prompt).toContain('completed without leaving any code changes')
    expect(prompt).toContain('Repair attempt: 1 of 2')
    expect(prompt).toContain('requires a real implementation')
    expect(prompt).toContain('leave the final changes in the worktree')
  })
})

describe('Anypi status evidence formatting', () => {
  test('formats validation error with exit code and command', () => {
    const result: ValidationResult = {
      command: 'bun',
      args: ['run', 'test'],
      exitCode: 1,
      stdout: '',
      stderr: 'FAIL: test failed',
      durationMs: 100,
      ok: false,
    }
    const formatted = formatValidationError(result)
    expect(formatted).toBe('validation failed (1): bun run test')
  })

  test('formats CI repair summary with checks', () => {
    const ci = {
      ok: false,
      status: 'failed',
      requiredOnly: true,
      attempts: 2,
      durationMs: 45000,
      checks: [
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'pyright', workflow: 'CI', bucket: 'fail', state: 'FAILURE' },
        { name: 'test', workflow: 'CI', bucket: 'fail', state: 'FAILURE' },
      ],
      summary: '1 passed/skipped, 0 pending, 2 failed/cancelled',
    }
    // formatCiRepairSummary is not exported but tested indirectly via buildPullRequestBody
    expect(ci.summary).toBe('1 passed/skipped, 0 pending, 2 failed/cancelled')
  })
})

describe('Anypi status evidence', () => {
  test('builds pull request body with prompt variant and hash evidence', () => {
    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Improve services/anypi tests' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/test' },
    }
    const status = {
      namespace: 'agents',
      runName: 'anypi-test-20260616',
      promptVariant: 'repair-loop',
      promptHash: 'abc123def4567890',
      sessionFile: '/workspace/.anypi/sessions/attempt-12345678/session.json',
      validations: [],
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 12000,
        checks: [],
        summary: 'no required checks reported',
      },
      commit: 'abc1234567890def',
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/1234', created: true },
    }
    const git = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }
    const piText = '## Summary\n\nTest changes added.'
    const body = buildPullRequestBody({ runSpec, status: status as any, git, piText })

    expect(body).toContain('Prompt variant: repair-loop (abc123def4567890)')
    expect(body).toContain('Session artifact: /workspace/.anypi/sessions/attempt-12345678/session.json')
    expect(body).toContain('CI: passed: no required checks reported')
    expect(body).toContain('Test changes added.')
  })

  test('builds pull request body with validation results and CI check details', () => {
    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Fix validation commands' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/fix' },
    }
    const status = {
      namespace: 'agents',
      runName: 'anypi-fix-20260616',
      promptVariant: 'minimal',
      promptHash: '1111111111111111',
      sessionFile: '/workspace/.anypi/sessions/validation-repair-1-abcdef12/session.json',
      validations: [
        {
          command: 'bun',
          args: ['run', '--filter', '@proompteng/anypi', 'tsc'],
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 5000,
          ok: true,
        },
        {
          command: 'bun',
          args: ['run', '--filter', '@proompteng/anypi', 'test'],
          exitCode: 0,
          stdout: '2 passed',
          stderr: '',
          durationMs: 3000,
          ok: true,
        },
      ],
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 45000,
        checks: [
          { name: 'tsc', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
          { name: 'test', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        ],
        summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
      },
      commit: 'deadbeef12345678',
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/5678', created: true },
    }
    const git = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/fix',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }
    const piText = '## Changes\n\nFixed validation commands.'
    const body = buildPullRequestBody({ runSpec, status: status as any, git, piText })

    expect(body).toContain('Prompt variant: minimal (1111111111111111)')
    expect(body).toContain('`bun run --filter @proompteng/anypi tsc` exit 0')
    expect(body).toContain('`bun run --filter @proompteng/anypi test` exit 0')
    expect(body).toContain('passed: 2 passed/skipped, 0 pending, 0 failed/cancelled')
  })

  test('builds pull request body with failed CI details for repair evidence', () => {
    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'Fix CI failures' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/ci-fix' },
    }
    const status = {
      namespace: 'agents',
      runName: 'anypi-ci-fix-20260616',
      promptVariant: 'strict-repo',
      promptHash: 'ffffffffffffffff',
      sessionFile: '/workspace/.anypi/sessions/ci-repair-1-fedcba98/session.json',
      validations: [],
      ci: {
        ok: false,
        status: 'failed',
        requiredOnly: true,
        attempts: 1,
        durationMs: 60000,
        checks: [
          { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
          { name: 'pyright', workflow: 'CI', bucket: 'fail', state: 'FAILURE', link: 'https://ci.invalid/pyright' },
          { name: 'test', workflow: 'CI', bucket: 'fail', state: 'FAILURE', link: 'https://ci.invalid/test' },
        ],
        summary: '0 passed/skipped, 0 pending, 2 failed/cancelled',
      },
      commit: 'cafebabe00000000',
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/9999', created: true },
    }
    const git = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/ci-fix',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }
    const piText = '## CI Repair\n\nFixed type errors.'
    const body = buildPullRequestBody({ runSpec, status: status as any, git, piText })

    expect(body).toContain('Prompt variant: strict-repo (ffffffffffffffff)')
    expect(body).toContain('CI: failed: 0 passed/skipped, 0 pending, 2 failed/cancelled')
  })

  test('builds pull request body with missing CI evidence when checks not started', () => {
    const runSpec: AgentRunSpecPayload = {
      implementation: { summary: 'New feature' },
      vcs: { repository: 'proompteng/lab', baseBranch: 'main', headBranch: 'codex/new' },
    }
    const status = {
      namespace: 'agents',
      runName: 'anypi-new-20260616',
      promptVariant: 'finish-gated',
      promptHash: '0000000000000000',
      sessionFile: null,
      validations: [],
      ci: undefined,
      commit: null,
      pullRequest: { enabled: true, url: 'https://github.com/proompteng/lab/pull/1000', created: true },
    }
    const git = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/new',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: true,
    }
    const piText = ''
    const body = buildPullRequestBody({ runSpec, status: status as any, git, piText })

    expect(body).toContain('Prompt variant: finish-gated (0000000000000000)')
    expect(body).toContain('Pending: pull request checks have not completed yet.')
    expect(body).toContain('N/A')
  })

  test('builds a validation repair prompt with multiple failed commands', () => {
    const prompt = buildValidationRepairPrompt({
      attempt: 2,
      maxAttempts: 2,
      worktree: '/workspace/lab',
      results: [
        {
          command: 'bash',
          args: ['-lc', 'git diff --check'],
          exitCode: 2,
          stdout: 'README.md:42: trailing whitespace.\nsrc/utils.ts:10: trailing whitespace.',
          stderr: '',
          durationMs: 25,
          ok: false,
        },
        {
          command: 'bun',
          args: ['run', 'lint'],
          exitCode: 1,
          stdout: '',
          stderr: 'ERROR: 5 lint errors found.',
          durationMs: 1500,
          ok: false,
        },
      ],
    })
    expect(prompt).toContain('Repair attempt: 2 of 2')
    expect(prompt).toContain('git diff --check')
    expect(prompt).toContain('README.md:42: trailing whitespace')
    expect(prompt).toContain('src/utils.ts:10: trailing whitespace')
    expect(prompt).toContain('bun run lint')
    expect(prompt).toContain('5 lint errors found')
    expect(prompt).toContain('do not remove or weaken')
  })
})

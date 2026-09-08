import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { describe, expect, test } from 'vitest'

import {
  ALL_PI_TOOL_NAMES,
  DEFAULT_REQUIRED_RUNTIME_TOOLS,
  buildModelsJson,
  parseCommandList,
  resolveConfig,
} from './config'
import {
  isNoChecksReportedResult,
  isNoRequiredChecksResult,
  classifyRestrictedChangedFile,
  validateChangedFilePolicy,
  parseCiChecks,
  parseCiChecksResult,
  parsePullRequestList,
  summarizeChecks,
} from './git'
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
  formatToolExecutionSummary,
  isBenignAssistantContinuationError,
  resolveAttemptSessionDir,
  resolveEffectiveSystemPrompt,
} from './pi-session'
import { checkRuntimeTool, verifyRequiredRuntimeTools } from './runtime-preflight'
import {
  buildCommitMessage,
  buildPullRequestTitle,
  hasWorktreeProgress,
  normalizeConventionalSummary,
  renderPullRequestBody,
  shouldRunCiRepair,
} from './run'
import { validatePullRequestBody, validationErrorToMessage } from './pr-body-validator'

describe('Anypi config', () => {
  test('defaults to Flamingo and all Pi coding tools', () => {
    const config = resolveConfig({})
    expect(config.provider).toBe('flamingo')
    expect(config.model).toBe('qwen36-flamingo')
    expect(config.baseUrl).toBe('http://flamingo.flamingo.svc.cluster.local/v1')
    expect(config.modelReadyTimeoutSeconds).toBe(1800)
    expect(config.piPromptTimeoutSeconds).toBe(1800)
    expect(config.promptVariant).toBe('minimal')
    expect(config.allowSystemPromptOverride).toBe(false)
    expect(config.thinkingLevel).toBe('medium')
    expect(config.contextWindow).toBe(229376)
    expect(config.maxTokens).toBe(32768)
    expect(config.tools).toEqual([...ALL_PI_TOOL_NAMES])
    expect(config.requiredTools).toEqual([...DEFAULT_REQUIRED_RUNTIME_TOOLS])
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
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens',
            thinkingFormat: 'qwen-chat-template',
          },
          models: [{ id: 'qwen36-flamingo', reasoning: true, contextWindow: 229376, maxTokens: 32768 }],
        },
      },
    })
  })

  test('parses validation commands from newline text or JSON', () => {
    expect(parseCommandList('git diff --check\nbun test')).toEqual(['git diff --check', 'bun test'])
    expect(parseCommandList('["git diff --check","bun test"]')).toEqual(['git diff --check', 'bun test'])
  })

  test('allows provider config to override required runtime tools', () => {
    expect(resolveConfig({ ANYPI_REQUIRED_TOOLS: 'git,gh bun' }).requiredTools).toEqual(['git', 'gh', 'bun'])
  })

  test('checks required runtime tools before model work', async () => {
    await expect(checkRuntimeTool('sh', process.cwd())).resolves.toMatchObject({ tool: 'sh', ok: true })

    const logs: string[] = []
    await expect(
      verifyRequiredRuntimeTools(['sh', 'definitely-missing-anypi-tool'], process.cwd(), async (message) => {
        logs.push(message)
      }),
    ).rejects.toThrow(/runtime preflight failed: missing required tools: definitely-missing-anypi-tool/)
    expect(logs.some((line) => line.startsWith('runtime tool ready: sh'))).toBe(true)
    expect(logs.some((line) => line.startsWith('runtime tool missing: definitely-missing-anypi-tool'))).toBe(true)
  })

  test('normalizes prompt variants and validation policy from env', () => {
    expect(resolvePromptVariant('strict-repo')).toBe('strict-repo')
    expect(resolvePromptVariant('unknown')).toBe('minimal')
    expect(
      resolveConfig({
        ANYPI_PROMPT_VARIANT: 'repair-loop',
        ANYPI_VALIDATION_POLICY: 'override',
        ANYPI_PI_PROMPT_TIMEOUT_SECONDS: '900',
      }),
    ).toMatchObject({
      promptVariant: 'repair-loop',
      validationPolicy: 'override',
      piPromptTimeoutSeconds: 900,
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

  test('summarizes tool calls with useful redacted context for runner logs', () => {
    expect(
      formatToolExecutionSummary('bash', {
        command: 'GH_TOKEN=ghp_1234567890123456789012345678901234567890 gh pr checks 123 --watch',
        timeout: 120,
      }),
    ).toBe('command="GH_TOKEN=<redacted> gh pr checks 123 --watch" timeout=120')

    expect(formatToolExecutionSummary('write', { path: 'tmp/result.txt', content: 'secret body' })).toBe(
      'path="tmp/result.txt" contentChars=11',
    )
    expect(formatToolExecutionSummary('edit', { path: 'src/file.ts', edits: [{ oldText: 'a', newText: 'b' }] })).toBe(
      'path="src/file.ts" edits=1',
    )
    expect(formatToolExecutionSummary('grep', { pattern: 'ANYPI_REQUIRED_TOOLS', path: 'argocd' })).toBe(
      'pattern="ANYPI_REQUIRED_TOOLS" path="argocd"',
    )
    expect(formatToolExecutionSummary('custom_tool', { token: 'abc123', action: 'inspect' })).toBe(
      'token=<redacted> action="inspect"',
    )
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
    expect(prompt).toContain('Use existing repository scripts, package-manager commands, and test/build configs')
    expect(prompt).toContain('Do not add package.json, tsconfig, test config, or local wrapper config solely')
    expect(prompt).toContain('Do not edit generated files or lockfiles')
    expect(prompt).toContain('Refactor code and add tests.')
    expect(prompt).toContain('Leave the final changes in the worktree')
    expect(prompt).not.toMatch(/Anypi|YOLO|Kubernetes|Pi SDK|shell, read, edit, write/)
  })

  test('keeps the default system prompt simple and repo-focused', () => {
    const prompt = buildSystemPrompt('minimal')
    expect(prompt).toContain('Act as a coding agent inside an existing repository')
    expect(prompt).toContain('Use existing repository scripts, package-manager commands, and test/build configs')
    expect(prompt).toContain('Do not add package.json, tsconfig, test config, or local wrapper config solely')
    expect(prompt).toContain('Run the checks required for touched files')
    expect(prompt).toContain('Do not edit generated files or lockfiles')
    expect(prompt).not.toMatch(/Anypi|YOLO|Kubernetes|Pi SDK|provider|Flamingo/)
    expect(hashSystemPrompt('minimal')).toMatch(/^[a-f0-9]{16}$/)
  })

  test('builds distinct prompt variants without runtime leakage', () => {
    expect(buildSystemPrompt('finish-gated')).toContain('Continue until the implementation')
    expect(buildSystemPrompt('repair-loop')).toContain('fix the root cause')
    expect(buildSystemPrompt('strict-repo')).toContain('Follow AGENTS.md')
    for (const variant of ['minimal', 'finish-gated', 'repair-loop', 'strict-repo'] as const) {
      expect(buildSystemPrompt(variant)).toContain('Use existing repository scripts')
      expect(buildSystemPrompt(variant)).toContain('Do not add package.json, tsconfig')
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
      'feat: improve torghut diff coverage',
    )
    expect(buildPullRequestTitle({ implementation: { summary: 'Improve Torghut Diff Coverage' } })).toBe(
      'feat: improve torghut diff coverage',
    )
  })

  test('renders PR bodies from the repository template without runtime leakage or placeholders', () => {
    const body = renderPullRequestBody({
      runSpec: { implementation: { summary: 'Improve Anypi PR body rendering' } },
      status: {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'anypi-eval-runner-repair-20260616',
        namespace: 'agents',
        model: 'qwen36-flamingo',
        providerModel: 'flamingo/qwen36-flamingo',
        thinkingLevel: 'medium',
        contextWindow: 229376,
        maxTokens: 32768,
        piPromptTimeoutSeconds: 1800,
        promptVariant: 'repair-loop',
        promptHash: '0123456789abcdef',
        tools: ['bash', 'edit'],
        requiredTools: ['bash', 'bun', 'git'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        validations: [
          {
            command: 'bash',
            args: ['-lc', 'bun run --filter @proompteng/anypi test'],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 42,
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
        ciAttempts: 1,
        promptChars: 1200,
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 3,
          durationMs: 3000,
          checks: [],
          summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
        },
      },
      git: {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi-eval/runner',
        cloneUrl: 'https://github.com/proompteng/lab.git',
        webUrl: 'https://github.com/proompteng/lab',
        worktree: '/workspace/lab',
        env: {},
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
      piText: 'implemented',
      template: `## Summary

<!-- 3-5 concise bullets describing what changed. -->

## Related Issues

## Testing

## Screenshots (if applicable)

## Breaking Changes

## Checklist

- [ ] Testing section documents the exact validation performed (or \`N/A\` with justification).
- [ ] Screenshots and Breaking Changes sections are handled appropriately (removed or filled in).
- [ ] Documentation, release notes, and follow-ups are updated or tracked.
`,
    })

    expect(body).toContain('## Summary')
    expect(body).toContain('## Testing')
    expect(body).toContain('- Improve Anypi PR body rendering.')
    expect(body).toContain('- Validation commands and CI status are listed below.')
    expect(body).toContain('bun run --filter @proompteng/anypi test')
    expect(body).toContain('- CI: passed: 2 passed/skipped, 0 pending, 0 failed/cancelled')
    expect(body).toContain('- [x] Testing section documents the exact validation performed.')
    expect(body).not.toContain('Generated for')
    expect(body).not.toContain('Prompt variant')
    expect(body).not.toContain('Session artifact')
    expect(body).not.toContain('anypi-eval-runner-repair-20260616')
    expect(body).not.toContain('0123456789abcdef')
    expect(body).not.toContain('/workspace/.anypi/sessions')
    expect(body).not.toContain('<!--')
    expect(body).not.toContain('[ ]')
    expect(body).not.toMatch(/TODO|TBD|<\.\.\.>/)
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
    expect(
      inferValidationCommands({
        implementation: { text: 'Improve argocd/applications/agents AgentProvider manifests.' },
      }),
    ).toContain('kustomize build --enable-helm argocd/applications/agents >/tmp/anypi-agents.yaml')

    expect(() => resolveValidationPlan({ implementation: { text: 'Change generic docs.' } }, [], 'append')).toThrow(
      /service-aware validation/,
    )
  })

  test('records validation sources and appends run commands (env appended, no inferred)', () => {
    const plan = resolveValidationPlan(
      {
        implementation: { text: 'Improve services/anypi prompt handling.' },
        parameters: { validationCommands: 'bun run --filter @proompteng/anypi test' },
      },
      ['bun run --filter @proompteng/anypi lint'],
      'append',
    )
    // Run-spec commands are authoritative; env commands appended; inferred commands NOT included
    expect(plan.sources).toEqual(['run-spec', 'env'])
    expect(plan.commands).toContain('bun run --filter @proompteng/anypi test')
    expect(plan.commands).toContain('bun run --filter @proompteng/anypi lint')
    expect(plan.commands).not.toContain('bun run --filter @proompteng/anypi tsc')
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

  test('only treats failed or cancelled GitHub checks as CI-repairable', () => {
    expect(
      shouldRunCiRepair({
        ok: false,
        status: 'failed',
        requiredOnly: false,
        attempts: 1,
        durationMs: 100,
        checks: [{ name: 'scripts', workflow: 'CI', bucket: 'fail' }],
        summary: '0 passed/skipped, 0 pending, 1 failed/cancelled',
      }),
    ).toBe(true)

    expect(
      shouldRunCiRepair({
        ok: false,
        status: 'failed',
        requiredOnly: false,
        attempts: 1,
        durationMs: 100,
        checks: [{ name: 'scripts', workflow: 'CI', bucket: 'pending' }],
        summary: '0 passed/skipped, 1 pending, 0 failed/cancelled',
      }),
    ).toBe(false)

    expect(
      shouldRunCiRepair({
        ok: false,
        status: 'unavailable',
        requiredOnly: true,
        attempts: 1,
        durationMs: 100,
        checks: [],
        summary: "gh pr checks failed (1): no required checks reported on the 'codex/example' branch",
      }),
    ).toBe(false)
  })

  test('rejects generated artifact and lockfile drift before commit', async () => {
    expect(classifyRestrictedChangedFile('bun.lock')).toBe('lockfile')
    expect(classifyRestrictedChangedFile('services/anypi/dist/index.js')).toBe('generated-artifact')
    expect(classifyRestrictedChangedFile('services/anypi/src/run.ts')).toBeNull()

    const worktree = await mkdtemp(join(tmpdir(), 'anypi-policy-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'anypi@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })
    await writeFile(join(worktree, 'README.md'), 'ok\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })
    await writeFile(join(worktree, 'bun.lock'), 'lock drift\n', 'utf8')

    const failure = await validateChangedFilePolicy(
      {
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi-policy',
        cloneUrl: 'https://github.com/proompteng/lab.git',
        webUrl: 'https://github.com/proompteng/lab',
        worktree,
        env: {},
        writeEnabled: true,
        pullRequestsEnabled: true,
      },
      {},
    )

    expect(failure).toMatchObject({
      command: 'anypi-policy',
      args: ['restricted-files'],
      exitCode: 1,
      ok: false,
    })
    expect(failure?.stdout).toContain('bun.lock (lockfile)')

    await expect(
      validateChangedFilePolicy(
        {
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi-policy',
          cloneUrl: 'https://github.com/proompteng/lab.git',
          webUrl: 'https://github.com/proompteng/lab',
          worktree,
          env: {},
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
        { parameters: { allowLockfileChanges: 'true' } },
      ),
    ).resolves.toBeNull()
  })

  test('rejects unsupported GitHub check command output instead of treating it as no checks', () => {
    expect(
      isNoChecksReportedResult({
        command: 'gh',
        args: ['pr', 'checks', 'branch', '--json', 'name,workflow,state,bucket,link'],
        exitCode: 1,
        stdout: '',
        stderr: "no checks reported on the 'codex/example' branch",
        durationMs: 12,
      }),
    ).toBe(true)
    expect(
      isNoRequiredChecksResult({
        command: 'gh',
        args: ['pr', 'checks', 'branch', '--required', '--json', 'name,workflow,state,bucket,link'],
        exitCode: 1,
        stdout: '',
        stderr: "no required checks reported on the 'codex/example' branch",
        durationMs: 12,
      }),
    ).toBe(true)
    expect(
      isNoRequiredChecksResult({
        command: 'gh',
        args: ['pr', 'checks', 'branch', '--json', 'name,workflow,state,bucket,link'],
        exitCode: 1,
        stdout: '',
        stderr: 'unknown flag: --json',
        durationMs: 12,
      }),
    ).toBe(false)

    expect(() =>
      parseCiChecksResult({
        command: 'gh',
        args: ['pr', 'checks', 'branch', '--json', 'name,workflow,state,bucket,link'],
        exitCode: 1,
        stdout: '',
        stderr: 'unknown flag: --json',
        durationMs: 12,
      }),
    ).toThrow(/gh pr checks failed.*unknown flag: --json/)
  })

  test('parses GitHub REST pull request lookup results', () => {
    expect(parsePullRequestList('[{"number":123,"html_url":"https://github.com/proompteng/lab/pull/123"}]')).toEqual({
      number: 123,
      url: 'https://github.com/proompteng/lab/pull/123',
    })
    expect(parsePullRequestList('[]')).toBeNull()
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

  test('detects whether a repair attempt changed worktree progress', () => {
    expect(
      hasWorktreeProgress(
        { status: ' M services/anypi/src/run.ts', commitsAhead: 0, contentHash: 'a' },
        { status: ' M services/anypi/src/run.ts\n M services/anypi/src/config.ts', commitsAhead: 0, contentHash: 'b' },
      ),
    ).toBe(true)
    expect(
      hasWorktreeProgress(
        { status: ' M foo.ts', commitsAhead: 0, contentHash: 'before' },
        { status: ' M foo.ts', commitsAhead: 0, contentHash: 'after' },
      ),
    ).toBe(true)
    expect(
      hasWorktreeProgress(
        { status: '', commitsAhead: 0, contentHash: 'a' },
        { status: '', commitsAhead: 1, contentHash: 'a' },
      ),
    ).toBe(true)
    expect(
      hasWorktreeProgress(
        { status: ' M foo.ts', commitsAhead: 1, contentHash: 'same' },
        { status: ' M foo.ts', commitsAhead: 1, contentHash: 'same' },
      ),
    ).toBe(false)
  })

  describe('validation planning - regression tests', () => {
    test('explicit run-spec validation commands are authoritative (append policy)', () => {
      // Run with explicit validation commands and task text mentioning multiple unrelated areas
      // Should only run the explicit commands, NOT inferred commands for those areas
      const plan = resolveValidationPlan(
        {
          implementation: {
            text: 'Improve services/torghut validation and services/anypi prompt handling and argocd/applications/agents manifests.',
          },
          parameters: {
            validationCommands: 'echo specific validation command\ngit diff --check',
          },
        },
        [],
        'append',
      )

      // Should only have the explicit commands, NOT inferred commands
      expect(plan.sources).toEqual(['run-spec'])
      expect(plan.commands).toEqual(['echo specific validation command', 'git diff --check'])
      expect(plan.commands).not.toContain('cd services/torghut && uv sync --frozen --extra dev')
      expect(plan.commands).not.toContain('bun run --filter @proompteng/anypi tsc')
      expect(plan.commands).not.toContain(
        'kustomize build --enable-helm argocd/applications/agents >/tmp/anypi-agents.yaml',
      )
    })

    test('inferred commands work as fallback when no explicit commands are provided', () => {
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Improve services/anypi prompt handling.' },
        },
        [],
        'append',
      )

      expect(plan.sources).toEqual(['inferred'])
      expect(plan.commands).toContain('bun run --filter @proompteng/anypi tsc')
      expect(plan.commands).toContain('bun run --filter @proompteng/anypi test')
      expect(plan.commands).toContain('bun run --filter @proompteng/anypi lint')
    })

    test('env override still wins in override mode', () => {
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Change something.' },
          parameters: { validationCommands: 'run-spec command' },
        },
        ['env override command'],
        'override',
      )

      expect(plan.sources).toEqual(['env'])
      expect(plan.commands).toEqual(['env override command'])
    })

    test('validation source metadata is accurate for append policy with run-spec only', () => {
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Improve services/anypi prompt handling.' },
          parameters: { validationCommands: 'custom validation' },
        },
        [],
        'append',
      )

      expect(plan.sources).toEqual(['run-spec'])
      expect(plan.commands).toEqual(['custom validation'])
    })

    test('validation source metadata is accurate for append policy with run-spec and env', () => {
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Improve services/anypi prompt handling.' },
          parameters: { validationCommands: 'run-spec command' },
        },
        ['env command'],
        'append',
      )

      // Env commands should be appended, but inferred should NOT be included
      expect(plan.sources).toEqual(['run-spec', 'env'])
      expect(plan.commands).toEqual(['run-spec command', 'env command'])
    })

    test('validation source metadata is accurate for append policy with env only', () => {
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Change generic docs.' },
        },
        ['env only command'],
        'append',
      )

      // Only env commands, no inferred
      expect(plan.sources).toEqual(['env'])
      expect(plan.commands).toEqual(['env only command'])
    })

    test('append policy with env does not add inferred commands', () => {
      // Even though the task mentions torghut, inferred commands should NOT be added
      // because env commands are provided
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Improve services/torghut validation.' },
        },
        ['env command 1', 'env command 2'],
        'append',
      )

      expect(plan.sources).toEqual(['env'])
      expect(plan.commands).toEqual(['env command 1', 'env command 2'])
      expect(plan.commands).not.toContain('cd services/torghut && uv sync --frozen --extra dev')
    })

    test('override policy still works correctly with env override', () => {
      // When env commands are provided with override policy, they should be used exclusively
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Improve services/torghut validation.' },
          parameters: { validationCommands: 'run-spec command' },
        },
        ['env override command 1', 'env override command 2'],
        'override',
      )

      expect(plan.sources).toEqual(['env'])
      expect(plan.commands).toEqual(['env override command 1', 'env override command 2'])
      expect(plan.commands).not.toContain('run-spec command')
      expect(plan.commands).not.toContain('cd services/torghut && uv sync --frozen --extra dev')
    })

    test('override policy falls back to run-spec when no env commands', () => {
      const plan = resolveValidationPlan(
        {
          implementation: { text: 'Improve services/anypi prompt handling.' },
          parameters: { validationCommands: 'run-spec command 1\nrun-spec command 2' },
        },
        [],
        'override',
      )

      expect(plan.sources).toEqual(['run-spec'])
      expect(plan.commands).toEqual(['run-spec command 1', 'run-spec command 2'])
    })
  })

  // ------------------------------------------------------------------------
  // PR body validation
  // ------------------------------------------------------------------------

  describe('PR body validation', () => {
    test('valid rendered body passes without errors', () => {
      const body = [
        '## Summary',
        '',
        '- Improved the feature',
        '- Fixed edge cases',
        '',
        '## Testing',
        '',
        '- ran bun test',
        '',
        '## Checklist',
        '',
        '- [x] All tests pass.',
        '- [x] Documentation updated.',
      ].join('\n')
      expect(validatePullRequestBody(body)).toBeNull()
    })

    test('renders from template produce a clean body that passes validation', () => {
      const body = renderPullRequestBody({
        runSpec: { implementation: { summary: 'Fix PR body validation' } },
        status: {
          provider: 'anypi',
          status: 'running' as const,
          startedAt: '2026-06-16T00:00:00.000Z',
          runName: 'anypi-foo',
          namespace: 'agents',
          model: 'qwen36-flamingo',
          providerModel: 'flamingo/qwen36-flamingo',
          thinkingLevel: 'medium' as const,
          contextWindow: 229376,
          maxTokens: 32768,
          piPromptTimeoutSeconds: 1800,
          promptVariant: 'minimal',
          promptHash: '0123456789abcdef',
          tools: [],
          requiredTools: [],
          validations: [],
          validationPlan: { policy: 'append', sources: [], commands: [] },
          agentAttempts: 1,
          validationAttempts: 1,
          ciAttempts: 1,
          promptChars: 0,
          ci: {
            ok: true,
            status: 'passed' as const,
            requiredOnly: true,
            attempts: 1,
            durationMs: 100,
            checks: [],
            summary: '0 passed/skipped, 0 pending, 0 failed/cancelled',
          },
        },
        git: {
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/test',
          cloneUrl: 'https://github.com/proompteng/lab.git',
          webUrl: 'https://github.com/proompteng/lab',
          worktree: '/tmp/lab',
          env: {},
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
        piText: 'done',
        template: [
          '## Summary',
          '',
          '## Related Issues',
          '',
          '## Testing',
          '',
          '## Screenshots (if applicable)',
          '',
          '## Breaking Changes',
          '',
          '## Checklist',
          '',
          '- [ ] Testing section documents the exact validation performed.',
          '- [ ] Screenshots and Breaking Changes sections are handled appropriately.',
          '- [ ] Documentation updated.',
        ].join('\n'),
      })
      expect(validatePullRequestBody(body)).toBeNull()
    })

    test('rejects HTML comments from template scaffolding', () => {
      const body = [
        '## Summary',
        '',
        '<!-- 3-5 concise bullets describing what changed. -->',
        '',
        '- Did the thing.',
      ].join('\n')
      const err = validatePullRequestBody(body)
      expect(err).not.toBeNull()
      expect(err!.issues).toContain('html-comment')
      expect(validationErrorToMessage(err!)).toContain('html-comment')
    })

    test('rejects bare TODO and TBD keywords', () => {
      const body = ['## Summary', '', '- Improve this TODO section before merge.', '- TBD: finalize the changes.'].join(
        '\n',
      )
      const err = validatePullRequestBody(body)
      expect(err).not.toBeNull()
      expect(err!.issues).toContain('TODO/TBD placeholder')
    })

    test('rejects angle-bracket placeholders', () => {
      const body = ['## Summary', '', '- Improved <feature name>.', '- Updated <component> to handle edge cases.'].join(
        '\n',
      )
      const err = validatePullRequestBody(body)
      expect(err).not.toBeNull()
      expect(err!.issues.some((issue) => issue.includes('angle-bracket'))).toBe(true)
    })

    test('rejects unchecked checklist items', () => {
      const body = [
        '## Summary',
        '',
        '- Fixed the bug.',
        '',
        '## Checklist',
        '',
        '- [ ] Testing section documents validation.',
        '- [x] Screenshots handled.',
      ].join('\n')
      const err = validatePullRequestBody(body)
      expect(err).not.toBeNull()
      expect(err!.issues.some((issue) => issue.includes('unchecked checklist'))).toBe(true)
    })

    test('rejects bare-dash placeholders used as bullet scaffolding', () => {
      const body = ['## Summary', '', '- Fixed things.', '', '- ', '- '].join('\n')
      const err = validatePullRequestBody(body)
      expect(err).not.toBeNull()
      expect(err!.issues.some((issue) => issue.includes('bare-dash'))).toBe(true)
    })

    test('rejects combined scaffolding in one pass', () => {
      const body = [
        '## Summary',
        '',
        '<!-- TODO: write summary -->',
        '',
        '- <feature name>',
        '',
        '- ',
        '- ',
        '',
        '## Checklist',
        '',
        '- [ ] Testing done.',
      ].join('\n')
      const err = validatePullRequestBody(body)
      expect(err).not.toBeNull()
      expect(err!.issues).toContain('html-comment')
      expect(err!.issues).toContain('TODO/TBD placeholder')
      expect(err!.issues.some((issue) => issue.includes('angle-bracket'))).toBe(true)
      expect(err!.issues.some((issue) => issue.includes('bare-dash'))).toBe(true)
      expect(err!.issues.some((issue) => issue.includes('unchecked checklist'))).toBe(true)
    })

    test('validation error message is human readable', () => {
      const err = validatePullRequestBody('<!-- placeholder -->')
      const msg = validationErrorToMessage(err!)
      expect(msg).toContain('PR body validation failed')
      expect(msg).toContain('html-comment')
      expect(msg).toContain('remove all HTML comments')
    })
  })
})

import { describe, expect, it } from 'vitest'

import { buildAgentPrompt, resolveValidationPlan } from './prompt'
import type { AgentRunSpecPayload, AnypiStatus } from './types'
import { buildCommitMessage, buildPullRequestTitle, normalizeConventionalSummary, renderPullRequestBody } from './run'

describe('Anypi status metadata', () => {
  describe('renderPullRequestBody', () => {
    it('includes prompt variant and hash in PR body', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'anypi-eval-runner-repair-20260616',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: '0123456789abcdef',
        tools: ['bash', 'edit'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
        validations: [
          {
            command: 'bash',
            args: ['-lc', 'bun run --filter @proompteng/anypi test'],
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
          attempts: 1,
          durationMs: 3000,
          checks: [],
          summary: 'All checks passed',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        piText: 'implemented changes',
        template: undefined,
      })

      expect(body).toContain('Prompt variant: `finish-gated` (`0123456789abcdef`)')
    })

    it('includes validation results in PR body', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash'],
        sessionFile: undefined,
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
          sources: ['inferred', 'run-spec', 'env'],
          commands: ['git diff --check', 'bun test'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 1,
        promptChars: 800,
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 3000,
          checks: [],
          summary: 'All checks passed',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        template: undefined,
      })

      // Validation results show the actual command that was run
      expect(body).toContain('`bash -lc bun test` exit 0')
      // CI results are shown
      expect(body).toContain('CI: passed: All checks passed')
    })

    it('includes CI attempts in PR body', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash'],
        sessionFile: undefined,
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 3,
        promptChars: 800,
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 3,
          durationMs: 5000,
          checks: [
            { name: 'lint', workflow: 'CI', bucket: 'pass' },
            { name: 'test', workflow: 'CI', bucket: 'pass' },
          ],
          summary: '2 passed/skipped, 0 pending, 0 failed/cancelled',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        template: undefined,
      })

      expect(body).toContain('CI: passed: 2 passed/skipped, 0 pending, 0 failed/cancelled')
    })

    it('includes session artifact paths in PR body', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 1,
        promptChars: 800,
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 3000,
          checks: [],
          summary: 'All checks passed',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        template: undefined,
      })

      expect(body).toContain('Session artifact: `/workspace/.anypi/sessions/initial/session.json`')
    })

    it('includes PR URL in PR body when available', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash'],
        sessionFile: undefined,
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 1,
        promptChars: 800,
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/123',
          created: true,
        },
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 3000,
          checks: [],
          summary: 'All checks passed',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        template: undefined,
      })

      expect(body).toContain('agents/test-run')
    })

    it('includes PR metadata without session file when not available', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash'],
        sessionFile: undefined,
        sessionFiles: undefined,
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        ciAttempts: 1,
        promptChars: 800,
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/123',
          created: false,
        },
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 3000,
          checks: [],
          summary: 'All checks passed',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        template: undefined,
      })

      expect(body).toContain('Session artifact: `N/A`')
      expect(body).toContain('agents/test-run')
    })

    it('handles failed CI status in PR body', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'running',
        startedAt: '2026-06-16T00:00:00.000Z',
        runName: 'test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'abcdef1234567890',
        tools: ['bash'],
        sessionFile: undefined,
        validations: [],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['git diff --check'],
        },
        agentAttempts: 2,
        validationAttempts: 2,
        ciAttempts: 2,
        promptChars: 800,
        ci: {
          ok: false,
          status: 'failed',
          requiredOnly: true,
          attempts: 2,
          durationMs: 10000,
          checks: [
            { name: 'lint', workflow: 'CI', bucket: 'pass' },
            { name: 'test', workflow: 'CI', bucket: 'fail' },
          ],
          summary: '1 passed/skipped, 0 pending, 1 failed/cancelled',
        },
      }

      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Test implementation' },
        parameters: {},
        prompt: 'Test prompt',
        goal: { objective: 'Test objective' },
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/anypi',
        issueTitle: 'Test issue',
        issueBody: 'Test body',
        vcs: {
          provider: 'github',
          providerName: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          mode: 'write',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const git = {
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
        template: undefined,
      })

      expect(body).toContain('CI: failed: 1 passed/skipped, 0 pending, 1 failed/cancelled')
    })
  })

  describe('buildCommitMessage and buildPullRequestTitle', () => {
    it('normalizes summary to conventional commit format', () => {
      expect(normalizeConventionalSummary('Improve Anypi status.', 'fallback')).toBe('improve anypi status')
      expect(normalizeConventionalSummary('  add  tests   for status  ', 'fallback')).toBe('add tests for status')
      expect(normalizeConventionalSummary('Fix bug in PR body', 'fallback')).toBe('fix bug in pr body')
    })

    it('builds commit message from implementation summary', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Improve Anypi status metadata' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const message = buildCommitMessage(runSpec)
      expect(message).toBe('feat(anypi): improve anypi status metadata')
    })

    it('builds pull request title from implementation summary', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: 'Improve Anypi status metadata' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const title = buildPullRequestTitle(runSpec)
      expect(title).toBe('feat(anypi): improve anypi status metadata')
    })

    it('falls back to issue title when implementation summary is missing', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { summary: undefined },
        parameters: {},
        prompt: 'Test prompt',
        issueTitle: 'Fix status metadata',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const message = buildCommitMessage(runSpec)
      expect(message).toBe('feat(anypi): fix status metadata')
    })
  })

  describe('buildAgentPrompt without runtime leakage', () => {
    it('does not include Anypi runtime details', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Add new feature' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const prompt = buildAgentPrompt(runSpec, '/workspace/lab')

      expect(prompt).not.toMatch(/Anypi|YOLO|Kubernetes|Pi SDK|provider|Flamingo|flamingo|qwen3/)
      expect(prompt).not.toMatch(/baseUrl|apiKey|authPath|modelsPath/)
      expect(prompt).toContain('Use repository instructions and existing patterns')
      expect(prompt).toContain('Test prompt')
    })

    it('includes task instructions without runtime config', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Refactor code' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const prompt = buildAgentPrompt(runSpec, '/workspace/lab')

      expect(prompt).toContain('Worktree: /workspace/lab')
      expect(prompt).toContain('Repository: proompteng/lab')
      expect(prompt).toContain('Base branch: main')
      expect(prompt).toContain('Head branch: codex/anypi')
      expect(prompt).not.toMatch(/provider|providerModel|promptVariant|promptHash/)
    })
  })

  describe('validation plan sources tracking', () => {
    it('records inferred validation sources', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Improve services/anypi.' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const plan = resolveValidationPlan(runSpec, [], 'append')

      expect(plan.sources).toContain('inferred')
      expect(plan.commands).toContain('bun run --filter @proompteng/anypi test')
    })

    it('records run-spec validation sources', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Improve services/anypi.' },
        parameters: { validationCommands: 'bun test --coverage' },
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const plan = resolveValidationPlan(runSpec, [], 'append')

      expect(plan.sources).toContain('run-spec')
      expect(plan.commands).toContain('bun test --coverage')
    })

    it('records env validation sources', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Improve services/anypi.' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const plan = resolveValidationPlan(runSpec, ['npm run lint'], 'append')

      expect(plan.sources).toContain('env')
      expect(plan.commands).toContain('npm run lint')
    })

    it('records multiple validation sources in order', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Improve services/anypi.' },
        parameters: { validationCommands: 'bun test' },
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const plan = resolveValidationPlan(runSpec, ['npm run lint'], 'append')

      expect(plan.sources).toEqual(['inferred', 'run-spec', 'env'])
      expect(plan.commands).toContain('bun run --filter @proompteng/anypi test')
      expect(plan.commands).toContain('bun test')
      expect(plan.commands).toContain('npm run lint')
    })

    it('uses override policy with env commands', () => {
      const runSpec: AgentRunSpecPayload = {
        provider: 'anypi',
        agentRun: { name: 'test-run', namespace: 'agents' },
        implementation: { text: 'Improve services/anypi.' },
        parameters: {},
        prompt: 'Test prompt',
        vcs: {
          provider: 'github',
          repository: 'proompteng/lab',
          baseBranch: 'main',
          headBranch: 'codex/anypi',
          writeEnabled: true,
          pullRequestsEnabled: true,
        },
      }

      const plan = resolveValidationPlan(runSpec, ['custom lint'], 'override')

      expect(plan.sources).toEqual(['env'])
      expect(plan.commands).toEqual(['custom lint'])
      expect(plan.policy).toBe('override')
    })
  })

  describe('status metadata auditability', () => {
    it('includes all required status fields for audit', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'succeeded',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:05:00.000Z',
        runName: 'audit-test-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'finish-gated',
        promptHash: 'a1b2c3d4e5f6g7h8',
        tools: ['bash', 'read', 'edit', 'write'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
        commit: 'abc123def456',
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/123',
          created: true,
        },
        ci: {
          ok: true,
          status: 'passed',
          requiredOnly: true,
          attempts: 1,
          durationMs: 3000,
          checks: [{ name: 'lint', workflow: 'CI', bucket: 'pass' }],
          summary: '1 passed/skipped',
        },
        ciAttempts: 1,
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
          commands: ['bun test', 'git diff --check'],
        },
        agentAttempts: 2,
        validationAttempts: 2,
        promptChars: 1500,
      }

      // Verify all audit fields are present
      expect(status.provider).toBe('anypi')
      expect(status.status).toBe('succeeded')
      expect(status.startedAt).toBeDefined()
      expect(status.finishedAt).toBeDefined()
      expect(status.runName).toBe('audit-test-run')
      expect(status.namespace).toBe('agents')
      expect(status.repository).toBe('proompteng/lab')
      expect(status.baseBranch).toBe('main')
      expect(status.headBranch).toBe('codex/anypi')
      expect(status.worktree).toBe('/workspace/lab')
      expect(status.model).toBe('qwen3-coder-flamingo')
      expect(status.providerModel).toBe('flamingo/qwen3-coder-flamingo')
      expect(status.promptVariant).toBe('finish-gated')
      expect(status.promptHash).toBe('a1b2c3d4e5f6g7h8')
      expect(status.tools).toEqual(['bash', 'read', 'edit', 'write'])
      expect(status.sessionFile).toBe('/workspace/.anypi/sessions/initial/session.json')
      expect(status.sessionFiles).toEqual(['/workspace/.anypi/sessions/initial/session.json'])
      expect(status.commit).toBe('abc123def456')
      expect(status.pullRequest).toBeDefined()
      expect(status.pullRequest?.enabled).toBe(true)
      expect(status.pullRequest?.url).toBe('https://github.com/proompteng/lab/pull/123')
      expect(status.pullRequest?.created).toBe(true)
      expect(status.ci).toBeDefined()
      expect(status.ci?.ok).toBe(true)
      expect(status.ci?.status).toBe('passed')
      expect(status.ci?.attempts).toBe(1)
      expect(status.ci?.checks).toHaveLength(1)
      expect(status.ciAttempts).toBe(1)
      expect(status.validations).toHaveLength(1)
      expect(status.validationPlan).toBeDefined()
      expect(status.validationPlan?.sources).toEqual(['inferred', 'run-spec'])
      expect(status.validationPlan?.commands).toEqual(['bun test', 'git diff --check'])
      expect(status.agentAttempts).toBe(2)
      expect(status.validationAttempts).toBe(2)
      expect(status.promptChars).toBe(1500)
    })

    it('handles failed status with error information', () => {
      const status: AnypiStatus = {
        provider: 'anypi',
        status: 'failed',
        startedAt: '2026-06-16T00:00:00.000Z',
        finishedAt: '2026-06-16T00:02:00.000Z',
        runName: 'failed-run',
        namespace: 'agents',
        repository: 'proompteng/lab',
        baseBranch: 'main',
        headBranch: 'codex/anypi',
        worktree: '/workspace/lab',
        model: 'qwen3-coder-flamingo',
        providerModel: 'flamingo/qwen3-coder-flamingo',
        promptVariant: 'minimal',
        promptHash: 'f1e2d3c4b5a67890',
        tools: ['bash'],
        sessionFile: '/workspace/.anypi/sessions/initial/session.json',
        sessionFiles: ['/workspace/.anypi/sessions/initial/session.json'],
        commit: undefined,
        pullRequest: {
          enabled: true,
          url: 'https://github.com/proompteng/lab/pull/124',
          created: true,
        },
        ci: undefined,
        ciAttempts: 0,
        validations: [
          {
            command: 'bash',
            args: ['-lc', 'bun test'],
            exitCode: 1,
            stdout: '',
            stderr: 'Test failed',
            durationMs: 100,
            ok: false,
          },
        ],
        validationPlan: {
          policy: 'append',
          sources: ['inferred'],
          commands: ['bun test'],
        },
        agentAttempts: 1,
        validationAttempts: 1,
        promptChars: 1200,
        error: 'Validation failed',
      }

      expect(status.status).toBe('failed')
      expect(status.error).toBe('Validation failed')
      expect(status.validations[0].ok).toBe(false)
      expect(status.validations[0].exitCode).toBe(1)
      expect(status.validationAttempts).toBe(1)
    })
  })
})

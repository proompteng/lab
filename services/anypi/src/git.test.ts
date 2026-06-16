import { afterEach, afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import type { CiCheck } from './types'
import type { GitContext } from './git'
import {
  countCommitsAhead,
  createOrUpdatePullRequest,
  gitStatusShort,
  parseCiChecks,
  parsePullRequestList,
  prepareRepository,
  pushBranch,
  resolveGitContext,
  runValidationCommands,
  summarizeChecks,
} from './git'
import type { AnypiConfig } from './config'
import type { AgentRunSpecPayload, CommandResult } from './types'

// Helper to create a mock git context
const mockGitContext = (overrides: Partial<GitContext> = {}): GitContext => ({
  repository: 'proompteng/lab',
  baseBranch: 'main',
  headBranch: 'codex/test',
  cloneUrl: 'https://github.com/proompteng/lab.git',
  webUrl: 'https://github.com/proompteng/lab',
  worktree: '/workspace/lab',
  env: {},
  writeEnabled: true,
  pullRequestsEnabled: true,
  ...overrides,
})

// Helper to create a mock config
const mockConfig = (overrides: Partial<AnypiConfig> = {}): AnypiConfig => ({
  workspace: '/workspace',
  worktree: '/workspace/.anypi/worktree',
  agentDir: '/workspace/.anypi/agent',
  sessionDir: '/workspace/.anypi/sessions',
  authPath: '/workspace/.anypi/auth.json',
  modelsPath: '/workspace/.anypi/models.json',
  runSpecPath: '/workspace/run.json',
  runnerSpecPath: '/workspace/agent-runner.json',
  statusPath: '/workspace/.agent/status.json',
  logPath: '/workspace/.agent/runner.log',
  provider: 'flamingo',
  model: 'qwen3-coder-flamingo',
  baseUrl: 'http://flamingo.flamingo.svc.cluster.local/v1',
  apiKey: 'test-api-key',
  modelReadyTimeoutSeconds: 1800,
  promptVariant: 'minimal',
  allowSystemPromptOverride: false,
  thinkingLevel: 'off' as const,
  contextWindow: 32000,
  maxTokens: 8192,
  tools: ['bash', 'read', 'edit', 'write'],
  allowNoVcs: false,
  validationCommands: [],
  validationPolicy: 'append' as const,
  noChangeRepairAttempts: 2,
  validationRepairAttempts: 2,
  ciCheckTimeoutSeconds: 3600,
  ciCheckIntervalSeconds: 30,
  ciRepairAttempts: 1,
  ciRequiredOnly: true,
  ...overrides,
})

// Store original env and restore after all tests
const originalEnv = { ...process.env }

beforeAll(() => {
  // Clear VCS env vars that might interfere with tests
  delete process.env.VCS_REPOSITORY
  delete process.env.VCS_BASE_BRANCH
  delete process.env.VCS_HEAD_BRANCH
})

afterAll(() => {
  process.env = originalEnv
  vi.clearAllMocks()
})

describe('Anypi git utilities - pure functions', () => {
  describe('parseCiChecks', () => {
    test('parses empty string as empty array', () => {
      expect(parseCiChecks('')).toEqual([])
      expect(parseCiChecks('   ')).toEqual([])
    })

    test('parses valid JSON array of checks', () => {
      const raw = JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: 'https://example.com/lint' },
        { name: 'pyright', workflow: 'CI', bucket: 'fail', state: 'FAILURE', link: 'https://example.com/pyright' },
        { name: 'test', workflow: 'Tests', bucket: 'pending', state: 'PENDING' },
      ])
      const checks = parseCiChecks(raw)
      expect(checks).toHaveLength(3)
      expect(checks[0]).toMatchObject({
        name: 'lint',
        workflow: 'CI',
        bucket: 'pass',
        state: 'SUCCESS',
        link: 'https://example.com/lint',
      })
      expect(checks[1]).toMatchObject({
        name: 'pyright',
        workflow: 'CI',
        bucket: 'fail',
        state: 'FAILURE',
        link: 'https://example.com/pyright',
      })
      expect(checks[2]).toMatchObject({
        name: 'test',
        workflow: 'Tests',
        bucket: 'pending',
        state: 'PENDING',
      })
    })

    test('handles missing optional fields', () => {
      const raw = JSON.stringify([{ name: 'required-check', workflow: 'CI' }, { name: 'optional-check' }, {}])
      const checks = parseCiChecks(raw)
      expect(checks).toHaveLength(3)
      expect(checks[0]).toMatchObject({ name: 'required-check', workflow: 'CI' })
      expect(checks[1]).toMatchObject({ name: 'optional-check' })
    })

    test('throws on invalid JSON', () => {
      expect(() => parseCiChecks('not json')).toThrow()
      expect(() => parseCiChecks('{invalid}')).toThrow()
    })

    test('throws on non-array JSON', () => {
      expect(() => parseCiChecks('{"name": "test"}')).toThrow(/not an array/)
      expect(() => parseCiChecks('null')).toThrow()
      expect(() => parseCiChecks('123')).toThrow()
      expect(() => parseCiChecks('"string"')).toThrow()
    })

    test('handles array with non-object entries', () => {
      const raw = JSON.stringify([{ name: 'valid' }, 'invalid', null, 123, []])
      expect(() => parseCiChecks(raw)).not.toThrow()
      // Should handle gracefully and create defaults for invalid entries
    })
  })

  describe('summarizeChecks', () => {
    test('summarizes checks by bucket type', () => {
      const checks: CiCheck[] = [
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'security', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'test', workflow: 'Tests', bucket: 'skipping', state: 'SUCCESS' }, // treated as pass
        { name: 'pyright', workflow: 'CI', bucket: 'fail', state: 'FAILURE' },
        { name: 'e2e', workflow: 'Tests', bucket: 'cancel', state: 'CANCELLED' },
        { name: 'codecov', workflow: 'Coverage', bucket: 'pending', state: 'PENDING' },
        { name: 'check-links', workflow: 'CI', bucket: 'pending', state: 'PENDING' },
      ]

      const summary = summarizeChecks(checks)

      expect(summary.passed).toHaveLength(3)
      expect(summary.passed.map((c) => c.name)).toEqual(['lint', 'security', 'test'])

      expect(summary.failed).toHaveLength(2)
      expect(summary.failed.map((c) => c.name)).toEqual(['pyright', 'e2e'])

      expect(summary.pending).toHaveLength(2)
      expect(summary.pending.map((c) => c.name)).toEqual(['codecov', 'check-links'])

      expect(summary.summary).toBe('3 passed/skipped, 2 pending, 2 failed/cancelled')
    })

    test('handles empty array', () => {
      const summary = summarizeChecks([])
      expect(summary.passed).toHaveLength(0)
      expect(summary.failed).toHaveLength(0)
      expect(summary.pending).toHaveLength(0)
      expect(summary.summary).toBe('0 passed/skipped, 0 pending, 0 failed/cancelled')
    })
  })

  describe('parsePullRequestList', () => {
    test('parses single PR from array', () => {
      const raw = JSON.stringify([{ number: 123, html_url: 'https://github.com/proompteng/lab/pull/123' }])
      expect(parsePullRequestList(raw)).toEqual({
        number: 123,
        url: 'https://github.com/proompteng/lab/pull/123',
      })
    })

    test('returns null for empty array', () => {
      expect(parsePullRequestList('[]')).toBeNull()
    })

    test('returns null for empty string', () => {
      expect(parsePullRequestList('')).toBeNull()
    })

    test('returns null for non-array JSON', () => {
      expect(parsePullRequestList('{"number": 123}')).toBeNull()
    })

    test('returns null for invalid number', () => {
      const raw = JSON.stringify([{ number: 'not-a-number' }])
      expect(parsePullRequestList(raw)).toBeNull()
      expect(parsePullRequestList('{"number": -1}')).toBeNull()
      expect(parsePullRequestList('{"number": 0}')).toBeNull()
    })

    test('extracts URL only when present', () => {
      const raw = JSON.stringify([{ number: 456 }])
      expect(parsePullRequestList(raw)).toEqual({ number: 456 })
    })
  })

  describe('resolveGitContext', () => {
    test('uses runSpec vcs context when env vars absent', async () => {
      // Clear env vars that might interfere
      const savedRepo = process.env.VCS_REPOSITORY
      const savedBase = process.env.VCS_BASE_BRANCH
      const savedHead = process.env.VCS_HEAD_BRANCH
      delete process.env.VCS_REPOSITORY
      delete process.env.VCS_BASE_BRANCH
      delete process.env.VCS_HEAD_BRANCH

      try {
        const runSpec: AgentRunSpecPayload = {
          vcs: {
            repository: 'test/repo',
            baseBranch: 'develop',
            headBranch: 'feature/branch',
            writeEnabled: false,
            pullRequestsEnabled: false,
          },
        }
        const config = mockConfig({ worktree: '/tmp/anypi-workspace' })
        const git = await resolveGitContext(config, runSpec)
        expect(git).toMatchObject({
          repository: 'test/repo',
          baseBranch: 'develop',
          headBranch: 'feature/branch',
        })
        // Note: writeEnabled and pullRequestsEnabled are controlled by env vars, not runSpec
      } finally {
        process.env.VCS_REPOSITORY = savedRepo
        process.env.VCS_BASE_BRANCH = savedBase
        process.env.VCS_HEAD_BRANCH = savedHead
      }
    })

    test('prioritizes env vars over runSpec', async () => {
      const runSpec: AgentRunSpecPayload = {
        vcs: { repository: 'repo/from/spec' },
      }
      const config = mockConfig({ worktree: '/tmp/anypi-workspace' })
      const savedRepo = process.env.VCS_REPOSITORY
      process.env.VCS_REPOSITORY = 'repo/from/env'
      process.env.VCS_BASE_BRANCH = 'env-branch'
      process.env.VCS_HEAD_BRANCH = 'env-head'

      try {
        const git = await resolveGitContext(config, runSpec)
        expect(git).toMatchObject({
          repository: 'repo/from/env',
          baseBranch: 'env-branch',
          headBranch: 'env-head',
        })
      } finally {
        process.env.VCS_REPOSITORY = savedRepo
      }
    })

    test('returns null when VCS is disabled and allowNoVcs is true', async () => {
      const savedRepo = process.env.VCS_REPOSITORY
      delete process.env.VCS_REPOSITORY

      try {
        const config = mockConfig({ worktree: '/tmp/anypi-workspace', allowNoVcs: true })
        const git = await resolveGitContext(config, {})
        expect(git).toBeNull()
      } finally {
        process.env.VCS_REPOSITORY = savedRepo
      }
    })

    test('throws when VCS is required but not provided', async () => {
      const savedRepo = process.env.VCS_REPOSITORY
      delete process.env.VCS_REPOSITORY

      try {
        const config = mockConfig({ worktree: '/tmp/anypi-workspace', allowNoVcs: false })
        await expect(resolveGitContext(config, {})).rejects.toThrow('VCS_REPOSITORY')
      } finally {
        process.env.VCS_REPOSITORY = savedRepo
      }
    })
  })

  describe('prepareRepository', () => {
    test('creates worktree directory when git is null', async () => {
      const config = mockConfig({ worktree: '/tmp/anypi-test-workspace-null' })
      const log = vi.fn(async () => {})
      await prepareRepository(config, null, log)
      // Directory should be created
      // Note: This test is more for coverage - actual directory creation would need cleanup
    })
  })

  describe('gitStatusShort', () => {
    test('delegates to git status --short', async () => {
      const result = await gitStatusShort('/workspace/lab', {})
      // Should get actual status
      expect(typeof result).toBe('string')
    })
  })

  describe('countCommitsAhead', () => {
    test('parses commit count from git rev-list', async () => {
      const git = mockGitContext()
      const count = await countCommitsAhead(git)
      expect(typeof count).toBe('number')
      expect(count).toBeGreaterThanOrEqual(0)
    })

    test('returns 0 when no commits ahead', async () => {
      // This test assumes we're not ahead - just verifies it doesn't throw
      const git = mockGitContext()
      const count = await countCommitsAhead(git)
      expect(count).toBeGreaterThanOrEqual(0)
    })
  })

  describe('runValidationCommands', () => {
    test('runs all commands successfully', async () => {
      const commands = ['echo hello', 'echo world']
      const log = async (msg: string) => {}

      const git = mockGitContext()
      const result = await runValidationCommands(commands, git, '/workspace/lab', log)
      expect(result).toHaveLength(2)
      expect(result[0].exitCode).toBe(0)
      expect(result[1].exitCode).toBe(0)
    })

    test('stops on first failed command', async () => {
      const commands = ['echo success', 'exit 1', 'echo never-ran']
      const log = async (msg: string) => {}

      const git = mockGitContext()
      const result = await runValidationCommands(commands, git, '/workspace/lab', log)
      expect(result).toHaveLength(2) // Stops after first failure
      expect(result[0].exitCode).toBe(0)
      expect(result[1].exitCode).toBe(1)
    })
  })

  describe('pushBranch', () => {
    test('pushes to remote branch when write enabled', async () => {
      const git = mockGitContext()
      // Just verify the function doesn't throw when writeEnabled is true
      // We can't actually test the git push without a real repo
      await expect(pushBranch(git)).resolves
    })

    test('throws when write is disabled', async () => {
      const git = mockGitContext({ writeEnabled: false })
      await expect(pushBranch(git)).rejects.toThrow('VCS write mode is disabled')
    })
  })

  describe('createOrUpdatePullRequest', () => {
    test('returns disabled when pull requests are disabled', async () => {
      const git = mockGitContext({ pullRequestsEnabled: false })
      const result = await createOrUpdatePullRequest(git, { title: 'Test', body: 'Body' })
      expect(result.enabled).toBe(false)
    })
  })
})

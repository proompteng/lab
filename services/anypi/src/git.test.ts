import { describe, expect, test, vi } from 'vitest'

import type { GitContext } from './git'
import type { AnypiStatus, CommandResult } from './types'

// Mock runCommand and runShell before importing modules
vi.mock('./command', async () => {
  const actual = await vi.importActual('./command')
  return {
    ...actual,
    runCommand: vi.fn(),
    runShell: vi.fn(),
  }
})

describe('Anypi git context', () => {
  test('parses pull request list from GitHub API', async () => {
    const git = await import('./git')
    expect(
      git.parsePullRequestList(
        JSON.stringify([{ number: 123, html_url: 'https://github.com/proompteng/lab/pull/123' }]),
      ),
    ).toEqual({
      number: 123,
      url: 'https://github.com/proompteng/lab/pull/123',
    })
  })

  test('returns null for empty pull request list', async () => {
    const git = await import('./git')
    expect(git.parsePullRequestList('[]')).toBeNull()
  })

  test('returns null for malformed pull request list', async () => {
    const git = await import('./git')
    expect(git.parsePullRequestList(JSON.stringify([{ number: 'invalid' }]))).toBeNull()
    expect(git.parsePullRequestList(JSON.stringify([{ number: -1 }]))).toBeNull()
  })
})

describe('Anypi CI checks parsing', () => {
  test('parses GitHub checks JSON with all fields', async () => {
    const { parseCiChecks } = await import('./git')
    const raw = JSON.stringify([
      {
        name: 'lint',
        workflow: 'CI',
        state: 'SUCCESS',
        bucket: 'pass',
        link: 'https://github.com/proompteng/lab/actions/runs/123',
      },
      {
        name: 'pyright',
        workflow: 'Type Check',
        state: 'FAILURE',
        bucket: 'fail',
        link: 'https://github.com/proompteng/lab/actions/runs/456',
      },
    ])
    const checks = parseCiChecks(raw)
    expect(checks).toHaveLength(2)
    expect(checks[0]).toMatchObject({
      name: 'lint',
      workflow: 'CI',
      bucket: 'pass',
      state: 'SUCCESS',
      link: 'https://github.com/proompteng/lab/actions/runs/123',
    })
    expect(checks[1]).toMatchObject({
      name: 'pyright',
      workflow: 'Type Check',
      bucket: 'fail',
      state: 'FAILURE',
    })
  })

  test('handles missing optional fields in checks', async () => {
    const { parseCiChecks } = await import('./git')
    const raw = JSON.stringify([
      { name: 'simple-check', bucket: 'pass' },
      { name: 'another-check', workflow: 'Build', bucket: 'pending' },
    ])
    const checks = parseCiChecks(raw)
    expect(checks[0]).toMatchObject({ name: 'simple-check', bucket: 'pass', workflow: undefined })
    expect(checks[1]).toMatchObject({ name: 'another-check', workflow: 'Build' })
  })

  test('summarizes checks by bucket status', async () => {
    const { parseCiChecks, summarizeChecks } = await import('./git')
    const checks = parseCiChecks(
      JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'format', workflow: 'CI', bucket: 'skipping', state: 'SUCCESS' },
        { name: 'pyright', workflow: 'Type Check', bucket: 'fail', state: 'FAILURE' },
        { name: 'test', workflow: 'CI', bucket: 'pending', state: 'PENDING' },
      ]),
    )
    const summary = summarizeChecks(checks)
    expect(summary.passed).toHaveLength(2)
    expect(summary.pending).toHaveLength(1)
    expect(summary.failed).toHaveLength(1)
    expect(summary.summary).toBe('2 passed/skipped, 1 pending, 1 failed/cancelled')
  })

  test('handles empty checks array', async () => {
    const { parseCiChecks, summarizeChecks } = await import('./git')
    const checks = parseCiChecks('[]')
    expect(checks).toEqual([])
    expect(summarizeChecks(checks)).toMatchObject({
      passed: [],
      pending: [],
      failed: [],
      summary: '0 passed/skipped, 0 pending, 0 failed/cancelled',
    })
  })
})

describe('Anypi CI wait result handling', () => {
  test('returns failed when any check has failed bucket', async () => {
    const { waitForPullRequestChecks } = await import('./git')
    const { runCommand } = await import('./command')

    const mockGit: GitContext = {
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

    const log = vi.fn(async () => {})
    vi.mocked(runCommand).mockResolvedValueOnce({
      command: 'gh',
      args: [
        'pr',
        'checks',
        'codex/test',
        '--repo',
        'proompteng/lab',
        '--json',
        'name,workflow,state,bucket,link',
        '--required',
      ],
      cwd: '/workspace/lab',
      exitCode: 0,
      stdout: JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass' },
        { name: 'test', workflow: 'CI', bucket: 'fail' },
      ]),
      stderr: '',
      durationMs: 100,
    })

    const result = await waitForPullRequestChecks(
      mockGit,
      { timeoutSeconds: 10, intervalSeconds: 1, requiredOnly: true },
      log,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.requiredOnly).toBe(true)
    expect(result.summary).toContain('1 failed/cancelled')
    expect(result.checks).toHaveLength(2)
    expect(log).toHaveBeenCalledWith('ci checks: 1 passed/skipped, 0 pending, 1 failed/cancelled')
  })

  test('returns passed when all checks pass and none pending', async () => {
    const { waitForPullRequestChecks } = await import('./git')
    const { runCommand } = await import('./command')

    const mockGit: GitContext = {
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

    const log = vi.fn(async () => {})
    vi.mocked(runCommand).mockResolvedValueOnce({
      command: 'gh',
      args: [
        'pr',
        'checks',
        'codex/test',
        '--repo',
        'proompteng/lab',
        '--json',
        'name,workflow,state,bucket,link',
        '--required',
      ],
      cwd: '/workspace/lab',
      exitCode: 0,
      stdout: JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass' },
        { name: 'test', workflow: 'CI', bucket: 'pass' },
      ]),
      stderr: '',
      durationMs: 100,
    })

    const result = await waitForPullRequestChecks(
      mockGit,
      { timeoutSeconds: 10, intervalSeconds: 1, requiredOnly: true },
      log,
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe('passed')
    expect(result.summary).toBe('2 passed/skipped, 0 pending, 0 failed/cancelled')
  })

  test('falls back to all checks when required-only returns empty', async () => {
    const { waitForPullRequestChecks } = await import('./git')
    const { runCommand } = await import('./command')

    const mockGit: GitContext = {
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

    const log = vi.fn(async () => {})
    // First call with --required returns empty
    // Second call without --required returns checks
    vi.mocked(runCommand)
      .mockResolvedValueOnce({
        command: 'gh',
        args: [
          'pr',
          'checks',
          'codex/test',
          '--repo',
          'proompteng/lab',
          '--json',
          'name,workflow,state,bucket,link',
          '--required',
        ],
        cwd: '/workspace/lab',
        exitCode: 0,
        stdout: '[]',
        stderr: '',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        command: 'gh',
        args: ['pr', 'checks', 'codex/test', '--repo', 'proompteng/lab', '--json', 'name,workflow,state,bucket,link'],
        cwd: '/workspace/lab',
        exitCode: 0,
        stdout: JSON.stringify([{ name: 'lint', workflow: 'CI', bucket: 'pass' }]),
        stderr: '',
        durationMs: 100,
      })

    const result = await waitForPullRequestChecks(
      mockGit,
      { timeoutSeconds: 10, intervalSeconds: 1, requiredOnly: true },
      log,
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe('passed')
    expect(result.requiredOnly).toBe(false) // Should have fallen back
    expect(log).toHaveBeenCalledWith('ci checks: no required checks reported; falling back to all pull request checks')
    expect(log).toHaveBeenCalledWith('ci checks: 1 passed/skipped, 0 pending, 0 failed/cancelled')
  })

  test('returns timed-out when checks remain pending past timeout', async () => {
    const { waitForPullRequestChecks } = await import('./git')
    const { runCommand } = await import('./command')

    const mockGit: GitContext = {
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

    const log = vi.fn(async () => {})
    // Always return checks with pending status
    vi.mocked(runCommand).mockResolvedValue({
      command: 'gh',
      args: [
        'pr',
        'checks',
        'codex/test',
        '--repo',
        'proompteng/lab',
        '--json',
        'name,workflow,state,bucket,link',
        '--required',
      ],
      cwd: '/workspace/lab',
      exitCode: 0,
      stdout: JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass' },
        { name: 'test', workflow: 'CI', bucket: 'pending' },
      ]),
      stderr: '',
      durationMs: 100,
    })

    const result = await waitForPullRequestChecks(
      mockGit,
      { timeoutSeconds: 2, intervalSeconds: 1, requiredOnly: true },
      log,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe('timed-out')
    expect(result.requiredOnly).toBe(true)
    expect(result.summary).toBe('1 passed/skipped, 1 pending, 0 failed/cancelled')
    expect(result.checks).toHaveLength(2)
  })

  test('returns unavailable when gh command fails with invalid JSON', async () => {
    const { waitForPullRequestChecks } = await import('./git')
    const { runCommand } = await import('./command')

    const mockGit: GitContext = {
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

    const log = vi.fn(async () => {})
    // Set the command to return invalid JSON which will throw in parseCiChecks
    vi.mocked(runCommand).mockResolvedValue({
      command: 'gh',
      args: [
        'pr',
        'checks',
        'codex/test',
        '--repo',
        'proompteng/lab',
        '--json',
        'name,workflow,state,bucket,link',
        '--required',
      ],
      cwd: '/workspace/lab',
      exitCode: 1,
      stdout: 'not valid json',
      stderr: 'error: failed to fetch checks',
      durationMs: 100,
    })

    const result = await waitForPullRequestChecks(
      mockGit,
      { timeoutSeconds: 1, intervalSeconds: 0.1, requiredOnly: true }, // Short timeout for faster test
      log,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe('unavailable')
    expect(result.summary).toContain('Unexpected token')
  })
})

describe('Anypi validation commands', () => {
  test('runs validation commands and reports results', async () => {
    const { runValidationCommands } = await import('./git')
    const { runShell } = await import('./command')

    vi.mocked(runShell)
      .mockResolvedValueOnce({
        command: 'bash',
        args: ['-lc', 'echo pass'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'pass',
        stderr: '',
        durationMs: 50,
      })
      .mockResolvedValueOnce({
        command: 'bash',
        args: ['-lc', 'exit 1'],
        cwd: '/workspace',
        exitCode: 1,
        stdout: '',
        stderr: 'failed',
        durationMs: 50,
      })

    const log = vi.fn(async () => {})

    const results = await runValidationCommands(['echo pass', 'exit 1'], null, '/workspace', log)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ exitCode: 0, stdout: 'pass' })
    expect(results[1]).toMatchObject({ exitCode: 1, stderr: 'failed' })
    expect(log).toHaveBeenCalledWith('validation: echo pass')
    expect(log).toHaveBeenCalledWith('validation: exit 1')
    expect(log).toHaveBeenCalledWith('validation failed (1): exit 1')
  })

  test('stops on first failed validation command', async () => {
    const { runValidationCommands } = await import('./git')
    const { runShell } = await import('./command')

    vi.mocked(runShell)
      .mockResolvedValueOnce({
        command: 'bash',
        args: ['-lc', 'exit 0'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 50,
      })
      .mockResolvedValueOnce({
        command: 'bash',
        args: ['-lc', 'exit 1'],
        cwd: '/workspace',
        exitCode: 1,
        stdout: '',
        stderr: '',
        durationMs: 50,
      })
      .mockResolvedValueOnce({
        command: 'bash',
        args: ['-lc', 'echo should not run'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'should not run',
        stderr: '',
        durationMs: 50,
      })

    const log = vi.fn(async () => {})

    const results = await runValidationCommands(['exit 0', 'exit 1', 'echo should not run'], null, '/workspace', log)

    expect(results).toHaveLength(2) // Should stop after first failure
    expect(results[0]).toMatchObject({ exitCode: 0 })
    expect(results[1]).toMatchObject({ exitCode: 1 })
  })
})

describe('Anypi commit operations', () => {
  test('countCommitsAhead returns 0 when no commits ahead', async () => {
    const { countCommitsAhead } = await import('./git')
    const { runShell } = await import('./command')

    vi.mocked(runShell).mockResolvedValue({
      command: 'git',
      args: [],
      cwd: '/workspace',
      exitCode: 0,
      stdout: '0',
      stderr: '',
      durationMs: 10,
    })

    const git: GitContext = {
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

    const count = await countCommitsAhead(git)
    expect(count).toBe(0)
  })

  test('commitIfNeeded returns null when no changes', async () => {
    const { commitIfNeeded } = await import('./git')
    const { runCommand, runShell } = await import('./command')

    vi.mocked(runCommand)
      .mockResolvedValue({
        command: 'git',
        args: ['status', '--short'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 10,
      })
      .mockResolvedValue({
        command: 'git',
        args: ['rev-list', '--count', 'origin/main..HEAD'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: '0',
        stderr: '',
        durationMs: 10,
      })

    const git: GitContext = {
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

    const commit = await commitIfNeeded(git, 'feat: test commit')
    expect(commit).toBeNull()
  })

  test('commitIfNeeded returns commit hash when changes exist', async () => {
    const { commitIfNeeded } = await import('./git')
    const { runCommand, runShell } = await import('./command')

    // Mock order for commitIfNeeded:
    // 1. git status --short (via gitStatusShort)
    // 2. git add -A (only if there are changes)
    // 3. git commit -m (only if there are changes)
    // 4. git rev-list --count (via countCommitsAhead using runShell)
    // 5. git rev-parse HEAD (to get the commit hash)
    vi.mocked(runCommand)
      .mockResolvedValueOnce({
        command: 'git',
        args: ['status', '--short'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'M file.ts',
        stderr: '',
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        command: 'git',
        args: ['add', '-A'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        command: 'git',
        args: ['commit', '-m', 'feat: test commit'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: '[codex/test abc1234] feat: test commit\n 1 file changed',
        stderr: '',
        durationMs: 100,
      })
      .mockResolvedValue({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'abc1234567890',
        stderr: '',
        durationMs: 10,
      })

    vi.mocked(runShell).mockResolvedValue({
      command: 'bash',
      args: ['-lc', 'git rev-list --count "origin/main..HEAD"'],
      cwd: '/workspace',
      exitCode: 0,
      stdout: '1',
      stderr: '',
      durationMs: 10,
    })

    const git: GitContext = {
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

    const commit = await commitIfNeeded(git, 'feat: test commit')
    expect(commit).toBe('abc1234567890')
  })
})

describe('Anypi git push operations', () => {
  test('pushBranch throws when write is disabled', async () => {
    const { pushBranch } = await import('./git')

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: false,
      pullRequestsEnabled: true,
    }

    await expect(pushBranch(git)).rejects.toThrow('VCS write mode is disabled')
  })

  test('pushBranch succeeds when write is enabled', async () => {
    const { pushBranch } = await import('./git')
    const { runCommand } = await import('./command')

    vi.mocked(runCommand).mockResolvedValue({
      command: 'git',
      args: ['push', '-u', 'origin', 'HEAD:codex/test'],
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'To github.com:proompteng/lab.git',
      stderr: '',
      durationMs: 1000,
    })

    const git: GitContext = {
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

    await expect(pushBranch(git)).resolves.not.toThrow()
  })
})

describe('Anypi PR operations', () => {
  test('createOrUpdatePullRequest returns disabled when PRs disabled', async () => {
    const { createOrUpdatePullRequest } = await import('./git')

    const git: GitContext = {
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/test',
      cloneUrl: 'https://github.com/proompteng/lab.git',
      webUrl: 'https://github.com/proompteng/lab',
      worktree: '/workspace/lab',
      env: {},
      writeEnabled: true,
      pullRequestsEnabled: false,
    }

    const result = await createOrUpdatePullRequest(git, {
      title: 'Test PR',
      body: 'Test body',
    })

    expect(result).toEqual({ enabled: false })
  })

  test('createOrUpdatePullRequest creates new PR when none exists', async () => {
    const { createOrUpdatePullRequest } = await import('./git')
    const { runCommand } = await import('./command')

    vi.mocked(runCommand)
      .mockResolvedValue({
        command: 'gh',
        args: [
          'api',
          'repos/proompteng/lab/pulls',
          '-X',
          'GET',
          '-f',
          'head=proompteng:codex/test',
          '-f',
          'state=open',
        ],
        cwd: '/workspace',
        exitCode: 1,
        stdout: '',
        stderr: 'No pull requests found',
        durationMs: 100,
      })
      .mockResolvedValue({
        command: 'gh',
        args: ['api', 'repos/proompteng/lab/pulls', '-X', 'POST', '--input', expect.any(String)],
        cwd: '/workspace',
        exitCode: 0,
        stdout: JSON.stringify({ number: 42, html_url: 'https://github.com/proompteng/lab/pull/42' }),
        stderr: '',
        durationMs: 200,
      })

    const git: GitContext = {
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

    const result = await createOrUpdatePullRequest(git, {
      title: 'Test PR',
      body: 'Test body',
    })

    expect(result).toEqual({ enabled: true, url: 'https://github.com/proompteng/lab/pull/42', created: true })
  })

  test('createOrUpdatePullRequest updates existing PR', async () => {
    const { createOrUpdatePullRequest } = await import('./git')
    const { runCommand } = await import('./command')

    // First call: GET to check for existing PR
    // Second call: PATCH to update existing PR
    vi.mocked(runCommand)
      .mockResolvedValueOnce({
        command: 'gh',
        args: [
          'api',
          'repos/proompteng/lab/pulls',
          '-X',
          'GET',
          '-f',
          'head=proompteng:codex/test',
          '-f',
          'state=open',
        ],
        cwd: '/workspace',
        exitCode: 0,
        stdout: JSON.stringify([{ number: 42, html_url: 'https://github.com/proompteng/lab/pull/42' }]),
        stderr: '',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        command: 'gh',
        args: ['api', 'repos/proompteng/lab/pulls/42', '-X', 'PATCH', '--input', expect.any(String)],
        cwd: '/workspace',
        exitCode: 0,
        stdout: JSON.stringify({ number: 42, html_url: 'https://github.com/proompteng/lab/pull/42' }),
        stderr: '',
        durationMs: 200,
      })

    const git: GitContext = {
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

    const result = await createOrUpdatePullRequest(git, {
      title: 'Updated PR',
      body: 'Updated body',
    })

    expect(result).toEqual({ enabled: true, url: 'https://github.com/proompteng/lab/pull/42', created: false })
  })
})

describe('Anypi git status', () => {
  test('gitStatusShort returns short status output', async () => {
    const { gitStatusShort } = await import('./git')
    const { runCommand } = await import('./command')

    vi.mocked(runCommand).mockResolvedValue({
      command: 'git',
      args: ['status', '--short'],
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'M  file.ts\n?? new.txt',
      stderr: '',
      durationMs: 10,
    })

    const status = await gitStatusShort('/workspace')
    expect(status).toBe('M  file.ts\n?? new.txt')
  })
})

describe('Anypi PR body testing output', () => {
  test('validationSummary formats validation results with CI status', async () => {
    const { validationSummary } = await import('./run')

    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'test-run',
      namespace: 'agents',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: '0123456789abcdef',
      tools: [],
      sessionFile: '/tmp/session.json',
      validations: [
        {
          command: 'bash',
          args: ['-lc', 'git diff --check'],
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 50,
          ok: true,
        },
      ],
      validationPlan: {
        policy: 'append',
        sources: ['inferred'],
        commands: ['git diff --check'],
      },
      agentAttempts: 1,
      validationAttempts: 1,
      ciAttempts: 0,
      promptChars: 500,
      ci: {
        ok: true,
        status: 'passed',
        requiredOnly: false,
        attempts: 2,
        durationMs: 2000,
        checks: [],
        summary: '1 passed/skipped, 0 pending, 0 failed/cancelled',
      },
    }

    const summary = validationSummary(status)
    expect(summary).toContain('git diff --check')
    expect(summary).toContain('exit 0')
    expect(summary).toContain('passed: 1 passed/skipped, 0 pending, 0 failed/cancelled')
  })

  test('validationSummary shows pending when no CI result yet', async () => {
    const { validationSummary } = await import('./run')

    const status: AnypiStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-16T00:00:00.000Z',
      runName: 'test-run',
      namespace: 'agents',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      promptVariant: 'minimal',
      promptHash: '0123456789abcdef',
      tools: [],
      sessionFile: '/tmp/session.json',
      validations: [],
      validationPlan: {
        policy: 'append',
        sources: [],
        commands: [],
      },
      agentAttempts: 0,
      validationAttempts: 0,
      ciAttempts: 0,
      promptChars: 500,
    }

    const summary = validationSummary(status)
    expect(summary).toContain('- N/A')
    expect(summary).toContain('Pending: pull request checks have not completed yet.')
  })
})

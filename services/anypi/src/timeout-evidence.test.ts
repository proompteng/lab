import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execFileSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

import { captureTimeoutEvidence, mergeTimeoutEvidence, TimeoutErrorWithEvidence } from './timeout-evidence'

describe('Anypi timeout evidence', () => {
  test('captures git branch, HEAD, status, and diff files on timeout', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-timeout-'))

    // Initialize a git repo
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })

    // Create an initial commit
    await writeFile(join(worktree, 'README.md'), '# Test\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })

    // Make some changes (uncommitted)
    await writeFile(join(worktree, 'README.md'), '# Test Updated\n', 'utf8')
    await writeFile(join(worktree, 'newfile.ts'), 'console.log("hello");\n', 'utf8')

    const evidence = await captureTimeoutEvidence(worktree, process.env)

    expect(evidence).toMatchObject({
      git: {
        branch: 'main',
        statusShort: expect.stringContaining('M'),
      },
    })
    expect(evidence.git.head).toMatch(/^[a-f0-9]{40}$/)
    expect(evidence.patchFile).toBeDefined()
    expect(evidence.patchFile).toMatch(/\.agent\/timeout-patch-\d+\.patch$/)

    // Verify the patch file exists and contains diff
    const patchContent = await import('node:fs/promises').then(({ readFile }) => readFile(evidence.patchFile!, 'utf8'))
    expect(patchContent).toContain('diff --git')
    expect(patchContent).toContain('README.md')
    expect(patchContent).toContain('+# Test Updated')

    await rm(worktree, { recursive: true, force: true })
  })

  test('captures empty patch when no changes', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-timeout-clean-'))

    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })

    await writeFile(join(worktree, 'README.md'), '# Clean\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })

    const evidence = await captureTimeoutEvidence(worktree, process.env)

    expect(evidence.git.branch).toBe('main')
    expect(evidence.git.statusShort).toBe('')
    expect(evidence.patchFile).toBeDefined()

    // Empty diff should produce an empty patch file
    const patchContent = await import('node:fs/promises').then(({ readFile }) => readFile(evidence.patchFile!, 'utf8'))
    // The patch file exists but may be empty or just have headers
    expect(patchContent).toBeDefined()

    await rm(worktree, { recursive: true, force: true })
  })

  test('mergeTimeoutEvidence preserves existing status fields', () => {
    const existingStatus = {
      provider: 'anypi',
      status: 'running',
      startedAt: '2026-06-18T00:00:00.000Z',
      runName: 'test-run',
      namespace: 'agents',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      headBranch: 'codex/test',
      worktree: '/workspace/lab',
      model: 'qwen3-coder-flamingo',
      providerModel: 'flamingo/qwen3-coder-flamingo',
      piPromptTimeoutSeconds: 1800,
      promptVariant: 'minimal',
      promptHash: 'abc123def456',
      tools: ['bash', 'edit', 'read'],
      sessionFile: '/path/to/session.json',
      sessionFiles: ['/path/to/session.json'],
      commit: 'abc123',
      validations: [{ command: 'bash', args: [], exitCode: 0, stdout: '', stderr: '', durationMs: 100, ok: true }],
      validationPlan: { policy: 'append', sources: [], commands: [] },
      agentAttempts: 1,
      validationAttempts: 1,
      ciAttempts: 0,
      promptChars: 1000,
    }

    const evidence = {
      git: {
        branch: 'codex/test',
        head: 'def456abc123',
        statusShort: ' M services/anypi/src/run.ts',
        diffStat: '1 file changed, 1 insertion(+)',
      },
      patchFile: '/workspace/lab/.agent/timeout-patch-123.patch',
    }

    const merged = mergeTimeoutEvidence(existingStatus as any, evidence)

    // Verify existing fields are preserved
    expect(merged.provider).toBe('anypi')
    expect(merged.runName).toBe('test-run')
    expect(merged.tools).toEqual(['bash', 'edit', 'read'])
    expect(merged.sessionFile).toBe('/path/to/session.json')
    expect(merged.validations.length).toBe(1)
    expect(merged.promptChars).toBe(1000)

    // Verify timeout evidence fields are added
    expect(merged.gitBranch).toBe('codex/test')
    expect(merged.gitHead).toBe('def456abc123')
    expect(merged.gitStatusShort).toBe(' M services/anypi/src/run.ts')
    expect(merged.gitDiffStat).toBe('1 file changed, 1 insertion(+)')
    expect(merged.timeoutPatchFile).toBe('/workspace/lab/.agent/timeout-patch-123.patch')

    // Verify the original is not mutated
    expect(existingStatus.provider).toBe('anypi')
  })

  test('TimeoutErrorWithEvidence error class captures evidence', () => {
    const evidence = {
      git: {
        branch: 'test-branch',
        head: 'abc123',
        statusShort: 'M test.txt',
        diffStat: '1 file changed',
      },
      patchFile: '/tmp/test.patch',
    }
    const error = new TimeoutErrorWithEvidence('test timeout', evidence)
    expect(error.message).toBe('test timeout')
    expect(error.name).toBe('TimeoutErrorWithEvidence')
    expect(error.evidence).toBe(evidence)
    expect(error.evidence.git.branch).toBe('test-branch')
  })
})

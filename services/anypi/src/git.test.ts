import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { describe, expect, test } from 'vitest'

import { classifyRestrictedChangedFile, validateChangedFilePolicy } from './git'

describe('Anypi timeout evidence capture', () => {
  test('captures git state (branch, HEAD, status) on timeout', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-timeout-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'anypi@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })
    await writeFile(join(worktree, 'README.md'), 'hello\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: worktree })

    // Create a change
    await writeFile(join(worktree, 'new-file.txt'), 'new content\n', 'utf8')

    // Import git functions dynamically to avoid circular dependencies in test
    const { captureGitState } = await import('./git')
    const state = await captureGitState(worktree)
    expect(state.branch).toBe('main')
    expect(state.status).toContain('new-file.txt')
  })

  test('captures diff stat on timeout', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-diffstat-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'anypi@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })
    await writeFile(join(worktree, 'file1.ts'), 'line1\nline2\nline3\n', 'utf8')
    execFileSync('git', ['add', 'file1.ts'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })

    await writeFile(join(worktree, 'file1.ts'), 'line1\nline2\nline3\nline4\n', 'utf8')

    const { computeDiffStat } = await import('./git')
    const diffStat = await computeDiffStat(worktree)
    expect(diffStat).toContain('file1.ts')
    expect(diffStat).toContain('1 insertion')
  })

  test('captures patch file on timeout', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-patch-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'anypi@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })
    await writeFile(join(worktree, 'original.txt'), 'original\n', 'utf8')
    execFileSync('git', ['add', 'original.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })

    await writeFile(join(worktree, 'original.txt'), 'modified\n', 'utf8')
    await writeFile(join(worktree, 'new.txt'), 'new file\n', 'utf8')

    const { captureTimeoutEvidence } = await import('./git')
    const evidence = await captureTimeoutEvidence(worktree, undefined, '/tmp/log.txt', '/tmp/status.json')
    expect(evidence.patchPath).toContain('anypi-patch-')
    expect(evidence.patchPath).toContain('.patch')
    expect(evidence.branch).toBe('main')

    // Verify patch file exists and has content
    const fs = await import('node:fs/promises')
    const patchContent = await fs.readFile(evidence.patchPath, 'utf8')
    expect(patchContent).toContain('diff --git')
  })

  test('captures all timeout evidence metadata', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-evidence-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'anypi@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })
    await writeFile(join(worktree, 'test.txt'), 'content\n', 'utf8')
    execFileSync('git', ['add', 'test.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })

    await writeFile(join(worktree, 'test.txt'), 'modified\n', 'utf8')

    const { captureTimeoutEvidence } = await import('./git')
    const evidence = await captureTimeoutEvidence(worktree, undefined, '/custom/log.txt', '/custom/status.json')

    expect(evidence.branch).toBe('main')
    expect(evidence.head).toHaveLength(40) // SHA-1 hash length
    expect(evidence.status).toContain('test.txt')
    expect(evidence.diffStat).toContain('test.txt')
    expect(evidence.patchPath).toContain('.patch')
    expect(evidence.runnerLogPath).toBe('/custom/log.txt')
    expect(evidence.runnerStatusPath).toBe('/custom/status.json')
    expect(evidence.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('captures evidence when no changes exist (empty diff)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'anypi-nochange-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'anypi@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'Anypi Test'], { cwd: worktree })
    await writeFile(join(worktree, 'file.txt'), 'content\n', 'utf8')
    execFileSync('git', ['add', 'file.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: worktree })

    const { captureTimeoutEvidence } = await import('./git')
    const evidence = await captureTimeoutEvidence(worktree)

    expect(evidence.diffStat).toBe('') // No changes means empty diff stat
    expect(evidence.patchPath).toBeDefined()
  })
})

describe('Anypi git utilities', () => {
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

    const { validateChangedFilePolicy } = await import('./git')

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
})

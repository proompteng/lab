import { describe, expect, it } from 'vitest'

import { evaluateDeterministicGates } from '~/server/codex-judge-gates'

describe('codex judge deterministic gates', () => {
  it('flags empty diff when no noop override is present', () => {
    const result = evaluateDeterministicGates({
      diff: '',
      issueTitle: 'Implement gating',
      issueBody: 'Ensure behavior matches requirements.',
      prompt: 'Do the work.',
    })

    expect(result).not.toBeNull()
    expect(result?.decision).toBe('needs_iteration')
    expect(result?.reason).toBe('empty_diff')
  })

  it('detects merge conflicts from diff markers', () => {
    const diff = [
      'diff --git a/file.txt b/file.txt',
      '@@',
      '+<<<<<<< HEAD',
      '+conflict',
      '+=======',
      '+resolution',
      '+>>>>>>> branch',
    ].join('\n')

    const result = evaluateDeterministicGates({
      diff,
      issueTitle: 'Resolve issue',
      issueBody: '',
      prompt: 'Update the file.',
    })

    expect(result).not.toBeNull()
    expect(result?.decision).toBe('needs_human')
    expect(result?.reason).toBe('merge_conflict')
  })

  it('detects patch apply failures from logs', () => {
    const result = evaluateDeterministicGates({
      diff: 'diff --git a/file.txt b/file.txt\n+change',
      issueTitle: 'Apply patch',
      issueBody: '',
      prompt: 'Apply changes.',
      logExcerpt: { output: 'error: patch failed: file.txt' },
    })

    expect(result).not.toBeNull()
    expect(result?.decision).toBe('needs_iteration')
    expect(result?.reason).toBe('patch_apply_failed')
  })
})

import { describe, expect, it } from 'vitest'

import {
  buildCodexBranchName,
  buildCodexPrompt,
  normalizeLogin,
  PROGRESS_COMMENT_MARKER,
  sanitizeBranchComponent,
} from './codex'

describe('normalizeLogin', () => {
  it('lowercases and trims valid logins', () => {
    expect(normalizeLogin('  GregKonush  ')).toBe('gregkonush')
  })

  it('returns null for empty or non-string inputs', () => {
    expect(normalizeLogin('')).toBeNull()
    expect(normalizeLogin(undefined)).toBeNull()
    expect(normalizeLogin(null)).toBeNull()
  })
})

describe('sanitizeBranchComponent', () => {
  it('replaces invalid characters and lowercases the value', () => {
    expect(sanitizeBranchComponent('Feature/ISSUE-123')).toBe('feature-issue-123')
  })

  it('falls back to task when no characters survive sanitisation', () => {
    expect(sanitizeBranchComponent('@@@')).toBe('task')
  })
})

describe('buildCodexBranchName', () => {
  it('builds a deterministic branch prefix with sanitized delivery id suffix', () => {
    const branch = buildCodexBranchName(42, 'Delivery-123XYZ', 'codex/issue-')
    const expectedSuffix = sanitizeBranchComponent('Delivery-123XYZ').slice(0, 8)
    expect(branch.startsWith('codex/issue-42-')).toBe(true)
    expect(branch).toContain(expectedSuffix)
    expect(branch).toMatch(/^codex\/issue-42-[a-z0-9-]+$/)
  })
})

describe('buildCodexPrompt', () => {
  it('constructs an implementation prompt with execution rules and memory capture', () => {
    const prompt = buildCodexPrompt({
      issueTitle: 'Improve webhook reliability',
      issueBody: 'Focus on retry logic and logging.',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 77,
      baseBranch: 'main',
      headBranch: 'codex/issue-77-abc123',
      issueUrl: 'https://github.com/proompteng/lab/issues/77',
    })

    expect(prompt).toContain('Implement this issue end to end and open a ready-to-merge PR.')
    expect(prompt).toContain('Head branch: codex/issue-77-abc123')
    expect(prompt).toContain('Requirements:')
    expect(prompt).toContain(`Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current`)
    expect(prompt).toContain('If total PR changes exceed 1000 lines')
    expect(prompt).toContain('permitted to merge the PR once CI is green')
    expect(prompt).toContain('Memory:')
    expect(prompt).toContain('Save a memory for every change made.')
  })

  it('uses a default issue body when none is supplied', () => {
    const prompt = buildCodexPrompt({
      issueTitle: 'Refine metrics dashboards',
      issueBody: '   ',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 101,
      baseBranch: 'main',
      headBranch: 'codex/issue-101-abc123',
      issueUrl: 'https://github.com/proompteng/lab/issues/101',
    })

    expect(prompt).toContain('"""\nNo description provided.\n"""')
  })
})

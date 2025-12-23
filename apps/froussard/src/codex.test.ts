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

    expect(prompt).toContain('Implement this issue end to end.')
    expect(prompt).toContain('Implementation branch: codex/issue-77-abc123')
    expect(prompt).toContain('Do:')
    expect(prompt).toContain(`Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current`)
    expect(prompt).toContain('Runtime environment (from apps/froussard/Dockerfile.codex):')
    expect(prompt).toContain('Node 24.11.1, Go 1.25.4, Bun 1.3.5')
    expect(prompt).toContain('Memory capture:')
    expect(prompt).toContain('bun run --filter memories save-memory')
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

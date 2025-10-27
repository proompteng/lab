import { describe, expect, it } from 'vitest'

import {
  buildCodexBranchName,
  buildCodexPrompt,
  normalizeLogin,
  PLAN_COMMENT_MARKER,
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
  it('constructs a planning prompt with trimmed issue body', () => {
    const prompt = buildCodexPrompt({
      stage: 'planning',
      issueTitle: 'Improve webhook reliability',
      issueBody: '\nFocus on retry logic and logging.  \n',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 77,
      baseBranch: 'main',
      headBranch: 'codex/issue-77-abc123',
      issueUrl: 'https://github.com/proompteng/lab/issues/77',
    })

    expect(prompt).toContain('Draft the plan the next Codex run will execute.')
    expect(prompt).toContain('Guidance:')
    expect(prompt).toContain('Use internet search (web.run) when the plan needs up-to-date facts.')
    expect(prompt).toContain('Never emit raw')
    expect(prompt).toContain('Plan template (copy verbatim):')
    expect(prompt).toContain(PLAN_COMMENT_MARKER)
    expect(prompt).toContain('### Steps')
    expect(prompt).toContain('### Handoff Notes')
    expect(prompt).toContain('Guidance: describe concrete files, commands, or checks; note why each step matters.')
    expect(prompt).toContain('"""\nFocus on retry logic and logging.\n"""')
  })

  it('constructs an implementation prompt that embeds the approved plan', () => {
    const prompt = buildCodexPrompt({
      stage: 'implementation',
      issueTitle: 'Improve webhook reliability',
      issueBody: 'Focus on retry logic and logging.',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 77,
      baseBranch: 'main',
      headBranch: 'codex/issue-77-abc123',
      issueUrl: 'https://github.com/proompteng/lab/issues/77',
      planCommentBody: `${PLAN_COMMENT_MARKER}\n1. Step one`,
    })

    expect(prompt).toContain(
      'Execute the approved plan end to end. Keep notes concise and call out any deviations with their rationale.',
    )
    expect(prompt).toContain('Approved plan:')
    expect(prompt).toContain('1. Step one')
    expect(prompt).toContain('Implementation branch: codex/issue-77-abc123')
    expect(prompt).toContain('Guidance:')
    expect(prompt).toContain('Use internet search (web.run) when fresh context is needed')
    expect(prompt).toContain(
      `Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} up to date using apps/froussard/src/codex/cli/codex-progress-comment.ts.`,
    )
  })

  it('falls back to a default plan body when the approved plan is empty', () => {
    const prompt = buildCodexPrompt({
      stage: 'implementation',
      issueTitle: 'Stabilise deployment workflow',
      issueBody: 'Improve release cadence.',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 88,
      baseBranch: 'main',
      headBranch: 'codex/issue-88-xyz987',
      issueUrl: 'https://github.com/proompteng/lab/issues/88',
      planCommentBody: '   ',
    })

    expect(prompt).toContain('"""\nNo approved plan content was provided.\n"""')
  })

  it('uses a default issue body when none is supplied', () => {
    const prompt = buildCodexPrompt({
      stage: 'planning',
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

  it('constructs a review prompt with outstanding feedback context', () => {
    const prompt = buildCodexPrompt({
      stage: 'review',
      issueTitle: 'Tighten review automation',
      issueBody: 'Codex should keep working the PR until it can merge.',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 123,
      baseBranch: 'main',
      headBranch: 'codex/issue-123-abcd1234',
      issueUrl: 'https://github.com/proompteng/lab/issues/123',
      reviewContext: {
        summary: 'Two review threads remain unresolved.',
        reviewThreads: [
          {
            summary: 'Add unit coverage for the new webhook branch.',
            url: 'https://github.com/proompteng/lab/pull/456#discussion-1',
            author: 'octocat',
          },
        ],
        failingChecks: [
          {
            name: 'ci / lint',
            conclusion: 'failure',
            url: 'https://ci.example.com/lint',
            details: 'Biome formatting check is failing',
          },
        ],
        additionalNotes: ['Post an update in the progress comment after fixes land.'],
      },
    })

    expect(prompt).toContain('Address outstanding reviewer feedback and failing checks')
    expect(prompt).toContain('Outstanding items from GitHub:')
    expect(prompt).toContain('Open review threads:')
    expect(prompt).toContain('Add unit coverage for the new webhook branch.')
    expect(prompt).toContain('ci / lint')
    expect(prompt).toContain('Biome formatting check is failing')
    expect(prompt).toContain(PROGRESS_COMMENT_MARKER)
  })

  it('falls back to guidance when no review context is provided', () => {
    const prompt = buildCodexPrompt({
      stage: 'review',
      issueTitle: 'Run review loop',
      issueBody: 'Ensure Codex exits cleanly when nothing remains.',
      repositoryFullName: 'proompteng/lab',
      issueNumber: 321,
      baseBranch: 'main',
      headBranch: 'codex/issue-321-abcd1234',
      issueUrl: 'https://github.com/proompteng/lab/issues/321',
    })

    expect(prompt).toContain('No unresolved feedback or failing checks were supplied.')
    expect(prompt).toContain('Double-check the pull request status and exit once it is mergeable.')
  })
})

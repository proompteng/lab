import { describe, expect, it } from 'vitest'

import {
  buildCodexBranchName,
  buildCodexPrompt,
  normalizeLogin,
  PLAN_COMMENT_MARKER,
  PROGRESS_COMMENT_MARKER,
  REVIEW_COMMENT_MARKER,
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

    expect(prompt).toContain('Draft the final plan the next Codex run will execute.')
    expect(prompt).toContain('Execution contract:')
    expect(prompt).toContain(
      'Replace the `_Planning in progress…_` comment anchored by the plan marker with this finished plan.',
    )
    expect(prompt).toContain(
      'Respond with only the Markdown template; do not add preambles, analysis, or TODO placeholders.',
    )
    expect(prompt).toContain(
      'Reference repository paths, files, and symbols precisely so the executor knows exactly where to work.',
    )
    expect(prompt).toContain(
      'Call out commands with working directories and expected outputs so validation is reproducible.',
    )
    expect(prompt).toContain(
      'Highlight dependencies, migrations, approvals, or coordination steps so the executor can schedule work without guessing.',
    )
    expect(prompt).toContain(
      'GitHub CLI (`gh`) is installed and authenticated; use it for issue comments or metadata as needed.',
    )
    expect(prompt).toContain('gh issue comment --repo proompteng/lab 77 --body-file PLAN.md')
    expect(prompt).toContain('Use internet search (web.run) when fresh knowledge is required')
    expect(prompt).toContain('Never emit raw')
    expect(prompt).toContain(
      'Keep tone concise but comprehensive so the next Codex run can finish the task end to end.',
    )
    expect(prompt).toContain('Plan template (copy verbatim):')
    expect(prompt).toContain(PLAN_COMMENT_MARKER)
    expect(prompt).toContain('### Objective')
    expect(prompt).toContain('### Context & Constraints')
    expect(prompt).toContain('### Task Breakdown')
    expect(prompt).toContain('### Deliverables')
    expect(prompt).toContain('### Validation & Observability')
    expect(prompt).toContain('### Risks & Contingencies')
    expect(prompt).toContain('### Communication & Handoff')
    expect(prompt).toContain('### Ready Checklist')
    expect(prompt).toContain('- [ ] Dependencies clarified (feature flags, secrets, linked services)')
    expect(prompt).toContain('- [ ] Test and validation environments are accessible')
    expect(prompt).toContain('- [ ] Required approvals/reviewers identified')
    expect(prompt).toContain('- [ ] Rollback or mitigation steps documented')
    expect(prompt).toContain(
      'Guidance: describe concrete files, commands, or checks; explain why each step matters and how success is proven.',
    )
    expect(prompt).toContain(
      'Ensure validation aligns with the issue acceptance criteria and capture evidence the executor can record in the progress comment.',
    )
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
      'Execute the approved plan end to end. Do not stop until the work is complete, validation passes, and a pull request referencing the issue is open.',
    )
    expect(prompt).toContain('Approved plan:')
    expect(prompt).toContain('1. Step one')
    expect(prompt).toContain('Implementation branch: codex/issue-77-abc123')
    expect(prompt).toContain('Execution contract:')
    expect(prompt).toContain(
      'Follow the approved plan step by step; document any deviations with rationale in the progress comment and handoff notes.',
    )
    expect(prompt).toContain(
      `Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current with timestamps, commands, exit codes, links to logs, and validation evidence.`,
    )
    expect(prompt).toContain(
      'Use apps/froussard/src/codex/cli/codex-progress-comment.ts for every progress update and the final summary.',
    )
    expect(prompt).toContain(
      'GitHub CLI (`gh`) is installed and authenticated; use it to create or update pull requests and issue comments.',
    )
    expect(prompt).toContain(
      'Use internet search (web.run) when fresh context is needed and cite GitHub links or docs in progress updates or code comments as appropriate.',
    )
    expect(prompt).toContain(
      'Open or update a draft pull request targeting `main`, populate .github/PULL_REQUEST_TEMPLATE.md completely, and link #77.',
    )
    expect(prompt).toContain(
      'Do not exit until the pull request exists, CI has passed or failing checks are documented with mitigation steps, and the progress comment contains the final status.',
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

    expect(prompt).toContain(
      'Drive the Codex-authored pull request to a merge-ready state by verifying every approved plan step, finishing any outstanding work, and recording an explicit verdict.',
    )
    expect(prompt).toContain('Outstanding items from GitHub:')
    expect(prompt).toContain('Open review threads:')
    expect(prompt).toContain('Add unit coverage for the new webhook branch.')
    expect(prompt).toContain('ci / lint')
    expect(prompt).toContain('Biome formatting check is failing')
    expect(prompt).toContain('Execution contract:')
    expect(prompt).toContain(
      `Keep the pull request comment anchored by ${REVIEW_COMMENT_MARKER} current with reviewer responses, validation reruns, commands, timestamps, and the final verdict so automation can detect completion.`,
    )
    expect(prompt).toContain('Fetch the latest approved plan anchored by')
    expect(prompt).toContain('Use apps/froussard/src/codex/cli/codex-progress-comment.ts to post review updates')
    expect(prompt).toContain(
      'GitHub CLI (`gh`) is installed and authenticated; use it to fetch issue context, update the pull request, and interact with reviewers.',
    )
    expect(prompt).toContain(
      'post an approval comment on the pull request summarizing the evidence (e.g., `gh pr comment --body "Plan complete; validation evidence: ..."`).',
    )
    expect(prompt).toContain(REVIEW_COMMENT_MARKER)
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

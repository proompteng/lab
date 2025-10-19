import { describe, expect, it } from 'bun:test'

import {
  buildEventBody,
  buildReviewContext,
  parseArgs,
  summarizeText,
  type ReviewContextSummary,
} from '../trigger-review-workflow'

describe('summarizeText', () => {
  it('trims whitespace and collapses newlines', () => {
    expect(summarizeText('  hello\nworld  ')).toBe('hello world')
  })

  it('adds ellipsis when exceeding max length', () => {
    const longText = 'a'.repeat(300)
    expect(summarizeText(longText, 10)).toBe('aaaaaaaaa…')
  })
})

describe('buildReviewContext', () => {
  it('collects unresolved threads and failing checks with summary', () => {
    const threads = [
      {
        isResolved: false,
        path: 'src/app.ts',
        comments: {
          nodes: [
            {
              bodyText: 'Please update the unit test to cover the new branch.',
              url: 'https://example.test/thread',
              author: { login: 'octocat' },
            },
          ],
        },
      },
      {
        isResolved: true,
        path: 'src/ignore.ts',
      },
    ]

    const checks = [
      {
        name: 'ci / test',
        conclusion: 'failure',
        html_url: 'https://example.test/job/123',
        status: 'completed',
      },
      {
        name: 'ci / lint',
        conclusion: 'success',
        status: 'completed',
      },
    ]

    const context = buildReviewContext(threads as never, checks as never)

    expect(context.reviewThreads).toHaveLength(1)
    expect(context.reviewThreads[0]).toEqual({
      summary: 'Please update the unit test to cover the new branch.',
      url: 'https://example.test/thread',
      author: 'octocat',
    })

    expect(context.failingChecks).toHaveLength(1)
    expect(context.failingChecks[0]).toEqual({
      name: 'ci / test',
      conclusion: 'failure',
      url: 'https://example.test/job/123',
      details: undefined,
    })

    expect(context.summary).toBe('Outstanding items: 1 unresolved review thread, 1 failing check.')
  })

  it('omits summary when no outstanding items', () => {
    const context = buildReviewContext(
      [
        {
          isResolved: true,
          path: 'src/app.ts',
        },
      ] as never,
      [
        {
          name: 'ci / test',
          conclusion: 'success',
          status: 'completed',
        },
      ] as never,
    )

    expect(context.reviewThreads).toHaveLength(0)
    expect(context.failingChecks).toHaveLength(0)
    expect(context.summary).toBeUndefined()
  })
})

describe('buildEventBody', () => {
  it('constructs the workflow payload', () => {
    const context: ReviewContextSummary = {
      summary: 'Outstanding items: 1 unresolved review thread, 1 failing check.',
      reviewThreads: [
        {
          summary: 'Fix the failing test',
          url: 'https://example.test/thread',
          author: 'octocat',
        },
      ],
      failingChecks: [
        {
          name: 'ci / test',
          conclusion: 'failure',
          url: 'https://example.test/job/123',
        },
      ],
    }

    const eventBody = buildEventBody(
      'proompteng/lab',
      {
        number: 42,
        title: 'feat: add new feature',
        body: 'PR body',
        url: 'https://github.com/proompteng/lab/pull/42',
        headRefName: 'codex/issue-42-abc',
        headRefOid: 'abc123',
        baseRefName: 'main',
        isDraft: true,
      },
      context,
    )

    expect(eventBody).toEqual({
      stage: 'review',
      repository: 'proompteng/lab',
      issueNumber: 42,
      issueTitle: 'feat: add new feature',
      issueBody: 'PR body',
      issueUrl: 'https://github.com/proompteng/lab/pull/42',
      base: 'main',
      head: 'codex/issue-42-abc',
      reviewContext: context,
    })
  })
})

describe('parseArgs', () => {
  it('parses required and optional flags', () => {
    const options = parseArgs(['--pr=42', '--repo=acme/widgets', '--namespace=codex', '--dry-run'])
    expect(options).toEqual({
      pr: 42,
      repo: 'acme/widgets',
      namespace: 'codex',
      dryRun: true,
    })
  })

  it('defaults repo/namespace and disables dry run', () => {
    const options = parseArgs(['--pr=77'])
    expect(options).toEqual({
      pr: 77,
      repo: 'proompteng/lab',
      namespace: 'argo-workflows',
      dryRun: false,
    })
  })

  it('derives repo from PR URL', () => {
    const options = parseArgs(['--pr=https://github.com/acme/widgets/pull/99'])
    expect(options).toEqual({
      pr: 99,
      repo: 'acme/widgets',
      namespace: 'argo-workflows',
      dryRun: false,
    })
  })

  it('validates repo consistency when both URL and flag provided', () => {
    expect(() => parseArgs(['--pr=https://github.com/acme/widgets/pull/99', '--repo=acme/other'])).toThrow(
      /Repository mismatch/,
    )
  })

  it('throws on missing PR flag', () => {
    expect(() => parseArgs([])).toThrow(/Usage:/)
  })

  it('throws on invalid repo format', () => {
    expect(() => parseArgs(['--pr=1', '--repo=invalid'])).toThrow(/Repository must be/)
  })
})

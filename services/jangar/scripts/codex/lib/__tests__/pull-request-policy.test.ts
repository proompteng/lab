import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { evaluatePullRequestPolicy } from '../pull-request-policy'

describe('evaluatePullRequestPolicy', () => {
  it('does not enforce PR creation for non-implementation stages', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'plan',
        requirePullRequest: true,
        prUrl: null,
      }),
    )

    expect(decision).toEqual({
      ok: true,
      enforced: false,
    })
  })

  it('does not enforce PR creation when requirePullRequest is false', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'implementation',
        requirePullRequest: false,
        prUrl: null,
      }),
    )

    expect(decision).toEqual({
      ok: true,
      enforced: false,
    })
  })

  it('fails when implementation requires a PR but no URL is present', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'implementation',
        requirePullRequest: true,
        prUrl: null,
      }),
    )

    expect(decision).toEqual({
      ok: false,
      reason: 'MissingPullRequest',
      message: 'Implementation run completed without creating a pull request (missing PR_URL output)',
    })
  })

  it('passes when implementation requires a PR and URL is present', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'implementation',
        requirePullRequest: true,
        prUrl: 'https://github.com/proompteng/lab/pull/123',
      }),
    )

    expect(decision).toEqual({
      ok: true,
      enforced: true,
    })
  })
})

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

  it('does not enforce PR creation for deployer release-manager executions', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'implementation',
        requirePullRequest: true,
        prUrl: null,
        swarmAgentRole: 'deployer',
      }),
    )

    expect(decision).toEqual({
      ok: true,
      enforced: false,
    })
  })

  it('fails when architect merge evidence is required but missing', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'planning',
        requirePullRequest: false,
        prUrl: null,
        requireArchitectMergeEvidence: true,
        hasArchitectMergeEvidence: false,
      }),
    )

    expect(decision).toEqual({
      ok: false,
      reason: 'MissingArchitectMergeEvidence',
      message: 'Architect run changed repository files but did not provide merged PR/commit evidence',
    })
  })

  it('passes when architect merge evidence is required and present', () => {
    const decision = Effect.runSync(
      evaluatePullRequestPolicy({
        stage: 'planning',
        requirePullRequest: false,
        prUrl: null,
        requireArchitectMergeEvidence: true,
        hasArchitectMergeEvidence: true,
      }),
    )

    expect(decision).toEqual({
      ok: true,
      enforced: false,
    })
  })
})

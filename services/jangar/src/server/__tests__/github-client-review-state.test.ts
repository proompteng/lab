import { describe, expect, it } from 'vitest'

import { summarizeLatestReviewStates } from '../github-client'

describe('summarizeLatestReviewStates', () => {
  it('lets a later approval supersede an earlier change request from the same reviewer', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'reviewer',
          state: 'APPROVED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'approved', requestedChanges: false })
  })

  it('keeps a current change request from any reviewer blocking approval', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer-a',
          state: 'APPROVED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
        {
          author: 'reviewer-b',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'changes_requested', requestedChanges: true })
  })

  it('uses response order as a fallback when submitted timestamps are unavailable', () => {
    expect(
      summarizeLatestReviewStates([
        { author: 'reviewer', state: 'CHANGES_REQUESTED', submittedAt: null },
        { author: 'reviewer', state: 'APPROVED', submittedAt: null },
      ]),
    ).toEqual({ status: 'approved', requestedChanges: false })
  })
})

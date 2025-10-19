import { describe, expect, it } from 'vitest'

import {
  evaluateCodexWorkflow,
  type ReadyCommentCommand,
  type ReviewEvaluation,
  shouldPostReadyCommentGuard,
  type WorkflowContext,
} from '../workflow-machine'

describe('shouldPostReadyCommentGuard', () => {
  const baseContext: WorkflowContext = { commands: [] }
  const baseEvent: ReviewEvaluation = {
    outstandingWork: false,
    forceReview: false,
    isDraft: false,
    mergeStateRequiresAttention: false,
    readyCommentCommand: {
      repositoryFullName: 'acme/widgets',
      pullNumber: 42,
      issueNumber: 42,
      body: 'ready',
      marker: '<!-- codex:ready -->',
    },
  } as ReviewEvaluation

  it('returns false when the workflow is forcing a review stage', () => {
    const result = shouldPostReadyCommentGuard(baseContext, {
      type: 'PR_ACTIVITY',
      data: { ...baseEvent, forceReview: true },
    })

    expect(result).toBe(false)
  })

  it('returns true when all criteria are met', () => {
    const result = shouldPostReadyCommentGuard(baseContext, {
      type: 'PR_ACTIVITY',
      data: baseEvent,
    })

    expect(result).toBe(true)
  })
})

describe('evaluateCodexWorkflow', () => {
  const readyComment: ReadyCommentCommand = {
    repositoryFullName: 'acme/widgets',
    pullNumber: 42,
    issueNumber: 42,
    body: 'ready',
    marker: '<!-- codex:ready -->',
  }

  it('does not queue a ready comment when forceReview is true', () => {
    const result = evaluateCodexWorkflow({
      type: 'PR_ACTIVITY',
      data: {
        outstandingWork: false,
        forceReview: true,
        isDraft: false,
        mergeStateRequiresAttention: false,
        readyCommentCommand: readyComment,
      } as ReviewEvaluation,
    })

    expect(result.commands).toEqual([])
    expect(result.state).toBe('ignored')
  })

  it('queues a ready comment when forceReview is false', () => {
    const result = evaluateCodexWorkflow({
      type: 'PR_ACTIVITY',
      data: {
        outstandingWork: false,
        forceReview: false,
        isDraft: false,
        mergeStateRequiresAttention: false,
        readyCommentCommand: readyComment,
      } as ReviewEvaluation,
    })

    expect(result.commands).toEqual([{ type: 'postReadyComment', data: readyComment }])
    expect(result.state).toBe('reviewReadyComment')
  })
})

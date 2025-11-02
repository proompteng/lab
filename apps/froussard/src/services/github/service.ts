import { Effect, Layer } from 'effect'

import { findLatestPlanComment, issueHasReaction, postIssueReaction } from './issues'
import { createPullRequestComment, fetchPullRequest, markPullRequestReadyForReview } from './pull-requests'
import { listPullRequestCheckFailures, listPullRequestReviewThreads } from './reviews'
import type { GithubServiceDefinition } from './service.types'

export class GithubService extends Effect.Tag('@froussard/GithubService')<GithubService, GithubServiceDefinition>() {}

export const GithubServiceLayer = Layer.sync(GithubService, () => ({
  postIssueReaction,
  issueHasReaction,
  findLatestPlanComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
  createPullRequestComment,
  listPullRequestReviewThreads,
  listPullRequestCheckFailures,
}))

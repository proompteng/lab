import { Effect, Layer } from 'effect'

import { createPullRequestComment, fetchPullRequest, markPullRequestReadyForReview } from './pull-requests'
import { findLatestPlanComment, postIssueReaction } from './issues'
import { listPullRequestCheckFailures, listPullRequestReviewThreads } from './reviews'
import type { GithubServiceDefinition } from './service.types'

export class GithubService extends Effect.Tag('@froussard/GithubService')<GithubService, GithubServiceDefinition>() {}

export const GithubServiceLayer = Layer.sync(GithubService, () => ({
  postIssueReaction,
  findLatestPlanComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
  createPullRequestComment,
  listPullRequestReviewThreads,
  listPullRequestCheckFailures,
}))

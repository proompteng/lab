import { Effect, Layer } from 'effect'

import {
  createIssueComment,
  findLatestPlanComment,
  issueHasReaction,
  postIssueCommentReaction,
  postIssueReaction,
} from './issues'
import { createPullRequestComment, fetchPullRequest, markPullRequestReadyForReview } from './pull-requests'
import { listPullRequestCheckFailures, listPullRequestReviewThreads } from './reviews'
import type { GithubServiceDefinition } from './service.types'

export class GithubService extends Effect.Tag('@froussard/GithubService')<GithubService, GithubServiceDefinition>() {}

export const GithubServiceLayer = Layer.sync(GithubService, () => ({
  postIssueReaction,
  postIssueCommentReaction,
  issueHasReaction,
  findLatestPlanComment,
  createIssueComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
  createPullRequestComment,
  listPullRequestReviewThreads,
  listPullRequestCheckFailures,
}))
